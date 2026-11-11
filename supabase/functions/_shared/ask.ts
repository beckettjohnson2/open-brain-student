// _shared/ask.ts — "Ask my brain": answer a question from the owner's own notes.
//
// Used by telegram-bot (/ask, ?, "Answer it") and open-brain-mcp (ask_brain).
//
//   1. Follow-up? Haiku rewrites it into a standalone search query using the
//      last 5 exchanges of this chat.
//   2. hybrid_search_v2 → top 15 (course_setup left out), plus the thoughts
//      the previous answer cited, so "what about the second one?" works.
//   3. Re-rank: the owner's own writing (my_thought, project_doc, class_note)
//      counts more than saved sources; AI reports count less.
//   4. One call-llm call writes 3-6 sentences, citing [n] for every claim, or
//      says nothing relevant was found.
//   5. Cited kinds are checked in code: if every cited thought is a saved
//      source, the answer says so. If nothing was found, the 3 closest
//      thoughts are returned instead.
//   6. The turn is saved in ask_turns (memory + feedback + cost).
//
// Cost: Haiku 5.5, about $0.001 per question (two calls for a follow-up).
// To use a stronger model, change ANSWER_MODEL and add its price to
// PRICES in call-llm/index.ts.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const ANSWER_MODEL = "claude-haiku-5-5";
const REWRITE_MODEL = "claude-haiku-5-5";

const MATCH_COUNT = 15;
const MIN_SIMILARITY = 0.78;   // same bar as search everywhere else
const HISTORY_TURNS = 5;
const SNIPPET_CHARS = 900;     // per thought in the prompt — keeps each call cheap
const OWN_KINDS = ["my_thought", "project_doc", "class_note"];
const OWN_BOOST = 1.5;
const REPORT_PENALTY = 0.6;

const embedder = new Supabase.ai.Session("gte-small");

export type Source = {
  n: number;            // the [n] used in the answer
  id: string;
  shortId: string;      // first 8 characters — used for /t_xxxxxxxx
  created_at: string;
  kind: string | null;
  label: string;        // "your note", "a video you saved", ...
  title: string;        // summary or first line
};

export type AskResult = {
  turnId: string | null;
  question: string;
  searchQuery: string;
  intent: Intent;
  nothingFound: boolean;
  fromSourcesOnly: boolean;
  sourceLabel: string | null; // "a video you saved" when fromSourcesOnly
  answer: string;
  sources: Source[];    // only the ones the answer cited
  closest: Source[];    // filled when nothingFound
  promptTokens: number;
  completionTokens: number;
};

