// supabase/functions/telegram-bot/index.ts
// Telegram calls this function every time someone messages your bot, or taps
// one of its buttons.
//
//   any message       → saved as a thought
//   ? words  /ask …   → "Ask my brain": an answer from your notes, with sources
//   looks like a question but no ? or /ask → "Save it" / "Answer it" buttons
//   /search words     → a plain list of matching thoughts
//   /recent           → your last 5 thoughts
//   /new              → forget the conversation (follow-up memory)
//   /t_1a2b3c4d       → show one thought in full (the links under answers)
//   /king order       → the crew's King plans it; Approve / Edit / Cancel
//   /orders, /o_…     → your last 10 orders / one order step by step
//   looks like an instruction ("Delete that") → Save as note / Send to King
//
// Buttons are inline keyboards; taps arrive as callback_query updates.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { askBrain, clearHistory, renderAnswer } from '../_shared/ask.ts'
import { INTERNAL_HEADER, internalHeaders, rejectUnlessInternal, safeEqual } from '../_shared/internal-auth.ts'
import { MIN_REAL_CONTENT, refillThought } from '../_shared/refill.ts'
import { keywordQuery } from '../_shared/keywords.ts'
import { finishRun, startRun } from '../_shared/runs.ts'
import {
  DEFAULT_KIND, KIND_LABEL, kindByRules, PICKABLE, type Section, SECTION_LABEL, sectionOf,
} from '../_shared/kinds.ts'

// Secrets. The first three are ones you added; the SUPABASE_ ones are
// provided automatically by Supabase.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const OWNER_CHAT_ID = (Deno.env.get('TELEGRAM_CHAT_ID') ?? '').trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
// The capture functions sit behind Supabase's login check; the anon key
// gets through that, and the internal secret proves it's us.
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
// Telegram sends this back in X-Telegram-Bot-Api-Secret-Token on every
// update, because we registered it with setWebhook. Anything without it
// didn't come from Telegram.
const WEBHOOK_SECRET = (Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '').trim()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// The service role key skips your Level 2 security rule, so this code
// must set and filter user_id itself on every query.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Levels 6 + 7: Supabase's free built-in model that turns text into meaning.
const embedder = new Supabase.ai.Session('gte-small')

type ListRow = { id?: string; content: string; created_at?: string; kind?: string | null; summary?: string | null }

// Meaning + keyword search over the owner's thoughts, best first.
// section: only Personal or only Library; null = both (course_setup is
// always left out). Falls back to keyword search if anything goes wrong.
async function searchBrain(query: string, section: 'personal' | 'library' | null = null, count = 5) {
  try {
    const vector = await embedder.run(query, { mean_pool: true, normalize: true })
    const { data, error } = await db.rpc('hybrid_search_v3', {
      query_embedding: JSON.stringify(Array.from(vector as number[])),
      query_text: keywordQuery(query),
      match_count: count,
      p_user_id: OWNER_USER_ID,
      min_similarity: 0.78,
      p_section: section,
    })
    if (error) throw error
    return data as ListRow[]
  } catch (err) {
    console.error('hybrid search failed, using keyword search:', err)
    // Treat % and _ as plain characters, not wildcards
    const safe = query.replace(/[\\%_]/g, '\\$&')
    let q = db
      .from('thoughts')
      .select('id, content, created_at, kind, summary')
      .eq('user_id', OWNER_USER_ID)
      .ilike('content', `%${safe}%`)
    q = section ? q.eq('section', section) : q.in('section', ['personal', 'library'])
    const { data, error } = await q.order('created_at', { ascending: false }).limit(count)
    if (error) throw error
    return data as ListRow[]
  }
}

// Always answer Telegram with 200, or it will keep re-sending the message.
function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------
type Button = { text: string; callback_data: string }
type Keyboard = Button[][]

async function telegram(method: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.error(`${method} failed:`, res.status, await res.text())
      return null
    }
    return (await res.json())?.result ?? null
  } catch (err) {
    console.error(`${method} error:`, err)
    return null
  }
}

// Send a reply back to the chat, optionally with buttons under it.
async function reply(chatId: number | string, text: string, keyboard?: Keyboard): Promise<void> {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4000), // Telegram's limit is 4096 characters
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })
}

// Send a long text as several messages (split at paragraphs), buttons under
// the last one. Returns the last message's id.
async function sendLong(chatId: number | string, text: string, keyboard?: Keyboard): Promise<number | null> {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf('\n\n', 3900)
    if (cut < 2000) cut = rest.lastIndexOf('\n', 3900)
    if (cut < 2000) cut = 3900
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  let last: number | null = null
  for (const [i, part] of parts.entries()) {
    const sent = await telegram('sendMessage', {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...(keyboard && i === parts.length - 1 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }) as { message_id?: number } | null
    last = sent?.message_id ?? last
  }
  return last
}

// Buttons sent by our own jobs: text + callback_data under 64 bytes only.
// deno-lint-ignore no-explicit-any
function cleanKeyboard(rows: any[]): Keyboard {
  return rows.filter(Array.isArray).map((row) => row
    .filter((b: { text?: unknown; callback_data?: unknown }) => typeof b?.text === 'string' && typeof b?.callback_data === 'string'
      && new TextEncoder().encode(b.callback_data as string).length <= 64)
    .map((b: Button) => ({ text: b.text.slice(0, 60), callback_data: b.callback_data })))
    .filter((row) => row.length)
}

// --- The crew (King + workers), in the crew function ------------------------
async function crew(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/crew`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && !data?.text && !data?.toast) throw new Error(data?.error ?? `crew failed (HTTP ${res.status})`)
  return data
}

// Plan an order: the King sends the plan (with Approve / Edit / Cancel).
async function sendToKing(chatId: number | string, text: string, source: 'telegram' | 'button'): Promise<string | null> {
  try {
    const res = await crew({ action: 'plan', text, source, chat_id: String(chatId) })
    if (!res.ok && res.error) await reply(chatId, `\u{1F451} I couldn't plan that: ${res.error}`)
    return typeof res.order_id === 'string' ? res.order_id : null
  } catch (e) {
    await reply(chatId, `\u{1F451} I couldn't reach the King: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// A message that reads like an order to the bot ("Look up the videos and
// add them", "Delete that") rather than a note. It gets
// Save as note / Send to King instead of being saved straight away.
function looksLikeInstruction(text: string): boolean {
  const t = text.trim()
  if (t.length > 300) return false
  const s = t.toLowerCase()
  const addressed = /^(hey |ok(ay)? |so )?(please |pls )?((can|could|would|will) you|i (want|need) you to|go ahead and)\b/.test(s)
  const verb = /^(please |pls )?(look up|look for|find|search|add|attach|delete|remove|erase|fix|repair|update|change|move|archive|hide|fetch|pull|grab|show|list|review|summari[sz]e|organi[sz]e|clean up|sort|tag|rename|merge|re-?capture|re-?read|transcribe|download|undo|redo|get rid of)\b/.test(s)
  const botObject = /\b(that|this|it|them|those|these|the (videos?|links?|transcripts?|notes?|thoughts?|messages?|last one)|my (notes?|brain|thoughts?|videos?|links?|library|saved)|transcripts?|brain)\b/.test(s)
  return addressed || (verb && (botObject || t.split(/\s+/).length <= 3))
}

function shorten(text: string, max = 300): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '...' : clean
}

// "Personal · my thought" — the section and kind of a thought.
function whereLabel(kind: string | null | undefined): string {
  const section = sectionOf(kind)
  if (!section) return 'Unsorted'
  return `${SECTION_LABEL[section]} · ${KIND_LABEL[kind as string] ?? kind}`
}

function formatList(rows: ListRow[]): string {
  return rows
    .map((row, i) => {
      const date = row.created_at
        ? new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : ''
      const label = row.kind !== undefined ? `{${whereLabel(row.kind)}} ` : ''
      return `${i + 1}. ${date ? `[${date}] ` : ''}${label}${shorten(row.content)}`
    })
    .join('\n\n')
}

function titleOf(row: { content?: string | null; summary?: string | null }): string {
  const first = (row.content ?? '').split('\n').find((l) => l.trim()) ?? ''
  return shorten(row.summary?.trim() || first, 80)
}

const HELP =
  'Your Open Brain is listening.\n\n' +
  'Send any message to save it as a thought.\n' +
  '? question (or /ask question) to get an answer from your notes\n' +
  '/new to start a fresh conversation (forget follow-ups)\n' +
  '/search words: search everything, each result labelled\n' +
  '/me words: search only Personal (you and what you know)\n' +
  '/lib words: search only Library (things you found or made)\n' +
  '/takeaway words: add your takeaway to a Library item\n' +
  '/recap Class: summary, to save a class recap (I ask one follow-up question)\n' +
  '/goals to see the goals you track\n' +
  '/mygoals to review them one at a time (Keep / Pause / Drop)\n' +
  '/recent to see your last 5 thoughts\n' +
  '/king order: give the crew an order (you approve the plan first)\n' +
  '/orders to see your last 10 orders\n\n' +
  'Send a bare link and I read it (video transcript, article or PDF).'

// ---------------------------------------------------------------------------
// Ask my brain
// ---------------------------------------------------------------------------
// A plain message that reads like a question gets the Save it / Answer it
// buttons instead of being saved straight away.
function looksLikeQuestion(text: string): boolean {
  const t = text.trim()
  if (t.length > 400) return false
  if (t.endsWith('?')) return true
  return /^(what|why|how|when|where|who|which|did|do|does|have|has|had|is|are|was|were|can|could|should|would|will)\b/i
    .test(t)
}

const feedbackKeyboard = (turnId: string): Keyboard => [[
  { text: '\u{1F44D} Helpful', callback_data: `fb:h:${turnId}` },
  { text: '\u{1F44E} Wrong', callback_data: `fb:w:${turnId}` },
]]

async function answerQuestion(
  chatId: number,
  question: string,
  section: 'personal' | 'library' | null = null,
): Promise<void> {
  await telegram('sendChatAction', { chat_id: chatId, action: 'typing' })
  try {
    const res = await askBrain({
      db,
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_ROLE_KEY,
      userId: OWNER_USER_ID,
      question,
      channel: 'telegram',
      chatId: String(chatId),
      useHistory: true,
      section,
    })
    const text = renderAnswer(res, 'telegram')
    await reply(chatId, text, res.turnId ? feedbackKeyboard(res.turnId) : undefined)
  } catch (err) {
    console.error('ask failed:', err)
    const detail = (err as { message?: string })?.message ?? String(err)
    await reply(chatId, `Sorry, I couldn't answer that: ${detail}`)
  }
}

// Run slow work after Telegram has its 200, so it never re-sends the message.
function later(work: Promise<unknown>) {
  EdgeRuntime.waitUntil(work.catch((err) => console.error('background work failed:', err)))
}

type SavedRow = { id: string; kind: string | null; content: string; summary?: string | null }

// Save a message. The kind is decided right here by the free rules when
// they can, so the confirmation can name the section straight away; long
// unclear texts are sorted by enrich-thought a moment later.
async function saveThought(text: string, messageId?: number): Promise<SavedRow> {
  const metadata = { source: 'telegram', telegram_message_id: messageId }
  const kind = kindByRules({ content: text, metadata })
  const { data, error } = await db.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content: text,
    metadata,
    ...(kind ? { kind, kind_set_by: 'rule' } : {}),
  }).select('id, kind, content, summary').single()
  if (error) throw error
  return data as SavedRow
}

