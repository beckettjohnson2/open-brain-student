# Progress

_Last updated: November 10, 2026_

> **Live since Nov 10:** both migrations are applied, all functions are deployed,
> and all 54 thoughts have a kind. Still to do: put the MCP password in `.env` and
> run the retrieval test, plus the phone test below.

## What's built

| Piece | What it does | How to use it |
|---|---|---|
| Web app (Vercel, `index.html`) | Write, voice (browser speech), YouTube, PDF, URL capture; meaning + keyword search with related thoughts; recent list | Open your Vercel URL and sign in |
| Telegram bot | Saves any text message; `/search` lists matches; `/recent`; `?` and `/ask` answer questions (see Ask my brain) | Message your bot |
| MCP server | `search_thoughts`, `related_thoughts`, `list_recent`, `add_thought` for Claude Desktop and ChatGPT | Already set up in Claude Desktop |
| Enrichment | Every new thought gets tags, a category, a summary and a **kind** (Haiku via call-llm), plus a free embedding, chunks and graph links | Automatic |
| Weekly digest | Sundays 15:00 UTC, if there were 5+ thoughts that week. Leaves out course prompts and old digests | Shows up as a thought |
| call-llm | The one door for every AI call; logs tokens and cost per job | `select * from llm_usage_by_job;` |
| **Metadata** (Nov 9) | `kind` (my_thought, source, course_setup, project_doc, class_note, report), `status` (active, paused, done, dropped, reference), `kind_set_by` (rule, llm, manual) | `select kind, count(*) from thoughts group by 1;` |
| **Course prompts hidden** (Nov 9) | `course_setup` is left out of search, related thoughts, new links and digests | Automatic |
| **Backup** (Nov 9) | Read-only copy of every table, plus the schema, functions and cron jobs | `node scripts/backup.mjs` → `backups/<date>/` |
| **Retrieval test** (Nov 9) | 10 search cases (top 3 / top 10) + 5 ask cases (is the right thought cited?), history kept | `node scripts/retrieval-test.mjs` (`--no-ask` = free search cases only) |
| **Ask my brain** (Nov 10) | Plain-language answers from your notes, 3–6 sentences, every claim cited. Own writing weighted above saved sources; says when an answer comes only from a video or article; "Nothing in your brain on this" + 3 closest when your notes don't say. Remembers the last 5 exchanges for follow-ups. Haiku, about $0.001 per question | Telegram: `? question` or `/ask question`. Questions without `?` get **Save it / Answer it** buttons. Tap `/t_xxxxxxxx` under an answer to read that thought. `/new` forgets the conversation. Claude Desktop: the `ask_brain` tool |
| **Answer feedback** (Nov 10) | Helpful / Wrong buttons under every answer, logged | `select * from ask_quality;` |

## Maintenance scripts

- `node scripts/backup.mjs`: back up before any schema change.
- `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1`: embed anything not yet embedded (free).
- `powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1`: classify anything with no kind (rules, then Haiku).
- `node scripts/retrieval-test.mjs`: rerun after every change and compare with `tests/retrieval-history.csv`.

## Known issues

- `call-llm` and `enrich-thought` don't check who is calling them. Anyone with the URL could spend AI credit.
- 48 thoughts from before Level 5 have no tags, category or summary.
- 4 thoughts have no owner (`user_id` is empty), so they're invisible to the web app and search.
- The MCP `list_recent` doesn't filter by owner. That's harmless with one user.
- `/ search x` (with a space after the slash) is saved as a thought instead of searched.
- The Telegram bot can't receive voice notes (it would need a paid transcription service). Dictate with your keyboard's mic key instead.
- `?` used to mean search in Telegram; it now asks a question. Use `/search` for the plain list.

## Go-live steps (the owner runs these, in order)

1. Back up: `node scripts/backup.mjs`
2. SQL Editor → run `migrations/2026-11-09-metadata.sql`, then `migrations/2026-11-10-ask-brain.sql`
3. Deploy:
   ```
   npx supabase functions deploy call-llm --no-verify-jwt
   npx supabase functions deploy enrich-thought --no-verify-jwt
   npx supabase functions deploy weekly-digest --no-verify-jwt
   npx supabase functions deploy telegram-bot --no-verify-jwt
   npx supabase functions deploy open-brain-mcp --no-verify-jwt
   ```
4. `powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1`
5. Put `MCP_ACCESS_KEY=...` in `.env`, then `node scripts/retrieval-test.mjs`

## How to test Ask my brain on your phone

1. In Telegram, send `? what did I decide about investing and why`. You should see a few sentences with `[1]`-style citations, a **Sources** list, and Helpful / Wrong buttons.
2. Tap a `/t_…` link: the full thought appears.
3. Send `? what about the first one` (a follow-up). It should know what "the first one" means.
4. Send `? what is my favorite pizza topping`. You should get **Nothing in your brain on this**, plus the 3 closest thoughts.
5. Send `what have I saved about peptides` (no `?`). You should get **Save it / Answer it** buttons. Tap Answer it; it should say the answer is from a video you saved.
6. Tap **Helpful** under an answer: it turns into ✅ Helpful.
7. Send `/new`, then `? what about the first one`. It should no longer know what you mean.
8. Send a normal note like `Remember to email my lab partner`. It's saved straight away, with no buttons.

## What's next

1. Lock down `call-llm` and `enrich-thought` so they need the service key.
2. Tag the 48 untagged older thoughts (about 48 Haiku calls, under $0.01).
3. After a week of Helpful/Wrong taps: decide whether Haiku is good enough or Ask should move to Sonnet 5.5 (about 1–2¢ per question).
