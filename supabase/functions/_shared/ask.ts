// _shared/ask.ts — "Ask my brain": answer a question from the owner's own notes.
//
// Used by telegram-bot (/ask, ?, "Answer it") and open-brain-mcp (ask_brain).
//
//   1. Follow-up? Haiku rewrites it into a standalone search query using the
//      last 5 exchanges of this chat.
//   2. hybrid_search_v3 → top 15 (course_setup always left out), optionally
//      only one section. "About me" questions search Personal first, then
//      add a few Library items. Plus the thoughts the previous answer cited,
//      so "what about the second one?" works.
//   3. Takeaways: for every Library item found, the owner's takeaway on it
//      is added and ranked ABOVE the item, so their own view leads.
//   4. Re-rank: the owner's own writing counts more than saved sources;
//      AI write-ups count less.
//   5. One call-llm call writes the answer in two labelled parts — "what you
//      know" (Personal) and "from your library" (Library) — citing [n] for
//      every claim, or says nothing relevant was found.
//   6. The turn is saved in ask_turns (memory + feedback + cost).
//
// Sections come from kind (see _shared/kinds.ts and public.section_of()).
// Cost: Haiku 5.5, about $0.001 per question (two calls for a follow-up).
// To use a stronger model, change ANSWER_MODEL and add its price to
// PRICES in call-llm/index.ts.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { internalHeaders } from "./internal-auth.ts";
import { type Section, sectionOf, SECTION_LABEL } from "./kinds.ts";

export const ANSWER_MODEL = "claude-haiku-5-5";
const REWRITE_MODEL = "claude-haiku-5-5";

const MATCH_COUNT = 15;
const ABOUT_ME_LIBRARY_COUNT = 5; // Library items added after Personal for "about me"
const MIN_SIMILARITY = 0.78;      // same bar as search everywhere else
const HISTORY_TURNS = 5;
const SNIPPET_CHARS = 900;        // per thought in the prompt — keeps each call cheap
const OWN_KINDS = ["my_thought", "project_doc", "class_note"]; // the owner's own writing
const OWN_BOOST = 1.5;
const TAKEAWAY_BOOST = 1.2;       // on top of the item's score: takeaway leads
const ABOUT_ME_BOOST = 1.5;       // Personal first for questions about the owner
// Reports (digests, AI write-ups) are already ranked at half weight inside
// hybrid_search_v2. Among sources, research/expert edge out opinion.
const RELIABILITY_WEIGHT: Record<string, number> = { research: 1.15, expert: 1.1, unknown: 1, opinion: 0.85 };

const embedder = new Supabase.ai.Session("gte-small");

export type SectionFilter = "personal" | "library";

export type Source = {
  n: number;            // the [n] used in the answer
  id: string;
  shortId: string;      // first 8 characters — used for /t_xxxxxxxx
  created_at: string;
  kind: string | null;
  section: Section | null;
  label: string;        // "your note", "a video you saved", ...
  title: string;        // summary or first line
};

export type AskResult = {
  turnId: string | null;
  question: string;
  searchQuery: string;
  intent: Intent;
  section: SectionFilter | null;
  nothingFound: boolean;
  fromSourcesOnly: boolean;
  sourceLabel: string | null; // "a video you saved" when fromSourcesOnly
  whatYouKnow: string;        // the Personal part of the answer
  fromLibrary: string;        // the Library part of the answer
  answer: string;             // both parts, as one text (stored in ask_turns)
  sources: Source[];          // only the ones the answer cited
  closest: Source[];          // filled when nothingFound
  promptTokens: number;
  completionTokens: number;
};

type Intent = "about_me" | "decision" | "saved" | "last_time" | "changed" | "general";

type Row = {
  id: string;
  content: string;
  created_at: string;
  tags: string[] | null;
  category: string | null;
  summary: string | null;
  similarity: number | null;
  score: number | null;
  matched_chunk: string | null;
  kind: string | null;
  status?: string | null;
  takeaway_of?: string | null;
  reliability?: string | null;
};