// --- Sections: confirmation + one-tap kind switch ---------------------------
function kindKeyboard(id: string, kind: string | null): Keyboard {
  const section = sectionOf(kind)
  const flip = section === 'library'
    ? { text: '\u{1F9E0} Move to Personal', callback_data: `k:${DEFAULT_KIND.personal}:${id}` }
    : { text: '\u{1F4DA} Move to Library', callback_data: `k:${DEFAULT_KIND.library}:${id}` }
  return [[flip, { text: '✏️ Change kind', callback_data: `km:${id}` }]]
}

function savedText(kind: string | null): string {
  const section = sectionOf(kind)
  if (!section) return 'Saved to your brain. Sorting it into a section now.'
  const icon = section === 'library' ? '\u{1F4DA}' : '\u{1F9E0}'
  return `${icon} Saved to ${SECTION_LABEL[section as Section]} (${KIND_LABEL[kind as string] ?? kind})`
}

async function confirmSaved(chatId: number | string, saved: SavedRow): Promise<void> {
  await reply(chatId, savedText(saved.kind), sectionOf(saved.kind) ? kindKeyboard(saved.id, saved.kind) : undefined)
  if (sectionOf(saved.kind) === 'library') await askTakeaway(chatId, saved.id)
}

// --- Reply-mode questions ------------------------------------------------------
// A question sent in reply mode; replying to it is routed by `purpose`.
async function askInReplyMode(
  chatId: number | string,
  text: string,
  purpose: 'takeaway' | 'replace_link' | 'recap' | 'recap_answer',
  thoughtId: string | null,
  data: Record<string, unknown> = {},
  placeholder = 'Type your reply',
): Promise<void> {
  const sent = await telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  }) as { message_id?: number } | null
  if (!sent?.message_id) return
  const { error } = await db.from('telegram_prompts').insert({
    user_id: OWNER_USER_ID,
    chat_id: String(chatId),
    message_id: sent.message_id,
    purpose,
    thought_id: thoughtId,
    data,
  })
  if (error) console.error('could not store prompt:', error.message)
}

// --- Links that read themselves ------------------------------------------------
const BARE_LINK = /^https?:\/\/\S+$/i
const YT_SEARCH = /youtube\.com\/results\?(?:[^ ]*&)?search_query=/i
const YT_VIDEO = /(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)/i

function searchTerms(url: string): string {
  try {
    return new URL(url).searchParams.get('search_query') ?? url
  } catch {
    return url
  }
}

