// crew — the King and his workers.
//
// An order ("/king …" in Telegram, the "Send to King" button, or the MCP
// king_order tool) goes like this:
//
//   1. PLAN     The King (one Haiku call) breaks the order into steps and
//               picks a worker for each. The Critic is added as the last
//               step. The plan, with an estimated cost, goes to Telegram
//               with Approve / Edit / Cancel. NOTHING runs before Approve.
//   2. RUN      One step per call of this function, each a call-llm call,
//               passing the earlier steps' outputs along. After each step
//               the function calls itself for the next one (a confirmed
//               hand-off), so no call runs long. A 15-minute cron job
//               (resume-orders) restarts anything that got stuck.
//   3. CHECK    The Critic checks the final draft (every claim cited,
//               nothing invented, the owner's rules). If it fails, the draft
//               goes back to its worker once; if it still fails, the owner is
//               told what is wrong. Then the King's final check (no AI call)
//               confirms the citations resolve and the cost.
//   4. RESULT   Back to Telegram with numbered citations (/t_ links) and the
//               actual cost, plus a "Save as report" button.
//
// Every step writes a row in agent_runs (queued → working → done / failed /
// waiting_on_me), with its task, output, tokens and cost; the order's totals
// are in orders. The 3D office will show only this data.
//
// LIMITS: Haiku for every worker (agents.model). At most max_worker_steps
// worker steps per order and a cost cap per order (crew_config); before a
// step would pass the cap, the crew stops and asks. Workers can only READ
// the brain. The only writes: "Save as report" (kind = report, after the
// owner taps it) and the Fixer's housekeeping (re-capture, archive, change
// kind), ONLY after the owner taps Approve. Nothing is ever deleted. The only
// messages go to the owner's own Telegram chat (telegram-bot "notify").
//
// Internal only: every request needs the x-internal-secret header.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { internalHeaders, rejectUnlessInternal } from '../_shared/internal-auth.ts'
import { keywordQuery } from '../_shared/keywords.ts'
import { KIND_LABEL, PICKABLE, SECTION_LABEL, sectionOf } from '../_shared/kinds.ts'
import { estimateCost } from '../_shared/prices.ts'
import { MIN_REAL_CONTENT, refillThought } from '../_shared/refill.ts'
import { finishRun, startRun } from '../_shared/runs.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// The service role key skips row-level security: every query below filters
// by OWNER_USER_ID itself.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const embedder = new Supabase.ai.Session('gte-small')

const WORKERS = ['Librarian', 'Tutor', 'Reviewer', 'Writer', 'Critic', 'Fixer']
const DRAFTERS = ['Writer', 'Tutor', 'Reviewer', 'Librarian']   // whose output can be the final result
const ICON: Record<string, string> = {
  King: '\u{1F451}', Librarian: '\u{1F4DA}', Tutor: '\u{1F4A1}', Reviewer: '\u{1F50D}',
  Writer: '✍️', Critic: '✅', Scout: '\u{1F4E1}', Fixer: '\u{1F527}',
}
const STATUS_ICON: Record<string, string> = {
  planning: '\u{1F914}', awaiting_approval: '⏳', running: '⚙️', waiting_on_me: '✋',
  done: '✅', failed: '❌', cancelled: '✖️', queued: '⏳', working: '⚙️',
}

// Typical tokens per step (input, output incl. Haiku's built-in thinking),
// only for the estimate shown with the plan. The real cost is logged.
const EST_TOKENS: Record<string, { in: number; out: number }> = {
  King: { in: 2500, out: 1500 },
  Librarian: { in: 7000, out: 2000 },
  Tutor: { in: 7000, out: 4000 },
  Reviewer: { in: 12000, out: 3000 },
  Writer: { in: 7000, out: 3000 },
  Critic: { in: 9000, out: 1500 },
  Fixer: { in: 3000, out: 1000 },
}
const MIN_SIMILARITY = 0.78
const OWN_KINDS = ['my_thought', 'project_doc', 'class_note']
const RELIABILITY_WEIGHT: Record<string, number> = { research: 1.15, expert: 1.1, unknown: 1, opinion: 0.85 }
const STUCK_WORKING_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Agent = { name: string; role: string; model: string; system_prompt: string; allowed_tools: string[]; active: boolean }
type Step = { agent: string; task: string; query?: string }
type Plan = { summary: string; steps: Step[]; estimate: number }
type Src = {
  id: string; short: string; title: string; label: string; section: string | null
  kind: string | null; created_at: string; chunk?: string
}
type Registry = Record<string, Src>
// deno-lint-ignore no-explicit-any
type Order = any
// deno-lint-ignore no-explicit-any
type Run = any
type Row = {
  id: string; content: string; created_at: string; summary: string | null; kind: string | null
  status?: string | null; takeaway_of?: string | null; reliability?: string | null
  score?: number | null; similarity?: number | null; matched_chunk?: string | null
  metadata?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

const usd = (n: number) => `$${(Number(n) || 0).toFixed(n < 0.1 ? 4 : 2)}`

function shorten(text: string, max = 120): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function titleOf(r: { content?: string | null; summary?: string | null }): string {
  const first = (r.content ?? '').split('\n').find((l) => l.trim()) ?? ''
  return shorten(r.summary?.trim() || first, 90)
}

// What a note is, in words (the same labels Ask uses).
function labelOf(r: Row): string {
  const c = (r.content ?? '').trimStart()
  if (r.takeaway_of) return 'your takeaway'
  if (r.kind === 'source') {
    const what = c.startsWith('\u{1F4F9}') ? 'a video you saved'
      : c.startsWith('\u{1F517}') ? 'an article you saved'
      : c.startsWith('\u{1F4C4}') ? 'a PDF you saved'
      : 'a source you saved'
    return r.reliability ? `${what} (${r.reliability}-level)` : what
  }
  switch (r.kind) {
    case 'my_thought': return 'your note'
    case 'project_doc': return 'your document'
    case 'class_note': return 'your class notes'
    case 'report': return /^Weekly digest:/i.test(c) ? 'an AI weekly digest' : 'an AI write-up you saved'
    default: return 'a note'
  }
}

const shortOf = (id: string) => id.slice(0, 8)
const tag = (id: string) => `[t_${shortOf(id)}]`

function toSrc(r: Row): Src {
  return {
    id: r.id, short: shortOf(r.id), title: titleOf(r), label: labelOf(r),
    section: sectionOf(r.kind), kind: r.kind, created_at: r.created_at,
    ...(r.matched_chunk ? { chunk: r.matched_chunk.slice(0, 1200) } : {}),
  }
}

// A note as the workers see it: its citation tag, where it is, what it is.
function noteBlock(r: Row, chars: number): string {
  const section = sectionOf(r.kind)
  const head = (r.content ?? '').slice(0, chars)
  const chunk = r.matched_chunk && !head.includes(r.matched_chunk.slice(0, 80))
    ? `\n…\n${r.matched_chunk.slice(0, Math.min(chars, 1500))}` : ''
  return `${tag(r.id)} ${section ? SECTION_LABEL[section].toUpperCase() : 'UNSORTED'} · ${fmtDate(r.created_at)} · ${labelOf(r)}` +
    (r.summary ? ` · ${r.summary.replace(/\s+/g, ' ').trim()}` : '') +
    `\n${(head + chunk).trim()}${(r.content ?? '').length > chars ? '\n[…rest of this note not shown]' : ''}`
}

async function loadConfig() {
  const { data } = await db.from('crew_config').select('key, value')
  const v = new Map((data ?? []).map((r) => [r.key, r.value]))
  return {
    maxSteps: Math.max(2, Math.min(12, Number(v.get('max_worker_steps') ?? 8))),
    costCap: Math.max(0.001, Number(v.get('cost_cap_usd') ?? 0.05)),
    criticRetries: Math.max(0, Math.min(2, Number(v.get('critic_retries') ?? 1))),
  }
}

async function loadAgents(): Promise<Map<string, Agent>> {
  const { data, error } = await db.from('agents').select('name, role, model, system_prompt, allowed_tools, active')
  if (error) throw new Error(`agents: ${error.message}`)
  return new Map((data ?? []).map((a) => [a.name, a as Agent]))
}

function estimateStep(agent: string, agents: Map<string, Agent>): number {
  const t = EST_TOKENS[agent] ?? EST_TOKENS.Writer
  return estimateCost(agents.get(agent)?.model ?? 'claude-haiku-5-5', t.in, t.out)
}

// One AI call through call-llm, billed to this run (tokens + cost land on
// the run and its order inside call-llm).
async function llm(agent: Agent, runId: string | null, o: { system: string; prompt: string; maxTokens: number; source: string }) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      systemPrompt: o.system, prompt: o.prompt, maxTokens: o.maxTokens, model: agent.model,
      userId: OWNER_USER_ID, source: o.source, ...(runId ? { runId } : {}),
    }),
  })
  if (!res.ok) throw new Error(`call-llm failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { text: String(data.text ?? '').trim(), cost: Number(data.cost_usd ?? 0) }
}

function parseJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// Messages only ever go to the owner's own chat (telegram-bot notify).
async function notify(text: string, keyboard?: { text: string; callback_data: string }[][]): Promise<number | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-bot`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ action: 'notify', text, ...(keyboard ? { keyboard } : {}) }),
    })
    const body = await res.json().catch(() => ({}))
    return typeof body.message_id === 'number' ? body.message_id : null
  } catch (e) {
    console.log(`notify failed: ${e}`)
    return null
  }
}

