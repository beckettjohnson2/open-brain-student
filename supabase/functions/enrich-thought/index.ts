// enrich-thought — runs automatically every time a new thought is saved.
// Asks the AI (through YOUR gateway, call-llm) for tags, a category and a
// one-sentence summary, then writes them back onto the thought.
//
// It never talks to Claude directly. Swap providers in Supabase secrets,
// and this file doesn't change.
//
// Levels 6 + 7: after tagging, it also EMBEDS the thought (turns its meaning
// into 384 numbers with Supabase's free built-in gte-small model), cuts long
// thoughts into overlapping chunks, and links it to its closest neighbours.
//
// Three ways in:
//   INSERT   — your Database Webhook, on every new thought (tag + embed)
//   BACKFILL — the backfill script: embeds thoughts with no embedded_at yet.
//              Never calls the AI tagger, so it costs nothing.
//   RELINK   — rebuilds links for one page of thoughts (after a threshold change)
//   CLASSIFY — scripts/backfill-kind.ps1: sets `kind` on thoughts that have
//              none. Simple rules first; a short Haiku call only when the
//              rules can't decide. Never touches tags.
//
// New thoughts get `kind` here too: rules first, and if the rules can't
// decide, "kind" is added to the same tagging call (no extra AI call).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { internalHeaders, rejectUnlessInternal } from "../_shared/internal-auth.ts";
import { KINDS, type KindInput, kindByRules, sectionOf } from "../_shared/kinds.ts";
import { finishRun, startRun } from "../_shared/runs.ts";

// Every job here is the "Scout" agent in the run log (agent_runs). A new
// thought's run stays "working" until its embedding and chunks are done (the
// run id rides along with each CONTINUE hand-off). AI calls pass the run id
// to call-llm, which adds their tokens and cost to the run.
const owner = () => Deno.env.get("OWNER_USER_ID") || null;
function preview(text: string | null | undefined, max = 80): string {
  const first = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
  const s = first.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];
const MIN_LENGTH = 20;        // skip tiny notes like "test" or "ok"
const MAX_CHARS = 12_000;     // long captures get trimmed for enrichment — keeps each call cheap

// --- Embedding settings -------------------------------------------------
// gte-small reads only ~512 tokens, so the main embedding uses the summary,
// the tags and the START of the content. Longer thoughts also get chunks.
const MAIN_WORDS = 200;          // words of content in the main embedding
const CHUNK_MIN_WORDS = 300;     // only chunk thoughts longer than this
const CHUNK_WORDS = 250;         // words per chunk
const CHUNK_OVERLAP = 50;        // words shared with the previous chunk
// Supabase gives each call ~2 seconds of computing. Embedding is heavy, so
// each call works for about 1 second, then hands the rest of a long thought
// to a fresh call of this same function ("CONTINUE").
const WORK_MS = 1000;
// Hard cap per call, so a cold start (loading the model also uses computing)
// plus the chunks still fits in the allowance. Progress is saved per chunk.
const CHUNKS_PER_CALL = 3;
// RESUME (pg_cron, every 15 min): after this many checks in a row with no
// progress on a thought, tell the owner in Telegram (once).
const STUCK_AFTER = 3;

// --- Graph settings -----------------------------------------------------
// gte-small scores run high (on this brain the 80 closest pairs all scored
// above 0.875), so the bar is set high. 0.875 was the lowest score where
// pairs were still clearly about the same thing — see SETUP-NOTES.md.
const LINK_THRESHOLD = 0.875;
const LINK_COUNT = 5;

const embedder = new Supabase.ai.Session("gte-small");

const SYSTEM_PROMPT = `You label notes for a personal knowledge base.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"tags": ["tag1", "tag2", "tag3"], "category": "learning", "summary": "One sentence."}
Rules:
- tags: 3 to 5 short lowercase tags (1-3 words each) about the topic
- category: exactly one of: ${CATEGORIES.join(", ")}
- summary: one sentence, under 30 words, plain language`;

// =====================================================================
// KIND — what sort of thing a thought is
// =====================================================================
// my_thought, project_doc and class_note are the owner's own writing;
// source is someone else's (videos, articles); course_setup is the build
// prompts (left out of search and digests); report is AI-written summaries.
const KIND_GUIDE = `- my_thought: the owner's own personal thought, idea, goal, feeling or reflection
- project_doc: a longer document the owner wrote about themselves, a project, or their plans
- class_note: notes, assignments, essays or lab material for a class the owner is taking
- source: content made by someone else that the owner saved (video transcript, article, web page, outside PDF)
- course_setup: instructions or prompts for building this note-taking app itself
- report: an AI-written summary, digest or research write-up`;

function parseKind(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const raw = JSON.parse(match[0]);
      const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
      if (KINDS.includes(kind)) return kind;
    } catch { /* fall through */ }
  }
  // Not clean JSON: accept a reply that names exactly one kind.
  const named = KINDS.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(text));
  return named.length === 1 ? named[0] : null;
}

