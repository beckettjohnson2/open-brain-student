# Progress

_Last updated: November 11, 2026_

> **Nov 11 (fixes only):** internal functions now need a shared secret, the
> Telegram webhook is verified, the 4 ownerless thoughts are fixed, and 38 older
> thoughts got tags and summaries. One step left for you: run
> `migrations/2026-11-11b-remove-old-webhook.sql` in the SQL Editor (it removes the
> old, already-disabled webhook that had the service key in it, and the test thought).

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
| **Internal secret** (Nov 11) | `call-llm`, `enrich-thought` and `weekly-digest` return 401 unless the caller sends `x-internal-secret`. The value lives in Vault (`internal_secret`, used by the save trigger and the digest cron job), the `INTERNAL_SECRET` edge-function secret, and your git-ignored `.env` (used by the scripts). The MCP server also accepts it, so the retrieval test needs no password | Automatic |
| **Telegram webhook check** (Nov 11) | The bot only accepts requests carrying Telegram's secret token (`TELEGRAM_WEBHOOK_SECRET`) and only replies to your chat ID. Re-register: POST to the telegram-bot URL with the `x-internal-secret` header | Automatic |
| **Owner safety net** (Nov 11) | A thought saved without an owner gets yours (owner ID is in Vault) | Automatic |

## Maintenance scripts

- `node scripts/backup.mjs`: back up before any schema change.
- `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1`: embed anything not yet embedded (free).
- `powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1`: classify anything with no kind (rules, then Haiku).
- `powershell -ExecutionPolicy Bypass -File scriptsackfill-tags.ps1`: tag and summarize anything saved without tags (Haiku, skips course_setup). `-Preview 5` shows 5 without saving.
- `node scripts/retrieval-test.mjs`: rerun after every change and compare with `tests/retrieval-history.csv`.
- All scripts read `INTERNAL_SECRET` from `.env`. If you ever lose `.env`: in the SQL Editor run `select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret';` and put `INTERNAL_SECRET=<that>` in `.env`.

## Known issues

- **Answers can blur your thinking with AI write-ups.** When an answer cites a `report` (for example, the Tesla write-up), it labels the source "an AI digest" but can still say "you concluded". Fix: change the label to "an AI write-up you saved" and tell the model not to put those claims in your voice. Found by retrieval test A4 on Nov 11.
- "Mathew 5:27-32" is too short to tag, so it stays untagged.
- `/ search x` (with a space after the slash) is saved as a thought instead of searched.
- The Telegram bot can't receive voice notes (it would need a paid transcription service). Dictate with your keyboard's mic key instead.
- `?` used to mean search in Telegram; it now asks a question. Use `/search` for the plain list.

## Retrieval scores

| Date | Change | Search top 3 | Search top 10 | Ask cited |
|---|---|---|---|---|
| Nov 11 | Before tag backfill | 10/10 | 10/10 | 5/5 |
| Nov 11 | After tag backfill (38 thoughts) | 10/10 | 10/10 | 4/5 (A4: Tesla write-up now leads; see Known issues) |

The pre-filled cases are easy (everything already ranks in the top 3), so they mostly catch regressions. Add harder ones: a vague phrasing, or a detail buried deep in a long video.

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

1. Fix the AI write-up attribution in Ask answers (see Known issues).
2. Add harder retrieval test cases, so the test can show improvements and not only regressions.
3. After a week of Helpful/Wrong taps: decide whether Haiku is good enough or Ask should move to Sonnet 5.5 (about 1–2¢ per question).