async function updateOrder(id: string, fields: Record<string, unknown>) {
  const { error } = await db.from('orders').update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', OWNER_USER_ID)
  if (error) console.log(`order ${id} update failed: ${error.message}`)
}

async function updateRun(id: string, fields: Record<string, unknown>) {
  const { error } = await db.from('agent_runs').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) console.log(`run ${id} update failed: ${error.message}`)
}

async function loadOrder(id: string): Promise<Order | null> {
  const { data } = await db.from('orders').select('*').eq('id', id).eq('user_id', OWNER_USER_ID).maybeSingle()
  return data
}

async function loadRuns(orderId: string): Promise<Run[]> {
  const { data } = await db.from('agent_runs').select('*').eq('order_id', orderId).order('seq').order('created_at')
  return data ?? []
}

// Hand the next step to a fresh call of this function. Waits only for the
// "got it" reply; the 15-minute resume job catches a lost hand-off.
async function kick(orderId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/crew`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ action: 'advance', order_id: orderId }),
      signal: AbortSignal.timeout(8000),
    })
    await res.body?.cancel()
    return res.ok
  } catch (e) {
    console.log(`hand-off failed for order ${orderId}: ${e}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Reading the brain (read-only)
// ---------------------------------------------------------------------------
async function embed(text: string): Promise<string> {
  const vector = await embedder.run(text, { mean_pool: true, normalize: true })
  return JSON.stringify(Array.from(vector as number[]))
}

// Hybrid search (meaning + keywords). course_setup is always left out,
// archived thoughts are never returned.
async function search(query: string, section: 'personal' | 'library' | null, count: number): Promise<Row[]> {
  const { data, error } = await db.rpc('hybrid_search_v3', {
    query_embedding: await embed(query),
    query_text: keywordQuery(query),
    match_count: count,
    p_user_id: OWNER_USER_ID,
    min_similarity: MIN_SIMILARITY,
    p_section: section,
  })
  if (error) throw new Error(`hybrid_search_v3: ${error.message}`)
  return ((data ?? []) as Row[]).filter((r) => r.status !== 'archived')
}

const ROW_COLUMNS = 'id, content, created_at, summary, kind, status, takeaway_of, reliability, metadata'

async function byIds(ids: string[]): Promise<Row[]> {
  if (!ids.length) return []
  const { data } = await db.from('thoughts').select(ROW_COLUMNS).in('id', ids).eq('user_id', OWNER_USER_ID)
  return (data ?? []) as Row[]
}

// The owner's takeaways on Library items that were found; they lead.
async function withTakeaways(rows: Row[]): Promise<Row[]> {
  const ids = rows.filter((r) => sectionOf(r.kind) === 'library').map((r) => r.id)
  if (!ids.length) return rows
  const { data } = await db.from('thoughts').select(ROW_COLUMNS).in('takeaway_of', ids)
    .eq('user_id', OWNER_USER_ID).or('status.is.null,status.neq.archived')
  const score = new Map(rows.map((r) => [r.id, r.score ?? 0]))
  const extra = ((data ?? []) as Row[]).map((t) => ({ ...t, score: score.get(t.takeaway_of as string) ?? 0 }))
  return dedupe([...rows, ...extra])
}

async function withReliability(rows: Row[]): Promise<Row[]> {
  const ids = rows.filter((r) => r.kind === 'source' && r.reliability === undefined).map((r) => r.id)
  if (!ids.length) return rows
  const { data } = await db.from('thoughts').select('id, reliability').in('id', ids)
  const m = new Map((data ?? []).map((d) => [d.id, d.reliability]))
  return rows.map((r) => (m.has(r.id) ? { ...r, reliability: m.get(r.id) } : r))
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>()
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

// The owner's own writing counts more than saved sources, takeaways lead,
// research/expert sources edge out opinion ones.
function rank(rows: Row[]): Row[] {
  const w = (r: Row) => {
    let x = r.score ?? 0
    if (r.kind && OWN_KINDS.includes(r.kind)) x *= 1.5
    if (r.takeaway_of) x *= 1.2
    if (r.kind === 'source' && r.reliability) x *= RELIABILITY_WEIGHT[r.reliability] ?? 1
    return x
  }
  return rows.slice().sort((a, b) => w(b) - w(a))
}

async function findNotes(query: string, personal = 10, library = 6): Promise<Row[]> {
  const [p, l] = await Promise.all([search(query, 'personal', personal), search(query, 'library', library)])
  return rank(await withReliability(await withTakeaways(dedupe([...p, ...l]))))
}

// ---------------------------------------------------------------------------
// Citations: [t_1a2b3c4d] inside the crew, numbered [1] for the owner
// ---------------------------------------------------------------------------
function citedShorts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/t_([0-9a-f]{8})/gi)) {
    const s = m[1].toLowerCase()
    if (!out.includes(s)) out.push(s)
  }
  return out
}

async function resolveShorts(shorts: string[], registry: Registry): Promise<Registry> {
  const found: Registry = {}
  for (const s of shorts) {
    if (registry[s]) { found[s] = registry[s]; continue }
    const { data } = await db.from('thoughts').select(ROW_COLUMNS).eq('user_id', OWNER_USER_ID)
      .gte('id', `${s}-0000-0000-0000-000000000000`).lte('id', `${s}-ffff-ffff-ffff-ffffffffffff`).limit(1).maybeSingle()
    if (data && data.status !== 'archived') found[s] = toSrc(data as Row)
  }
  return found
}

// "[t_1a2b3c4d]" or "[t_1a2b3c4d, t_5e6f7a8b]" → "[1]" / "[1][2]", plus the list.
function numberCitations(text: string, known: Registry): { body: string; sources: Src[] } {
  const order: string[] = []
  const num = (s: string) => {
    if (!order.includes(s)) order.push(s)
    return order.indexOf(s) + 1
  }
  const body = text
    .replace(/\[([^\]\n]*?t_[0-9a-f]{8}[^\]\n]*?)\]/gi, (_w, inner: string) => {
      const ns = citedShorts(inner).filter((s) => known[s]).map((s) => `[${num(s)}]`)
      return ns.join('')
    })
    .replace(/\(?\bt_([0-9a-f]{8})\b\)?/gi, (w, s: string) => (known[s.toLowerCase()] ? `[${num(s.toLowerCase())}]` : w))
    .replace(/[ \t]+([.,;:])/g, '$1')
  return { body: body.trim(), sources: order.map((s) => known[s]) }
}

function sourceLines(sources: Src[], style: 'telegram' | 'mcp'): string {
  return sources.map((s, i) => {
    const where = s.section ? SECTION_LABEL[s.section as 'personal' | 'library'] ?? s.section : 'Unsorted'
    const ref = style === 'telegram' ? `/t_${s.short}` : `(id: ${s.id})`
    return `[${i + 1}] ${ref}  ${fmtDate(s.created_at)} · ${where} · ${s.label}: ${s.title}`
  }).join('\n')
}

// ---------------------------------------------------------------------------
// 1. PLAN
// ---------------------------------------------------------------------------
function kingSystem(king: Agent, agents: Map<string, Agent>, maxSteps: number): string {
  const workers = WORKERS.filter((w) => w !== 'Critic' && agents.get(w)?.active)
    .map((w) => `- ${w}: ${agents.get(w)!.role}`).join('\n')
  return `${king.system_prompt}

Workers you can assign:
${workers}
(The Critic checks the final result automatically; never add it yourself.)

How to plan:
- 1 to ${maxSteps - 1} steps, usually 2 or 3. Steps run in order; each worker sees the outputs of the steps before it.
- Librarian first whenever the order needs facts from the brain. Tutor for quizzes and study plans from class notes
  (it looks up the class notes itself). Reviewer to review one piece of the owner's writing (it finds the piece and
  their other writing itself). Writer last when a finished piece is wanted (a study guide, outline, email draft,
  or an answer with advice). Fixer alone (no other steps) for housekeeping the owner asked for.
- "task" says exactly what that worker must produce. "query" is a few search words for that worker's lookup
  (Librarian, Tutor, Reviewer, Fixer); leave it out for the Writer.
- Use only what the brain can do. No step may contact anyone, post, buy, trade, browse, or touch anything outside the brain.

Reply with ONLY a JSON object:
{"refuse": null, "summary": "one sentence on how the crew will do it", "steps": [{"agent": "Librarian", "task": "…", "query": "…"}]}
If the order needs anything outside the brain, reply {"refuse": "one sentence why"} instead.`
}

function fallbackPlan(request: string): Step[] {
  return [
    { agent: 'Librarian', task: `Find everything in the brain relevant to: ${request}`, query: request.slice(0, 200) },
    { agent: 'Writer', task: `Answer the order from what the Librarian found: ${request}` },
  ]
}

