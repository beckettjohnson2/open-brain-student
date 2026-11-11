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
): Promise<string | null> {
  const res = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
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
async function classify(supabase: SupabaseClient, batchSize: number, supabaseUrl: string, serviceKey: string) {
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
        kind = await kindByLlm(t, supabaseUrl, serviceKey);
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

// Embed chunks until the deadline, picking up where a previous call
// stopped. Always makes at least one chunk of progress. Returns true when
// every chunk is done.
async function embedChunks(supabase: SupabaseClient, row: Row, deadline: number): Promise<boolean> {
  const chunks = chunkText(row.content ?? "");
  if (chunks.length === 0) return true;

  const { count, error } = await supabase
    .from("thought_chunks")
    .select("id", { count: "exact", head: true })
    .eq("thought_id", row.id);
  if (error) throw new Error(`thought_chunks count: ${error.message}`);

  let next = count ?? 0;
  while (next < chunks.length) {
    const batch = [];
    while (next < chunks.length && batch.length < 5 && (batch.length === 0 || Date.now() < deadline)) {
      batch.push({
        thought_id: row.id,
        chunk_index: next,
        content: chunks[next],
        embedding: await embed(chunks[next]),
        user_id: row.user_id,
      });
      next++;
    }
    const { error: insertError } = await supabase
      .from("thought_chunks")
      .upsert(batch, { onConflict: "thought_id,chunk_index", ignoreDuplicates: true });
    if (insertError) throw new Error(`thought_chunks insert: ${insertError.message}`);
    if (Date.now() >= deadline) break;
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
async function continueLater(thoughtId: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/enrich-thought`;
  const call = fetch(url, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ type: "CONTINUE", id: thoughtId }),
  }).catch((e) => console.log(`continue failed for ${thoughtId}: ${e}`));
  await Promise.race([call, new Promise((r) => setTimeout(r, 1500))]);
}

const ROW_COLUMNS = "id, content, user_id, tags, category, summary";

// CONTINUE: keep chunking one long thought, then chain again if needed.
async function continueThought(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("thoughts")
    .select(`${ROW_COLUMNS}, embedded_at`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.embedded_at) return { ok: true, message: "nothing to continue" };

  const result = await embedThought(supabase, data as Row, {
    deadline: Date.now() + WORK_MS,
    hasEmbedding: true,
  });
  if (!result.done) await continueLater(id);
  return { ok: true, message: result.message };
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

// RETAG: tag older thoughts that were saved before auto-tagging existed
// (enriched_at is empty), skipping course_setup. After tagging, the main
// embedding is rebuilt from the new summary + tags and links are refreshed,
// so search benefits. Chunks are unchanged. Pages through by created_at so a
// thought that is too short to tag is never retried forever.
async function retag(
  supabase: SupabaseClient,
  o: { size: number; after: string | null; dryRun: boolean; supabaseUrl: string; serviceKey: string },
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
    const t = await tagThought(row, o.supabaseUrl, o.serviceKey, false, o.dryRun);
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

    if (payload?.type === "BACKFILL") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 5));
      return reply(await backfill(createClient(supabaseUrl, serviceKey), size));
    }
    if (payload?.type === "CONTINUE" && payload.id) {
      return reply(await continueThought(createClient(supabaseUrl, serviceKey), String(payload.id)));
    }
    if (payload?.type === "RELINK") {
      return reply(await relink(createClient(supabaseUrl, serviceKey), Math.max(0, Number(payload.page) || 0)));
    }
    if (payload?.type === "RETAG") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 3));
      return reply(await retag(createClient(supabaseUrl, serviceKey), {
        size,
        after: typeof payload.after === "string" ? payload.after : null,
        dryRun: payload.dryRun === true,
        supabaseUrl,
        serviceKey,
      }));
    }
    if (payload?.type === "CLASSIFY") {
      const size = Math.min(10, Math.max(1, Number(payload.batch) || 5));
      return reply(await classify(createClient(supabaseUrl, serviceKey), size, supabaseUrl, serviceKey));
    }

    if (payload?.type !== "INSERT" || !record?.id) {
      return ok("Not an insert with a record — nothing to do");
    }

    // Kind: rules first. If they can't decide, the tagging call below is
    // asked for it as well, so it costs nothing extra.
    const ruleKind = record.kind ? null : kindByRules(record);
    if (ruleKind) await saveKind(createClient(supabaseUrl, serviceKey), record.id, ruleKind, "rule");

    const tagged = await tagThought(record, supabaseUrl, serviceKey, !record.kind && !ruleKind);
    if (tagged.kind) await saveKind(createClient(supabaseUrl, serviceKey), record.id, tagged.kind, "llm");

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
        if (!r.done) await continueLater(row.id);
      })
      .catch((e) => console.log(`embedding failed for ${record.id}: ${e instanceof Error ? e.message : String(e)}`));
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
): Promise<{ message: string; tags?: string[]; category?: string | null; summary?: string | null; kind?: string | null }> {
  try {
    // Already has a category (for example, a weekly digest) — leave it alone.
    if (record.category || record.enriched_at) {
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
      }),
    });

    if (!llmRes.ok) {
      return { message: `call-llm failed (${llmRes.status}): ${await llmRes.text()}` };
    }

    const { text } = await llmRes.json();
    const { tags, category, summary } = parseEnrichment(text);
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