export type AskOptions = {
  db: SupabaseClient;
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
  question: string;
  channel: "telegram" | "mcp";
  chatId: string;
  useHistory: boolean;
  section?: SectionFilter | null;  // only search this section
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/\b(when did i (last|most recently)|last time i|most recent(ly)?)\b/.test(s)) return "last_time";
  if (/\b(what('s| has)? changed|chang(e|ed|ing) (in )?how i|evolv|over time|used to think|shift(ed)? in)\b/.test(s)) return "changed";
  if (/\b(what did i decide|decid|decision|why did i (choose|pick|go with))\b/.test(s)) return "decision";
  if (/\b(what (have|did) i (saved?|bookmark)|saved about|videos?|articles?|sources?)\b/.test(s)) return "saved";
  if (/\b(what do i (think|believe|feel|want|value|care)|what am i|who am i|about me|my (goals?|plans?|values|opinions?|views?|beliefs?|priorities|habits|strengths|weaknesses|personality))\b/.test(s)) return "about_me";
  return "general";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function sourceLabel(r: {
  kind: string | null;
  content: string;
  takeaway_of?: string | null;
  category?: string | null;
  reliability?: string | null;
}): string {
  const c = (r.content ?? "").trimStart();
  if (r.takeaway_of) return "your takeaway";
  if (r.kind === "report" && (r.category === "digest" || /^Weekly digest:/i.test(c))) return "an AI weekly digest";
  if (r.kind === "source") {
    const what = c.startsWith("📹") ? "a video you saved"
      : c.startsWith("🔗") ? "an article you saved"
      : c.startsWith("📄") ? "a PDF you saved"
      : "a source you saved";
    return r.reliability ? `${what} (${r.reliability}-level)` : what;
  }
  switch (r.kind) {
    case "my_thought": return "your note";
    case "project_doc": return "your document";
    case "class_note": return "your class notes";
    case "report": return "an AI write-up you saved";
    case "course_setup": return "a course prompt";
    case "source":
      if (c.startsWith("\u{1F4F9}")) return "a video you saved";
      if (c.startsWith("\u{1F517}")) return "an article you saved";
      if (c.startsWith("\u{1F4C4}")) return "a PDF you saved";
      return "a source you saved";
    default: return "a note";
  }
}

function titleOf(r: Row): string {
  const firstLine = (r.content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const t = r.summary?.trim() || firstLine;
  const clean = t.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? clean.slice(0, 90) + "…" : clean;
}

function snippet(r: Row): string {
  // Prefer the chunk that matched (a detail deep inside a long capture).
  const head = (r.content ?? "").slice(0, SNIPPET_CHARS);
  const chunk = r.matched_chunk && !head.includes(r.matched_chunk.slice(0, 80))
    ? `\n…\n${r.matched_chunk.slice(0, SNIPPET_CHARS)}`
    : "";
  return (head + chunk).replace(/\s+\n/g, "\n").trim();
}

function toSource(r: Row, n: number): Source {
  return {
    n,
    id: r.id,
    shortId: r.id.slice(0, 8),
    created_at: r.created_at,
    kind: r.kind,
    section: sectionOf(r.kind),
    label: sourceLabel(r),
    title: titleOf(r),
  };
}

async function embed(text: string): Promise<string> {
  const vector = await embedder.run(text, { mean_pool: true, normalize: true });
  return JSON.stringify(Array.from(vector as number[]));
}

async function callLlm(
  o: AskOptions,
  body: { systemPrompt: string; prompt: string; maxTokens: number; model: string; source: string },
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const res = await fetch(`${o.supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ ...body, userId: o.userId }),
  });
  if (!res.ok) throw new Error(`call-llm failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return {
    text: String(data.text ?? ""),
    promptTokens: Number(data.usage?.prompt_tokens ?? 0),
    completionTokens: Number(data.usage?.completion_tokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
type Turn = { question: string; answer: string | null; cited_ids: string[] };

async function loadHistory(o: AskOptions): Promise<Turn[]> {
  const { data, error } = await o.db
    .from("ask_turns")
    .select("question, answer, cited_ids")
    .eq("chat_id", o.chatId)
    .eq("user_id", o.userId)
    .is("cleared_at", null)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);
  if (error) {
    console.log("ask history unavailable:", error.message);
    return [];
  }
  return (data ?? []).reverse() as Turn[];
}

export async function clearHistory(db: SupabaseClient, userId: string, chatId: string): Promise<number> {
  const { data, error } = await db
    .from("ask_turns")
    .update({ cleared_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .is("cleared_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
async function search(
  o: AskOptions,
  query: string,
  minSimilarity: number,
  count: number,
  section: SectionFilter | null,
): Promise<Row[]> {
  const { data, error } = await o.db.rpc("hybrid_search_v3", {
    query_embedding: await embed(query),
    query_text: query,
    match_count: count,
    p_user_id: o.userId,
    min_similarity: minSimilarity,
    p_section: section,
  });
  if (error) throw new Error(`hybrid_search_v3: ${error.message}`);
  return (data ?? []) as Row[];
}

const ROW_COLUMNS = "id, content, created_at, tags, category, summary, kind, status, takeaway_of, reliability";

// Search results don't carry reliability; look it up for the sources found.
async function addReliability(o: AskOptions, rows: Row[]): Promise<Row[]> {
  const ids = rows.filter((r) => r.kind === "source" && r.reliability === undefined).map((r) => r.id);
  if (!ids.length) return rows;
  const { data } = await o.db.from("thoughts").select("id, reliability").in("id", ids);
  const byId = new Map((data ?? []).map((d) => [d.id, d.reliability]));
  return rows.map((r) => (byId.has(r.id) ? { ...r, reliability: byId.get(r.id) } : r));
}

async function fetchByIds(o: AskOptions, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await o.db
    .from("thoughts")
    .select(ROW_COLUMNS)
    .in("id", ids)
    .eq("user_id", o.userId);
  if (error) return [];
  return (data ?? []).map((r) => ({ ...r, similarity: null, score: 0, matched_chunk: null })) as Row[];
}

// The owner's takeaways on these Library items. They "match" whenever their
// item does, and get the item's score so they can outrank it.
async function takeawaysFor(o: AskOptions, items: Row[]): Promise<Row[]> {
  const ids = items.filter((r) => sectionOf(r.kind) === "library").map((r) => r.id);
  if (!ids.length) return [];
  const { data, error } = await o.db
    .from("thoughts")
    .select(ROW_COLUMNS)
    .in("takeaway_of", ids)
    .eq("user_id", o.userId);
  if (error) {
    console.log("takeaways unavailable:", error.message);
    return [];
  }
  const scoreOf = new Map(items.map((r) => [r.id, r.score ?? 0]));
  return (data ?? []).map((t) => ({
    ...t,
    similarity: null,
    score: scoreOf.get(t.takeaway_of as string) ?? 0,
    matched_chunk: null,
  })) as Row[];
}

function rerank(rows: Row[], intent: Intent): Row[] {
  const weighted = rows.map((r) => {
    let w = r.score ?? 0;
    if (intent !== "saved" && r.kind && OWN_KINDS.includes(r.kind)) w *= OWN_BOOST;
    if (intent === "saved" && r.kind === "source") w *= OWN_BOOST;
    if (r.takeaway_of) w *= TAKEAWAY_BOOST;
    if (intent === "about_me" && sectionOf(r.kind) === "personal") w *= ABOUT_ME_BOOST;
    if (r.kind === "source" && r.reliability) w *= RELIABILITY_WEIGHT[r.reliability] ?? 1;
    return { r, w };
  });
  // Ties go to the owner's own writing.
  const own = (r: Row) => (r.takeaway_of ? 2 : r.kind && OWN_KINDS.includes(r.kind) ? 1 : 0);
  weighted.sort((a, b) => b.w - a.w || own(b.r) - own(a.r));
  const ranked = weighted.map((x) => x.r);
  // For time questions, show the model the notes in date order.
  if (intent === "last_time" || intent === "changed") {
    ranked.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return ranked;
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------
const REWRITE_SYSTEM = `You turn a follow-up question into a standalone search query for a personal note search.
Use the earlier conversation to resolve words like "it", "that", "the second one".
Reply with ONLY the query, one line, no quotes.`;

const INTENT_HINTS: Record<Intent, string> = {
  about_me: "The owner asks about themselves. Answer from PERSONAL items first; use LIBRARY items only for context, clearly as things they saved.",
  decision: "The owner asks what they decided and why. Lead with the decision, then the reasons they gave, each cited. If no decision was written down, say so.",
  saved: "The owner asks what they have saved. List what the saved items cover, grouped, each cited. Library items are the point here.",
  last_time: "The owner asks when they last thought about this. The notes are in date order, oldest first. Give the date of the most recent relevant note first, then what it said.",
  changed: "The owner asks how their thinking has changed. The notes are in date order, oldest first. Describe earlier versus later, with dates, each cited. If there is only one note, say there is not enough to see a change.",
  general: "Answer the question directly.",
};

function answerSystem(intent: Intent): string {
  return `You answer questions for one person using ONLY their saved notes, given below as numbered [n] items.
Each item says its section and what it is:
- PERSONAL: "your note", "your class notes" and "your takeaway" are the person's own words. "an AI write-up you saved" is NOT their own words.
- LIBRARY: "a video/article/PDF/source you saved" was made by someone else; "your document" is something they made.
  Saved sources show how reliable they are: research-level (studies, official bodies), expert-level (credentialed people, established outlets), opinion-level (influencers, sales, hype) or unknown-level.
- "an AI weekly digest" is an AI summary of other notes.
A "your takeaway" item is the person's own view of a Library item. When a takeaway and its item both cover a point, lead with the takeaway.

Write the answer in two parts:
- what_you_know: from PERSONAL items only. Use "you" for their own notes and takeaways. For an AI write-up, write "an AI write-up you saved says…" — never "you think" or "you decided" for it.
- from_library: from LIBRARY items only, e.g. "A video you saved explains…".
Rules:
- 3 to 6 plain sentences in total. Either part may be empty if nothing in that section is relevant. No headings, bullet points or markdown.
- Put a citation like [2] after every claim, using only the numbers given. Never cite a number that does not support the claim.
- If the notes do not contain the answer, set nothing_found to true and leave both parts empty. Do not guess.
- When a claim rests only on opinion-level sources, say so in that sentence (e.g. "an opinion-level video claims…"). When sources disagree, prefer research- and expert-level ones and mention the disagreement.
- When a weekly digest and an original note support the same point, cite the original note, not the digest.
- Do not add general knowledge. The only exception: if one short piece of general knowledge is truly needed, put it in its own sentence starting with "General knowledge, not from your notes:", with no citation.
- ${INTENT_HINTS[intent]}

Reply with ONLY a JSON object: {"nothing_found": false, "what_you_know": "…", "from_library": "…", "used": [1, 3]}`;
}

function buildContext(rows: Row[]): string {
  const numberOf = new Map(rows.map((r, i) => [r.id, i + 1]));
  return rows.map((r, i) => {
    const section = sectionOf(r.kind);
    const about = r.takeaway_of && numberOf.has(r.takeaway_of) ? ` on [${numberOf.get(r.takeaway_of)}]` : "";
    return `[${i + 1}] ${section ? SECTION_LABEL[section].toUpperCase() : "UNSORTED"} · ${fmtDate(r.created_at)} · ${sourceLabel(r)}${about}` +
      (r.summary ? ` · ${r.summary.replace(/\s+/g, " ").trim()}` : "") +
      `\n${snippet(r)}`;
  }).join("\n\n");
}

type Parsed = { nothingFound: boolean; know: string; library: string; used: number[] };

function parseAnswer(text: string, max: number): Parsed {
  const valid = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  const cites = (s: string) => [...s.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const raw = JSON.parse(match[0]);
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      // Older shape ("answer") still accepted.
      const know = str(raw.what_you_know) || (raw.what_you_know === undefined ? str(raw.answer) : "");
      const library = str(raw.from_library);
      const used = [...new Set([...(Array.isArray(raw.used) ? raw.used : []), ...cites(know), ...cites(library)])]
        .filter(valid) as number[];
      return { nothingFound: raw.nothing_found === true || (!know && !library), know, library, used };
    } catch { /* fall through to plain-text handling */ }
  }
  // Not JSON: treat the reply as one answer, if it cites anything.
  const answer = text.trim();
  const used = [...new Set(cites(answer))].filter(valid);
  return { nothingFound: used.length === 0, know: used.length ? answer : "", library: "", used };
}

// ---------------------------------------------------------------------------
// The main function
// ---------------------------------------------------------------------------
export async function askBrain(o: AskOptions): Promise<AskResult> {
  const question = o.question.trim().slice(0, 1000);
  const sectionFilter = o.section ?? null;
  let promptTokens = 0, completionTokens = 0;

  // 1. Follow-up → standalone query
  const history = o.useHistory ? await loadHistory(o) : [];
  let searchQuery = question;
  if (history.length) {
    const convo = history.map((t) => `Q: ${t.question}\nA: ${(t.answer ?? "(nothing found)").slice(0, 600)}`).join("\n\n");
    try {
      const r = await callLlm(o, {
        systemPrompt: REWRITE_SYSTEM,
        prompt: `Earlier conversation:\n${convo}\n\nFollow-up: ${question}`,
        maxTokens: 1000, // room for Haiku's built-in thinking; the query itself is short
        model: REWRITE_MODEL,
        source: "ask-rewrite",
      });
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      const line = r.text.split("\n").map((l) => l.trim()).find(Boolean);
      if (line) searchQuery = line.replace(/^["']|["']$/g, "").slice(0, 500);
    } catch (e) {
      console.log("rewrite failed, searching the question as typed:", e);
    }
  }
  const intent = detectIntent(question);

  // 2. Retrieve: one section, or "about me" = Personal first, or both.
  let rows: Row[];
  if (sectionFilter) {
    rows = await search(o, searchQuery, MIN_SIMILARITY, MATCH_COUNT, sectionFilter);
  } else if (intent === "about_me") {
    const [personal, library] = await Promise.all([
      search(o, searchQuery, MIN_SIMILARITY, MATCH_COUNT, "personal"),
      search(o, searchQuery, MIN_SIMILARITY, ABOUT_ME_LIBRARY_COUNT, "library"),
    ]);
    rows = personal.concat(library);
  } else {
    rows = await search(o, searchQuery, MIN_SIMILARITY, MATCH_COUNT, null);
  }
  const lastCited = history.at(-1)?.cited_ids ?? [];
  const missing = lastCited.filter((id) => !rows.some((r) => r.id === id));
  rows = rows.concat(await fetchByIds(o, missing));
  // 3. The owner's takeaways on any Library items found (not when only
  //    Library was asked for — takeaways are Personal).
  if (sectionFilter !== "library") rows = rows.concat(await takeawaysFor(o, rows));
  if (sectionFilter) rows = rows.filter((r) => sectionOf(r.kind) === sectionFilter);
  rows = rows.filter((r) => r.status !== "archived");
  rows = rerank(dedupe(await addReliability(o, rows)), intent);

  const save = async (fields: Partial<Record<string, unknown>>): Promise<string | null> => {
    const { data, error } = await o.db.from("ask_turns").insert({
      user_id: o.userId,
      channel: o.channel,
      chat_id: o.chatId,
      question,
      search_query: searchQuery,
      intent,
      model: ANSWER_MODEL,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      ...fields,
    }).select("id").single();
    if (error) {
      console.log("could not save ask turn:", error.message);
      return null;
    }
    return data.id as string;
  };

  const base = { question, searchQuery, intent, section: sectionFilter };

  const nothing = async (): Promise<AskResult> => {
    const near = rows.length ? rows : await search(o, searchQuery, 0, 3, sectionFilter).catch(() => []);
    const closest = near
      .slice()
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 3)
      .map((r, i) => toSource(r, i + 1));
    const turnId = await save({ nothing_found: true, closest_ids: closest.map((c) => c.id), answer: null });
    return {
      ...base, turnId, nothingFound: true, fromSourcesOnly: false, sourceLabel: null,
      whatYouKnow: "", fromLibrary: "", answer: "", sources: [], closest, promptTokens, completionTokens,
    };
  };

  if (rows.length === 0) return await nothing();

  // 4. Answer
  const r = await callLlm(o, {
    systemPrompt: answerSystem(intent),
    prompt: `My notes:\n\n${buildContext(rows)}\n\nQuestion: ${question}` +
      (searchQuery !== question ? `\n(Meaning: ${searchQuery})` : ""),
    maxTokens: 2000,
    model: ANSWER_MODEL,
    source: "ask-brain",
  });
  promptTokens += r.promptTokens;
  completionTokens += r.completionTokens;

  const parsed = parseAnswer(r.text, rows.length);
  if (parsed.nothingFound || parsed.used.length === 0) return await nothing();

  // 5. Renumber citations 1..k in order of first use (Personal part first).
  const order: number[] = [];
  for (const m of `${parsed.know} ${parsed.library}`.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (parsed.used.includes(n) && !order.includes(n)) order.push(n);
  }
  for (const n of parsed.used) if (!order.includes(n)) order.push(n);
  const renumber = new Map(order.map((oldN, i) => [oldN, i + 1]));
  const tidy = (s: string) => s
    .replace(/\[(\d+)\]/g, (_whole, d) => renumber.has(Number(d)) ? `[${renumber.get(Number(d))}]` : "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  const whatYouKnow = tidy(parsed.know);
  const fromLibrary = tidy(parsed.library);
  const sources = order.map((oldN, i) => toSource(rows[oldN - 1], i + 1));

  // 6. Only saved sources?
  const kinds = sources.map((s) => s.kind);
  const fromSourcesOnly = kinds.length > 0 && kinds.every((k) => k === "source");
  const labels = [...new Set(sources.map((s) => s.label))];
  const label = fromSourcesOnly ? (labels.length === 1 ? labels[0] : "sources you saved") : null;

  const answer = [
    whatYouKnow && `What you know: ${whatYouKnow}`,
    fromLibrary && `From your library: ${fromLibrary}`,
  ].filter(Boolean).join("\n");

  const turnId = await save({
    answer,
    cited_ids: sources.map((s) => s.id),
    from_sources_only: fromSourcesOnly,
  });

  return {
    ...base, turnId, nothingFound: false, fromSourcesOnly, sourceLabel: label,
    whatYouKnow, fromLibrary, answer, sources, closest: [], promptTokens, completionTokens,
  };
}

// ---------------------------------------------------------------------------
// Plain-text rendering (Telegram and MCP share it)
// ---------------------------------------------------------------------------
export function renderAnswer(res: AskResult, style: "telegram" | "mcp"): string {
  const ref = (s: Source) => style === "telegram" ? `/t_${s.shortId}` : `(id: ${s.id})`;
  const where = (s: Source) => (s.section ? SECTION_LABEL[s.section] : "Unsorted");
  const line = (s: Source) => `[${s.n}] ${ref(s)}  ${fmtDate(s.created_at)} · ${where(s)} · ${s.label}: ${s.title}`;
  const scope = res.section ? ` (searched ${SECTION_LABEL[res.section]} only)` : "";

  if (res.nothingFound) {
    const near = res.closest.length
      ? "\n\nClosest thoughts:\n" + res.closest.map(line).join("\n")
      : "";
    return `Nothing in your brain on this${scope}.${near}`;
  }

  const parts: string[] = [];
  if (res.whatYouKnow) parts.push(`\u{1F9E0} What you know\n${res.whatYouKnow}`);
  if (res.fromLibrary) parts.push(`\u{1F4DA} From your library\n${res.fromLibrary}`);
  const note = res.fromSourcesOnly
    ? `\n\n(From ${res.sourceLabel}, not your own notes.)`
    : "";
  return `${parts.join("\n\n")}${note}${scope ? `\n\n${scope.trim()}` : ""}\n\nSources:\n${res.sources.map(line).join("\n")}`;
}