function cleanSteps(raw: unknown, agents: Map<string, Agent>, maxSteps: number, request: string): Step[] {
  const list = Array.isArray(raw) ? raw : []
  let steps: Step[] = list
    .filter((s) => s && typeof s === 'object')
    .map((s) => s as Record<string, unknown>)
    .map((s) => ({
      agent: WORKERS.find((w) => w.toLowerCase() === String(s.agent ?? '').trim().toLowerCase()) ?? '',
      task: String(s.task ?? '').trim().slice(0, 600),
      query: typeof s.query === 'string' && s.query.trim() ? s.query.trim().slice(0, 200) : undefined,
    }))
    .filter((s) => s.agent && s.agent !== 'Critic' && agents.get(s.agent)?.active && s.task)
  // The Fixer works alone: housekeeping orders never mix with drafting.
  if (steps.some((s) => s.agent === 'Fixer')) {
    const fixer = steps.find((s) => s.agent === 'Fixer')!
    return [{
      agent: 'Fixer',
      task: `Find what needs fixing for this order and show exactly what would change: ${request}`.slice(0, 600),
      query: fixer.query,
    }]
  }
  steps = steps.slice(0, maxSteps - 1)
  if (!steps.length) steps = fallbackPlan(request)
  // The Critic checks every drafted result.
  if (!steps.some((s) => s.agent === 'Fixer')) {
    steps.push({ agent: 'Critic', task: 'Check the final draft: every claim cited, nothing invented, the owner\'s rules followed.' })
  }
  return steps
}

function planText(order: { request: string }, plan: Plan, cap: number): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. ${ICON[s.agent] ?? ''} ${s.agent}: ${s.task}`)
  return `\u{1F451} Plan for: "${shorten(order.request, 200)}"\n${plan.summary ? `${plan.summary}\n` : ''}\n${lines.join('\n')}\n\n` +
    `Estimated cost: about ${usd(plan.estimate)} (${plan.steps.some((s) => s.agent === 'Critic') ? 'more if the Critic sends a draft back once; ' : ''}cap ${usd(cap)}). Nothing runs until you tap Approve.`
}

const planKeyboard = (orderId: string) => [[
  { text: '✅ Approve', callback_data: `ko:a:${orderId}` },
  { text: '✏️ Edit', callback_data: `ko:e:${orderId}` },
  { text: '✖️ Cancel', callback_data: `ko:c:${orderId}` },
]]

async function planOrder(o: { text: string; source: string; chatId?: string | null; parentId?: string | null }) {
  const request = o.text.trim().slice(0, 2000)
  if (!request) return { ok: false, error: 'empty order' }
  const [cfg, agents] = await Promise.all([loadConfig(), loadAgents()])
  const king = agents.get('King')
  if (!king) throw new Error('The King is missing from the agents table.')

  const { data: order, error } = await db.from('orders').insert({
    user_id: OWNER_USER_ID, request, source: o.source, chat_id: o.chatId ?? null,
    parent_order_id: o.parentId ?? null, status: 'planning', cost_cap: cfg.costCap,
  }).select('*').single()
  if (error) throw new Error(`orders: ${error.message}`)

  const runId = await startRun(db, { userId: OWNER_USER_ID, agent: 'King', task: `Plan the order: ${request}`, orderId: order.id, seq: 0 })
  let refuse: string | null = null
  let steps: Step[]
  let summary = ''
  try {
    const r = await llm(king, runId, {
      system: kingSystem(king, agents, cfg.maxSteps),
      prompt: `The owner's order:\n"""\n${request}\n"""`,
      maxTokens: 2500,
      source: 'crew-king-plan',
    })
    const parsed = parseJson(r.text)
    refuse = parsed && typeof parsed.refuse === 'string' && parsed.refuse.trim() ? parsed.refuse.trim() : null
    summary = parsed && typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 300) : ''
    steps = cleanSteps(parsed?.steps, agents, cfg.maxSteps, request)
  } catch (e) {
    await finishRun(db, runId, { status: 'failed', error: String(e) })
    await updateOrder(order.id, { status: 'failed', error: `Planning failed: ${e}`, finished_at: new Date().toISOString() })
    await notify(`\u{1F451} I couldn't plan that order: ${e}`)
    return { ok: false, order_id: order.id, error: String(e) }
  }

  if (refuse) {
    await finishRun(db, runId, { output: `Refused: ${refuse}` })
    await updateOrder(order.id, { status: 'cancelled', error: `Refused by the King: ${refuse}`, finished_at: new Date().toISOString() })
    const text = `\u{1F451} I won't run that order: ${refuse}\nThe crew only works inside your brain.`
    await notify(text)
    return { ok: true, order_id: order.id, status: 'cancelled', plan_text: text }
  }

  if (steps.length === 1 && steps[0].agent === 'Fixer') {
    summary = 'The Fixer checks your brain and lists exactly what it would change. Nothing changes until you tap Approve on that list too.'
  }
  const fresh = await loadOrder(order.id)
  const estimate = Number(fresh?.total_cost ?? 0) + steps.reduce((sum, s) => sum + estimateStep(s.agent, agents), 0)
  const plan: Plan = { summary, steps, estimate }
  const text = planText({ request }, plan, cfg.costCap)
  await finishRun(db, runId, { output: steps.map((s, i) => `${i + 1}. ${s.agent}: ${s.task}${s.query ? ` (search: ${s.query})` : ''}`).join('\n') })
  const messageId = await notify(text, planKeyboard(order.id))
  await updateOrder(order.id, {
    status: 'awaiting_approval', plan, plan_text: text, estimated_cost: estimate, plan_message_id: messageId,
  })
  return { ok: true, order_id: order.id, status: 'awaiting_approval', plan_text: text }
}