// Fill a saved thought from a link with the existing capture functions,
// keeping the thought's id. Returns what was read, or why not.
async function fillFromLink(thoughtId: string, url: string): Promise<{ ok: boolean; title?: string; chars?: number; error?: string }> {
  const endpoint = YT_VIDEO.test(url) ? 'capture-youtube' : 'capture-url'
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
      method: 'POST',
      headers: internalHeaders({ Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY }),
      body: JSON.stringify({ url, thought_id: thoughtId }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    if ((body.chars ?? 0) < MIN_REAL_CONTENT) return { ok: false, title: body.title, error: 'too little text' }
    return { ok: true, title: body.title, chars: body.chars }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const COULD_NOT_READ = "Saved the link but couldn't read it. Send me the text or a different link?"

// Every bare link is read right away. If it ends up with no real content,
// say so and wait for the text or a better link (reply mode).
async function processLink(
  chatId: number | string,
  thoughtId: string,
  url: string,
  o: { quiet?: boolean } = {},
): Promise<'filled' | 'needs_video_link' | 'unreadable'> {
  if (YT_SEARCH.test(url)) {
    await askInReplyMode(chatId,
      `\u{1F50E} This is a YouTube search, not a video: "${searchTerms(url)}".\nReply with the actual video link and I'll attach its transcript.`,
      'replace_link', thoughtId, { original: url }, 'Paste the video link')
    return 'needs_video_link'
  }
  const filled = await fillFromLink(thoughtId, url)
  if (!filled.ok) {
    console.log(`could not read ${url}: ${filled.error}`)
    await askInReplyMode(chatId, `${COULD_NOT_READ}\n(${shorten(url, 80)})`, 'replace_link', thoughtId,
      { original: url }, 'Paste the text or another link')
    return 'unreadable'
  }
  if (!o.quiet) {
    const row: SavedRow = { id: thoughtId, kind: 'source', content: filled.title ?? url }
    await reply(chatId, `\u{1F4DA} Saved to Library (saved source): ${filled.title ?? url}\n${filled.chars?.toLocaleString()} characters read.`,
      kindKeyboard(thoughtId, 'source'))
    await askTakeaway(chatId, row.id)
  }
  return 'filled'
}

// A reply to "send me the text or a different link": a link is read; pasted
// text is stored as the content. The thought keeps its id either way.
async function replaceLinkContent(chatId: number | string, thoughtId: string, text: string, original: string) {
  const link = text.match(/https?:\/\/\S+/)?.[0]
  if (link && text.trim().length < 400) {
    if (YT_SEARCH.test(link)) {
      await askInReplyMode(chatId, 'That is a search page too. Reply with a link to the video itself.',
        'replace_link', thoughtId, { original }, 'Paste the video link')
      return
    }
    await reply(chatId, 'Reading it…')
    const filled = await fillFromLink(thoughtId, link)
    if (filled.ok) {
      await reply(chatId, `\u{1F4DA} Attached: ${filled.title ?? link} (${filled.chars?.toLocaleString()} characters).`,
        kindKeyboard(thoughtId, 'source'))
      await askTakeaway(chatId, thoughtId)
    } else {
      await askInReplyMode(chatId, `${COULD_NOT_READ}\n(${shorten(link, 80)})`, 'replace_link', thoughtId,
        { original }, 'Paste the text or another link')
    }
    return
  }
  if (text.trim().length < MIN_REAL_CONTENT) {
    await askInReplyMode(chatId, `That's a bit short to be the content (${text.trim().length} characters). Paste the full text, or a link.`,
      'replace_link', thoughtId, { original }, 'Paste the text or another link')
    return
  }
  await refillThought(db, {
    thoughtId,
    content: `\u{1F517} URL: ${original}\n\n${text.trim()}`,
    metadata: { source: 'url', url: original, pasted: true },
    sourceText: text.trim(),
    sourceKind: 'pasted',
    truncated: false,
  })
  await reply(chatId, '\u{1F4DA} Got it. The text is attached to the saved link.', kindKeyboard(thoughtId, 'source'))
  await askTakeaway(chatId, thoughtId)
}

// --- Junk review ----------------------------------------------------------------
// Test messages and commands saved by mistake. Never deleted: Archive sets
// status = 'archived' (hidden from search, Ask, links and digests).
async function findJunk() {
  const { data, error } = await db.from('thoughts')
    .select('id, content, created_at, status, metadata')
    .eq('user_id', OWNER_USER_ID)
    .or('status.is.null,status.neq.archived')
    .order('created_at')
  if (error) throw error
  return (data ?? []).filter((t) => {
    const c = (t.content ?? '').trim()
    if ((t.metadata as Record<string, unknown> | null)?.junk_review) return false   // already decided
    if (/^\/\s*\w*/.test(c)) return true                                            // a saved command
    return c.length < 120 && /\b(test(ing)?|hello|first thought|ignore this)\b/i.test(c)
  })
}

const junkKeyboard = (id: string): Keyboard => [[
  { text: '\u{1F5C4} Archive', callback_data: `ar:${id}` },
  { text: '\u{1F44D} Keep', callback_data: `kp:${id}` },
]]

// --- Goals ------------------------------------------------------------------------
// Proposed from the owner's voice notes in their own words. A goal is only
// created when the owner taps Track (CLAUDE.md rule 4).
const GOALS_SYSTEM = `You read one person's voice notes and list the goals they state, in their own words.
A goal is something they say they want to do, change, become, or achieve. Use their wording, short and first person
(for example "Fix my sleep schedule"). Do not invent goals or add advice. One goal per item; if two notes state the
same goal, list it once with the clearest note.
Reply with ONLY a JSON object: {"goals": [{"goal": "…", "note": 3}]} where note is the number of the note it came from.`

async function proposeGoals(): Promise<number> {
  const { data: notes, error } = await db.from('thoughts')
    .select('id, content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .eq('kind', 'my_thought')
    .like('content', '\u{1F3A4} Voice:%')
    .or('status.is.null,status.neq.archived')
    .order('created_at')
  if (error) throw error
  if (!notes?.length) return 0
  const runId = await startRun(db, { userId: OWNER_USER_ID, agent: 'Scout', job: 'goal-proposals', task: `Read ${notes.length} voice notes for stated goals` })
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      systemPrompt: GOALS_SYSTEM,
      prompt: notes.map((n, i) => `[${i + 1}] ${n.content}`).join('\n\n'),
      maxTokens: 3000,
      userId: OWNER_USER_ID,
      source: 'goal-proposals',
      runId,
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    await finishRun(db, runId, { status: 'failed', error: detail })
    throw new Error(`call-llm failed (${res.status}): ${detail}`)
  }
  const text = String((await res.json()).text ?? '')
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{"goals":[]}')
  const { data: existing } = await db.from('goal_candidates').select('text').eq('user_id', OWNER_USER_ID)
  const seen = new Set((existing ?? []).map((e) => e.text.toLowerCase()))
  const rows = (parsed.goals ?? [])
    .filter((g: { goal?: unknown; note?: unknown }) => typeof g.goal === 'string' && Number.isInteger(g.note)
      && (g.note as number) >= 1 && (g.note as number) <= notes.length)
    .filter((g: { goal: string }) => !seen.has(g.goal.toLowerCase()))
    .map((g: { goal: string; note: number }) => ({
      user_id: OWNER_USER_ID,
      text: g.goal.trim().slice(0, 300),
      source_thought_id: notes[g.note - 1].id,
    }))
  if (rows.length) {
    const { error: insertError } = await db.from('goal_candidates').insert(rows)
    if (insertError) {
      await finishRun(db, runId, { status: 'failed', error: insertError.message })
      throw insertError
    }
  }
  await finishRun(db, runId, { output: `${rows.length} new goal proposal(s); each waits for Track / Not a goal.` })
  return rows.length
}

// Send the next undecided proposal, one at a time.
async function sendNextGoal(chatId: number | string): Promise<boolean> {
  const { data: next } = await db.from('goal_candidates')
    .select('id, text, source_thought_id, created_at')
    .eq('user_id', OWNER_USER_ID)
    .is('decision', null)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (!next) return false
  const { data: note } = next.source_thought_id
    ? await db.from('thoughts').select('id, created_at').eq('id', next.source_thought_id).maybeSingle()
    : { data: null }
  const from = note
    ? `\nFrom your note /t_${note.id.slice(0, 8)} (${new Date(note.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
    : ''
  await reply(chatId, `\u{1F3AF} Is this a goal you want to track?\n"${next.text}"${from}`, [[
    { text: '✅ Track', callback_data: `gt:${next.id}` },
    { text: 'Not a goal', callback_data: `gn:${next.id}` },
  ]])
  await db.from('goal_candidates').update({ sent_at: new Date().toISOString() }).eq('id', next.id)
  return true
}

// /mygoals: review tracked (active) goals one at a time with Keep / Pause / Drop.
// Pause and Drop only change goals.status; nothing is ever deleted.
// `after` = the goal just answered, so the review walks forward in tracking order.
async function sendNextTrackedGoal(chatId: number | string, after?: { confirmed_at: string }): Promise<boolean> {
  let q = db.from('goals').select('id, text, source_thought_id, confirmed_at')
    .eq('user_id', OWNER_USER_ID).eq('status', 'active').order('confirmed_at').order('id')
  if (after) q = q.gt('confirmed_at', after.confirmed_at)
  const { data, error } = await q
  if (error) throw error
  const next = data?.[0]
  if (!next) return false
  const left = data.length - 1
  const from = next.source_thought_id ? `\nFrom /t_${next.source_thought_id.slice(0, 8)}` : ''
  await reply(chatId,
    `\u{1F3AF} "${next.text}"${from}\n\n${left ? `${left} more after this.` : 'Last one.'}`, [[
      { text: '✅ Keep', callback_data: `mg:k:${next.id}` },
      { text: '⏸ Pause', callback_data: `mg:p:${next.id}` },
      { text: '\u{1F5D1} Drop', callback_data: `mg:d:${next.id}` },
    ]])
  return true
}

// --- Class recaps ------------------------------------------------------------------
// "/recap Chem 113: we covered…" → class = before the colon. Without a colon,
// the first word is the class. No summary → ask for it in reply mode.
function parseRecap(arg: string): { className: string; summary: string } {
  const colon = arg.indexOf(':')
  if (colon > 0 && colon < 40) return { className: arg.slice(0, colon).trim(), summary: arg.slice(colon + 1).trim() }
  const newline = arg.indexOf('\n')
  if (newline > 0 && newline < 40) return { className: arg.slice(0, newline).trim(), summary: arg.slice(newline + 1).trim() }
  const words = arg.split(/\s+/).filter(Boolean)
  // "/recap Chem 113" — just a class name: ask for the summary.
  if (words.length <= 3) return { className: words.join(' '), summary: '' }
  return { className: words[0], summary: words.slice(1).join(' ') }
}

const classTag = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim()

const RECAP_QUESTION_SYSTEM = `A student just dictated a quick recap of a class. Ask ONE short follow-up question
(one sentence, under 25 words) that makes them think a bit more: explain why something works, connect it to
something they already know, or apply it to an example. Use only what is in the recap. Reply with only the question.`

async function saveRecap(chatId: number | string, className: string, summary: string, messageId?: number) {
  const { data: saved, error } = await db.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content: `\u{1F4DD} Class recap (${className}): ${summary}`,
    kind: 'class_note',
    kind_set_by: 'manual',
    tags: [classTag(className)],
    metadata: { source: 'telegram', telegram_message_id: messageId, class: className, recap: true },
  }).select('id').single()
  if (error) throw error
  await reply(chatId, `\u{1F4DD} Saved to Personal (class note) · ${className}`, kindKeyboard(saved.id, 'class_note'))

  let question = ''
  const runId = await startRun(db, {
    userId: OWNER_USER_ID, agent: 'Tutor', job: 'recap-question', thoughtId: saved.id,
    task: `Ask one follow-up question on the ${className} recap`,
  })
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        systemPrompt: RECAP_QUESTION_SYSTEM,
        prompt: `Class: ${className}\nRecap: ${summary}`,
        maxTokens: 1000,
        userId: OWNER_USER_ID,
        source: 'recap-question',
        runId,
      }),
    })
    if (res.ok) question = String((await res.json()).text ?? '').trim().split('\n').find(Boolean) ?? ''
    await finishRun(db, runId, question ? { output: question } : { status: 'failed', error: `call-llm HTTP ${res.status}` })
  } catch (e) {
    console.error('recap question failed:', e)
    await finishRun(db, runId, { status: 'failed', error: String(e) })
  }
  if (question) {
    await askInReplyMode(chatId, `\u{1F914} ${question}`, 'recap_answer', saved.id,
      { class: className, question }, 'Your answer (optional)')
  }
}

// --- Takeaways ---------------------------------------------------------------
// The question is sent in reply mode: replying to it saves the takeaway.
// Ignoring it is fine — nothing else waits on it.
async function askTakeaway(chatId: number | string, thoughtId: string): Promise<void> {
  const { data: item } = await db
    .from('thoughts')
    .select('id, content, summary, section')
    .eq('id', thoughtId)
    .eq('user_id', OWNER_USER_ID)
    .maybeSingle()
  if (!item || item.section !== 'library') return
  const sent = await telegram('sendMessage', {
    chat_id: chatId,
    text: `\u{1F4A1} What's your takeaway from "${titleOf(item)}"?\nReply to this message (optional, ignore it to skip).`,
    disable_web_page_preview: true,
    reply_markup: { force_reply: true, input_field_placeholder: 'Your takeaway (optional)' },
  }) as { message_id?: number } | null
  if (!sent?.message_id) return
  const { error } = await db.from('telegram_prompts').insert({
    user_id: OWNER_USER_ID,
    chat_id: String(chatId),
    message_id: sent.message_id,
    purpose: 'takeaway',
    thought_id: thoughtId,
  })
  if (error) console.error('could not store takeaway prompt:', error.message)
}

