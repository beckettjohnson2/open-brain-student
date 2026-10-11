// supabase/functions/capture-youtube/index.ts
//
// You give it a YouTube link. It fetches what was SAID in the video and saves
// it to your thoughts table.
//
// Why this file looks more complicated than the others
// -----------------------------------------------------
// YouTube does not want programs reading its subtitles. When a request comes
// from a data centre (which is what a Supabase function is), YouTube serves a
// stripped-down page with the captions removed. There is no single reliable
// way around that, so this function tries three routes in order and uses the
// first one that works:
//
//   1. Supadata   - a transcript service that fetches from a home internet
//                   connection. Used only if you added SUPADATA_API_KEY.
//   2. Innertube  - the private address YouTube's own phone apps talk to.
//                   We introduce ourselves as the iPhone app, then the
//                   Android app, because those still get caption links.
//   3. Description - if nothing above works, we save the video's written
//                   description instead, and say so clearly in the thought.
//
// Real code often looks like this: not because the idea is hard, but because
// the outside world is unreliable and you need a plan B and a plan C.
//
// What it does NOT do yet: summarise. That needs an AI key you get in Level 5.

import { createClient } from 'npm:@supabase/supabase-js@2'

// The three SUPABASE_ values are provided automatically. You never add them.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SUPADATA_API_KEY = (Deno.env.get('SUPADATA_API_KEY') ?? '').trim()

const MAX_TEXT_CHARS = 400_000 // roughly a seven-hour video

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function tidy(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // last on purpose
}