// ---------------------------------------------------------------------------
// 2. RUN — one step per call
// ---------------------------------------------------------------------------
async function approve(order: Order) {
  const { data: claimed } = await db.from('orders')
    .update({ status: 'running', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', order.id).eq('user_id', OWNER_USER_ID).eq('status', 'awaiting_approval').select('id')
  if (!claimed?.length) return false
  const steps: Step[] = order.plan?.steps ?? []
  const { error } = await db.from('agent_runs').insert(steps.map((s, i) => ({
    user_id: OWNER_USER_ID, order_id: order.id, seq: i + 1, agent: s.agent, status: 'queued', task: s.task,
  })))
  if (error) {
    await updateOrder(order.id, { status: 'failed', error: `Could not queue the steps: ${error.message}` })
    return false
  }
  await kick(order.id)
  return true
}

async function advance(orderId: string): Promise<void> {
  const order = await loadOrder(orderId)
  if (!order || order.status !== 'running') return
  const runs = await loadRuns(orderId)
  if (runs.some((r) => r.status === 'working' || r.status === 'waiting_on_me')) return   // someone is on it
  const next = runs.find((r) => r.status === 'queued')
  if (!next) return await finalize(order, runs)

  const [cfg, agents] = await Promise.all([loadConfig(), loadAgents()])
  // Cost cap: stop and ask before a step would go past it.
  const est = estimateStep(next.agent, agents)
  const cap = Number(order.cost_cap ?? cfg.costCap)
  if (Number(order.total_cost) + est > cap) {
    await updateRun(next.id, { status: 'waiting_on_me' })
    await updateOrder(orderId, { status: 'waiting_on_me' })
    await notify(
      `✋ Order "${shorten(order.request, 80)}" has cost ${usd(order.total_cost)} so far. The next step ` +
        `(${ICON[next.agent] ?? ''} ${next.agent}, about ${usd(est)}) would pass its ${usd(cap)} cap.`,
      [[{ text: `Go on (+${usd(cfg.costCap)})`, callback_data: `ko:g:${orderId}` }, { text: 'Stop here', callback_data: `ko:x:${orderId}` }]],
    )
    return
  }

  // Claim the step, so two calls can't both run it.
  const { data: claimed } = await db.from('agent_runs')
    .update({ status: 'working', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', next.id).eq('status', 'queued').select('id')
  if (!claimed?.length) return

  const agent = agents.get(next.agent)
  try {
    if (!agent || !agent.active) throw new Error(`${next.agent} is not an active agent`)
    const result = await runStep(order, next, runs, agent, agents, cfg)
    if (result === 'waiting') return   // the Fixer waits for the owner's Approve
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finishRun(db, next.id, { status: 'failed', error: msg })
    await failOrder(order, `${next.agent} failed: ${msg}`)
    return
  }
  await kick(orderId)
}

async function failOrder(order: Order, reason: string) {
  await db.from('agent_runs').update({ status: 'failed', error: 'not run: the order stopped', finished_at: new Date().toISOString() })
    .eq('order_id', order.id).in('status', ['queued', 'waiting_on_me'])
  await updateOrder(order.id, { status: 'failed', error: reason, finished_at: new Date().toISOString() })
  const fresh = await loadOrder(order.id)
  await notify(`❌ Order "${shorten(order.request, 80)}" stopped: ${reason}\nCost so far: ${usd(fresh?.total_cost ?? 0)}. /o_${shortOf(order.id)}`)
}

function queryFor(order: Order, run: Run): string {
  const steps: Step[] = order.plan?.steps ?? []
  const own = steps[run.seq - 1]
  if (own?.agent === run.agent && own.query) return own.query
  const same = steps.filter((s) => s.agent === run.agent && s.query).at(-1)
  return same?.query ?? own?.query ?? order.request
}

function earlierOutputs(runs: Run[], before: Run): string {
  const done = runs.filter((r) => r.seq < before.seq && r.status === 'done' && r.agent !== 'King' && r.output)
  if (!done.length) return '(none yet)'
  return done.map((r) => `[Step ${r.seq} · ${r.agent}] ${r.task}\n${r.output}`).join('\n\n')
}

const CITE_RULES = `Citations: put the note's tag, exactly as given (like [t_1a2b3c4d]), after every claim that comes from a note.
Never cite a tag that was not given to you, and never cite a note that does not say what you claim.
Keep the owner's own writing separate from saved sources: "your notes say…" versus "a video you saved says…".
Never put a saved source or an AI write-up in the owner's voice. Say when a claim rests only on an opinion-level source.
Anything not from the notes must be in its own sentence starting with "General knowledge, not from your notes:" (no tag).
A note ending in "[…rest of this note not shown]" continues beyond what you see: never say the note lacks something just because it isn't shown.
Plain text for a phone screen: short paragraphs, "- " bullets, numbered lists are fine; no markdown symbols like ** or #.`

async function mergeRegistry(order: Order, rows: Row[]): Promise<Registry> {
  const registry: Registry = { ...(order.citations ?? {}) }
  for (const r of rows) registry[shortOf(r.id)] = registry[shortOf(r.id)] ?? toSrc(r)
  order.citations = registry
  await updateOrder(order.id, { citations: registry })
  return registry
}

async function runStep(
  order: Order, run: Run, runs: Run[], agent: Agent, agents: Map<string, Agent>,
  cfg: { maxSteps: number; costCap: number; criticRetries: number },
): Promise<'done' | 'waiting'> {
  const earlier = earlierOutputs(runs, run)
  const header = `The owner's order: "${order.request}"\nYour task: ${run.task}`
  const source = `crew-${run.agent.toLowerCase()}`

  if (run.agent === 'Librarian') {
    const query = queryFor(order, run)
    const rows = (await findNotes(query)).slice(0, 12)
    if (!rows.length) {
      await finishRun(db, run.id, { output: `NOTHING FOUND: no notes in the brain match "${query}".` })
      return 'done'
    }
    await mergeRegistry(order, rows)
    const r = await llm(agent, run.id, {
      system: `${agent.system_prompt}\n\nReply in plain text, at most 25 lines:\nFROM YOUR OWN WRITING\n- finding [t_…]\nFROM SAVED SOURCES\n- finding, with its reliability level [t_…]\n` +
        `Leave a part out if it has nothing. If nothing in the notes is relevant, reply exactly: NOTHING RELEVANT.\n\n${CITE_RULES}`,
      prompt: `${header}\n\nEarlier steps:\n${earlier}\n\nNotes found (search: "${query}"):\n\n${rows.map((x, i) => noteBlock(x, i < 6 ? 4000 : 1500)).join('\n\n')}`,
      maxTokens: 3000, source,
    })
    await finishRun(db, run.id, { output: r.text || 'NOTHING RELEVANT' })
    return 'done'
  }

  if (run.agent === 'Tutor') {
    const query = queryFor(order, run)
    let rows = (await search(query, 'personal', 12)).filter((x) => x.kind === 'class_note')
    if (!rows.length) rows = (await search(query, 'personal', 8)).filter((x) => x.kind && OWN_KINDS.includes(x.kind))
    rows = rows.slice(0, 5)
    if (!rows.length) {
      await finishRun(db, run.id, { output: `NOTHING FOUND: no class notes match "${query}".` })
      return 'done'
    }
    await mergeRegistry(order, rows)
    const r = await llm(agent, run.id, {
      system: `${agent.system_prompt}\n\nWrite exactly what the task asks for (for example a day-by-day study plan, then quiz questions with answers). ` +
        `Every study step and every question cites the class note it comes from.\n\n${CITE_RULES}`,
      prompt: `${header}\n\nEarlier steps:\n${earlier}\n\nClass notes (search: "${query}"):\n\n${rows.map((x, i) => noteBlock(x, i < 3 ? 7000 : 1500)).join('\n\n')}`,
      maxTokens: 5000, source,
    })
    await finishRun(db, run.id, { output: r.text })
    return 'done'
  }

  if (run.agent === 'Reviewer') {
    const query = queryFor(order, run)
    const candidates = (await search(query, null, 10)).filter((x) => x.kind && OWN_KINDS.includes(x.kind) && !x.takeaway_of)
    const draft = candidates[0]
    if (!draft) {
      await finishRun(db, run.id, { output: `NOTHING FOUND: I could not find the piece of writing for "${query}".` })
      return 'done'
    }
    const [similar, lessons] = await Promise.all([
      search(`${query} ${run.task}`.slice(0, 300), null, 12),
      search('feedback on my writing, lessons learned, how to write better, what to improve next time', 'personal', 8),
    ])
    const others = dedupe([...similar, ...lessons])
      .filter((x) => x.id !== draft.id && x.kind && (OWN_KINDS.includes(x.kind) || x.takeaway_of)).slice(0, 7)
    await mergeRegistry(order, [draft, ...others])
    const r = await llm(agent, run.id, {
      system: `${agent.system_prompt}\n\nReply in plain text with three parts:\nWHAT WORKS\n- point [t_…]\nWHAT TO IMPROVE NEXT TIME\n- point, tied to a passage of the draft [t_…] and, where it fits, to an earlier note [t_…]\n` +
        `WHAT YOUR OTHER WRITING SHOWS\n- patterns that repeat across pieces [t_…]\nCite the draft's tag for points about the draft. A point that is only your own reading of the draft must say "my reading:".\n\n${CITE_RULES}`,
      prompt: `${header}\n\nEarlier steps:\n${earlier}\n\nTHE DRAFT TO REVIEW:\n${noteBlock(draft, 14000)}\n\nTHE OWNER'S OTHER WRITING AND SAVED LESSONS:\n\n` +
        (others.length ? others.map((x) => noteBlock(x, 1500)).join('\n\n') : '(none found)'),
      maxTokens: 4000, source,
    })
    await finishRun(db, run.id, { output: r.text })
    return 'done'
  }

  if (run.agent === 'Writer') {
    const registry: Registry = order.citations ?? {}
    const cited = citedShorts(earlier).filter((s) => registry[s])
    const notes = await byIds(cited.map((s) => registry[s].id))
    const r = await llm(agent, run.id, {
      system: `${agent.system_prompt}\n\nWrite the finished piece the task asks for, built on the earlier steps. Keep every citation tag from the ` +
        `findings you use. Start with the piece itself (no preamble), under 500 words unless the task needs more.\n\n${CITE_RULES}`,
      prompt: `${header}\n\nEarlier steps:\n${earlier}\n\nThe cited notes, for checking details:\n\n` +
        (notes.length ? notes.map((x) => noteBlock({ ...x, matched_chunk: registry[shortOf(x.id)]?.chunk ?? null }, 900)).join('\n\n') : '(none)'),
      maxTokens: 4000, source,
    })
    await finishRun(db, run.id, { output: r.text })
    return 'done'
  }

  if (run.agent === 'Critic') return await critic(order, run, runs, agent, cfg)
  if (run.agent === 'Fixer') return await fixerPropose(order, run, agent)
  throw new Error(`no worker code for ${run.agent}`)
}

// ---------------------------------------------------------------------------
// 3. CHECK — the Critic
// ---------------------------------------------------------------------------
function lastDraft(runs: Run[], before: Run): Run | undefined {
  return runs.filter((r) => r.seq < before.seq && r.status === 'done' && DRAFTERS.includes(r.agent) && r.output).at(-1)
}

async function critic(
  order: Order, run: Run, runs: Run[], agent: Agent, cfg: { maxSteps: number; criticRetries: number },
): Promise<'done'> {
  const draftRun = lastDraft(runs, run)
  if (!draftRun) {
    await finishRun(db, run.id, { output: 'FAIL\n- There is no draft to check.' })
    return 'done'
  }
  const draft: string = draftRun.output
  const registry: Registry = order.citations ?? {}
  const problems: string[] = []
  const nothing = /^NOTHING (FOUND|RELEVANT)/.test(draft.trim())

  // Free checks first: unknown tags, and no citations at all.
  const shorts = citedShorts(draft)
  const known = await resolveShorts(shorts, registry)
  const unknown = shorts.filter((s) => !known[s])
  if (unknown.length) problems.push(`Cites notes that were never found: ${unknown.map((s) => `t_${s}`).join(', ')}.`)
  if (!nothing && !shorts.length) problems.push('The draft cites no notes at all.')

  let llmPass = true
  if (!nothing && shorts.length) {
    const notes = await byIds(Object.values(known).map((s) => s.id))
    const r = await llm(agent, run.id, {
      system: `${agent.system_prompt}\n\nThe draft cites notes with tags like [t_1a2b3c4d]. Below are the cited notes and what the earlier workers found ` +
        `in them (an earlier worker may have seen more of a long note than is shown here; a claim it reported with the same tag counts as supported).\n` +
        `Reply with ONLY a JSON object: {"pass": true, "problems": []} or {"pass": false, "problems": ["one short, specific problem per item"]}.`,
      prompt: `The owner's order: "${order.request}"\n\nTHE DRAFT (by ${draftRun.agent}):\n${draft}\n\nWHAT EARLIER WORKERS FOUND:\n${earlierOutputs(runs, draftRun)}\n\nTHE CITED NOTES:\n\n` +
        // The Critic sees as much of each note as the workers did (the most
        // cited notes in full), so it never fails a claim it simply can't see.
        notes
          .sort((a, b) => (draft.split(shortOf(b.id)).length) - (draft.split(shortOf(a.id)).length))
          .map((x, i) => noteBlock({ ...x, matched_chunk: registry[shortOf(x.id)]?.chunk ?? null }, i < 3 ? 14000 : 3000)).join('\n\n'),
      maxTokens: 2500, source: 'crew-critic',
    })
    const parsed = parseJson(r.text)
    if (parsed) {
      llmPass = parsed.pass === true
      if (Array.isArray(parsed.problems)) {
        for (const p of parsed.problems) if (typeof p === 'string' && p.trim()) problems.push(p.trim().slice(0, 300))
      }
    } else {
      problems.push('The Critic\'s reply could not be read, so the draft is not confirmed.')
      llmPass = false
    }
  }
  const pass = llmPass && problems.length === 0
  await finishRun(db, run.id, { output: pass ? 'PASS' : `FAIL\n${problems.map((p) => `- ${p}`).join('\n')}` })

  // Failed: send it back to its worker once, if the step limit allows.
  if (!pass) {
    const workerRuns = runs.filter((r) => r.agent !== 'King').length
    const retries = runs.filter((r) => r.agent === 'Critic' && r.seq < run.seq).length
    if (retries < cfg.criticRetries && workerRuns + 2 <= cfg.maxSteps) {
      const seq = Math.max(...runs.map((r) => r.seq)) + 1
      await db.from('agent_runs').insert([
        {
          user_id: OWNER_USER_ID, order_id: order.id, seq, agent: draftRun.agent, status: 'queued', attempt: 2,
          task: `Revise your draft so it fixes what the Critic found: ${problems.join(' ')} ` +
            `Where the Critic is wrong (the note does say it), keep the point and its citation. Reply with the corrected ` +
            `piece only, written for the owner: no notes about the revision or the Critic.\n\nYour previous draft:\n${draft}`.slice(0, 9000),
        },
        { user_id: OWNER_USER_ID, order_id: order.id, seq: seq + 1, agent: 'Critic', status: 'queued', attempt: 2, task: 'Check the revised draft.' },
      ])
    }
  }
  return 'done'
}

// The King's final check: no AI call. Confirms the Critic's verdict, that
// every citation resolves to a real note, and the cost; then sends the result.
async function finalize(order: Order, runs: Run[]) {
  // Claim the finish, so two calls can't both send the result.
  const { data: claimed } = await db.from('orders').update({ finished_at: new Date().toISOString() })
    .eq('id', order.id).eq('user_id', OWNER_USER_ID).eq('status', 'running').is('finished_at', null).select('id')
  if (!claimed?.length) return
  const seq = Math.max(0, ...runs.map((r) => r.seq)) + 1
  const kingRun = await startRun(db, { userId: OWNER_USER_ID, agent: 'King', task: 'Final check and send the result', orderId: order.id, seq })
  const fixer = runs.filter((r) => r.agent === 'Fixer' && r.status === 'done').at(-1)
  const lastCritic = runs.filter((r) => r.agent === 'Critic' && r.status === 'done').at(-1)
  const draftRun = runs.filter((r) => DRAFTERS.includes(r.agent) && r.status === 'done' && r.output).at(-1)
  const fresh = (await loadOrder(order.id)) ?? order
  const crew = runs.filter((r) => r.agent !== 'King').map((r) => `${ICON[r.agent] ?? ''} ${r.agent}`).join(' → ')
  const costLine = `Cost: ${usd(fresh.total_cost)} (estimated ${usd(fresh.estimated_cost ?? 0)}) · ${Number(fresh.total_tokens).toLocaleString()} tokens`

  let text: string
  let finalOutput: string
  let citations: Registry = fresh.citations ?? {}
  if (fixer) {
    finalOutput = fixer.output
    text = `\u{1F451} Done: "${shorten(order.request, 120)}"\n\n${fixer.output}\n\nCrew: ${crew}\n${costLine}\n/o_${shortOf(order.id)}`
  } else if (draftRun) {
    const known = await resolveShorts(citedShorts(draftRun.output), citations)
    citations = { ...citations, ...known }
    const { body, sources } = numberCitations(draftRun.output, known)
    finalOutput = body
    const passed = lastCritic?.output?.startsWith('PASS')
    const warn = lastCritic && !passed
      ? `⚠️ The Critic still found problems after one revision. Read with care:\n${lastCritic.output.replace(/^FAIL\n?/, '')}\n\n`
      : ''
    text = `\u{1F451} Done: "${shorten(order.request, 120)}"\n\n${warn}${body}` +
      (sources.length ? `\n\nSources:\n${sourceLines(sources, 'telegram')}` : '') +
      `\n\nCrew: ${crew}${lastCritic ? (passed ? ' (passed)' : ' (problems flagged)') : ''}\n${costLine}\n/o_${shortOf(order.id)}`
  } else {
    finalOutput = 'No result: no step produced an output.'
    text = `\u{1F451} "${shorten(order.request, 120)}": no step produced a result.\n${costLine}\n/o_${shortOf(order.id)}`
  }

  await finishRun(db, kingRun, {
    output: fixer ? 'Fixer report sent.' : draftRun
      ? `Result from ${draftRun.agent}; Critic: ${lastCritic?.output?.split('\n')[0] ?? 'none'}; ${citedShorts(draftRun.output).length} citations checked; ${costLine}`
      : 'Nothing to send.',
  })
  const keyboard = draftRun && !fixer ? [[{ text: '\u{1F4BE} Save as report', callback_data: `ko:s:${order.id}` }]] : undefined
  await updateOrder(order.id, {
    status: 'done', final_output: finalOutput, citations, finished_at: new Date().toISOString(),
  })
  await notify(text, keyboard)
}

// ---------------------------------------------------------------------------
// The Fixer: find problems, propose exact changes, wait for Approve
// ---------------------------------------------------------------------------
const BARE_LINK = /^https?:\/\/\S+$/i

function urlOf(r: Row): string | null {
  const m = (r.metadata ?? {}) as Record<string, unknown>
  const u = (typeof m.video_url === 'string' && m.video_url) || (typeof m.url === 'string' && m.url) ||
    (r.content ?? '').match(/https?:\/\/\S+/)?.[0] || null
  return u
}

const isVideo = (r: Row) => /youtube\.com|youtu\.be/i.test(urlOf(r) ?? '') || (r.content ?? '').startsWith('\u{1F4F9}')

// How long a video is, from YouTube's app API (free). null if unknown.
async function videoSeconds(videoId: string): Promise<number | null> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '19.45.4',
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'IOS', clientVersion: '19.45.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US' } },
      }),
    })
    if (res.ok) {
      const s = Number((await res.json())?.videoDetails?.lengthSeconds)
      if (Number.isFinite(s) && s > 0) return s
    } else {
      await res.body?.cancel()
    }
  } catch { /* try the watch page */ }
  // Fallback: the normal watch page carries the length too.
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) { await res.body?.cancel(); return null }
    const html = await res.text()
    const secs = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1] ?? html.match(/"approxDurationMs":"(\d+)"/)?.[1]?.slice(0, -3))
    if (Number.isFinite(secs) && secs > 0) return secs
    const iso = html.match(/itemprop="duration" content="PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/)
    if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0) || null
    return null
  } catch {
    return null
  }
}

