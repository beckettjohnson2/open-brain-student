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

// Secrets. The first three are ones you added; the SUPABASE_ ones are
// provided automatically by Supabase.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const OWNER_CHAT_ID = (Deno.env.get('TELEGRAM_CHAT_ID') ?? '').trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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

// Meaning + keyword search over the owner's thoughts, best first.
// Falls back to the old keyword search if anything goes wrong.
async function searchBrain(query: string) {
  try {
    const vector = await embedder.run(query, { mean_pool: true, normalize: true })
    const { data, error } = await db.rpc('hybrid_search', {
      query_embedding: JSON.stringify(Array.from(vector as number[])),
      query_text: query,
      match_count: 5,
      p_user_id: OWNER_USER_ID,
      min_similarity: 0.78,
    })
    if (error) throw error
    return data as { content: string; created_at: string }[]
  } catch (err) {
    console.error('hybrid search failed, using keyword search:', err)
    // Treat % and _ as plain characters, not wildcards
    const safe = query.replace(/[\\%_]/g, '\\$&')
    const { data, error } = await db
      .from('thoughts')
      .select('content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .ilike('content', `%${safe}%`)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) throw error
    return data
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

function formatList(rows: { content: string; created_at?: string }[]): string {
  return rows
    .map((row, i) => {
      const date = row.created_at
        ? new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : ''
      return `${i + 1}. ${date ? `[${date}] ` : ''}${shorten(row.content)}`
    })
    .join('\n\n')
}

const HELP =
  'Your Open Brain is listening.\n\n' +
  'Send any message to save it as a thought.\n' +
  '? question (or /ask question) to get an answer from your notes\n' +
  '/new to start a fresh conversation (forget follow-ups)\n' +
  '/search words to list matching thoughts\n' +
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

async function answerQuestion(chatId: number, question: string): Promise<void> {
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

async function saveThought(text: string, messageId?: number) {
  const { error } = await db.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content: text,
    metadata: { source: 'telegram', telegram_message_id: messageId },
  })
  if (error) throw error
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
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: resolution === 'saved' ? 'Saved to your brain' : 'Looking in your notes…',
    })
    if (resolution === 'saved') {
      await saveThought(row.text, row.message_id ?? undefined)
    } else {
      await answerQuestion(chatId, row.text)
    }
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
        .select('content, created_at')
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

    if (command === 'search') {
      if (!argument) {
        await reply(chatId, 'Tell me what to look for, like: /search coffee')
        return ok()
      }
      const data = await searchBrain(argument)
      await reply(
        chatId,
        data && data.length
          ? `Found in your brain for "${argument}":\n\n` + formatList(data)
          : `Nothing found for "${argument}".`,
      )
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
    await saveThought(text, msg.message_id)
    await reply(chatId, 'Saved to your brain')
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