type Intent = "decision" | "saved" | "last_time" | "changed" | "general";

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
  return "general";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function sourceLabel(kind: string | null, content: string): string {
  const c = content.trimStart();
  switch (kind) {
    case "my_thought": return "your note";
    case "project_doc": return "your document";
    case "class_note": return "your class notes";
    case "report": return "an AI digest";
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
    label: sourceLabel(r.kind, r.content ?? ""),
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.serviceKey}` },
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
async function search(o: AskOptions, query: string, minSimilarity: number, count: number): Promise<Row[]> {
  const { data, error } = await o.db.rpc("hybrid_search_v2", {
    query_embedding: await embed(query),
    query_text: query,
    match_count: count,
    p_user_id: o.userId,
    min_similarity: minSimilarity,
  });
  if (error) throw new Error(`hybrid_search_v2: ${error.message}`);
  return (data ?? []) as Row[];
}

async function fetchByIds(o: AskOptions, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await o.db
    .from("thoughts")
    .select("id, content, created_at, tags, category, summary, kind, status")
    .in("id", ids)
    .eq("user_id", o.userId);
  if (error) return [];
  return (data ?? []).map((r) => ({ ...r, similarity: null, score: 0, matched_chunk: null })) as Row[];
}

function rerank(rows: Row[], intent: Intent): Row[] {
  const weighted = rows.map((r) => {
    let w = r.score ?? 0;
    if (intent !== "saved" && r.kind && OWN_KINDS.includes(r.kind)) w *= OWN_BOOST;
    if (intent === "saved" && r.kind === "source") w *= OWN_BOOST;
    if (r.kind === "report" || r.category === "digest") w *= REPORT_PENALTY;
    return { r, w };
  });
  // Ties go to the owner's own writing.
  const own = (r: Row) => (r.kind && OWN_KINDS.includes(r.kind) ? 1 : 0);
  weighted.sort((a, b) => b.w - a.w || own(b.r) - own(a.r));
  const ranked = weighted.map((x) => x.r);
  // For time questions, show the model the notes in date order.
  if (intent === "last_time" || intent === "changed") {
    ranked.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return ranked;
}

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------
const REWRITE_SYSTEM = `You turn a follow-up question into a standalone search query for a personal note search.
Use the earlier conversation to resolve words like "it", "that", "the second one".
Reply with ONLY the query, one line, no quotes.`;

const INTENT_HINTS: Record<Intent, string> = {
  decision: "The owner asks what they decided and why. Lead with the decision, then the reasons they gave, each cited. If no decision was written down, say so.",
  saved: "The owner asks what they have saved. List what the saved items cover, grouped, each cited. Saved sources are the point here.",
  last_time: "The owner asks when they last thought about this. The notes are in date order, oldest first. Give the date of the most recent relevant note first, then what it said.",
  changed: "The owner asks how their thinking has changed. The notes are in date order, oldest first. Describe earlier versus later, with dates, each cited. If there is only one note, say there is not enough to see a change.",
  general: "Answer the question directly.",
};

function answerSystem(intent: Intent): string {
  return `You answer questions for one person using ONLY their own saved notes, given below as numbered [n] items.
Each item is labelled: "your note", "your document" and "your class notes" are their own writing; "a video/article/PDF/source you saved" was made by someone else; "an AI digest" is an AI summary.

Rules:
- Write 3 to 6 plain sentences, speaking to them as "you". No headings, no bullet points, no markdown.
- Put a citation like [2] after every claim, using only the numbers given. Never cite a number that does not support the claim.
- Prefer their own writing over saved sources when both cover the point.
- If the notes do not contain the answer, set nothing_found to true and leave answer empty. Do not guess.
- Do not add general knowledge. The only exception: if one short piece of general knowledge is truly needed, put it in its own sentence starting with "General knowledge, not from your notes:", with no citation.
- ${INTENT_HINTS[intent]}

Reply with ONLY a JSON object: {"nothing_found": false, "answer": "…", "used": [1, 3]}`;
}

function buildContext(rows: Row[]): string {
  return rows.map((r, i) =>
    `[${i + 1}] ${fmtDate(r.created_at)} · ${sourceLabel(r.kind, r.content ?? "")}` +
    (r.summary ? ` · ${r.summary.replace(/\s+/g, " ").trim()}` : "") +
    `\n${snippet(r)}`
  ).join("\n\n");
}

function parseAnswer(text: string, max: number): { nothingFound: boolean; answer: string; used: number[] } {
  const valid = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const raw = JSON.parse(match[0]);
      const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
      const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const used = [...new Set([...(Array.isArray(raw.used) ? raw.used : []), ...cited])].filter(valid) as number[];
      return { nothingFound: raw.nothing_found === true || !answer, answer, used };
    } catch { /* fall through to plain-text handling */ }
  }
  // Not JSON: treat the reply as the answer, if it cites anything.
  const answer = text.trim();
  const used = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter(valid);
  return { nothingFound: used.length === 0, answer: used.length ? answer : "", used };
}

// ---------------------------------------------------------------------------
// The main function
// ---------------------------------------------------------------------------
export async function askBrain(o: AskOptions): Promise<AskResult> {
  const question = o.question.trim().slice(0, 1000);
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

  // 2. Retrieve, plus what the last answer cited
  let rows = await search(o, searchQuery, MIN_SIMILARITY, MATCH_COUNT);
  const lastCited = history.at(-1)?.cited_ids ?? [];
  const missing = lastCited.filter((id) => !rows.some((r) => r.id === id));
  rows = rows.concat(await fetchByIds(o, missing));
  rows = rerank(rows, intent);

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

  const nothing = async (): Promise<AskResult> => {
    const near = rows.length ? rows : await search(o, searchQuery, 0, 3).catch(() => []);
    const closest = near
      .slice()
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 3)
      .map((r, i) => toSource(r, i + 1));
    const turnId = await save({ nothing_found: true, closest_ids: closest.map((c) => c.id), answer: null });
    return {
      turnId, question, searchQuery, intent, nothingFound: true, fromSourcesOnly: false, sourceLabel: null,
      answer: "", sources: [], closest, promptTokens, completionTokens,
    };
  };

  if (rows.length === 0) return await nothing();

  // 3. Answer
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

  // 4. Renumber citations 1..k in order of first use, so the list is tidy.
  const order: number[] = [];
  for (const m of parsed.answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (parsed.used.includes(n) && !order.includes(n)) order.push(n);
  }
  for (const n of parsed.used) if (!order.includes(n)) order.push(n);
  const renumber = new Map(order.map((oldN, i) => [oldN, i + 1]));
  const answer = parsed.answer
    .replace(/\[(\d+)\]/g, (whole, d) => renumber.has(Number(d)) ? `[${renumber.get(Number(d))}]` : "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  const sources = order.map((oldN, i) => toSource(rows[oldN - 1], i + 1));

  // 5. Own writing, or only saved sources?
  const kinds = sources.map((s) => s.kind);
  const fromSourcesOnly = kinds.length > 0 && kinds.every((k) => k === "source");
  const labels = [...new Set(sources.map((s) => s.label))];
  const label = fromSourcesOnly ? (labels.length === 1 ? labels[0] : "sources you saved") : null;

  const turnId = await save({
    answer,
    cited_ids: sources.map((s) => s.id),
    from_sources_only: fromSourcesOnly,
  });

  return {
    turnId, question, searchQuery, intent, nothingFound: false, fromSourcesOnly, sourceLabel: label,
    answer, sources, closest: [], promptTokens, completionTokens,
  };
}

// ---------------------------------------------------------------------------
// Plain-text rendering (Telegram and MCP share it)
// ---------------------------------------------------------------------------
export function renderAnswer(res: AskResult, style: "telegram" | "mcp"): string {
  const ref = (s: Source) => style === "telegram" ? `/t_${s.shortId}` : `(id: ${s.id})`;
  const line = (s: Source) => `[${s.n}] ${ref(s)}  ${fmtDate(s.created_at)} · ${s.label}: ${s.title}`;

  if (res.nothingFound) {
    const near = res.closest.length
      ? "\n\nClosest thoughts:\n" + res.closest.map(line).join("\n")
      : "";
    return `Nothing in your brain on this.${near}`;
  }

  const note = res.fromSourcesOnly
    ? `\n\n(From ${res.sourceLabel}, not your own notes.)`
    : "";
  return `${res.answer}${note}\n\nSources:\n${res.sources.map(line).join("\n")}`;
}