type Problem = { row: Row; problem: string }

// Saved videos/articles whose text is missing or cut off. Free.
async function findCaptureProblems(): Promise<{ problems: Problem[]; checked: number; notes: string[] }> {
  const { data, error } = await db.from('thoughts').select(ROW_COLUMNS)
    .eq('user_id', OWNER_USER_ID).eq('kind', 'source').or('status.is.null,status.neq.archived')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Row[]
  const ids = rows.map((r) => r.id)
  const [{ data: sources }, { data: progress }] = await Promise.all([
    db.from('thought_sources').select('thought_id, char_count, truncated, source_kind').in('thought_id', ids),
    db.from('chunk_progress').select('thought_id, total_chunks, next_index, done_at').in('thought_id', ids),
  ])
  const src = new Map((sources ?? []).map((s) => [s.thought_id, s]))
  const prog = new Map((progress ?? []).map((p) => [p.thought_id, p]))
  const problems: Problem[] = []
  const notes: string[] = []
  for (const r of rows) {
    const content = (r.content ?? '').trim()
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const s = src.get(r.id)
    const p = prog.get(r.id)
    const body = content.split('\n').slice(2).join('\n').trim()   // after the title and link lines
    if (BARE_LINK.test(content)) { problems.push({ row: r, problem: 'only the link was saved; nothing was read' }); continue }
    if (!urlOf(r)) continue
    if (isVideo(r) && (meta.has_transcript === false || meta.fetched_via === 'description' || content.includes('(No transcript could be fetched'))) {
      problems.push({ row: r, problem: 'no transcript: only the video description was saved' }); continue
    }
    if (s?.truncated) { problems.push({ row: r, problem: `the text was cut at the size limit (${s.char_count?.toLocaleString()} characters kept)` }); continue }
    if (body.length < MIN_REAL_CONTENT) { problems.push({ row: r, problem: `almost no text (${body.length} characters)` }); continue }
    if (p && p.total_chunks > 0 && !p.done_at) notes.push(`"${titleOf(r)}": still being made searchable (${p.next_index}/${p.total_chunks} pieces); that finishes on its own.`)
    if (isVideo(r) && typeof meta.video_id === 'string') {
      const secs = await videoSeconds(meta.video_id)
      if (secs && secs > 120) {
        const words = body.split(/\s+/).filter(Boolean).length
        const wpm = words / (secs / 60)
        // People speak about 120-170 words a minute. Far fewer = cut off.
        if (wpm < 60) {
          problems.push({ row: r, problem: `looks cut off: ${words.toLocaleString()} words for a ${Math.round(secs / 60)}-minute video (about ${Math.round(wpm)} words a minute; speech is usually 120+)` })
        }
      } else if (!secs) {
        // YouTube often refuses the length lookup from servers. Then: a
        // punctuated transcript that stops mid-sentence may be cut off; the
        // Fixer re-reads it to compare (and only proposes a longer text).
        const sentences = (body.match(/[.!?](\s|$)/g) ?? []).length
        if (sentences >= 20 && !/[.!?)"'\]…]$/.test(body.trimEnd())) {
          problems.push({ row: r, problem: `may be cut off: the transcript stops mid-sentence ("…${body.trimEnd().slice(-40)}")` })
        }
      }
    }
  }
  return { problems, checked: rows.length, notes }
}

