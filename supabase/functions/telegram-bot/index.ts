// supabase/functions/telegram-bot/index.ts
// Telegram calls this function every time someone messages your bot.
// It saves the message to your thoughts table, or searches it.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Secrets. The first three are ones you added; the SUPABASE_ ones are
// provided automatically by Supabase.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const OWNER_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
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

// Always answer Telegram with 200, or it will keep re-sending the message.
function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Send a reply back to the chat.
async function reply(chatId: number, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000), // Telegram's limit is 4096 characters
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) console.error('sendMessage failed:', res.status, await res.text())
  } catch (err) {
    console.error('sendMessage error:', err)
  }
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
  '/search words (or ? words) to search your brain\n' +
  '/recent to see your last 5 thoughts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined

  try {
    const update = await req.json()
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
    if (String(chatId) !== OWNER_CHAT_ID.trim()) return ok()

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup problem: the OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    const text = (msg.text ?? '').trim()
    if (!text) {
      await reply(chatId, 'I can only save text messages for now.')
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

    if (command === 'search' || text.startsWith('?')) {
      const query = command === 'search' ? argument : text.slice(1).trim()
      if (!query) {
        await reply(chatId, 'Tell me what to look for, like: /search coffee')
        return ok()
      }
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
      await reply(
        chatId,
        data && data.length
          ? `Found in your brain for "${query}":\n\n` + formatList(data)
          : `Nothing found for "${query}".`,
      )
      return ok()
    }

    if (command) {
      await reply(chatId, `I do not know the command /${command}.\n\n${HELP}`)
      return ok()
    }

    // Anything else: save it as a new thought that belongs to the owner.
    const { error } = await db.from('thoughts').insert({
      user_id: OWNER_USER_ID,
            content: text,
      metadata: { source: 'telegram', telegram_message_id: msg.message_id },
    })
    if (error) throw error

    await reply(chatId, 'Saved to your brain')
    return ok()
  } catch (err) {
    console.error('telegram-bot error:', err)
    const detail = (err as { message?: string })?.message ?? String(err)
    if (chatId && String(chatId) === OWNER_CHAT_ID.trim()) {
      await reply(chatId, `Something went wrong: ${detail}`)
    }
    return ok()
  }
})