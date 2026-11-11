// retrieval-test.mjs — does search find the right thought? Does "Ask my
// brain" cite it?
//
// Reads tests/retrieval-cases.txt and runs:
//   Q:   cases through the SAME search Claude Desktop and Telegram use (the
//        MCP server's search_thoughts → hybrid_search). Scored top 3 / top 10.
//        Free: the built-in gte-small model, no AI calls.
//   ASK: cases through the full answer path (the MCP ask_brain tool). They
//        pass when the answer cites the expected thought (or, for
//        EXPECT: NOTHING, when it says nothing was found). ~$0.001 each.
// Each run is added to tests/retrieval-history.csv so you can see whether a
// change helped or hurt.
//
// Uses INTERNAL_SECRET from .env (set up Nov 11), or your MCP password (the
// MCP_ACCESS_KEY secret from your Claude Desktop config). For the password:
//   - put a line  MCP_ACCESS_KEY=...  in a file named .env in the project
//     folder (.env is git-ignored), or
//   - PowerShell:  $env:MCP_ACCESS_KEY = "..."  before running.
//
// Run from the project folder:   node scripts/retrieval-test.mjs
// Only the free search cases:     node scripts/retrieval-test.mjs --no-ask
// A different cases file:         node scripts/retrieval-test.mjs path\to\cases.txt

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const MCP_URL = process.env.MCP_URL ?? "https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/open-brain-mcp";
const args = process.argv.slice(2);
const NO_ASK = args.includes("--no-ask");
const CASES_FILE = args.find((a) => !a.startsWith("--")) ?? "tests/retrieval-cases.txt";
const HISTORY_FILE = "tests/retrieval-history.csv";
const HISTORY_HEADER = "date,commit,cases,top3,top10,ask_cases,ask_pass";

// The MCP password, or else the INTERNAL_SECRET (already in .env) — the
// MCP server accepts either. Returns the headers to send.
function authHeaders() {
  const fromEnvFile = (name) => {
    if (process.env[name]) return process.env[name].trim();
    if (!existsSync(".env")) return "";
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  };
  const mcp = fromEnvFile("MCP_ACCESS_KEY");
  if (mcp) return { Authorization: `Bearer ${mcp}` };
  const internal = fromEnvFile("INTERNAL_SECRET");
  if (internal) return { "x-internal-secret": internal };
  console.error("No MCP_ACCESS_KEY or INTERNAL_SECRET found in .env (see the top of this file).");
  process.exit(1);
}

// "## 3 / Q: ... / EXPECT: ..." blocks → [{ slot, mode, question, expect }]
function readCases(path) {
  const cases = [];
  let current = null;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const slot = line.match(/^##\s*(.+)$/);
    if (slot) {
      current = { slot: slot[1], mode: "search", question: "", expect: "" };
      cases.push(current);
      continue;
    }
    if (!current || line.startsWith("#")) continue;
    const q = line.match(/^Q:\s*(.*)$/i);
    const a = line.match(/^ASK:\s*(.*)$/i);
    const e = line.match(/^EXPECT:\s*(.*)$/i);
    if (q) current.question = q[1].trim();
    if (a) { current.question = a[1].trim(); current.mode = "ask"; }
    if (e) current.expect = e[1].trim();
  }
  return cases.filter((c) => c.question && c.expect);
}