// Save kind on its own, so a problem here can never undo tagging.
async function saveKind(supabase: SupabaseClient, id: string, kind: string, setBy: "rule" | "llm") {
  // Never overwrite a kind the owner picked by hand.
  const { error } = await supabase.from("thoughts").update({ kind, kind_set_by: setBy })
    .eq("id", id).or("kind_set_by.is.null,kind_set_by.neq.manual");
  if (error) console.log(`could not save kind for ${id}: ${error.message}`);
  return !error;
}

// One short Haiku call through call-llm, for the backfill.
async function kindByLlm(
  t: KindInput & { id: string; user_id?: string | null },
  supabaseUrl: string,
  serviceKey: string,
  runId?: string | null,
): Promise<string | null> {
  const res = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...(runId ? { runId } : {}),
      systemPrompt:
        `You sort notes in one person's personal knowledge base by who wrote them and what they are.\n` +
        `Reply with ONLY a JSON object like {"kind": "my_thought"}. kind is exactly one of:\n${KIND_GUIDE}`,
      prompt: `Note (may be cut short):\n"""\n${(t.content ?? "").slice(0, 3000)}\n"""`,
      // Room for Haiku's built-in thinking; the answer itself is a few tokens.
      maxTokens: 1024,
      userId: t.user_id ?? undefined,
      source: "classify-kind",
    }),
  });
  if (!res.ok) throw new Error(`call-llm failed (${res.status}): ${await res.text()}`);
  const { text } = await res.json();
  return parseKind(String(text ?? ""));
}