async function saveTakeaway(chatId: number | string, itemId: string, text: string, messageId?: number) {
  const { data: item } = await db
    .from('thoughts')
    .select('id, content, summary')
    .eq('id', itemId)
    .eq('user_id', OWNER_USER_ID)
    .maybeSingle()
  if (!item) {
    await reply(chatId, 'I could not find the item this takeaway is for, so I saved it as a normal thought.')
    await confirmSaved(chatId, await saveThought(text, messageId))
    return
  }
  // The title goes into the text, so search finds the takeaway by topic too.
  const { data, error } = await db.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content: `\u{1F4A1} Takeaway on "${titleOf(item)}": ${text}`,
    kind: 'my_thought',
    kind_set_by: 'rule',
    takeaway_of: item.id,
    metadata: { source: 'telegram', telegram_message_id: messageId, takeaway_of: item.id },
  }).select('id').single()
  if (error) throw error
  await reply(chatId, `\u{1F4A1} Takeaway saved to Personal, linked to "${titleOf(item)}".`,
    [[{ text: '\u{1F4C4} Open the item', callback_data: `op:${item.id}` }]])
  return data
}

// /t_1a2b3c4d — show one thought in full. The 8 characters are the start of
// its id; ids are compared as a range because uuids can't be pattern-matched.
async function showThought(chatId: number, prefix: string): Promise<void> {
  if (!/^[0-9a-f]{8}$/i.test(prefix)) {
    await reply(chatId, 'That link looks broken.')
    return
  }
  const p = prefix.toLowerCase()
  const { data, error } = await db
    .from('thoughts')
    .select('id, content, created_at, summary, kind')
    .eq('user_id', OWNER_USER_ID)
    .gte('id', `${p}-0000-0000-0000-000000000000`)
    .lte('id', `${p}-ffff-ffff-ffff-ffffffffffff`)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    await reply(chatId, 'I could not find that thought.')
    return
  }
  const date = new Date(data.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  await showPage(chatId, data.id, data.content ?? '', 0,
    `${date}${data.kind ? ` · ${data.kind}` : ''}\n${data.summary ? `${data.summary}\n` : ''}\n`)
}

// Long thoughts are shown a page at a time, with "Show more" for the rest,
// so a long transcript never looks cut off.
const PAGE_CHARS = 3500

async function showPage(chatId: number | string, id: string, content: string, offset: number, header = ''): Promise<void> {
  let end = Math.min(content.length, offset + PAGE_CHARS)
  if (end < content.length) {
    const space = content.lastIndexOf(' ', end)
    if (space > offset + PAGE_CHARS * 0.8) end = space   // don't cut a word in half
  }
  const left = content.length - end
  const page = Math.floor(offset / PAGE_CHARS) + 1
  const pages = Math.ceil(content.length / PAGE_CHARS)
  const body = (offset ? '…' : '') + content.slice(offset, end) + (left > 0 ? '…' : '')
  const footer = left > 0 ? `\n\n(Part ${page} of about ${pages}: ${left.toLocaleString()} more characters)` : offset ? '\n\n(End.)' : ''
  await reply(chatId, `${header}${body}${footer}`,
    left > 0 ? [[{ text: '⬇️ Show more', callback_data: `mr:${id}:${end}` }]] : undefined)
}