async function callTool(key, name, toolArgs) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: toolArgs } }),
  });
  if (!res.ok) throw new Error(`MCP server answered ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(text);
  return text;
}

async function search(key, query) {
  const text = await callTool(key, "search_thoughts", { query });
  // Each result: "[created_at] (id: <uuid>)\n<content>", separated by ---
  return text.split("\n\n---\n\n").map((block) => {
    const id = block.match(/\(id: ([0-9a-f-]{36})\)/i)?.[1] ?? "";
    const content = block.replace(/^\[[^\]]*\] \(id: [^)]*\)\n/, "");
    return { id, content };
  }).filter((r) => r.id);
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const looksLikeId = (s) => /^[0-9a-f]{8}(-[0-9a-f-]*)?$/i.test(s);

function rankOf(results, expect) {
  const i = looksLikeId(expect)
    ? results.findIndex((r) => r.id.toLowerCase().startsWith(expect.toLowerCase()))
    : results.findIndex((r) => norm(r.content).startsWith(norm(expect)));
  return i < 0 ? null : i + 1;
}

// For a phrase EXPECT, find the thought's id once with search, so the ask
// check can compare ids (answers only show a short title per source).
async function expectedId(key, c) {
  if (looksLikeId(c.expect)) return c.expect.toLowerCase();
  const results = await search(key, c.expect);
  const hit = results.find((r) => norm(r.content).startsWith(norm(c.expect)));
  return hit ? hit.id.toLowerCase() : null;
}

const key = authHeaders();
const all = readCases(CASES_FILE);
const searchCases = all.filter((c) => c.mode === "search");
const askCases = NO_ASK ? [] : all.filter((c) => c.mode === "ask");
if (all.length === 0) {
  console.log(`No filled-in cases in ${CASES_FILE} yet. Write a Q: (or ASK:) and EXPECT: in at least one slot.`);
  process.exit(0);
}

let top3 = 0, top10 = 0;
if (searchCases.length) console.log("SEARCH (top 3 / top 10)");
for (const c of searchCases) {
  let rank = null, note = "";
  try {
    const results = await search(key, c.question);
    rank = rankOf(results, c.expect);
    if (!rank) note = results.length ? `  (top hit: ${norm(results[0].content).slice(0, 50)}…)` : "  (no results)";
  } catch (e) {
    note = `  ERROR: ${e.message}`;
  }
  if (rank && rank <= 3) top3++;
  if (rank && rank <= 10) top10++;
  const mark = !rank ? "MISS " : rank <= 3 ? "TOP3 " : "TOP10";
  console.log(`${mark} #${c.slot.padEnd(3)} rank ${rank ?? "-"}`.padEnd(24) + `${c.question}${note}`);
}

let askPass = 0;
if (askCases.length) console.log("\nASK (does the answer cite it?)");
for (const c of askCases) {
  let pass = false, note = "";
  try {
    const answer = await callTool(key, "ask_brain", { question: c.question });
    const nothing = answer.startsWith("Nothing in your brain on this");
    if (c.expect.toUpperCase() === "NOTHING") {
      pass = nothing;
      if (!pass) note = "  (it answered instead of saying nothing was found)";
    } else {
      const want = await expectedId(key, c);
      // Only the "Sources:" part counts — not the "Closest thoughts" list.
      const sourcesPart = nothing ? "" : (answer.split("\nSources:\n")[1] ?? "");
      const cited = [...sourcesPart.matchAll(/\(id: ([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());
      if (!want) note = "  (could not find the EXPECT thought itself — check the phrase)";
      pass = !!want && cited.some((id) => id.startsWith(want));
      if (!pass && want) note = nothing ? "  (said nothing was found)" : `  (cited ${cited.length} others)`;
    }
  } catch (e) {
    note = `  ERROR: ${e.message}`;
  }
  if (pass) askPass++;
  console.log(`${pass ? "CITED" : "MISS "} #${c.slot.padEnd(3)}`.padEnd(24) + `${c.question}${note}`);
}

console.log("");
if (searchCases.length) {
  console.log(`Top 3:  ${top3}/${searchCases.length}`);
  console.log(`Top 10: ${top10}/${searchCases.length}`);
}
if (askCases.length) console.log(`Ask cited: ${askPass}/${askCases.length}`);

let commit = "";
try { commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a git folder */ }
if (CASES_FILE === "tests/retrieval-cases.txt") {
  if (!existsSync(HISTORY_FILE)) writeFileSync(HISTORY_FILE, HISTORY_HEADER + "\n");
  appendFileSync(
    HISTORY_FILE,
    `${new Date().toISOString()},${commit},${searchCases.length},${top3},${top10},${askCases.length},${askPass}\n`,
  );
  console.log(`Saved to ${HISTORY_FILE}`);
}
