// supabase/functions/capture-url/index.ts
//
// You give it a link. It fetches the page HERE, on the server, pulls out the
// readable text, and saves it to your thoughts table.
//
// Why this could not be done in Level 2: a web page in your browser is not
// allowed to read other websites (a browser rule called CORS). A server has
// no such rule, so the fetching moved to where it is allowed.
//
// What it does NOT do yet: summarise. That needs an AI key you get in Level 5.
// For now it saves the article's own text, which is exactly what your search
// needs.

import { createClient } from 'npm:@supabase/supabase-js@2'

// All three are provided automatically by Supabase. You never add them.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_PAGE_BYTES = 3_000_000 // stop reading a page after 3 MB
const MAX_TEXT_CHARS = 200_000 // the most article text we keep
const MIN_TEXT_CHARS = 200 // less than this usually means "no article here"
const MAX_REDIRECTS = 5

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// An error we want the person to read, with the HTTP status to send.
class Problem extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Which addresses the server refuses to visit.
// Without this, someone could ask your server to read addresses that only
// exist inside a private network. Only public websites are allowed.
// ---------------------------------------------------------------------------
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return true
  if (host.includes(':')) return true // a raw IPv6 address
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (!host.includes('.')) return true // a bare machine name

  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ip) {
    const a = Number(ip[1])
    const b = Number(ip[2])
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

function checkUrl(input: string): URL {
  let raw = (input ?? '').trim()
  if (!raw) throw new Problem(400, 'Paste a link first.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Problem(400, 'That does not look like a web link.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Problem(400, 'Only http and https links can be captured.')
  }
  if (isBlockedHost(url.hostname)) {
    throw new Problem(400, 'That address is not a public website.')
  }
  return url
}

// Fetch the page, following redirects ourselves so every hop gets checked.
async function fetchPage(start: URL): Promise<{ res: Response; finalUrl: URL }> {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response
    try {
      res = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Problem(504, 'That website took too long to answer.')
      }
      throw new Problem(502, 'Could not reach that website.')
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await res.body?.cancel()
      if (!location) throw new Problem(502, 'That website sent a redirect with no destination.')
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new Problem(502, 'That website sent a redirect that could not be followed.')
      }
      current = checkUrl(next.href)
      continue
    }
    return { res, finalUrl: current }
  }
  throw new Problem(502, 'That link redirected too many times.')
}

// Read the page body, but never more than MAX_PAGE_BYTES of it.
async function readLimited(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  while (total < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const room = MAX_PAGE_BYTES - total
    const piece = value.length > room ? value.subarray(0, room) : value
    parts.push(piece)
    total += piece.length
  }
  try {
    await reader.cancel()
  } catch { /* already finished */ }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1]
  // Some pages only say their encoding inside the HTML itself.
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048))
  const fromMeta = head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1]
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue
    try {
      return new TextDecoder(label).decode(bytes)
    } catch { /* unknown encoding name, try the next one */ }
  }
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------------------
// Turning a web page into readable text.
// ---------------------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iexcl: '¡', iquest: '¿',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code: string) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return whole
      try {
        return String.fromCodePoint(n)
      } catch {
        return whole
      }
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    .replace(/&amp;/g, '&') // last on purpose, so "&amp;lt;" becomes "&lt;" and not "<"
}

function stripTags(html: string): string {
  const text = html
    // tags that start a new line when a person reads the page
    .replace(/<\/?(p|div|section|article|main|h[1-6]|li|ul|ol|tr|table|blockquote|pre|br|hr|dd|dt|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function longestBlock(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  let best = ''
  for (const match of html.matchAll(pattern)) {
    if (match[1].length > best.length) best = match[1]
  }
  return best
}

function htmlToText(html: string): string {
  // 1. Throw away everything that is never article text.
  let page = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select|button|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  // 2. Prefer the part the site itself marks as the article.
  const body = longestBlock(page, 'body') || page
  let chosen = body
  for (const tag of ['article', 'main']) {
    const block = longestBlock(body, tag)
    if (block && stripTags(block).length >= 500) {
      chosen = block
      break
    }
  }

  // 3. Drop menus, sidebars and footers from what is left.
  page = chosen.replace(/<(nav|aside|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  return stripTags(page)
}

function pageTitle(html: string): string {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of metaTags) {
    if (/(property|name)=["'](og:title|twitter:title)["']/i.test(tag)) {
      const content = tag.match(/content=("([^"]*)"|'([^']*)')/i)
      const value = (content?.[2] ?? content?.[3] ?? '').trim()
      if (value) return decodeEntities(value).replace(/\s+/g, ' ').trim()
    }
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  return decodeEntities(title.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// The function itself.
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  try {
    // Who is asking? Read it from their login token. A user id sent in the
    // request body is never trusted, because anyone could type anyone's id.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!token) throw new Problem(401, 'Sign in first.')
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { data: auth, error: authError } = await asCaller.auth.getUser(token)
    const user = auth?.user
    if (authError || !user) throw new Problem(401, 'Sign in first.')

    let body: { url?: unknown } = {}
    try {
      body = await req.json()
    } catch { /* an empty or broken body is handled as "no link" below */ }
    const url = checkUrl(typeof body.url === 'string' ? body.url : '')

    const { res, finalUrl } = await fetchPage(url)
    if (!res.ok) {
      await res.body?.cancel()
      throw new Problem(422, `That website refused the request (it answered ${res.status}).`)
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('application/pdf')) {
      await res.body?.cancel()
      throw new Problem(422, 'That link is a PDF. Download it and use the PDF tab.')
    }
    const isHtml = contentType.includes('html')
    const isPlain = contentType.startsWith('text/plain')
    if (contentType && !isHtml && !isPlain) {
      await res.body?.cancel()
      throw new Problem(422, 'That link is not a readable web page.')
    }

    const raw = decodeBytes(await readLimited(res), contentType)
    let title = ''
    let text = ''
    if (isPlain) {
      text = raw.replace(/\r\n/g, '\n').trim()
    } else {
      title = pageTitle(raw)
      text = htmlToText(raw)
    }

    if (text.length < MIN_TEXT_CHARS) {
      throw new Problem(
        422,
        'Could not find readable text on that page. It may need a login, or it builds itself with JavaScript. You can still paste the text by hand.',
      )
    }

    const truncated = text.length > MAX_TEXT_CHARS
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS)

    // Save with the service role key. That key skips your Level 2 security
    // rule, so user_id is set here by hand on every row.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const link = finalUrl.href
    const content = `\u{1F517} URL: ${title ? title + '\n' : ''}${link}\n\n${text}`

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: { source: 'url', title, url: link },
      })
      .select('id')
      .single()
    if (insertError || !thought) throw insertError ?? new Error('The thought was not saved.')

    // The full text also goes in thought_sources, the same as Level 2 did.
    // If this part fails the thought is already saved, so it only logs.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated,
    })
    if (sourceError) console.warn('thought_sources insert failed:', sourceError.message)

    return json({ ok: true, id: thought.id, title, url: link, chars: text.length, truncated })
  } catch (err) {
    if (err instanceof Problem) return json({ error: err.message }, err.status)
    console.error('capture-url error:', err)
    const detail = (err as { message?: string })?.message ?? String(err)
    return json({ error: `Something went wrong: ${detail}` }, 500)
  }
})
