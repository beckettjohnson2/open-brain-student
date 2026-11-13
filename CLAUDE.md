# Open Brain — standing rules for every session

Personal knowledge base: Supabase (Postgres + edge functions + pg_cron), a
single-file web app on Vercel (`index.html`), a Telegram bot, and an MCP
server for Claude Desktop / ChatGPT. Read `PROGRESS.md` first for what's
built and what's next.

## How to work with me (autonomy rules)
- Work on your own as much as possible. Don't ask me about routine steps: reading files, writing code, running tests, deploying edge functions, running the retrieval test, committing.
- Batch your questions. Check in only at these checkpoints, with one short message: "Here's what I did, here's what I'm about to do, OK to go ahead?"
  1. Before any database schema change (after the backup is done)
  2. Before anything that costs more than $0.25 in AI calls in one go
  3. Before deleting or overwriting anything, or rotating keys or secrets
  4. Before git push (that deploys to Vercel)
  5. When you need me to do something only I can do (dashboard clicks, pasting a secret, testing on my phone)
- If something fails, try to fix it yourself up to 3 times before asking me. Then explain the problem in plain words and give me 2 options.
- At the end of each session, give me a short summary: what's done, what to test on my phone (step by step), what's next.

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
   - Also pass `runId` (an `agent_runs` id): call-llm then adds the call's
     tokens and cost to that run and its order (`add_run_usage`). Every AI
     call belongs to a run (check: `select count(*) from llm_usage where
     run_id is null and created_at > now() - interval '1 day';` should be 0).
     Prices live in `_shared/prices.ts`.
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
   `callback_data` prefix (`fb:` feedback, `sv:`/`an:` Save it/Answer it,
   `k:<kind>:<id>` set kind, `km:` kind menu, `tk:` pick takeaway item,
   `op:` open item, `gt:`/`gn:` goal proposals, `mg:k|p|d:` /mygoals review,
   `kg:` Send to King, `ko:a|e|c|g|x|s:<order>` order Approve / Edit / Cancel /
   Go on / Stop / Save as report, `fx:a|n:<run>` Fixer Approve / Reject,
   `mr:<id>:<offset>` Show more). Add new buttons there, and keep `callback_data` under
   64 bytes.