type Change = {
  action: 'recapture' | 'archive' | 'set_kind'
  id: string; short: string; title: string; reason: string
  kind?: string; from_kind?: string | null
  url?: string; before_chars?: number; after_chars?: number
  preview?: { content: string; metadata: Record<string, unknown>; source_text: string; source_kind: string; truncated: boolean }
}

// Read a link again WITHOUT saving (capture "preview" mode).
async function previewCapture(row: Row, url: string) {
  const endpoint = /youtube\.com|youtu\.be/i.test(url) ? 'capture-youtube' : 'capture-url'
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
    method: 'POST',
    headers: internalHeaders({ Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY }),
    body: JSON.stringify({ url, thought_id: row.id, preview: true }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok || !body.preview) return { ok: false as const, error: String(body.error ?? `HTTP ${res.status}`) }
  return {
    ok: true as const,
    chars: Number(body.chars ?? 0),
    hasTranscript: body.has_transcript !== false,
    preview: {
      content: String(body.content ?? ''), metadata: (body.metadata ?? {}) as Record<string, unknown>,
      source_text: String(body.source_text ?? ''), source_kind: String(body.source_kind ?? 'web'), truncated: body.truncated === true,
    },
  }
}

const FIX_WORDS = /\b(videos?|transcripts?|links?|captures?|articles?|pdfs?|cut[- ]off|missing|truncated|re-?capture|re-?read)\b/i

async function fixerPropose(order: Order, run: Run, agent: Agent): Promise<'done' | 'waiting'> {
  const query = queryFor(order, run)
  const changes: Change[] = []
  const report: string[] = []
  const lines: string[] = []

  if (FIX_WORDS.test(`${order.request} ${run.task}`)) {
    // Transcript / capture problems: found by rules, no AI needed.
    const scan = await findCaptureProblems()
    report.push(`Checked ${scan.checked} saved sources.`)
    for (const n of scan.notes) report.push(`Note: ${n}`)
    for (const { row, problem } of scan.problems) {
      const url = urlOf(row)
      if (!url) continue
      const before = (row.content ?? '').length
      const p = await previewCapture(row, url)
      if (!p.ok) { report.push(`"${titleOf(row)}": ${problem}. I tried reading it again and couldn't (${p.error}). Paste the text in Telegram instead.`); continue }
      const better = p.chars >= MIN_REAL_CONTENT && p.preview.content.length > before * 1.1 && (p.hasTranscript || !isVideo(row))
      if (!better) {
        report.push(`"${titleOf(row)}": ${problem}. Reading it again gave nothing better (${p.preview.content.length.toLocaleString()} vs ${before.toLocaleString()} characters), so I left it alone.`)
        continue
      }
      changes.push({
        action: 'recapture', id: row.id, short: shortOf(row.id), title: titleOf(row), reason: problem, url,
        before_chars: before, after_chars: p.preview.content.length, preview: p.preview,
      })
    }
  } else {
    // Other housekeeping (archive, change kind): the Fixer proposes from the
    // thoughts that match, and the code checks every proposal.
    const rows = (await search(query, null, 8))
    if (rows.length) {
      const r = await llm(agent, run.id, {
        system: `${agent.system_prompt}\n\nKinds you may set: ${[...PICKABLE.personal, ...PICKABLE.library].join(', ')}.\n` +
          `Reply with ONLY a JSON object: {"changes": [{"action": "archive" | "set_kind" | "recapture", "id": "t_1a2b3c4d", "kind": "only for set_kind", "reason": "one line"}]}. ` +
          `Propose nothing ({"changes": []}) if the order doesn't clearly call for a change to these thoughts.`,
        prompt: `The owner's order: "${order.request}"\nYour task: ${run.task}\n\nMatching thoughts:\n\n` +
          rows.map((x) => `${tag(x.id)} kind ${x.kind ?? 'none'} · status ${x.status ?? 'active'} · ${titleOf(x)}${urlOf(x) ? ` · ${urlOf(x)}` : ''}`).join('\n'),
        maxTokens: 1500, source: 'crew-fixer',
      })
      const parsed = parseJson(r.text)
      const byShort = new Map(rows.map((x) => [shortOf(x.id), x]))
      for (const c of Array.isArray(parsed?.changes) ? parsed!.changes as Record<string, unknown>[] : []) {
        const short = citedShorts(String(c.id ?? ''))[0]
        const row = short ? byShort.get(short) : undefined
        const action = String(c.action ?? '')
        const reason = String(c.reason ?? '').slice(0, 200)
        if (!row) continue
        if (action === 'archive' && row.status !== 'archived') {
          changes.push({ action: 'archive', id: row.id, short, title: titleOf(row), reason })
        } else if (action === 'set_kind') {
          const kind = String(c.kind ?? '')
          if ([...PICKABLE.personal, ...PICKABLE.library].includes(kind) && kind !== row.kind) {
            changes.push({ action: 'set_kind', id: row.id, short, title: titleOf(row), reason, kind, from_kind: row.kind })
          }
        } else if (action === 'recapture' && urlOf(row)) {
          const p = await previewCapture(row, urlOf(row)!)
          if (p.ok && p.preview.content.length > (row.content ?? '').length) {
            changes.push({
              action: 'recapture', id: row.id, short, title: titleOf(row), reason, url: urlOf(row)!,
              before_chars: (row.content ?? '').length, after_chars: p.preview.content.length, preview: p.preview,
            })
          }
        }
      }
    }
    if (!changes.length) report.push(rows.length ? 'Nothing among the matching thoughts clearly needs changing.' : `No thoughts match "${query}".`)
  }

  if (!changes.length) {
    await finishRun(db, run.id, { output: `\u{1F527} Fixer: nothing to change.\n${report.join('\n')}`.trim() })
    return 'done'
  }

  for (const [i, c] of changes.entries()) {
    lines.push(`${i + 1}. ` + (c.action === 'recapture'
      ? `Re-capture /t_${c.short} "${c.title}" from ${c.url}: replace ${c.before_chars?.toLocaleString()} characters with ${c.after_chars?.toLocaleString()} (old text kept in its metadata). Why: ${c.reason}.`
      : c.action === 'archive'
      ? `Archive /t_${c.short} "${c.title}" (hidden everywhere, not deleted). Why: ${c.reason}.`
      : `Change /t_${c.short} "${c.title}" from ${KIND_LABEL[c.from_kind ?? ''] ?? c.from_kind ?? 'no kind'} to ${KIND_LABEL[c.kind!] ?? c.kind}. Why: ${c.reason}.`))
  }
  const summary = `\u{1F527} The Fixer wants to make ${changes.length} change${changes.length > 1 ? 's' : ''}:\n\n${lines.join('\n')}` +
    (report.length ? `\n\n${report.join('\n')}` : '') + `\n\nNothing changes until you tap Approve. Nothing is ever deleted.`
  await updateRun(run.id, { status: 'waiting_on_me', proposal: { changes }, output: summary })
  await updateOrder(order.id, { status: 'waiting_on_me' })
  await notify(summary, [[
    { text: '✅ Approve', callback_data: `fx:a:${run.id}` },
    { text: '✖️ Reject', callback_data: `fx:n:${run.id}` },
  ]])
  return 'waiting'
}

