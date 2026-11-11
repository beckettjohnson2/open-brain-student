// Chunking helper: resume unfinished chunking now (the same thing the
// 15-minute `resume-chunking` cron job does), or continue one thought.
//
//   node scripts/chunking.mjs            → RESUME every unfinished thought
//   node scripts/chunking.mjs <id>       → CONTINUE one thought
//   node scripts/chunking.mjs <id> --redo → RECHUNK: redo its chunks from 0,
//                                           overwritten in place (test/repair)
//
// Free: embeddings use the built-in gte-small model, no AI calls.
// Reads INTERNAL_SECRET from .env (never printed).
import { readFileSync } from "node:fs";

const URL = "https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought";
const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("INTERNAL_SECRET="));
if (!line) throw new Error("INTERNAL_SECRET missing from .env (see PROGRESS.md, Maintenance scripts)");
const secret = line.slice("INTERNAL_SECRET=".length).trim().replace(/^["']|["']$/g, "");

const id = process.argv[2];
const res = await fetch(URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-secret": secret },
  body: JSON.stringify(id ? { type: process.argv.includes("--redo") ? "RECHUNK" : "CONTINUE", id } : { type: "RESUME" }),
});
console.log(res.status, await res.text());