// ---------------------------------------------------------------------------
// Button taps
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleCallback(cb: any): Promise<void> {
  const chatId = cb.message?.chat?.id
  const messageId = cb.message?.message_id
  const data: string = cb.data ?? ''
  // Anyone who is not the owner gets nothing.
  if (!chatId || String(chatId) !== OWNER_CHAT_ID) {
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    return
  }

  // Helpful / Wrong under an answer
  const fb = data.match(/^fb:([hw]):([0-9a-f-]{36})$/)
  if (fb) {
    const rating = fb[1] === 'h' ? 'helpful' : 'wrong'
    const { error } = await db.from('answer_feedback').insert({ turn_id: fb[2], user_id: OWNER_USER_ID, rating })
    await telegram('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: error ? `Could not log that: ${error.message}` : rating === 'helpful' ? 'Thanks — logged as helpful' : 'Thanks — logged as wrong',
    })
    if (!error) {
      // Show which one you picked; tapping the other still changes it.
      await telegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: rating === 'helpful' ? '✅ Helpful' : '\u{1F44D} Helpful', callback_data: `fb:h:${fb[2]}` },
            { text: rating === 'wrong' ? '✅ Wrong' : '\u{1F44E} Wrong', callback_data: `fb:w:${fb[2]}` },
          ]],
        },
      })
    }
    return
  }

  // Save it / Answer it on a message that looked like a question;
  // Save as note / Send to King on one that looked like an instruction.
  const pend = data.match(/^(sv|an|kg):([0-9a-f-]{36})$/)
  if (pend) {
    const { data: row, error } = await db
      .from('telegram_pending')
      .select('id, text, message_id, resolution, resolved_at, order_id')
      .eq('id', pend[2])
      .eq('user_id', OWNER_USER_ID)
      .maybeSingle()
    if (error || !row) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'That message has expired.' })
      return
    }
    if (row.resolution || row.resolved_at) {
      await telegram('answerCallbackQuery', {
        callback_query_id: cb.id, text: row.resolution ? `Already ${row.resolution}.` : 'Already sent to the King.',
      })
      return
    }
    // Send to King: resolved_at marks it handled (resolution stays empty,
    // order_id links the order).
    if (pend[1] === 'kg') {
      const { data: claimed } = await db.from('telegram_pending')
        .update({ resolved_at: new Date().toISOString() })
        .eq('id', row.id).is('resolution', null).is('resolved_at', null).select('id')
      if (!claimed?.length) {
        await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already handled.' })
        return
      }
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Sent to the King' })
      await telegram('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: `\u{1F451} Sent to the King: "${shorten(row.text, 200)}". Planning… (nothing runs until you approve)`,
      })
      const orderId = await sendToKing(chatId, row.text, 'button')
      if (orderId) await db.from('telegram_pending').update({ order_id: orderId }).eq('id', row.id)
      return
    }
    const resolution = pend[1] === 'sv' ? 'saved' : 'answered'
    // Claim it first, so a double tap can't save or answer twice.
    const { data: claimed } = await db
      .from('telegram_pending')
      .update({ resolution, resolved_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('resolution', null)
      .is('resolved_at', null)
      .select('id')
    if (!claimed?.length) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already handled.' })
      return
    }
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    if (resolution === 'saved') {
      const saved = await saveThought(row.text, row.message_id ?? undefined)
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: savedText(saved.kind),
        ...(sectionOf(saved.kind) ? { reply_markup: { inline_keyboard: kindKeyboard(saved.id, saved.kind) } } : {}),
      })
      if (sectionOf(saved.kind) === 'library') await askTakeaway(chatId, saved.id)
    } else {
      await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text: 'Looking in your notes…' })
      await answerQuestion(chatId, row.text)
    }
    return
  }

  // "Change kind": show every kind the owner can pick
  const menu = data.match(/^km:([0-9a-f-]{36})$/)
  if (menu) {
    const { data: row } = await db.from('thoughts').select('id, kind')
      .eq('id', menu[1]).eq('user_id', OWNER_USER_ID).maybeSingle()
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    if (!row) return
    const button = (k: string) => ({
      text: `${k === row.kind ? '✅ ' : ''}${KIND_LABEL[k]}`,
      callback_data: `k:${k}:${row.id}`,
    })
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          PICKABLE.personal.map(button).map((b) => ({ ...b, text: `\u{1F9E0} ${b.text}` })),
          PICKABLE.library.map(button).map((b) => ({ ...b, text: `\u{1F4DA} ${b.text}` })),
        ],
      },
    })
    return
  }

  // Set a kind (from the one-tap switch or the menu). The database logs the
  // change in kind_changes (old, new, when).
  const setKind = data.match(/^k:([a-z_]+):([0-9a-f-]{36})$/)
  if (setKind) {
    const [, kind, id] = setKind
    if (![...PICKABLE.personal, ...PICKABLE.library].includes(kind)) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unknown kind.' })
      return
    }
    const { data: before } = await db.from('thoughts').select('kind, takeaway_of')
      .eq('id', id).eq('user_id', OWNER_USER_ID).maybeSingle()
    if (!before) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Thought not found.' })
      return
    }
    if (before.kind === kind) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Already ${KIND_LABEL[kind]}.` })
      return
    }
    const { error } = await db.from('thoughts').update({ kind, kind_set_by: 'manual' })
      .eq('id', id).eq('user_id', OWNER_USER_ID)
    if (error) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Could not change it: ${error.message}` })
      return
    }
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Now ${KIND_LABEL[kind]}` })
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: savedText(kind).replace('Saved to', 'Moved to'),
      reply_markup: { inline_keyboard: kindKeyboard(id, kind) },
    })
    // Newly in the Library: offer a takeaway, unless it already has one.
    if (sectionOf(kind) === 'library' && sectionOf(before.kind) !== 'library') {
      const { count } = await db.from('thoughts').select('id', { count: 'exact', head: true })
        .eq('takeaway_of', id).eq('user_id', OWNER_USER_ID)
      if (!count) await askTakeaway(chatId, id)
    }
    return
  }

  // /takeaway picker: add a takeaway to this Library item
  const pick = data.match(/^tk:([0-9a-f-]{36})$/)
  if (pick) {
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    await askTakeaway(chatId, pick[1])
    return
  }

  // Junk review: Archive (status = archived, never deleted) or Keep
  const junk = data.match(/^(ar|kp):([0-9a-f-]{36})$/)
  if (junk) {
    const archive = junk[1] === 'ar'
    const { data: row } = await db.from('thoughts').select('id, content, metadata')
      .eq('id', junk[2]).eq('user_id', OWNER_USER_ID).maybeSingle()
    if (!row) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Thought not found.' })
      return
    }
    const metadata = { ...(row.metadata ?? {}), junk_review: archive ? 'archived' : 'keep', junk_reviewed_at: new Date().toISOString() }
    const { error } = await db.from('thoughts')
      .update(archive ? { status: 'archived', metadata } : { metadata })
      .eq('id', row.id).eq('user_id', OWNER_USER_ID)
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: error ? `Failed: ${error.message}` : archive ? 'Archived' : 'Kept' })
    if (!error) {
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${archive ? '\u{1F5C4} Archived (hidden, not deleted)' : '\u{1F44D} Kept'}: ${shorten(row.content, 120)}`,
      })
    }
    return
  }

  // Goals: Track creates the goal; Not a goal records the answer. Then the next.
  const goal = data.match(/^(gt|gn):([0-9a-f-]{36})$/)
  if (goal) {
    const track = goal[1] === 'gt'
    // Claim it first, so a double tap can't create two goals.
    const { data: claimed } = await db.from('goal_candidates')
      .update({ decision: track ? 'track' : 'not_goal', decided_at: new Date().toISOString() })
      .eq('id', goal[2]).eq('user_id', OWNER_USER_ID).is('decision', null)
      .select('id, text, source_thought_id')
    const c = claimed?.[0]
    if (!c) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already answered.' })
      return
    }
    if (track) {
      const { data: g, error } = await db.from('goals').insert({
        user_id: OWNER_USER_ID, text: c.text, source_thought_id: c.source_thought_id, status: 'active',
      }).select('id').single()
      if (error) {
        await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Could not save: ${error.message}` })
        await db.from('goal_candidates').update({ decision: null, decided_at: null }).eq('id', c.id)
        return
      }
      await db.from('goal_candidates').update({ goal_id: g.id }).eq('id', c.id)
    }
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: track ? 'Tracking it' : 'Noted' })
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: track ? `\u{1F3AF} Tracking: "${c.text}"` : `Not a goal: "${c.text}"`,
    })
    const more = await sendNextGoal(chatId)
    if (!more) await reply(chatId, "That's all of them. /goals shows what you're tracking.")
    return
  }

  // /mygoals review: Keep leaves it active; Pause / Drop only change status. Then the next.
  const mg = data.match(/^mg:([kpd]):([0-9a-f-]{36})$/)
  if (mg) {
    const { data: g } = await db.from('goals').select('id, text, status, confirmed_at')
      .eq('id', mg[2]).eq('user_id', OWNER_USER_ID).maybeSingle()
    if (!g) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Goal not found.' })
      return
    }
    const status = mg[1] === 'k' ? 'active' : mg[1] === 'p' ? 'paused' : 'dropped'
    if (g.status !== status) {
      const { error } = await db.from('goals').update({ status }).eq('id', g.id).eq('user_id', OWNER_USER_ID)
      if (error) {
        await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Could not save: ${error.message}` })
        return
      }
    }
    const label = status === 'active' ? '✅ Kept' : status === 'paused' ? '⏸ Paused' : '\u{1F5D1} Dropped (not deleted)'
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: label })
    await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `${label}: "${g.text}"` })
    const more = await sendNextTrackedGoal(chatId, g)
    if (!more) {
      const { data: all } = await db.from('goals').select('status').eq('user_id', OWNER_USER_ID)
      const n = (s: string) => (all ?? []).filter((x) => x.status === s).length
      await reply(chatId, `Done. Active: ${n('active')}, paused: ${n('paused')}, dropped: ${n('dropped')}. ` +
        'Nothing was deleted. /goals lists the active ones.')
    }
    return
  }

  // Orders: Approve / Edit / Cancel a plan, Go on / Stop at the cost cap,
  // Save as report under a result. The crew function does the work.
  const ko = data.match(/^ko:([aecgxs]):([0-9a-f-]{36})$/)
  if (ko) {
    const [, button, orderId] = ko
    if (button === 'e') {
      const { data: order } = await db.from('orders').select('id, status, request')
        .eq('id', orderId).eq('user_id', OWNER_USER_ID).maybeSingle()
      if (!order || order.status !== 'awaiting_approval') {
        await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: order ? `Already ${order.status.replace(/_/g, ' ')}.` : 'Order not found.' })
        return
      }
      await telegram('answerCallbackQuery', { callback_query_id: cb.id })
      const sent = await telegram('sendMessage', {
        chat_id: chatId,
        text: `✏️ Reply to this message with the changed order. The King will make a new plan.\n\nWas: "${shorten(order.request, 300)}"`,
        reply_markup: { force_reply: true, input_field_placeholder: 'The changed order' },
      }) as { message_id?: number } | null
      if (sent?.message_id) {
        await db.from('orders').update({ edit_prompt_message_id: sent.message_id, updated_at: new Date().toISOString() })
          .eq('id', orderId).eq('user_id', OWNER_USER_ID)
      }
      return
    }
    let res: Record<string, unknown>
    try {
      res = await crew({ action: 'button', order_id: orderId, button })
    } catch (e) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Failed: ${e instanceof Error ? e.message : e}`.slice(0, 190) })
      return
    }
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: String(res.toast ?? '').slice(0, 190) })
    if (res.ok && typeof res.text === 'string') {
      await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text: res.text.slice(0, 4000), disable_web_page_preview: true })
    } else if (res.ok && res.keepText) {
      await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    }
    if (typeof res.reply === 'string') await reply(chatId, res.reply)
    return
  }

  // The Fixer's proposal: Approve applies exactly the listed changes.
  const fx = data.match(/^fx:([an]):([0-9a-f-]{36})$/)
  if (fx) {
    // Take the buttons away first, so the proposal can't be tapped twice.
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    let res: Record<string, unknown>
    try {
      res = await crew({ action: 'fixer', run_id: fx[2], approve: fx[1] === 'a' })
    } catch (e) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Failed: ${e instanceof Error ? e.message : e}`.slice(0, 190) })
      return
    }
    await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: String(res.toast ?? '').slice(0, 190) })
    if (res.ok && typeof res.text === 'string') {
      await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text: res.text.slice(0, 4000), disable_web_page_preview: true })
    }
    return
  }

  // "Show more" under a long thought
  const more = data.match(/^mr:([0-9a-f-]{36}):(\d{1,7})$/)
  if (more) {
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    const { data: row } = await db.from('thoughts').select('id, content')
      .eq('id', more[1]).eq('user_id', OWNER_USER_ID).maybeSingle()
    if (!row) return
    // The button has done its job; the next page carries its own.
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    await showPage(chatId, row.id, row.content ?? '', Math.min(Number(more[2]), (row.content ?? '').length))
    return
  }

  // "Open the item" under a saved takeaway
  const open = data.match(/^op:([0-9a-f-]{36})$/)
  if (open) {
    await telegram('answerCallbackQuery', { callback_query_id: cb.id })
    await showThought(chatId, open[1].slice(0, 8))
    return
  }

  await telegram('answerCallbackQuery', { callback_query_id: cb.id })
}