async function applyChange(c: Change, orderId: string): Promise<string> {
  const { data: row } = await db.from('thoughts').select(ROW_COLUMNS).eq('id', c.id).eq('user_id', OWNER_USER_ID).maybeSingle()
  if (!row) return `✖️ /t_${c.short}: not found, skipped.`
  const meta = { ...((row.metadata ?? {}) as Record<string, unknown>) }
  if (c.action === 'archive') {
    const { error } = await db.from('thoughts').update({
      status: 'archived',
      metadata: { ...meta, archived_by: 'fixer', fixer_order_id: orderId, archived_at: new Date().toISOString(), archived_reason: c.reason },
    }).eq('id', c.id).eq('user_id', OWNER_USER_ID)
    return error ? `✖️ Archive /t_${c.short} failed: ${error.message}` : `✅ Archived /t_${c.short} "${c.title}" (not deleted).`
  }
  if (c.action === 'set_kind') {
    const { error } = await db.from('thoughts').update({ kind: c.kind, kind_set_by: 'manual' })
      .eq('id', c.id).eq('user_id', OWNER_USER_ID)
    return error ? `✖️ Kind change /t_${c.short} failed: ${error.message}` : `✅ /t_${c.short} "${c.title}" is now ${KIND_LABEL[c.kind!] ?? c.kind} (logged in kind_changes).`
  }
  if (c.action === 'recapture' && c.preview) {
    // The text being replaced is kept in the thought's metadata.
    await db.from('thoughts').update({
      metadata: { ...meta, fixer_previous_content: row.content, fixer_order_id: orderId, fixer_at: new Date().toISOString() },
    }).eq('id', c.id).eq('user_id', OWNER_USER_ID)
    await refillThought(db, {
      thoughtId: c.id, content: c.preview.content, metadata: { ...c.preview.metadata, fixer_order_id: orderId },
      sourceText: c.preview.source_text, sourceKind: c.preview.source_kind, truncated: c.preview.truncated,
    })
    return `✅ Re-captured /t_${c.short} "${c.title}": ${c.after_chars?.toLocaleString()} characters (was ${c.before_chars?.toLocaleString()}). Tags, embedding and chunks are being redone.`
  }
  return `✖️ /t_${c.short}: unknown change, skipped.`
}

async function fixerDecision(runId: string, approve: boolean) {
  const { data: run } = await db.from('agent_runs').select('*').eq('id', runId).eq('user_id', OWNER_USER_ID).maybeSingle()
  if (!run || run.agent !== 'Fixer') return { ok: false, toast: 'Not found.' }
  // Claim it, so a double tap can't apply twice.
  const { data: claimed } = await db.from('agent_runs')
    .update({ status: 'working', updated_at: new Date().toISOString() })
    .eq('id', runId).eq('status', 'waiting_on_me').select('id')
  if (!claimed?.length) return { ok: false, toast: 'Already answered.' }
  const order = await loadOrder(run.order_id)
  const changes: Change[] = run.proposal?.changes ?? []
  let output: string
  if (approve) {
    const results: string[] = []
    for (const c of changes) {
      try { results.push(await applyChange(c, run.order_id)) } catch (e) { results.push(`✖️ /t_${c.short}: ${e}`) }
    }
    output = `\u{1F527} Fixer, approved by you:\n${results.join('\n')}`
  } else {
    output = '\u{1F527} Fixer: you rejected the changes. Nothing was changed.'
  }
  // Keep the proposal, drop the stored preview text (it is in the thought now).
  const slim = changes.map(({ preview: _p, ...rest }) => rest)
  await updateRun(runId, { proposal: { changes: slim, decision: approve ? 'approved' : 'rejected', decided_at: new Date().toISOString() } })
  await finishRun(db, runId, { output })
  if (order) {
    await updateOrder(order.id, { status: 'running' })
    await kick(order.id)
  }
  return { ok: true, toast: approve ? 'Approved' : 'Rejected', text: `${run.output}\n\n${approve ? '✅ Approved.' : '✖️ Rejected.'}` }
}

