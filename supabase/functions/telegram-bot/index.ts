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
//
// Buttons are inline keyboards; taps arrive as callback_query updates.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { askBrain, clearHistory, renderAnswer } from '../_shared/ask.ts'
import { INTERNAL_HEADER, rejectUnlessInternal, safeEqual } from '../_shared/internal-auth.ts'
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
      query_text: query,
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
  '/recent to see your last 5 thoughts'

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
  const content: string = data.content ?? ''
  const MAX = 3500
  const body = content.length > MAX
    ? content.slice(0, MAX) + `\n\n… (${content.length - MAX} more characters — the full text is in the web app)`
    : content
  await reply(chatId, `${date}${data.kind ? ` · ${data.kind}` : ''}\n${data.summary ? `${data.summary}\n` : ''}\n${body}`)
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

  // Save it / Answer it on a message that looked like a question
  const pend = data.match(/^(sv|an):([0-9a-f-]{36})$/)
  if (pend) {
    const { data: row, error } = await db
      .from('telegram_pending')
      .select('id, text, message_id, resolution')
      .eq('id', pend[2])
      .eq('user_id', OWNER_USER_ID)
      .maybeSingle()
    if (error || !row) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'That message has expired.' })
      return
    }
    if (row.resolution) {
      await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: `Already ${row.resolution}.` })
      return
    }
    const resolution = pend[1] === 'sv' ? 'saved' : 'answered'
    // Claim it first, so a double tap can't save or answer twice.
    const { data: claimed } = await db
      .from('telegram_pending')
      .update({ resolution, resolved_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('resolution', null)
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

    // A reply to a "What's your takeaway?" question is that takeaway.
    const repliedTo = msg.reply_to_message?.message_id
    if (repliedTo) {
      const { data: prompt } = await db
        .from('telegram_prompts')
        .select('id, thought_id')
        .eq('chat_id', String(chatId))
        .eq('message_id', repliedTo)
        .eq('purpose', 'takeaway')
        .maybeSingle()
      if (prompt?.thought_id) {
        await saveTakeaway(chatId, prompt.thought_id, text, msg.message_id)
        await db.from('telegram_prompts').update({ resolved_at: new Date().toISOString() })
          .eq('id', prompt.id).is('resolved_at', null)
        return ok()
      }
    }

    // Commands look like "/search cats" or "/search@mybot cats"
    const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
    const command = match?.[1]?.toLowerCase()
    const argument = (match?.[2] ?? '').trim()

    if (command === 'start' || command === 'help') {
      await reply(chatId, HELP)
      return ok()
    }

    if (command?.startsWith('t_')) {
      await showThought(chatId, command.slice(2))
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