// ---------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  // Internal calls (need the internal secret):
  //   {action: "ask_takeaway", thought_id} — enrich-thought saved a new Library
  //     item: confirm its section and ask for a takeaway.
  //   anything else — (re)register this function as the bot's webhook, with
  //     the secret token and the update types we handle.
  if (req.headers.get(INTERNAL_HEADER)) {
    const denied = rejectUnlessInternal(req)
    if (denied) return denied
    const body = await req.json().catch(() => ({}))
    const jsonReply = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (body?.action && (!OWNER_CHAT_ID || !OWNER_USER_ID)) return jsonReply({ error: 'owner not configured' }, 500)

    // Fill one bare-link thought (keeps its id). Quiet: only asks the owner
    // when it needs them (a search link, or a page that can't be read).
    if (body?.action === 'fix_link' && typeof body.thought_id === 'string') {
      const { data: row } = await db.from('thoughts').select('id, content')
        .eq('id', body.thought_id).eq('user_id', OWNER_USER_ID).maybeSingle()
      if (!row) return jsonReply({ ok: false, error: 'not found' }, 404)
      const url = String(row.content ?? '').trim()
      if (!BARE_LINK.test(url)) return jsonReply({ ok: false, error: 'not a bare link' }, 400)
      const result = await processLink(OWNER_CHAT_ID, row.id, url, { quiet: true })
      return jsonReply({ ok: true, id: row.id, url, result })
    }

    // A message to the owner from our own jobs ("chunking is stuck", the
    // crew's plans and results). Only ever to the owner's chat. Long texts
    // are split; buttons (inline keyboard) go under the last part.
    if (body?.action === 'notify' && typeof body.text === 'string' && body.text.trim()) {
      const keyboard = Array.isArray(body.keyboard) ? cleanKeyboard(body.keyboard) : undefined
      const messageId = await sendLong(OWNER_CHAT_ID, body.text.slice(0, 16000), keyboard)
      return jsonReply({ ok: true, message_id: messageId })
    }

    // List junk candidates in Telegram, each with Archive / Keep.
    if (body?.action === 'review_junk') {
      const junk = await findJunk()
      if (junk.length) {
        await reply(OWNER_CHAT_ID, `\u{1F9F9} ${junk.length} saved message(s) look like tests or mistyped commands. Archive hides them (nothing is deleted).`)
        for (const t of junk) await reply(OWNER_CHAT_ID, shorten(t.content, 300), junkKeyboard(t.id))
      }
      return jsonReply({ ok: true, candidates: junk.map((t) => ({ id: t.id, content: shorten(t.content, 80) })) })
    }

    // Propose goals from voice notes, then send the first for Track / Not a goal.
    if (body?.action === 'propose_goals') {
      const added = await proposeGoals()
      const sent = await sendNextGoal(OWNER_CHAT_ID)
      if (sent) await reply(OWNER_CHAT_ID, 'I read your voice notes for goals you stated. Answer each one; nothing is tracked unless you tap Track.')
      return jsonReply({ ok: true, proposed: added, first_sent: sent })
    }

    if (body?.action === 'ask_takeaway' && typeof body.thought_id === 'string') {
      if (!OWNER_CHAT_ID || !OWNER_USER_ID) return new Response('owner not configured', { status: 500 })
      const { data: row } = await db.from('thoughts').select('id, kind, content, summary')
        .eq('id', body.thought_id).eq('user_id', OWNER_USER_ID).maybeSingle()
      if (!row) return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
      await reply(OWNER_CHAT_ID, `${savedText(row.kind)}: ${titleOf(row)}`, kindKeyboard(row.id, row.kind))
      await askTakeaway(OWNER_CHAT_ID, row.id)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (!WEBHOOK_SECRET) return new Response('TELEGRAM_WEBHOOK_SECRET is not set', { status: 500 })
    const result = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${SUPABASE_URL}/functions/v1/telegram-bot`,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      }),
    }).then((r) => r.json())
    const info = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`).then((r) => r.json())
    // Never echo the token or secret back.
    const w = info?.result ?? {}
    return new Response(JSON.stringify({
      setWebhook: result?.ok === true, description: result?.description,
      url: w.url, allowed_updates: w.allowed_updates, pending_update_count: w.pending_update_count,
      last_error_message: w.last_error_message ?? null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  // Only Telegram knows the secret token. Fails closed if it isn't set.
  const telegramToken = (req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '').trim()
  if (!WEBHOOK_SECRET || !telegramToken || !safeEqual(telegramToken, WEBHOOK_SECRET)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let chatId: number | undefined

  try {
    const update = await req.json()

    if (update?.callback_query) {
      if (OWNER_USER_ID) later(handleCallback(update.callback_query))
      return ok()
    }

    const msg = update?.message
    if (!msg?.chat?.id) return ok() // not a normal message, ignore it
    chatId = msg.chat.id as number

    // Who is knocking? Until TELEGRAM_CHAT_ID is set, do nothing except
    // tell the sender their chat number so the owner can lock the bot.
    if (!OWNER_CHAT_ID) {
      await reply(
        chatId,
        `Setup needed. Your chat ID is ${chatId}\n\n` +
          'Add it in Supabase as a secret named TELEGRAM_CHAT_ID, then message me again.',
      )
      return ok()
    }
    // Anyone who is not the owner gets no reply at all.
    if (String(chatId) !== OWNER_CHAT_ID) return ok()

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup problem: the OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    const text = (msg.text ?? '').trim()
    if (!text) {
      await reply(chatId, 'I can only read text messages for now. Tip: use the microphone key on your keyboard to dictate.')
      return ok()
    }

    // A reply to one of the bot's reply-mode questions goes where it belongs.
    // A reply that starts with "/" is a command: it is run as one and is
    // NEVER saved as a takeaway (or anything else); the question stays open.
    const repliedTo = msg.reply_to_message?.message_id
    let keptOpen = false
    if (repliedTo && text.startsWith('/')) {
      const { count: prompts } = await db.from('telegram_prompts').select('id', { count: 'exact', head: true })
        .eq('chat_id', String(chatId)).eq('message_id', repliedTo).is('resolved_at', null)
      const { count: edits } = await db.from('orders').select('id', { count: 'exact', head: true })
        .eq('user_id', OWNER_USER_ID).eq('edit_prompt_message_id', repliedTo).eq('status', 'awaiting_approval')
      keptOpen = Boolean(prompts || edits)
    }
    if (repliedTo && !text.startsWith('/')) {
      // "Edit" on a plan: the reply is the changed order.
      const { data: edited } = await db.from('orders').select('id, status')
        .eq('user_id', OWNER_USER_ID).eq('edit_prompt_message_id', repliedTo).maybeSingle()
      if (edited) {
        if (edited.status !== 'awaiting_approval') {
          await reply(chatId, `That order is already ${edited.status.replace(/_/g, ' ')}. Send /king with a new order instead.`)
          return ok()
        }
        await reply(chatId, '\u{1F451} Got it. Making a new plan…')
        const to = chatId
        later(crew({ action: 'edit', order_id: edited.id, text }).then(async (res) => {
          if (!res.ok && res.error) await reply(to, `\u{1F451} I couldn't plan that: ${res.error}`)
        }))
        return ok()
      }
    }
    if (repliedTo && !text.startsWith('/')) {
      const { data: prompt } = await db
        .from('telegram_prompts')
        .select('id, purpose, thought_id, data')
        .eq('chat_id', String(chatId))
        .eq('message_id', repliedTo)
        .maybeSingle()
      if (prompt) {
        const pdata = (prompt.data ?? {}) as Record<string, string>
        const resolve = () => db.from('telegram_prompts').update({ resolved_at: new Date().toISOString() })
          .eq('id', prompt.id).is('resolved_at', null)
        if (prompt.purpose === 'takeaway' && prompt.thought_id) {
          await saveTakeaway(chatId, prompt.thought_id, text, msg.message_id)
          await resolve()
          return ok()
        }
        if (prompt.purpose === 'replace_link' && prompt.thought_id) {
          await resolve()
          later(replaceLinkContent(chatId, prompt.thought_id, text, pdata.original ?? ''))
          return ok()
        }
        if (prompt.purpose === 'recap') {
          await resolve()
          later(saveRecap(chatId, pdata.class ?? 'class', text, msg.message_id))
          return ok()
        }
        if (prompt.purpose === 'recap_answer') {
          const className = pdata.class ?? 'class'
          const { data: saved, error } = await db.from('thoughts').insert({
            user_id: OWNER_USER_ID,
            content: `\u{1F4DD} Recap follow-up (${className})\nQ: ${pdata.question ?? ''}\nA: ${text}`,
            kind: 'class_note',
            kind_set_by: 'manual',
            tags: [classTag(className)],
            metadata: { source: 'telegram', class: className, recap_of: prompt.thought_id, telegram_message_id: msg.message_id },
          }).select('id').single()
          if (error) throw error
          await resolve()
          await reply(chatId, `\u{1F4DD} Saved your answer to Personal (class note) · ${className}`, kindKeyboard(saved.id, 'class_note'))
          return ok()
        }
      }
    }

    // Commands look like "/search cats" or "/search@mybot cats". A space
    // after the slash ("/ search cats") is forgiven. Anything that starts
    // with "/" is treated as a command and is NEVER saved as a thought.
    const match = text.match(/^\/\s*(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
    const command = match?.[1]?.toLowerCase()
    const argument = (match?.[2] ?? '').trim()
    if (text.startsWith('/') && !command) {
      await reply(chatId, `That looks like a command, but I couldn't read it, so I didn't save it.\n\n${HELP}`)
      return ok()
    }

    // Ran a command in reply to an open question: say the question still waits.
    if (keptOpen) {
      later((async () => {
        await new Promise((r) => setTimeout(r, 1500))   // after the command's own answer
        await reply(chatId, '(That was a command, so I ran it and saved nothing. Your earlier question is still open: reply to it when you\'re ready.)')
      })())
    }

    if (command === 'start' || command === 'help') {
      await reply(chatId, HELP)
      return ok()
    }

    if (command?.startsWith('t_')) {
      await showThought(chatId, command.slice(2))
      return ok()
    }

    // /king order: the King plans it and sends Approve / Edit / Cancel.
    if (command === 'king') {
      if (!argument) {
        await reply(chatId, 'Give the King an order, like: /king make me a 3-day study plan for Chem 113 with quiz questions')
        return ok()
      }
      await reply(chatId, '\u{1F451} Planning… (nothing runs until you approve the plan)')
      later(sendToKing(chatId, argument, 'telegram'))
      return ok()
    }

    // /orders: the last 10 orders. /o_1a2b3c4d: one order, step by step.
    if (command === 'orders' || command?.startsWith('o_')) {
      const res = command === 'orders'
        ? await crew({ action: 'list' })
        : await crew({ action: 'show', order: command.slice(2), style: 'telegram' })
      await sendLong(chatId, String(res.text ?? res.error ?? 'Nothing to show.'))
      return ok()
    }

    // /recap Chem 113: what we covered…
    if (command === 'recap') {
      const { className, summary } = parseRecap(argument)
      if (!className) {
        await reply(chatId, 'Tell me the class, like: /recap Chem 113: today we covered…')
        return ok()
      }
      if (!summary) {
        await askInReplyMode(chatId, `\u{1F4DD} Recap for ${className}: reply with what you covered.`, 'recap', null,
          { class: className }, 'What did you cover?')
        return ok()
      }
      later(saveRecap(chatId, className, summary, msg.message_id))
      return ok()
    }

    // /goals: what you're tracking (goals only exist after you tapped Track)
    if (command === 'goals') {
      const { data, error } = await db.from('goals').select('text, source_thought_id, confirmed_at')
        .eq('user_id', OWNER_USER_ID).eq('status', 'active').order('confirmed_at')
      if (error) throw error
      const pending = await sendNextGoal(chatId)
      await reply(chatId, data?.length
        ? '\u{1F3AF} Goals you are tracking:\n\n' + data.map((g, i) =>
          `${i + 1}. ${g.text}${g.source_thought_id ? `  /t_${g.source_thought_id.slice(0, 8)}` : ''}`).join('\n')
        : pending ? 'No goals tracked yet. Answer the question above.' : 'No goals tracked yet.')
      return ok()
    }

    // /mygoals: review tracked goals one at a time (Keep / Pause / Drop)
    if (command === 'mygoals') {
      const sent = await sendNextTrackedGoal(chatId)
      if (!sent) await reply(chatId, 'No active goals to review. /goals shows proposals waiting for an answer.')
      return ok()
    }

    if (command === 'new') {
      const n = await clearHistory(db, OWNER_USER_ID, String(chatId))
      await reply(chatId, n ? 'Fresh start — I forgot our conversation.' : 'Fresh start.')
      return ok()
    }

    if (command === 'recent') {
      const { data, error } = await db
        .from('thoughts')
        .select('content, created_at, kind')
        .eq('user_id', OWNER_USER_ID)
        .or('status.is.null,status.neq.archived')
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId,
        data && data.length
          ? 'Your last thoughts:\n\n' + formatList(data)
          : 'Your brain is empty so far. Send me a thought.',
      )
      return ok()
    }

    // /search = both sections (each result labelled), /me = Personal, /lib = Library
    if (command === 'search' || command === 'me' || command === 'lib') {
      const section = command === 'me' ? 'personal' : command === 'lib' ? 'library' : null
      const where = section ? ` in ${SECTION_LABEL[section]}` : ''
      if (!argument) {
        await reply(chatId, `Tell me what to look for, like: /${command} coffee`)
        return ok()
      }
      const data = await searchBrain(argument, section)
      await reply(
        chatId,
        data && data.length
          ? `Found${where} for "${argument}":\n\n` + formatList(data)
          : `Nothing found${where} for "${argument}".`,
      )
      return ok()
    }

    // /takeaway words: pick a Library item, then reply with your takeaway.
    // /takeaway alone: your latest Library items without a takeaway.
    if (command === 'takeaway') {
      let items: ListRow[]
      if (argument) {
        items = await searchBrain(argument, 'library')
      } else {
        const { data: withTakeaway } = await db.from('thoughts').select('takeaway_of')
          .eq('user_id', OWNER_USER_ID).not('takeaway_of', 'is', null)
        const done = new Set((withTakeaway ?? []).map((r) => r.takeaway_of))
        const { data, error } = await db.from('thoughts').select('id, content, created_at, kind, summary')
          .eq('user_id', OWNER_USER_ID).eq('section', 'library')
          .order('created_at', { ascending: false }).limit(20)
        if (error) throw error
        items = (data ?? []).filter((r) => !done.has(r.id)).slice(0, 5)
      }
      if (!items.length) {
        await reply(chatId, argument ? `No Library item matches "${argument}".` : 'Every Library item already has a takeaway.')
        return ok()
      }
      await reply(chatId, 'Which item is your takeaway for?', items.filter((r) => r.id).map((r) => [{
        text: titleOf(r).slice(0, 60),
        callback_data: `tk:${r.id}`,
      }]))
      return ok()
    }

    if (command === 'ask' || text.startsWith('?')) {
      const question = command === 'ask' ? argument : text.slice(1).trim()
      if (!question) {
        await reply(chatId, 'Ask me something, like: ? what did I decide about my sleep schedule')
        return ok()
      }
      later(answerQuestion(chatId, question))
      return ok()
    }

    if (command) {
      await reply(chatId, `I do not know the command /${command}.\n\n${HELP}`)
      return ok()
    }

    // Reads like an instruction to the bot ("Delete that", "Look up the
    // videos and add them")? It's not a note: Save as note / Send to King.
    if (looksLikeInstruction(text) && !BARE_LINK.test(text)) {
      const { data: pending, error } = await db
        .from('telegram_pending')
        .insert({ user_id: OWNER_USER_ID, chat_id: String(chatId), message_id: msg.message_id, text })
        .select('id')
        .single()
      if (!error && pending) {
        await reply(chatId, 'That sounds like an instruction, not a note. Save it as a note, or send it to the King (you approve his plan first)?', [[
          { text: '\u{1F4BE} Save as note', callback_data: `sv:${pending.id}` },
          { text: '\u{1F451} Send to King', callback_data: `kg:${pending.id}` },
        ]])
        return ok()
      }
      console.error('pending insert failed, saving instead:', error?.message)
    }

    // Reads like a question? Ask before saving — and keep it until you tap.
    if (looksLikeQuestion(text)) {
      const { data: pending, error } = await db
        .from('telegram_pending')
        .insert({ user_id: OWNER_USER_ID, chat_id: String(chatId), message_id: msg.message_id, text })
        .select('id')
        .single()
      if (!error && pending) {
        await reply(chatId, 'Save this as a thought, or answer it from your notes?', [[
          { text: '\u{1F4BE} Save it', callback_data: `sv:${pending.id}` },
          { text: '\u{1F50E} Answer it', callback_data: `an:${pending.id}` },
        ]])
        return ok()
      }
      // If the buttons can't be offered, fall through and save — never drop it.
      console.error('pending insert failed, saving instead:', error?.message)
    }

    // A bare link: save it, then read it (transcript / article / PDF) into
    // the same thought. If nothing readable comes back, say so and ask.
    if (BARE_LINK.test(text)) {
      const saved = await saveThought(text, msg.message_id)
      if (!YT_SEARCH.test(text)) await reply(chatId, '\u{1F517} Saved the link. Reading it now…')
      later(processLink(chatId, saved.id, text))
      return ok()
    }

    // Anything else: save it as a new thought that belongs to the owner.
    // The confirmation names the section, with a one-tap switch.
    await confirmSaved(chatId, await saveThought(text, msg.message_id))
    return ok()
  } catch (err) {
    console.error('telegram-bot error:', err)
    const detail = (err as { message?: string })?.message ?? String(err)
    if (chatId && String(chatId) === OWNER_CHAT_ID) {
      await reply(chatId, `Something went wrong: ${detail}`)
    }
    return ok()
  }
})