12. **Crew rules (King + workers, `supabase/functions/crew`).**
   - Nothing runs before the owner taps **Approve** on the King's plan. The
     Fixer changes nothing before a second **Approve** on its exact change list.
     Never approve on the owner's behalf, except test orders the owner asked
     for, and never a Fixer change.
   - Workers only READ the brain. The only writes: "Save as report" (kind =
     report, after the owner taps it) and the Fixer's housekeeping (re-capture,
     archive, change kind). Never delete. No messages to anyone but the owner
     (telegram-bot `notify` sends only to the owner's chat), no posting,
     purchases, trading, or anything outside the brain. The King refuses such orders.
   - Haiku for every agent (`agents.model`). Limits in `crew_config`:
     `max_worker_steps` 8, `cost_cap_usd` 0.05 per order (the crew stops and
     asks before passing it), `critic_retries` 1.
   - Every agent step AND every background job writes `agent_runs`
     (queued | working | waiting_on_me | done | failed). The 3D office will show
     only this data, so a new job must call `startRun`/`finishRun`
     (`_shared/runs.ts`) and pass `runId` to call-llm. Background jobs are
     agent `Scout` (job = enrich-thought, refresh, resume-chunking,
     weekly-digest, goal-proposals, …); Ask is `Librarian` (job ask-brain);
     the recap question is `Tutor` (job recap-question).
   - Every result cites notes as `[t_<8 hex>]` inside the crew, shown to the
     owner as `[n]` plus `/t_` links. The Critic checks them; it sends a failed
     draft back once, then the problems are shown with the result.
10. **Never delete thoughts. Sections are derived from kind.** Personal =
   `my_thought`, `class_note`, `report`; Library = `source`, `project_doc`;
   `course_setup` stays hidden. Never store a section by hand: change the
   mapping only in `public.section_of()` (and its copy in
   `_shared/kinds.ts` and `index.html`).
11. **Hide, don't remove.** Unwanted thoughts get `status = 'archived'`
   (hidden from search, Ask, related, links, digests, Recent). Never delete
   rows. Goals exist only after the owner taps Track in Telegram.

## Facts worth knowing

- **Search:** `hybrid_search` (web app's search-brain) wraps
  `hybrid_search_v2` (adds `kind`/`status`, `include_kinds text[]`; null =
  everything except `course_setup`). `hybrid_search_v3` (bot, MCP, Ask) adds
  `p_section` ('personal' | 'library' | null) and returns `section` and
  `takeaway_of`. v2 leaves out archived thoughts and ranks `kind = report`
  (digests, AI write-ups) at half weight, so originals come first.
  Embeddings: gte-small, 384 dims, via `Supabase.ai.Session` inside edge
  functions only. Thoughts over 300 words also get chunks in `thought_chunks`.
  Every caller passes `query_text: keywordQuery(q)` (`_shared/keywords.ts`):
  the keyword half ANDs every word, so filler like "video", "something",
  "actually" is dropped there; the embedding uses the question as typed.
- **Reliability:** `thoughts.reliability` (research | expert | opinion |
  unknown) for `kind = source`, rated by Haiku (`rate-reliability`) on save
  and on REFRESH; backfill with enrich-thought `{type: "RELIABILITY"}`. Ask and
  the weekly digest flag opinion-only claims and prefer research/expert.
- **Captures:** `capture-url` (now also reads PDFs, via `npm:unpdf`) and
  `capture-youtube` have an internal refill mode (`x-internal-secret` +
  `thought_id`): they fill an existing thought, keep its id (old text in
  `metadata.original_content`), then enrich-thought `REFRESH` redoes tags,
  reliability, embedding, chunks and links. The bot reads every bare link
  this way; under `MIN_REAL_CONTENT` (200 chars) it asks for the text or
  another link.
- **Bot prompts** (`telegram_prompts.purpose`): `takeaway`, `replace_link`,
  `recap`, `recap_answer`. Internal bot actions: `ask_takeaway`, `fix_link`,
  `review_junk`, `propose_goals`, `notify` (text to the owner, optional
  `keyboard`, long texts split; returns `message_id`). Anything starting with `/` is a command
  and is never saved, even as a reply to a bot question (the question stays open).
- **Goals:** `goal_candidates` (proposals from voice notes) → `goals`
  (status active) only via the Track button (`gt:`/`gn:` callbacks).
  `/mygoals` sets status active/paused/dropped (never deletes). Ask adds the
  source notes of active goals to "about me" questions.
- **Sections:** `thoughts.section` is a generated column =
  `section_of(kind)`. After changing `section_of()`, refresh with
  `update thoughts set kind = kind;`. Every kind change is logged in
  `kind_changes` by the `thoughts_log_kind_change` trigger (old, new, by,
  when). `enrich-thought` never overwrites `kind_set_by = 'manual'`.
- **Takeaways:** a `my_thought` with `takeaway_of` = the Library item's id,
  content `💡 Takeaway on "<title>": …`. Prompts live in `telegram_prompts`
  (the bot's force-reply message id → item). New Library items saved
  outside the bot get a prompt via `telegram-bot` `{action: "ask_takeaway"}`
  from enrich-thought. Ask adds takeaways of matched items, ranked above
  the item.
- **Web app:** `index.html` deploys through Vercel only when pushed to
  GitHub. Ask the owner before pushing.
- **Enrichment:** the `enrich_on_insert_v2` trigger (`notify_enrich_thought()`,
  pg_net) → `enrich-thought` (tags/category/summary/kind via call-llm, then
  free embedding/chunks/links). Modes: `BACKFILL`, `CONTINUE`, `RELINK`,
  `CLASSIFY`, `RETAG` (with `dryRun`), `REFRESH`, `RELIABILITY`. The old `enrich-on-insert` webhook was
  removed on Nov 11.
- **Ask my brain:** `supabase/functions/_shared/ask.ts` (`askBrain`,
  `renderAnswer`), used by `telegram-bot` and the `ask_brain` MCP tool.
  Tables: `ask_turns` (memory, cost, citations; `/new` sets `cleared_at`),
  `answer_feedback`, `telegram_pending`. View: `ask_quality`. Redeploy BOTH
  `telegram-bot` and `open-brain-mcp` after changing `_shared/`.
- **Cron:** `keep-brain-awake` (Sun and Wed 09:00 UTC), `weekly-brain-digest` (Sun 15:00 UTC),
  `resume-chunking` (every 15 min → enrich-thought `RESUME`), `resume-orders`
  (every 15 min → crew `resume`: re-kicks lost hand-offs, retries a step stuck
  5+ min once, closes finished Scout runs).
- **Crew:** tables `agents` (registry: name, role, symbol_key, item_key,
  model, system_prompt, allowed_tools, active), `crew_config`, `orders`,
  `agent_runs`; view `agent_board`. Flow: `plan` (King, 1 Haiku call) →
  Telegram plan with buttons → `approve` queues one run per step → `advance`
  runs ONE step per call, then calls itself (confirmed hand-off) → Critic →
  King's final check (no AI call) → result in Telegram. Entry points: `/king`,
  the "Send to King" button (messages that look like instructions, see
  `looksLikeInstruction`), MCP `king_order`. `/orders`, `/o_<8 hex>` show them.
  Capture functions have an internal `preview: true` refill mode (read, don't
  save) that the Fixer uses to show before/after sizes. Test helper calls:
  crew `{action: "scan"}` (read-only capture check), `{action: "show", order}`.
- **Brain HQ (`hq.html`):** the 3D office. Loads once at open, then Supabase
  Realtime on `agent_runs`, `orders`, `thoughts`, `llm_usage` (publication
  `supabase_realtime`); no polling, no AI calls. Its buttons call crew
  `{action: "web", op: approve|cancel|go_on|stop|fixer_approve|fixer_reject}`
  with the owner's login token (checked against `OWNER_USER_ID`); that path
  runs `orderButton` / `fixerDecision`, nothing else. Robot shape is fixed:
  never change `makeRobot`. Rollback tag: `hq-classic-v1`. `hq.html?demo`
  renders a sample crew without login (`&open=board|agent|core|replay`).
- **Chunking:** at most `CHUNKS_PER_CALL` (3) chunks per call, each saved with
  its progress in `chunk_progress` (next_index/total, last_error, stalls).
  CONTINUE replies at once and works after the reply. RESUME restarts every
  thought with `embedded_at` null; after 3 checks with no progress it sends a
  Telegram `notify` once. Resuming starts at the first chunk whose saved
  text differs from the current content (so refilled text is rechunked
  even with the same chunk count). `RECHUNK {id}` rebuilds one thought's
  chunks in place; `AUDIT_CHUNKS` (read-only) lists mismatches.
  Helper: `node scripts/chunking.mjs [id] [--redo] | --audit`.
- **Owner:** functions using the service key must filter by `OWNER_USER_ID`
  themselves; row-level security doesn't apply to them.
- **Deploy:** `npx supabase functions deploy <name> --no-verify-jwt` for
  `telegram-bot`, `open-brain-mcp`, `enrich-thought`, `weekly-digest`,
  `call-llm`, `crew`. After changing `_shared/`, redeploy every function that
  imports the changed file. Type-check first (no local Deno; this works):
  `npx -y deno@2.1.4 check --no-lock <types.d.ts> <fn>/index.ts`, with a small
  d.ts declaring `Supabase.ai.Session` and `EdgeRuntime`. Deploy `search-brain`, `capture-url` and `capture-youtube`
  without that flag (they check logins).
- **Internal secret:** `call-llm`, `enrich-thought`, `weekly-digest` and `crew` call
  `rejectUnlessInternal(req)` (`_shared/internal-auth.ts`) and return 401
  without the `x-internal-secret` header. Any new internal call must send
  `internalHeaders()`. The value lives in Vault (`internal_secret`, read by
  SQL/pg_cron), the `INTERNAL_SECRET` edge secret, and `.env` (scripts). Never
  write it into the repo or into SQL. The MCP server accepts it as well as its
  own keys.
- **Telegram:** requests must carry `X-Telegram-Bot-Api-Secret-Token` =
  `TELEGRAM_WEBHOOK_SECRET`. POST to telegram-bot with `x-internal-secret` to
  re-register the webhook (`allowed_updates`: message, callback_query).
- **Owner:** Vault `owner_user_id`; `public.owner_user_id()`; the
  `thoughts_default_owner` trigger fills in a missing `user_id`.
- **Permissions on this machine:** the auto-mode check allows deploys and
  `migrations/*.sql` runs. It blocks drops/deletes and reading the owner's
  credentials, so hand those to the owner as copy-paste SQL.
- **Never** re-run the root `migration.sql`: it re-creates the Level 1
  "anyone can read and write" policy.
- No Docker or `pg_dump` on this machine; `npx supabase db query --remote --read-only`
  works for read-only checks.