// ---------------------------------------------------------------------------
// Buttons, listing, resume
// ---------------------------------------------------------------------------
async function orderButton(orderId: string, button: string) {
  const order = await loadOrder(orderId)
  if (!order) return { ok: false, toast: 'Order not found.' }
  const cfg = await loadConfig()
  if (button === 'a') {
    if (order.status !== 'awaiting_approval') return { ok: false, toast: `Already ${order.status.replace(/_/g, ' ')}.` }
    const started = await approve(order)
    return started
      ? { ok: true, toast: 'Approved', text: `${order.plan_text}\n\n✅ Approved. The crew is working; the result will come here.` }
      : { ok: false, toast: 'Could not start it.' }
  }
  if (button === 'c') {
    if (!['awaiting_approval', 'planning'].includes(order.status)) return { ok: false, toast: `Already ${order.status.replace(/_/g, ' ')}.` }
    await updateOrder(orderId, { status: 'cancelled', error: 'Cancelled by the owner', finished_at: new Date().toISOString() })
    return { ok: true, toast: 'Cancelled', text: `${order.plan_text}\n\n✖️ Cancelled. Nothing ran.` }
  }
  if (button === 'g' || button === 'x') {
    if (order.status !== 'waiting_on_me') return { ok: false, toast: 'Already answered.' }
    const { data: waiting } = await db.from('agent_runs').select('id').eq('order_id', orderId).eq('status', 'waiting_on_me').neq('agent', 'Fixer')
    if (!waiting?.length) return { ok: false, toast: 'Nothing is waiting on the cap.' }
    if (button === 'g') {
      const cap = Number(order.cost_cap ?? cfg.costCap) + cfg.costCap
      await db.from('agent_runs').update({ status: 'queued' }).eq('order_id', orderId).eq('status', 'waiting_on_me')
      await updateOrder(orderId, { status: 'running', cost_cap: cap })
      await kick(orderId)
      return { ok: true, toast: `Going on (cap now ${usd(cap)})`, text: `Going on. This order's cap is now ${usd(cap)}.` }
    }
    await db.from('agent_runs').update({ status: 'failed', error: 'stopped by the owner at the cost cap', finished_at: new Date().toISOString() })
      .eq('order_id', orderId).in('status', ['queued', 'waiting_on_me'])
    await updateOrder(orderId, { status: 'cancelled', error: 'Stopped by the owner at the cost cap', finished_at: new Date().toISOString() })
    return { ok: true, toast: 'Stopped', text: `Stopped at ${usd(order.total_cost)}. /o_${shortOf(orderId)} shows what was done.` }
  }
  if (button === 's') {
    if (order.status !== 'done' || !order.final_output) return { ok: false, toast: 'Nothing to save yet.' }
    if (order.report_thought_id) return { ok: false, toast: 'Already saved.' }
    const known: Registry = order.citations ?? {}
    const cited = citedShorts(order.final_output).length ? citedShorts(order.final_output) : []
    const { sources } = numberCitations(
      (await loadRuns(orderId)).filter((r) => DRAFTERS.includes(r.agent) && r.status === 'done').at(-1)?.output ?? '', known,
    )
    const content = `\u{1F916} Crew report: ${order.request}\n\n${order.final_output}` +
      (sources.length ? `\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} (${s.label}, ${fmtDate(s.created_at)}, id ${s.id})`).join('\n')}` : '')
    const { data: saved, error } = await db.from('thoughts').insert({
      user_id: OWNER_USER_ID, content, kind: 'report', kind_set_by: 'manual',
      metadata: { source: 'crew', order_id: orderId, cited_ids: sources.map((s) => s.id), cited_shorts: cited },
    }).select('id').single()
    if (error) return { ok: false, toast: `Could not save: ${error.message}` }
    await updateOrder(orderId, { report_thought_id: saved.id })
    return { ok: true, toast: 'Saved as a report', keepText: true, reply: `\u{1F4BE} Saved to Personal (AI write-up) /t_${shortOf(saved.id)}. It counts half in search, so your own notes still come first.` }
  }
  return { ok: false, toast: 'Unknown button.' }
}

async function findOrder(ref: string): Promise<Order | null> {
  const s = ref.toLowerCase().replace(/^o_/, '')
  if (/^[0-9a-f-]{36}$/.test(s)) return await loadOrder(s)
  if (!/^[0-9a-f]{8}$/.test(s)) return null
  const { data } = await db.from('orders').select('*').eq('user_id', OWNER_USER_ID)
    .gte('id', `${s}-0000-0000-0000-000000000000`).lte('id', `${s}-ffff-ffff-ffff-ffffffffffff`).limit(1).maybeSingle()
  return data
}

async function listOrders(): Promise<string> {
  const { data } = await db.from('orders').select('id, request, status, total_cost, created_at')
    .eq('user_id', OWNER_USER_ID).order('created_at', { ascending: false }).limit(10)
  if (!data?.length) return 'No orders yet. Try: /king make me a study plan for …'
  return '\u{1F451} Your last orders:\n\n' + data.map((o, i) =>
    `${i + 1}. ${STATUS_ICON[o.status] ?? ''} ${o.status.replace(/_/g, ' ')} · ${new Date(o.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${usd(o.total_cost)}\n` +
    `   ${shorten(o.request, 70)}  /o_${shortOf(o.id)}`).join('\n')
}

async function orderText(order: Order, style: 'telegram' | 'mcp'): Promise<string> {
  const runs = await loadRuns(order.id)
  const steps = runs.map((r) => `${r.seq}. ${ICON[r.agent] ?? ''} ${r.agent} · ${STATUS_ICON[r.status] ?? ''} ${r.status.replace(/_/g, ' ')} · ${usd(r.cost)} · ${shorten(r.task ?? '', 90)}` +
    (r.error ? `\n   error: ${shorten(r.error, 150)}` : ''))
  let result = ''
  if (order.final_output) {
    const draftRun = runs.filter((r) => DRAFTERS.includes(r.agent) && r.status === 'done' && r.output).at(-1)
    const { sources } = numberCitations(draftRun?.output ?? '', order.citations ?? {})
    result = `\n\nResult:\n${order.final_output}` + (sources.length ? `\n\nSources:\n${sourceLines(sources, style)}` : '')
  } else if (order.plan_text && order.status === 'awaiting_approval') {
    result = `\n\n${order.plan_text}`
  }
  return `\u{1F451} Order ${style === 'telegram' ? `/o_${shortOf(order.id)}` : order.id} · ${order.status.replace(/_/g, ' ')} · ${fmtDate(order.created_at)}\n"${order.request}"\n\n` +
    `Steps:\n${steps.join('\n') || '(none yet)'}\n\nCost: ${usd(order.total_cost)} (estimated ${usd(order.estimated_cost ?? 0)}, cap ${usd(order.cost_cap ?? 0)}) · ` +
    `${Number(order.total_tokens).toLocaleString()} tokens${order.error ? `\nNote: ${order.error}` : ''}${result}`
}

// pg_cron every 15 minutes: restart lost hand-offs, retry stuck steps once,
// and close background (Scout) runs whose work finished.
async function resume() {
  const out: string[] = []
  const now = Date.now()
  const { data: working } = await db.from('agent_runs').select('id, order_id, agent, attempt, started_at, thought_id, job')
    .eq('status', 'working').eq('user_id', OWNER_USER_ID)
  for (const r of working ?? []) {
    const age = now - Date.parse(r.started_at ?? new Date().toISOString())
    if (r.order_id) {
      if (age < STUCK_WORKING_MS) continue
      if (r.attempt < 2) {
        await updateRun(r.id, { status: 'queued', attempt: r.attempt + 1, error: 'retried: the step stopped without finishing' })
        await updateOrder(r.order_id, { status: 'running' })
        out.push(`retry ${r.agent} in ${r.order_id}`)
      } else {
        await finishRun(db, r.id, { status: 'failed', error: 'stopped twice without finishing' })
        const order = await loadOrder(r.order_id)
        if (order) await failOrder(order, `${r.agent} stopped twice without finishing`)
        out.push(`failed ${r.agent} in ${r.order_id}`)
      }
    } else if (r.thought_id && age > 10 * 60_000) {
      // A background job on one thought: done once the thought is fully embedded.
      const { data: t } = await db.from('thoughts').select('embedded_at').eq('id', r.thought_id).maybeSingle()
      if (t?.embedded_at) { await finishRun(db, r.id, { output: 'Finished (embedding and chunks done).' }); out.push(`closed ${r.job}`) }
      else if (age > 3 * 3600_000) { await finishRun(db, r.id, { status: 'failed', error: 'did not finish within 3 hours' }); out.push(`failed ${r.job}`) }
    } else if (!r.thought_id && age > 3 * 3600_000) {
      await finishRun(db, r.id, { status: 'failed', error: 'did not finish within 3 hours' })
    }
  }
  const { data: running } = await db.from('orders').select('id, updated_at').eq('status', 'running').eq('user_id', OWNER_USER_ID)
  for (const o of running ?? []) {
    if (now - Date.parse(o.updated_at) < 2 * 60_000) continue
    const runs = await loadRuns(o.id)
    if (runs.some((r) => r.status === 'working')) continue
    await kick(o.id)
    out.push(`kicked ${o.id}`)
  }
  const { data: planning } = await db.from('orders').select('id, created_at').eq('status', 'planning').eq('user_id', OWNER_USER_ID)
  for (const o of planning ?? []) {
    if (now - Date.parse(o.created_at) > 10 * 60_000) {
      await updateOrder(o.id, { status: 'failed', error: 'Planning never finished', finished_at: new Date().toISOString() })
      out.push(`planning failed ${o.id}`)
    }
  }
  return { ok: true, resumed: out }
}

// ---------------------------------------------------------------------------
// Brain HQ (hq.html): the SAME buttons as Telegram, for the signed-in owner.
// The page sends the owner's login token. Only these actions exist here:
// Approve / Cancel a plan, Go on / Stop at the cost cap, Approve / Reject a
// Fixer change list. Each one runs the exact Telegram code path (orderButton,
// fixerDecision) with all its checks; nothing else is reachable.
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const WEB_BUTTONS: Record<string, string> = { approve: 'a', cancel: 'c', go_on: 'g', stop: 'x' }

async function webAction(req: Request, body: Record<string, unknown>) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token || token === ANON_KEY) return { status: 401, body: { ok: false, error: 'Sign in first.' } }
  const { data, error } = await db.auth.getUser(token)
  if (error || !data?.user || data.user.id !== OWNER_USER_ID) {
    return { status: 403, body: { ok: false, error: 'Only the owner can do this.' } }
  }
  const op = String(body.op ?? '')
  let result: { ok: boolean; toast?: string; text?: string }
  let what = ''
  if (WEB_BUTTONS[op]) {
    const order = await loadOrder(String(body.order_id ?? ''))
    if (!order) return { status: 404, body: { ok: false, error: 'Order not found.' } }
    result = await orderButton(order.id, WEB_BUTTONS[op])
    what = `"${shorten(order.request, 80)}" /o_${shortOf(order.id)}`
  } else if (op === 'fixer_approve' || op === 'fixer_reject') {
    result = await fixerDecision(String(body.run_id ?? ''), op === 'fixer_approve')
    what = 'the Fixer’s change list'
  } else {
    return { status: 400, body: { ok: false, error: 'Unknown action.' } }
  }
  // Keep the Telegram chat in step (only ever the owner's own chat).
  if (result.ok) await notify(`\u{1F3E2} From Brain HQ: ${result.toast ?? op} · ${what}`)
  return { status: 200, body: { ok: result.ok, toast: result.toast ?? '' } }
}

// ---------------------------------------------------------------------------
// The front door (internal only, except the Brain HQ buttons above)
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (!OWNER_USER_ID) return json({ error: 'OWNER_USER_ID is not set' }, 500)
  const body = await req.json().catch(() => ({}))
  if (body?.action === 'web') {
    try {
      const r = await webAction(req, body)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch (e) {
      console.error('crew web error:', e)
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }
  const denied = rejectUnlessInternal(req)
  if (denied) return denied
  try {
    switch (body?.action) {
      case 'plan':
        return json(await planOrder({
          text: String(body.text ?? ''),
          source: ['telegram', 'button', 'mcp'].includes(body.source) ? body.source : 'telegram',
          chatId: typeof body.chat_id === 'string' ? body.chat_id : null,
        }))
      case 'edit': {
        const old = await loadOrder(String(body.order_id ?? ''))
        if (!old) return json({ ok: false, error: 'order not found' }, 404)
        if (old.status === 'awaiting_approval') {
          await updateOrder(old.id, { status: 'cancelled', error: 'Replaced by an edited order', finished_at: new Date().toISOString() })
        }
        return json(await planOrder({ text: String(body.text ?? ''), source: old.source, chatId: old.chat_id, parentId: old.id }))
      }
      case 'advance': {
        const id = String(body.order_id ?? '')
        // Answer at once (confirms the hand-off); the step runs after.
        EdgeRuntime.waitUntil(advance(id).catch((e) => console.log(`advance ${id} failed: ${e}`)))
        return json({ ok: true, queued: id })
      }
      case 'button':
        return json(await orderButton(String(body.order_id ?? ''), String(body.button ?? '')))
      case 'fixer':
        return json(await fixerDecision(String(body.run_id ?? ''), body.approve === true))
      case 'list':
        return json({ ok: true, text: await listOrders() })
      case 'show': {
        const order = await findOrder(String(body.order ?? ''))
        if (!order) return json({ ok: false, text: 'I could not find that order.' })
        return json({ ok: true, text: await orderText(order, body.style === 'mcp' ? 'mcp' : 'telegram'), status: order.status })
      }
      case 'resume':
        return json(await resume())
      case 'scan': { // read-only: what the Fixer would look at (for tests)
        const s = await findCaptureProblems()
        return json({
          ok: true, checked: s.checked, notes: s.notes,
          problems: s.problems.map((p) => ({ id: p.row.id, title: titleOf(p.row), problem: p.problem })),
        })
      }
      default:
        return json({ ok: false, error: 'unknown action' }, 400)
    }
  } catch (e) {
    console.error('crew error:', e)
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
