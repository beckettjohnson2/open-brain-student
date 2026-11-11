// backup.mjs — saves a full copy of your brain to backups/<date-time>/ on this computer.
//
// Uses only READ-ONLY queries through the Supabase CLI you are already logged
// into, so it can never change anything. No password, no Docker needed.
//
// Run from the project folder:   node scripts/backup.mjs
//
// What you get (one JSON file each):
//   thoughts, thought_chunks, thought_links, thought_sources, llm_usage,
//   and any other table in "public" — every row, every column.
//   schema.json — columns, constraints, indexes, policies, triggers, the full
//   SQL of every database function, and the cron jobs.
//
// backups/ is in .gitignore: it holds your private notes, never push it.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PAGE = 25; // rows per query — keeps each CLI answer small

// The SQL goes in a temp file: on Windows, npx runs through cmd.exe, which
// would split a query passed on the command line into separate words.
const SQL_FILE = join(tmpdir(), `open-brain-backup-${process.pid}.sql`);

function q(sql) {
  writeFileSync(SQL_FILE, sql);
  const out = execFileSync(
    "npx",
    ["--no-install", "supabase", "db", "query", "--remote", "--read-only", "--output-format", "json", "-f", SQL_FILE],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: process.platform === "win32" },
  );
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`Unexpected CLI output: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start)).rows;
}


const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join("backups", stamp);
mkdirSync(dir, { recursive: true });

const tables = q(
  "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
).map((r) => r.table_name);

const counts = {};
for (const table of tables) {
  const expected = Number(q(`select count(*) as n from public.${table}`)[0].n);
  const rows = [];
  for (let offset = 0; offset < expected; offset += PAGE) {
    // Order by every column's text so paging is stable even without an id.
    const page = q(
      `select row_to_json(t) as r from public.${table} t order by t::text limit ${PAGE} offset ${offset}`,
    );
    rows.push(...page.map((p) => p.r));
  }
  if (rows.length !== expected) {
    throw new Error(`${table}: expected ${expected} rows, got ${rows.length} — backup NOT complete`);
  }
  writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows));
  counts[table] = rows.length;
  console.log(`  ${table}: ${rows.length} rows`);
}

const schema = {
  columns: q(
    "select table_name, column_name, data_type, udt_name, is_nullable, column_default, is_generated, generation_expression from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position",
  ),
  constraints: q(
    "select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2",
  ),
  indexes: q("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
  policies: q("select * from pg_policies where schemaname = 'public'"),
  triggers: q(
    "select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'pg_%' and tgrelid::regclass::text not like '%.%'",
  ),
  functions: q(
    "select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1",
  ),
  extensions: q("select extname, extversion from pg_extension order by 1"),
  cron_jobs: q("select jobid, jobname, schedule, active, command from cron.job order by jobid"),
};
writeFileSync(join(dir, "schema.json"), JSON.stringify(schema, null, 2));
writeFileSync(join(dir, "summary.json"), JSON.stringify({ taken_at: new Date().toISOString(), counts }, null, 2));

console.log(`\nBackup complete: ${dir}`);
console.log("Keep this folder. It contains private notes — it is git-ignored, never push it.");