// CLASSIFY: give a kind to the next few thoughts that have none.
async function classify(supabase: SupabaseClient, batchSize: number, supabaseUrl: string, serviceKey: string, runId?: string | null) {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, category, metadata, user_id")
    .is("kind", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(error.message);

  const results: string[] = [];
  let failed = 0;
  for (const t of data ?? []) {
    try {
      let kind = kindByRules(t);
      let setBy: "rule" | "llm" = "rule";
      if (!kind) {
        kind = await kindByLlm(t, supabaseUrl, serviceKey, runId);
        setBy = "llm";
      }
      if (!kind) {
        failed++;
        results.push(`failed ${t.id}: the AI gave no valid kind`);
        continue;
      }
      if (!(await saveKind(supabase, t.id, kind, setBy))) throw new Error("save failed");
      const preview = (t.content ?? "").replace(/\s+/g, " ").slice(0, 50);
      results.push(`${kind.padEnd(12)} (${setBy})  ${preview}`);
    } catch (e) {
      failed++;
      results.push(`failed ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const { count } = await supabase
    .from("thoughts").select("id", { count: "exact", head: true }).is("kind", null);
  return { ok: true, processed: results, failed, remaining: count ?? 0 };
}

function ok(message: string) {
  // Webhook functions always answer 200, even when they skip or fail.
  // Saving the thought already worked — enrichment is a bonus, never a blocker.
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Pull the JSON object out of the AI's reply, even if it wrapped it in ```json fences.
function parseEnrichment(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in reply: ${text.slice(0, 200)}`);
  const raw = JSON.parse(match[0]);

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t: unknown) => typeof t === "string" && t.trim() !== "")
        .map((t: string) => t.trim().toLowerCase())
        .slice(0, 5)
    : [];

  const category = typeof raw.category === "string" && CATEGORIES.includes(raw.category.toLowerCase())
    ? raw.category.toLowerCase()
    : null;

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : null;

  return { tags, category, summary };
}

// =====================================================================
// EMBEDDING, CHUNKING AND LINKING (Levels 6 + 7)
// =====================================================================
type Row = {
  id: string;
  content: string | null;
  user_id: string | null;
  tags: string[] | null;
  category: string | null;
  summary: string | null;
};

async function embed(text: string): Promise<string> {
  const vector = await embedder.run(text, { mean_pool: true, normalize: true });
  // pgvector accepts the numbers as a "[0.1,0.2,...]" string
  return JSON.stringify(Array.from(vector as number[]));
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Summary + tags + the start of the content: what the thought is ABOUT.
function mainText(row: Row): string {
  return [
    row.summary ?? "",
    row.tags?.length ? `Tags: ${row.tags.join(", ")}` : "",
    words(row.content ?? "").slice(0, MAIN_WORDS).join(" "),
  ].filter(Boolean).join("\n");
}

// ~250-word pieces, each overlapping the last by ~50 words, so a sentence
// on a boundary is whole in at least one piece.
function chunkText(content: string): string[] {
  const all = words(content);
  if (all.length <= CHUNK_MIN_WORDS) return [];
  const chunks: string[] = [];
  for (let start = 0; start < all.length; start += CHUNK_WORDS - CHUNK_OVERLAP) {
    chunks.push(all.slice(start, start + CHUNK_WORDS).join(" "));
    if (start + CHUNK_WORDS >= all.length) break;
  }
  return chunks;
}

// Link a thought to its closest neighbours. Pairs are stored smaller-id
// first, which the table requires, so a→b and b→a can't both exist.
async function linkThought(supabase: SupabaseClient, row: Row): Promise<number> {
  if (row.category === "digest") return 0;   // digests would link to everything
  const { data, error } = await supabase.rpc("find_link_candidates", {
    p_thought_id: row.id,
    match_count: LINK_COUNT,
    min_similarity: LINK_THRESHOLD,
  });
  if (error) throw new Error(`find_link_candidates: ${error.message}`);
  if (!data?.length) return 0;

  const links = data.map((c: { id: string; similarity: number }) => ({
    from_id: row.id < c.id ? row.id : c.id,
    to_id: row.id < c.id ? c.id : row.id,
    similarity: c.similarity,
    user_id: row.user_id,
  }));
  const { error: linkError } = await supabase
    .from("thought_links")
    .upsert(links, { onConflict: "from_id,to_id", ignoreDuplicates: true });
  if (linkError) throw new Error(`thought_links: ${linkError.message}`);
  return links.length;
}

// Where to start: the first chunk whose saved text is missing or differs
// from the current content. Comparing the text (not just counting rows)
// means a gap is filled and a thought whose content was replaced (a link
// refilled with its transcript) is rechunked, even when the new text has
// the same number of chunks. RECHUNK can force an earlier start through
// the progress row (next_index = 0).
async function chunkStart(supabase: SupabaseClient, id: string, chunks: string[]): Promise<number> {
  const { data, error } = await supabase
    .from("thought_chunks").select("chunk_index, content").eq("thought_id", id);
  if (error) throw new Error(`thought_chunks read: ${error.message}`);
  const saved = new Map((data ?? []).map((c: { chunk_index: number; content: string }) => [c.chunk_index, c.content]));
  let i = 0;
  while (i < chunks.length && saved.get(i) === chunks[i]) i++;
  const { data: progress } = await supabase
    .from("chunk_progress").select("next_index, total_chunks").eq("thought_id", id).maybeSingle();
  if (progress && progress.total_chunks === chunks.length) i = Math.min(i, progress.next_index);
  return i;
}

async function saveProgress(supabase: SupabaseClient, row: Row, fields: Record<string, unknown>) {
  const { error } = await supabase.from("chunk_progress").upsert({
    thought_id: row.id,
    user_id: row.user_id,
    updated_at: new Date().toISOString(),
    ...fields,
  }, { onConflict: "thought_id" });
  if (error) console.log(`chunk_progress ${row.id}: ${error.message}`);
}

// Embed chunks, picking up where a previous call stopped. Small, resumable
// steps: at most CHUNKS_PER_CALL chunks per call, and each chunk is saved
// (and progress recorded) the moment it's embedded, so a call that gets cut
// off loses at most one chunk of work. Returns true when every chunk is done.
async function embedChunks(supabase: SupabaseClient, row: Row, deadline: number): Promise<boolean> {
  const chunks = chunkText(row.content ?? "");
  if (chunks.length === 0) return true;

  let next = await chunkStart(supabase, row.id, chunks);
  let doneThisCall = 0;
  await saveProgress(supabase, row, { total_chunks: chunks.length, next_index: next });
  try {
    while (next < chunks.length && doneThisCall < CHUNKS_PER_CALL && (doneThisCall === 0 || Date.now() < deadline)) {
      const { error } = await supabase.from("thought_chunks").upsert({
        thought_id: row.id,
        chunk_index: next,
        content: chunks[next],
        embedding: await embed(chunks[next]),
        user_id: row.user_id,
      }, { onConflict: "thought_id,chunk_index" });
      if (error) throw new Error(`thought_chunks save: ${error.message}`);
      next++;
      doneThisCall++;
      await saveProgress(supabase, row, {
        total_chunks: chunks.length,
        next_index: next,
        last_progress_at: new Date().toISOString(),
        last_error: null,
        stalls: 0,
        ...(next >= chunks.length ? { done_at: new Date().toISOString() } : {}),
      });
    }
  } catch (e) {
    await saveProgress(supabase, row, { last_error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  return next >= chunks.length;
}

// Main embedding → links → chunks → embedded_at. embedded_at is set only
// when everything is finished, so an interrupted run is simply resumed.
async function embedThought(
  supabase: SupabaseClient,
  row: Row,
  opts: { deadline: number; hasEmbedding?: boolean },
): Promise<{ message: string; done: boolean }> {
  const text = mainText(row);
  if (text && !opts.hasEmbedding) {
    const { error } = await supabase
      .from("thoughts").update({ embedding: await embed(text) }).eq("id", row.id);
    if (error) throw new Error(`save embedding: ${error.message}`);
  }
  const links = text && !opts.hasEmbedding ? await linkThought(supabase, row) : 0;
  const done = await embedChunks(supabase, row, opts.deadline);
  if (done) {
    const { error } = await supabase
      .from("thoughts").update({ embedded_at: new Date().toISOString() }).eq("id", row.id);
    if (error) throw new Error(`save embedded_at: ${error.message}`);
  }
  return {
    message: `embedded ${row.id}: ${links} links${done ? "" : " (more chunks to go)"}`,
    done,
  };
}

// Hand the rest of a long thought to a fresh call of this function, which
// gets its own computing allowance. We don't wait for it to finish.
// The CONTINUE call answers at once (the work runs after its reply), so we
// wait for that reply: then we know the hand-off arrived. If it doesn't, the
// 15-minute RESUME job picks the thought up anyway.
async function continueLater(thoughtId: string, runId?: string | null): Promise<boolean> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/enrich-thought`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ type: "CONTINUE", id: thoughtId, ...(runId ? { run_id: runId } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch (e) {
    console.log(`continue hand-off failed for ${thoughtId}: ${e}`);
    return false;
  }
}

const ROW_COLUMNS = "id, content, user_id, tags, category, summary";

// CONTINUE: keep chunking one long thought, then chain again if needed.
// Also does the main embedding if it's missing (RESUME sends every
// unfinished thought here, not only half-chunked ones).
async function continueThought(supabase: SupabaseClient, id: string, runId?: string | null) {
  const { data, error } = await supabase
    .from("thoughts")
    .select(`${ROW_COLUMNS}, embedded_at, has_embedding:embedding`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.embedded_at) {
    await finishRun(supabase, runId, { output: "Embedding and chunks done." });
    return { ok: true, message: "nothing to continue" };
  }

  const result = await embedThought(supabase, data as Row, {
    deadline: Date.now() + WORK_MS,
    hasEmbedding: data.has_embedding != null,
  });
  if (!result.done) await continueLater(id, runId);
  else await finishRun(supabase, runId, { output: `Embedding and chunks done. ${result.message}` });
  return { ok: true, message: result.message };
}

// RESUME (pg_cron every 15 minutes): restart every unfinished thought.
// A thought that made no progress for STUCK_AFTER checks in a row is
// reported to the owner in Telegram, once; it keeps being retried.
async function resume(supabase: SupabaseClient, supabaseUrl: string) {
  const { data, error } = await supabase
    .from("thoughts")
    .select(ROW_COLUMNS)
    .is("embedded_at", null)
    .lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString()) // not brand-new saves
    .order("created_at")
    .limit(10);
  if (error) throw new Error(error.message);

  const results: string[] = [];
  for (const t of data ?? []) {
    const row = t as Row;
    const chunks = chunkText(row.content ?? "");
    const total = chunks.length;
    const { data: p } = await supabase.from("chunk_progress")
      .select("next_index, total_chunks, stalls, last_seen_index, last_progress_at, last_error, notified_at")
      .eq("thought_id", row.id).maybeSingle();

    // Still being worked on right now: leave it alone.
    if (p?.last_progress_at && Date.now() - Date.parse(p.last_progress_at) < 2 * 60_000) {
      results.push(`${row.id}: busy`);
      continue;
    }
    const next = await chunkStart(supabase, row.id, chunks);
    const stalls = p && p.last_seen_index === next ? p.stalls + 1 : 0;
    await saveProgress(supabase, row, { total_chunks: total, next_index: next, last_seen_index: next, stalls });

    if (stalls >= STUCK_AFTER && !p?.notified_at) {
      const title = shortTitle(row);
      const text = `⚠️ Chunking is stuck on "${title}" at ${next} of ${total} chunks, after ${stalls} tries ` +
        `(15 minutes apart).${p?.last_error ? `\nLast error: ${p.last_error.slice(0, 200)}` : ""}\n\n` +
        `It's still found by its summary; the rest of its text isn't searchable yet. I keep retrying.`;
      const sent = await fetch(`${supabaseUrl}/functions/v1/telegram-bot`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ action: "notify", text }),
      }).then((r) => r.ok).catch(() => false);
      if (sent) await saveProgress(supabase, row, { notified_at: new Date().toISOString() });
    }
    const handed = await continueLater(row.id);
    results.push(`${row.id}: ${next}/${total}, stalls ${stalls}${handed ? "" : ", hand-off failed"}`);
  }
  // In the run log only when there was something to restart (it runs every 15 min).
  if (results.some((r) => !r.endsWith(": busy"))) {
    const runId = await startRun(supabase, {
      userId: owner(), agent: "Scout", job: "resume-chunking", task: `Restart unfinished chunking (${results.length} thought(s))`,
    });
    await finishRun(supabase, runId, { output: results.join("\n") });
  }
  return { ok: true, resumed: results };
}

function shortTitle(row: Row): string {
  const first = (row.content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const s = (row.summary?.trim() || first).replace(/\s+/g, " ");
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

function reply(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// BACKFILL: embed the next few thoughts that have no embedded_at.
// Never calls the AI tagger — free.
async function backfill(supabase: SupabaseClient, batchSize: number) {
  const { data, error } = await supabase
    .from("thoughts")
    .select(`${ROW_COLUMNS}, has_embedding:embedding`)
    .is("embedded_at", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(error.message);

  // Work through the batch for about one second; whatever is left (or a
  // long thought's remaining chunks) is picked up by the next call.
  const deadline = Date.now() + WORK_MS;
  const results: string[] = [];
  for (const row of data ?? []) {
    if (results.length > 0 && Date.now() >= deadline) break;
    try {
      const result = await embedThought(supabase, row as Row, {
        deadline,
        hasEmbedding: row.has_embedding != null,
      });
      results.push(result.message);
      if (!result.done) break;
    } catch (e) {
      results.push(`failed ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const { count } = await supabase
    .from("thoughts").select("id", { count: "exact", head: true }).is("embedded_at", null);
  return { ok: true, processed: results, remaining: count ?? 0 };
}

// RELINK: rebuild links for one page of thoughts with the current threshold.
// Page 0 first removes links below the threshold. Returns only counts.
async function relink(supabase: SupabaseClient, page: number) {
  const PAGE = 20;
  if (page === 0) {
    const { error } = await supabase.from("thought_links").delete().lt("similarity", LINK_THRESHOLD);
    if (error) throw new Error(error.message);
  }
  const { data, error } = await supabase
    .from("thoughts")
    .select(ROW_COLUMNS)
    .not("embedding", "is", null)
    .order("created_at", { ascending: true })
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (error) throw new Error(error.message);

  let links = 0;
  for (const row of data ?? []) links += await linkThought(supabase, row as Row);
  return { ok: true, page, thoughts: data?.length ?? 0, links, more: (data?.length ?? 0) === PAGE };
}

// =====================================================================
// RELIABILITY — how much to trust a saved source
// =====================================================================
const RELIABILITY = ["research", "expert", "opinion", "unknown"];
const RELIABILITY_SYSTEM = `You rate how reliable a saved source is, for one person's notes.
Reply with ONLY a JSON object like {"reliability": "expert", "reason": "short reason"}.
reliability is exactly one of:
- research: a peer-reviewed study, systematic review, or official body (government, university, standards org)
- expert: a credentialed person speaking in their field, or an established outlet (major publication, TED/TED-Ed, recognised educational channel, career/reference site with editorial standards)
- opinion: an influencer, personal vlog, sales or affiliate pitch, hype, or claims without evidence
- unknown: you cannot tell from what is given (for example, only a bare link)`;

function parseReliability(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const r = String(JSON.parse(match[0]).reliability ?? "").toLowerCase().trim();
      if (RELIABILITY.includes(r)) return r;
    } catch { /* fall through */ }
  }
  const named = RELIABILITY.filter((k) => new RegExp("\\b" + k + "\\b", "i").test(text));
  return named.length === 1 ? named[0] : null;
}

// deno-lint-ignore no-explicit-any
async function rateSource(supabase: SupabaseClient, row: any, supabaseUrl: string, runId?: string | null): Promise<string | null> {
  const res = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...(runId ? { runId } : {}),
      systemPrompt: RELIABILITY_SYSTEM,
      prompt: `Source (may be cut short):\n"""\n${String(row.content ?? "").slice(0, 2500)}\n"""`,
      maxTokens: 1024, // room for Haiku's built-in thinking
      userId: row.user_id ?? undefined,
      source: "rate-reliability",
    }),
  });
  if (!res.ok) throw new Error(`call-llm failed (${res.status}): ${await res.text()}`);
  const reliability = parseReliability(String((await res.json()).text ?? ""));
  if (!reliability) return null;
  const { error } = await supabase.from("thoughts").update({ reliability }).eq("id", row.id);
  if (error) throw new Error(error.message);
  return reliability;
}

// RELIABILITY: rate the next few sources that have no rating yet.
async function rateBatch(supabase: SupabaseClient, size: number, supabaseUrl: string, runId?: string | null) {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, user_id")
    .eq("kind", "source")
    .is("reliability", null)
    .order("created_at", { ascending: true })
    .limit(size);
  if (error) throw new Error(error.message);
  const results: string[] = [];
  let failed = 0;
  for (const row of data ?? []) {
    try {
      const r = await rateSource(supabase, row, supabaseUrl, runId);
      if (!r) failed++;
      results.push((r ?? "FAILED").padEnd(9) + " " + String(row.content ?? "").replace(/\s+/g, " ").slice(0, 60));
    } catch (e) {
      failed++;
      results.push(`failed ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { count } = await supabase.from("thoughts").select("id", { count: "exact", head: true })
    .eq("kind", "source").is("reliability", null);
  return { ok: true, processed: results, failed, remaining: count ?? 0 };
}

// REFRESH: a thought's content was replaced (a bare link that got its
// transcript or article). Redo tags, summary, reliability, embedding,
// chunks and links. Its id, date and kind stay the same.
async function refresh(supabase: SupabaseClient, id: string, supabaseUrl: string, serviceKey: string) {
  const { data: row, error } = await supabase
    .from("thoughts")
    .select("id, content, user_id, tags, category, summary, kind, reliability")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return { ok: false, message: "not found" };

  const runId = await startRun(supabase, {
    userId: row.user_id ?? owner(), agent: "Scout", job: "refresh", thoughtId: id,
    task: `Redo tags, reliability, embedding and chunks after new text: ${preview(row.content)}`,
  });
  try {
    const t = await tagThought(row, supabaseUrl, serviceKey, false, false, { force: true, runId });
    let reliability: string | null = null;
    if (row.kind === "source") {
      reliability = await rateSource(supabase, row, supabaseUrl, runId).catch((e) => {
        console.log(`reliability failed for ${id}: ${e}`);
        return null;
      });
    }
    const fresh: Row = { ...row, tags: t.tags ?? row.tags, category: t.category ?? row.category, summary: t.summary ?? row.summary };
    const result = await embedThought(supabase, fresh, { deadline: Date.now() + WORK_MS });
    if (!result.done) await continueLater(id, runId);
    else await finishRun(supabase, runId, { output: `${t.message}; reliability ${reliability ?? "unchanged"}; ${result.message}` });
    return { ok: true, tagged: t.message, reliability, embedded: result.message };
  } catch (e) {
    await finishRun(supabase, runId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// RETAG: tag older thoughts that were saved before auto-tagging existed
// (enriched_at is empty), skipping course_setup. After tagging, the main
// embedding is rebuilt from the new summary + tags and links are refreshed,
// so search benefits. Chunks are unchanged. Pages through by created_at so a
// thought that is too short to tag is never retried forever.
async function retag(
  supabase: SupabaseClient,
  o: { size: number; after: string | null; dryRun: boolean; supabaseUrl: string; serviceKey: string; runId?: string | null },
) {
  let q = supabase
    .from("thoughts")
    .select("id, content, user_id, tags, category, summary, kind, enriched_at, created_at")
    .is("enriched_at", null)
    .or("kind.is.null,kind.neq.course_setup")
    .order("created_at", { ascending: true })
    .limit(o.size);
  if (o.after) q = q.gt("created_at", o.after);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const results: unknown[] = [];
  let failed = 0;
  for (const row of data ?? []) {
    const t = await tagThought(row, o.supabaseUrl, o.serviceKey, false, o.dryRun, { runId: o.runId });
    const preview = (row.content ?? "").replace(/\s+/g, " ").slice(0, 60);
    if (!t.tags) {
      if (!/too short/.test(t.message)) failed++;
      results.push({ id: row.id, preview, skipped: t.message });
      continue;
    }
    if (!o.dryRun) {
      // Re-embed with the new summary and tags, then refresh links.
      const fresh: Row = { ...row, tags: t.tags, category: t.category ?? null, summary: t.summary ?? null };
      const { error: e } = await supabase.from("thoughts").update({ embedding: await embed(mainText(fresh)) }).eq("id", row.id);
      if (e) throw new Error(`re-embed: ${e.message}`);
      await linkThought(supabase, fresh);
    }
    results.push({ id: row.id, preview, category: t.category, tags: t.tags, summary: t.summary });
  }

  const last = data?.at(-1)?.created_at ?? o.after;
  let remainingQ = supabase
    .from("thoughts").select("id", { count: "exact", head: true })
    .is("enriched_at", null).or("kind.is.null,kind.neq.course_setup");
  if (last) remainingQ = remainingQ.gt("created_at", last);
  const { count } = await remainingQ;
  return { ok: true, dryRun: o.dryRun, results, failed, after: last, remaining: count ?? 0 };
}

Deno.serve(async (req) => {
  // Only our own system: the database trigger, the backfill scripts, and
  // this function calling itself. Anyone else gets a 401.
  const denied = rejectUnlessInternal(req);
  if (denied) return denied;

  try {
    const payload = await req.json();
    const record = payload?.record;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // A maintenance batch (scripts): one Scout run per call, with the result
    // as its output. A call that found nothing to do isn't logged.
    const batchRun = async <T extends Record<string, unknown>>(
      job: string, task: string, work: (runId: string | null) => Promise<T>,
    ): Promise<T> => {
      const supabase = createClient(supabaseUrl, serviceKey);
      const runId = await startRun(supabase, { userId: owner(), agent: "Scout", job, task });
      try {
        const result = await work(runId);
        const items = (result.processed ?? result.results ?? []) as unknown[];
        const did = items.length > 0 || Number(result.links ?? 0) > 0;
        if (!did && runId) {
          // Nothing done: close it as done with that said, so the log stays honest.
          await finishRun(supabase, runId, { output: "Nothing to do." });
        } else {
          await finishRun(supabase, runId, { output: JSON.stringify(result).slice(0, 4000) });
        }
        return result;
      } catch (e) {
        await finishRun(supabase, runId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

    if (payload?.type === "BACKFILL") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 5));
      return reply(await batchRun("backfill", `Embed up to ${size} thoughts with no embedding`,
        () => backfill(createClient(supabaseUrl, serviceKey), size)));
    }
    if (payload?.type === "CONTINUE" && payload.id) {
      // Answer at once so the caller knows the hand-off arrived; the work
      // runs after the reply.
      const id = String(payload.id);
      const runId = typeof payload.run_id === "string" ? payload.run_id : null;
      EdgeRuntime.waitUntil(
        continueThought(createClient(supabaseUrl, serviceKey), id, runId)
          .then((r) => console.log(r.message))
          .catch((e) => console.log(`continue failed for ${id}: ${e instanceof Error ? e.message : String(e)}`)),
      );
      return reply({ ok: true, queued: id });
    }
    // RECHUNK (tests / repairs): redo one thought's chunks from chunk 0,
    // overwriting each in place (same thought_id + chunk_index). Nothing is
    // deleted. Needs the chunk_progress table.
    if (payload?.type === "RECHUNK" && payload.id) {
      const supabase = createClient(supabaseUrl, serviceKey);
      const id = String(payload.id);
      const { data: t, error } = await supabase.from("thoughts").select(ROW_COLUMNS).eq("id", id).maybeSingle();
      if (error || !t) return reply({ ok: false, error: error?.message ?? "not found" });
      const { error: pErr } = await supabase.from("chunk_progress").upsert({
        thought_id: id, user_id: t.user_id, total_chunks: chunkText(t.content ?? "").length, next_index: 0,
        stalls: 0, last_seen_index: null, last_error: null, done_at: null, notified_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "thought_id" });
      if (pErr) return reply({ ok: false, error: `chunk_progress: ${pErr.message}` });
      await supabase.from("thoughts").update({ embedded_at: null }).eq("id", id);
      return reply({ ok: true, handedOff: await continueLater(id) });
    }
    // AUDIT_CHUNKS (read-only): every thought whose saved chunks don't match
    // its current text (missing, different, or extra past the end).
    if (payload?.type === "AUDIT_CHUNKS") {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { data: thoughts, error } = await supabase.from("thoughts").select("id, content");
      if (error) return reply({ ok: false, error: error.message });
      const bad: string[] = [];
      for (const t of thoughts ?? []) {
        const chunks = chunkText(t.content ?? "");
        const { data: saved } = await supabase.from("thought_chunks").select("chunk_index, content").eq("thought_id", t.id);
        const byIndex = new Map((saved ?? []).map((c: { chunk_index: number; content: string }) => [c.chunk_index, c.content]));
        const differ = chunks.filter((c, i) => byIndex.get(i) !== c).length;
        const extra = (saved ?? []).filter((c: { chunk_index: number }) => c.chunk_index >= chunks.length).length;
        if (differ || extra) bad.push(`${t.id}: ${differ} missing/different, ${extra} extra (of ${chunks.length})`);
      }
      return reply({ ok: true, checked: thoughts?.length ?? 0, mismatched: bad });
    }
    if (payload?.type === "RESUME") {
      return reply(await resume(createClient(supabaseUrl, serviceKey), supabaseUrl));
    }
    if (payload?.type === "RELINK") {
      const page = Math.max(0, Number(payload.page) || 0);
      return reply(await batchRun("relink", `Rebuild graph links, page ${page}`,
        () => relink(createClient(supabaseUrl, serviceKey), page)));
    }
    if (payload?.type === "REFRESH" && payload.id) {
      return reply(await refresh(createClient(supabaseUrl, serviceKey), String(payload.id), supabaseUrl, serviceKey));
    }
    if (payload?.type === "RELIABILITY") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 3));
      return reply(await batchRun("rate-reliability", `Rate up to ${size} unrated sources`,
        (runId) => rateBatch(createClient(supabaseUrl, serviceKey), size, supabaseUrl, runId)));
    }
    if (payload?.type === "RETAG") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 3));
      const dryRun = payload.dryRun === true;
      return reply(await batchRun("retag", `${dryRun ? "Preview tags for" : "Tag"} up to ${size} untagged thoughts`,
        (runId) => retag(createClient(supabaseUrl, serviceKey), {
          size,
          after: typeof payload.after === "string" ? payload.after : null,
          dryRun,
          supabaseUrl,
          serviceKey,
          runId,
        })));
    }
    if (payload?.type === "CLASSIFY") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 5));
      return reply(await batchRun("classify-kind", `Give a kind to up to ${size} thoughts with none`,
        (runId) => classify(createClient(supabaseUrl, serviceKey), size, supabaseUrl, serviceKey, runId)));
    }

    if (payload?.type !== "INSERT" || !record?.id) {
      return ok("Not an insert with a record — nothing to do");
    }

    // The run log: Scout is working on this new thought until its
    // embedding and chunks are done.
    const runId = await startRun(createClient(supabaseUrl, serviceKey), {
      userId: record.user_id ?? owner(), agent: "Scout", job: "enrich-thought", thoughtId: record.id,
      task: `Enrich a new thought (tags, kind, summary, embedding, links): ${preview(record.content ?? record.text)}`,
    });

    // Kind: rules first. If they can't decide, the tagging call below is
    // asked for it as well, so it costs nothing extra.
    const ruleKind = record.kind ? null : kindByRules(record);
    if (ruleKind) await saveKind(createClient(supabaseUrl, serviceKey), record.id, ruleKind, "rule");

    const tagged = await tagThought(record, supabaseUrl, serviceKey, !record.kind && !ruleKind, false, {
      keepTags: Array.isArray(record.tags) ? record.tags : [],
      runId,
    });
    if (tagged.kind) await saveKind(createClient(supabaseUrl, serviceKey), record.id, tagged.kind, "llm");

    // Saved sources get a reliability rating (one short Haiku call).
    const finalKind = record.kind ?? ruleKind ?? tagged.kind ?? null;
    if (finalKind === "source" && !record.reliability) {
      EdgeRuntime.waitUntil(rateSource(createClient(supabaseUrl, serviceKey), record, supabaseUrl, runId)
        .catch((e) => console.log(`reliability failed for ${record.id}: ${e}`)));
    }

    // A new Library item (from the web app, MCP, or a long Telegram save)
    // gets a "What's your takeaway?" in Telegram. Saves where the bot already
    // set the kind itself asked there, so they're skipped here.
    const decidedKind = ruleKind ?? tagged.kind ?? null;
    if (decidedKind && sectionOf(decidedKind) === "library") {
      const ask = fetch(`${supabaseUrl}/functions/v1/telegram-bot`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ action: "ask_takeaway", thought_id: record.id }),
      }).then((r) => r.text()).catch((e) => console.log(`takeaway prompt failed: ${e}`));
      EdgeRuntime.waitUntil(ask);
    }

    // Embedding runs for every new thought, tagged or not, in the
    // background after we've answered the webhook. A long capture's chunks
    // continue in fresh calls until they're all done.
    const supabase = createClient(supabaseUrl, serviceKey);
    const row: Row = {
      id: record.id,
      content: record.content ?? record.text ?? "",
      user_id: record.user_id ?? null,
      tags: tagged.tags ?? record.tags ?? null,
      category: tagged.category ?? record.category ?? null,
      summary: tagged.summary ?? record.summary ?? null,
    };
    const work = embedThought(supabase, row, { deadline: Date.now() + WORK_MS })
      .then(async (r) => {
        console.log(r.message);
        if (!r.done) await continueLater(row.id, runId);
        else await finishRun(supabase, runId, { output: `${tagged.message}; ${r.message}` });
      })
      .catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`embedding failed for ${record.id}: ${msg}`);
        // The 15-minute RESUME job retries the embedding; this run records the failure.
        await finishRun(supabase, runId, { status: "failed", error: `${tagged.message}; embedding failed: ${msg}` });
      });
    EdgeRuntime.waitUntil(work);

    return ok(tagged.message);
  } catch (e) {
    return ok(`enrich-thought error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// The original Level 5 tagging, unchanged in what it does — just moved into
// its own function so embedding can run after it whether or not it tags.
async function tagThought(
  // deno-lint-ignore no-explicit-any
  record: any,
  supabaseUrl: string,
  serviceKey: string,
  wantKind = false,
  dryRun = false,   // RETAG preview: ask the AI, but save nothing
  opts: { force?: boolean; keepTags?: string[]; runId?: string | null } = {},
): Promise<{ message: string; tags?: string[]; category?: string | null; summary?: string | null; kind?: string | null }> {
  try {
    // Already has a category (for example, a weekly digest) — leave it alone,
    // unless REFRESH asks to redo it because the content changed.
    if (!opts.force && (record.category || record.enriched_at)) {
      return { message: `Thought ${record.id} already categorised — skipped` };
    }

    const content: string = record.content ?? record.text ?? "";
    if (content.trim().length < MIN_LENGTH) {
      return { message: `Thought ${record.id} too short to enrich — skipped` };
    }

    // Call YOUR gateway — never the AI provider directly.
    // The x-internal-secret header is required, or call-llm turns us away with a 401.
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        systemPrompt: wantKind
          ? `${SYSTEM_PROMPT}\n- also add "kind": exactly one of:\n${KIND_GUIDE}`
          : SYSTEM_PROMPT,
        prompt: `Note:\n"""\n${content.slice(0, MAX_CHARS)}\n"""`,
        maxTokens: 1024,
        userId: record.user_id,      // bill this call to the thought's owner
        source: "enrich-thought",
        ...(opts.runId ? { runId: opts.runId } : {}),
      }),
    });

    if (!llmRes.ok) {
      return { message: `call-llm failed (${llmRes.status}): ${await llmRes.text()}` };
    }

    const { text } = await llmRes.json();
    const parsed = parseEnrichment(text);
    const { category, summary } = parsed;
    // Tags set at save time (e.g. a class name from /recap) are kept.
    const tags = [...new Set([...(opts.keepTags ?? []), ...parsed.tags])].slice(0, 8);
    if (dryRun) return { message: `Preview ${record.id}`, tags, category, summary };

    const supabase = createClient(supabaseUrl, serviceKey);
    const { error } = await supabase
      .from("thoughts")
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq("id", record.id);

    if (error) return { message: `Could not save enrichment for ${record.id}: ${error.message}` };

    const kind = wantKind ? parseKind(text) : null;
    return { message: `Enriched ${record.id}: [${category}${kind ? `, ${kind}` : ""}] ${tags.join(", ")}`, tags, category, summary, kind };
  } catch (e) {
    return { message: `enrich-thought error: ${e instanceof Error ? e.message : String(e)}` };
  }
}