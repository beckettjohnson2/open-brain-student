# Open Brain — standing rules for every session

Personal knowledge base: Supabase (Postgres + edge functions + pg_cron), a
single-file web app on Vercel (`index.html`), a Telegram bot, and an MCP
server for Claude Desktop / ChatGPT. Read `PROGRESS.md` first for what's
built and what's next.

## Rules

1. **Reuse the existing architecture.** Supabase, edge functions, `call-llm`,
   the Telegram bot, pg_cron, built-in Supabase embeddings (gte-small).
   No new paid services or subscriptions.
2. **All LLM calls go through `call-llm`.** Never call a provider directly.
   - Scheduled and background jobs (enrichment, digests, classification): the
     cheapest Claude model, Haiku (the `LLM_MODEL` secret, currently
     `claude-haiku-5-5`).
   - "Ask my brain" uses Haiku too, by the owner's choice (Nov 10): they want
     each question to cost a fraction of a cent. `ANSWER_MODEL` in
     `supabase/functions/_shared/ask.ts` switches it.
   - A stronger model only when answering the owner's direct questions: pass
     `model` in the call-llm body, and add its price to `PRICES` in
     `call-llm/index.ts` first, or its cost is logged as $0.
   - Always pass `source` (the job name) and `userId`, so tokens and cost are
     logged per job in `llm_usage`. See them: `select * from llm_usage_by_job;`
3. **No destructive migrations.** Additive changes only (new nullable columns,
   new tables, `create or replace` keeping the same inputs and outputs).
   Nothing dropped or renamed. **Back up before any schema change:**
   `node scripts/backup.mjs` (read-only, writes `backups/<date>/`, git-ignored).
   Migrations live in `migrations/` and the owner runs them in the Supabase
   SQL Editor.
4. **Never turn casual thoughts into tasks, goals, or commitments without
   asking the owner in Telegram first** (inline-keyboard yes/no).
5. **Every AI answer or suggestion cites the thoughts it came from.** If
   nothing relevant exists, say so instead of guessing. General knowledge only
   when clearly labelled as general knowledge.
6. **Keep the owner's own writing separate from saved sources, and weight it
   higher.** Own writing: `kind` in (`my_thought`, `project_doc`,
   `class_note`). Saved sources: `source`. `course_setup` (the Level 0–7 build
   prompts) is excluded from search, related thoughts, links and digests by
   default. `report` is AI-written (digests).
7. **One feature at a time:** plan first → wait for the owner's OK →
   implement → test (including `node scripts/retrieval-test.mjs`) → show how
   to test it on the phone → commit with a clear message.
8. **Keep `PROGRESS.md` updated:** what's built, how to use it, what's next.
9. **Telegram buttons use inline keyboards** with `callback_query` handling
   in the existing `telegram-bot` function. `handleCallback` routes by a
   `callback_data` prefix (`fb:` feedback, `sv:`/`an:` Save it/Answer it).
   Add new buttons there, and keep `callback_data` under 64 bytes.

## Facts worth knowing

- **Search:** `hybrid_search` (same signature the web app, bot and MCP use)
  wraps `hybrid_search_v2`, which also returns `kind`/`status` and takes
  `include_kinds text[]` (null = everything except `course_setup`).
  Embeddings: gte-small, 384 dims, via `Supabase.ai.Session` inside edge
  functions only. Thoughts over 300 words also get chunks in `thought_chunks`.
- **Enrichment:** the `enrich-on-insert` database webhook → `enrich-thought`
  (tags/category/summary/kind via call-llm, then free embedding/chunks/links).
  Modes: `BACKFILL`, `CONTINUE`, `RELINK`, `CLASSIFY`.
- **Ask my brain:** `supabase/functions/_shared/ask.ts` (`askBrain`,
  `renderAnswer`), used by `telegram-bot` and the `ask_brain` MCP tool.
  Tables: `ask_turns` (memory, cost, citations; `/new` sets `cleared_at`),
  `answer_feedback`, `telegram_pending`. View: `ask_quality`. Redeploy BOTH
  `telegram-bot` and `open-brain-mcp` after changing `_shared/`.
- **Cron:** `keep-brain-awake` (Sun and Wed 09:00 UTC), `weekly-brain-digest` (Sun 15:00 UTC).
- **Owner:** functions using the service key must filter by `OWNER_USER_ID`
  themselves; row-level security doesn't apply to them.
- **Deploy:** `npx supabase functions deploy <name> --no-verify-jwt` for
  `telegram-bot`, `open-brain-mcp`, `enrich-thought`, `weekly-digest`,
  `call-llm`. Deploy `search-brain`, `capture-url` and `capture-youtube`
  without that flag (they check logins).
- **Known open issue:** `call-llm` and `enrich-thought` don't check who is
  calling them, so anyone with the URL can make them spend AI credit. Fix as
  its own feature.
- **Never** re-run the root `migration.sql`: it re-creates the Level 1
  "anyone can read and write" policy.
- No Docker or `pg_dump` on this machine; `npx supabase db query --remote --read-only`
  works for read-only checks.