// Accepts every common shape of YouTube link, or a bare 11-character video id.
function youTubeId(input: string): string {
  const raw = (input ?? '').trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw
  let candidate = raw
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate
  try {
    const u = new URL(candidate)
    const host = u.hostname.replace(/^(www|m|music)\./i, '').toLowerCase()
    let id = ''
    if (host === 'youtu.be') {
      id = u.pathname.split('/')[1] ?? ''
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v')
      if (v) {
        id = v
      } else {
        const parts = u.pathname.split('/').filter(Boolean)
        if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] ?? ''
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

// oEmbed is YouTube's public "tell me about this video" address.
async function fetchTitle(watchUrl: string): Promise<string> {
  try {
    const res = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(watchUrl),
      { signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) {
      await res.body?.cancel()
      return ''
    }
    const info = await res.json()
    return tidy(typeof info?.title === 'string' ? info.title : '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Route 1: Supadata
// ---------------------------------------------------------------------------
function supadataText(content: unknown): string {
  if (typeof content === 'string') return tidy(content)
  if (Array.isArray(content)) {
    return tidy(content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' '))
  }
  return ''
}

async function viaSupadata(watchUrl: string): Promise<string> {
  if (!SUPADATA_API_KEY) return ''
  const headers = { 'x-api-key': SUPADATA_API_KEY }
  try {
    // mode=native means "only the captions that already exist", which is the
    // quick, cheap request. It never asks Supadata to transcribe the audio.
    const res = await fetch(
      'https://api.supadata.ai/v1/transcript?text=true&mode=native&url=' + encodeURIComponent(watchUrl),
      { headers, signal: AbortSignal.timeout(25_000) },
    )

    if (res.status === 200) {
      const data = await res.json()
      return supadataText(data?.content)
    }

    // 202 means "this one takes a while, here is a ticket, come back for it".
    if (res.status === 202) {
      const jobId = (await res.json())?.jobId
      if (typeof jobId !== 'string' || !jobId) return ''
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(1500)
        const check = await fetch(
          'https://api.supadata.ai/v1/transcript/' + encodeURIComponent(jobId),
          { headers, signal: AbortSignal.timeout(10_000) },
        )
        if (!check.ok) {
          await check.body?.cancel()
          return ''
        }
        const job = await check.json()
        if (job?.status === 'completed') return supadataText(job?.content)
        if (job?.status === 'failed') return ''
      }
      return ''
    }

    console.warn('Supadata answered', res.status, (await res.text()).slice(0, 200))
    return ''
  } catch (err) {
    console.warn('Supadata route failed:', (err as { message?: string })?.message ?? err)
    return ''
  }
}

// ---------------------------------------------------------------------------
// Route 2: Innertube, YouTube's own app API
// ---------------------------------------------------------------------------
type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string }
type PlayerInfo = { tracks: CaptionTrack[]; title: string; description: string; keywords: string[] }

const APP_CLIENTS = [
  {
    label: 'ios',
    headerName: '5',
    userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    client: {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    label: 'android',
    headerName: '3',
    userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
    client: {
      clientName: 'ANDROID',
      clientVersion: '19.44.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
      hl: 'en',
      gl: 'US',
    },
  },
]

async function askPlayer(videoId: string, app: (typeof APP_CLIENTS)[number]): Promise<PlayerInfo | null> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': app.userAgent,
        'X-YouTube-Client-Name': app.headerName,
        'X-YouTube-Client-Version': app.client.clientVersion,
      },
      body: JSON.stringify({
        videoId,
        context: { client: app.client },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const data = await res.json()
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    const details = data?.videoDetails ?? {}
    return {
      tracks: Array.isArray(tracks) ? tracks : [],
      title: tidy(typeof details.title === 'string' ? details.title : ''),
      description: typeof details.shortDescription === 'string' ? details.shortDescription.trim() : '',
      keywords: Array.isArray(details.keywords)
        ? details.keywords.filter((k: unknown) => typeof k === 'string')
        : [],
    }
  } catch (err) {
    console.warn(`Innertube (${app.label}) failed:`, (err as { message?: string })?.message ?? err)
    return null
  }
}

// English first, and captions a person wrote before ones a machine guessed.
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const usable = tracks.filter((t) => typeof t.baseUrl === 'string' && t.baseUrl)
  if (!usable.length) return null
  const isEnglish = (t: CaptionTrack) => (t.languageCode ?? '').toLowerCase().startsWith('en')
  const isHuman = (t: CaptionTrack) => t.kind !== 'asr'
  return (
    usable.find((t) => isEnglish(t) && isHuman(t)) ??
    usable.find((t) => isEnglish(t)) ??
    usable.find((t) => isHuman(t)) ??
    usable[0]
  )
}

async function fetchCaptionText(baseUrl: string): Promise<string> {
  // First ask for the tidy JSON version of the captions.
  try {
    const jsonUrl = new URL(baseUrl)
    jsonUrl.searchParams.set('fmt', 'json3')
    const res = await fetch(jsonUrl.href, { signal: AbortSignal.timeout(12_000) })
    if (res.ok) {
      const data = JSON.parse(await res.text())
      const events = Array.isArray(data?.events) ? data.events : []
      const text = tidy(
        events
          .map((event: { segs?: { utf8?: string }[] }) =>
            Array.isArray(event?.segs) ? event.segs.map((seg) => seg?.utf8 ?? '').join('') : ''
          )
          .join(' '),
      )
      if (text) return text
    } else {
      await res.body?.cancel()
    }
  } catch { /* fall through to the older XML format */ }

  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) {
      await res.body?.cancel()
      return ''
    }
    const xml = await res.text()
    const lines: string[] = []
    for (const match of xml.matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      lines.push(decodeEntities(match[2].replace(/<[^>]+>/g, '')))
    }
    return tidy(decodeEntities(lines.join(' ')))
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Route 3 helper: read the description off the normal watch page
// ---------------------------------------------------------------------------
async function descriptionFromWatchPage(watchUrl: string): Promise<{ title: string; description: string }> {
  try {
    const res = await fetch(watchUrl + '&hl=en', {
      signal: AbortSignal.timeout(12_000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) {
      await res.body?.cancel()
      return { title: '', description: '' }
    }
    const html = await res.text()
    let description = ''
    const inPage = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)
    if (inPage) {
      try {
        description = String(JSON.parse('"' + inPage[1] + '"')).trim()
      } catch { /* leave it empty */ }
    }
    if (!description) {
      const meta = html.match(/<meta\s+(?:name|property)="(?:og:)?description"\s+content="([^"]*)"/i)
      if (meta) description = decodeEntities(meta[1]).trim()
    }
    const titleTag = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''
    const title = tidy(decodeEntities(titleTag).replace(/\s*-\s*YouTube\s*$/i, ''))
    return { title, description }
  } catch {
    return { title: '', description: '' }
  }
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
    const given = typeof body.url === 'string' ? body.url : ''
    if (!given.trim()) throw new Problem(400, 'Paste a YouTube link first.')
    const videoId = youTubeId(given)
    if (!videoId) throw new Problem(400, 'That does not look like a YouTube link.')
    const watchUrl = 'https://www.youtube.com/watch?v=' + videoId

    let title = await fetchTitle(watchUrl)
    let text = ''
    let fetchedVia = ''
    let hasTranscript = false
    let description = ''
    let keywords: string[] = []

    // Route 1: Supadata
    text = await viaSupadata(watchUrl)
    if (text) {
      fetchedVia = 'supadata'
      hasTranscript = true
    }

    // Route 2: Innertube, as the iPhone app and then the Android app
    if (!text) {
      for (const app of APP_CLIENTS) {
        const info = await askPlayer(videoId, app)
        if (!info) continue
        if (!title && info.title) title = info.title
        if (!description && info.description) description = info.description
        if (!keywords.length && info.keywords.length) keywords = info.keywords
        const track = pickTrack(info.tracks)
        if (!track?.baseUrl) continue
        const captions = await fetchCaptionText(track.baseUrl)
        if (captions) {
          text = captions
          fetchedVia = 'innertube_' + app.label
          hasTranscript = true
          break
        }
      }
    }

    // Route 3: the written description, clearly labelled as not a transcript
    if (!text) {
      if (!description) {
        const page = await descriptionFromWatchPage(watchUrl)
        description = page.description
        if (!title && page.title) title = page.title
      }
      const parts = [description]
      if (keywords.length) parts.push('Keywords: ' + keywords.slice(0, 30).join(', '))
      text = parts.filter(Boolean).join('\n\n').trim()
      if (text.length < 40) {
        throw new Problem(
          422,
          'Could not read anything from that video. It may be private, age-restricted, or have no captions. You can still paste the transcript by hand.',
        )
      }
      fetchedVia = 'description'
    }

    if (!title) title = 'Untitled video'
    const truncated = text.length > MAX_TEXT_CHARS
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS)

    const note = hasTranscript
      ? ''
      : '(No transcript could be fetched. This is the video description, not what was said.)\n\n'
    const content = `\u{1F4F9} YouTube: ${title}\n${watchUrl}\n\n${note}${text}`

    // Save with the service role key. That key skips your Level 2 security
    // rule, so user_id is set here by hand on every row.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: {
          source: 'youtube',
          title,
          video_id: videoId,
          video_url: watchUrl,
          has_transcript: hasTranscript,
          fetched_via: fetchedVia,
        },
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
      source_kind: hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: text.length,
      truncated,
    })
    if (sourceError) console.warn('thought_sources insert failed:', sourceError.message)

    return json({
      ok: true,
      id: thought.id,
      title,
      video_id: videoId,
      has_transcript: hasTranscript,
      fetched_via: fetchedVia,
      chars: text.length,
      truncated,
    })
  } catch (err) {
    if (err instanceof Problem) return json({ error: err.message }, err.status)
    console.error('capture-youtube error:', err)
    const detail = (err as { message?: string })?.message ?? String(err)
    return json({ error: `Something went wrong: ${detail}` }, 500)
  }
})
