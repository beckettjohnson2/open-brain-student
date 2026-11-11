# Progress

_Last updated: November 11, 2026_

> **Nov 11 (evening): Content quality.** 4 link-only thoughts now hold their
> transcript/article/PDF (same ids); 3 YouTube search links wait for you in Telegram.
> Junk review, goal proposals and source reliability are live. See "Waiting on you".
>
> **Nov 11 (later): Sections.** Personal and Library, derived from kind. Live in
> Telegram, MCP and Ask. The web app tabs go live after the next push to GitHub.
>
> **Nov 11 (fixes only):** internal functions now need a shared secret, the
> Telegram webhook is verified, the 4 ownerless thoughts are fixed, and 38 older
> thoughts got tags and summaries. The old webhook (which had the service key
> written into it) and the test thought were removed by the owner in the SQL Editor
> (`migrations/2026-11-11b-remove-old-webhook.sql`).

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
| **Sections** (Nov 11) | **Personal** = my_thought, class_note, report (you and what you know). **Library** = source, project_doc (things you found or made). course_setup stays hidden. Derived from kind, never labelled by hand (`thoughts.section`, computed) | `select section, count(*) from thoughts group by 1;` |
| **Section search** (Nov 11) | `/me words` = Personal only, `/lib words` = Library only, `/search words` = both with each result labelled. MCP `search_thoughts` and `ask_brain` take an optional `section` | Telegram, Claude Desktop |
| **Two-part answers** (Nov 11) | Ask answers in "🧠 What you know" and "📚 From your library". "About me" questions (goals, what do I think…) search Personal first. AI write-ups are never put in your voice | `? what are my goals` |
| **Kind switch + log** (Nov 11) | Every Telegram save says its section, with **Move to Library / Personal** and **Change kind** buttons. Every kind change, from anywhere, is logged (old, new, when) | `select * from kind_changes order by changed_at desc;` |
| **Takeaways** (Nov 11) | Saving a Library item (from Telegram, the web app or Claude Desktop) gets "💡 What's your takeaway?" in Telegram. Reply to that message to save it as your own note, linked to the item. `/takeaway words` adds one later; `/takeaway` alone lists items without one. Ask ranks your takeaway above the item | Reply to the bot's question |
| **Links that read themselves** (Nov 11) | Send the bot a bare link: a YouTube video gets its transcript, an article its text, a PDF its text, all in the same thought. A YouTube *search* link gets "send me the actual video link". If nothing readable comes back: "Saved the link but couldn't read it. Send me the text or a different link?" (reply with either) | Send a link |
| **Junk + commands** (Nov 11) | Anything starting with `/` is a command and is never saved; "/ search x" works as /search; unknown commands get the help. Test/junk messages can be archived (`status = 'archived'`, hidden everywhere, never deleted) | Archive / Keep buttons |
| **Source reliability** (Nov 11) | Every saved source is rated research / expert / opinion / unknown (Haiku). Ask and the weekly digest say when a claim rests only on opinion-level sources and prefer research/expert when they disagree | `select reliability, count(*) from thoughts where kind='source' group by 1;` |
| **Goals** (Nov 11) | Proposed from your voice notes in your own words, sent one at a time with **Track / Not a goal**. Only Track creates a goal | `/goals` |
| **Digests rank lower** (Nov 11) | Weekly digests and AI write-ups count half in every search; Ask cites the original notes instead of a digest | Automatic |
| **Class recaps** (Nov 11) | `/recap Chem 113: what we covered` saves a class note tagged with the class and asks one follow-up question; reply to it and your answer is saved too. `/recap Chem 113` alone asks you for the summary | Telegram |
| **Web app sections** (Nov 11) | All / Personal / Library filters on Recent; each card shows its section and has a kind picker | Recent tab, after the push |

## Maintenance scripts

- `node scripts/backup.mjs`: back up before any schema change.
- `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1`: embed anything not yet embedded (free).
- `powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1`: classify anything with no kind (rules, then Haiku).
- `powershell -ExecutionPolicy Bypass -File scriptsackfill-tags.ps1`: tag and summarize anything saved without tags (Haiku, skips course_setup). `-Preview 5` shows 5 without saving.
- `node scripts/retrieval-test.mjs`: rerun after every change and compare with `tests/retrieval-history.csv`.
- All scripts read `INTERNAL_SECRET` from `.env`. If you ever lose `.env`: in the SQL Editor run `select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret';` and put `INTERNAL_SECRET=<that>` in `.env`.

## Known issues

- Long documents can crowd generic questions: after the Paul Graham essay got its 67,000 characters, test #7 ("what does an industrial engineer actually do") slipped from rank 3 to 4 because the essay matches common words. Still top 10.
- 20 goal proposals is a lot; some overlap ("Break bad habits", "Better myself"). Tap Not a goal freely.
- Retrieval test A4 ("what did I decide about investing") is variable. Answers draw on several relevant notes and don't always cite the expected voice note. The answer itself is correct and cited.
- Your "About Me" profile is a `project_doc`, so it sits in Library. If you think of it as about you, move it to Personal with one tap.
- A takeaway counts only if you *reply* to the bot's question. A plain next message is saved as a normal thought.
- "Mathew 5:27-32" is too short to tag, so it stays untagged.
- `/ search x` (with a space after the slash) is saved as a thought instead of searched.
- The Telegram bot can't receive voice notes (it would need a paid transcription service). Dictate with your keyboard's mic key instead.
- `?` used to mean search in Telegram; it now asks a question. Use `/search` for the plain list.

## Retrieval scores

| Date | Change | Search top 3 | Search top 10 | Ask cited |
|---|---|---|---|---|
| Nov 11 | Before tag backfill | 10/10 | 10/10 | 5/5 |
| Nov 11 | After tag backfill (38 thoughts) | 10/10 | 10/10 | 4/5 (A4: Tesla write-up now leads; see Known issues) |
| Nov 11 | After Sections | 10/10 | 10/10 | 4/5 (A4 variable; see Known issues) |
| Nov 11 | Before content quality | 10/10 | 10/10 | 5/5 |
| Nov 11 | After content quality | 9/10 | 10/10 | 5/5 (#7 rank 3 → 4; see Known issues) |

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

## Waiting on you (Telegram)

1. **3 YouTube search links**: Veritasium "The Science of Thinking", Ray Dalio "How The Economic Machine Works", Julian Treasure "How to Speak So That People Want to Listen". Reply to each bot message with the real video link and its transcript is attached to the original thought.
2. **2 junk candidates**: "Hello, this is my first thought from Telegram" and "/ search speaking confidently". Tap Archive or Keep.
3. **20 goal proposals**, one at a time. Tap Track or Not a goal. `/goals` shows what you track and resumes the questions.

## How to test content quality on your phone

1. Send `/ search sleep` (with the space). You should get search results, not "Saved".
2. Send `/hello`. You should get the help text, not "Saved".
3. Send a YouTube video link. "Reading it now…", then "Saved to Library" with the character count and a takeaway question.
4. Send `/recap Chem 113: today we covered periodic trends and electronegativity`. Saved as a class note, plus one follow-up question; reply to it.
5. Send `? are fragrances bad for my health`. The research-level review should lead and the opinion-level video should be flagged.

## How to test Sections on your phone

1. Reply to the bot's "💡 What's your takeaway from Peptides…" message (swipe left on it) with a sentence. You should get "Takeaway saved to Personal, linked to…".
2. Send `? what do I think about peptides`. Your takeaway should lead under 🧠 What you know, with the video under 📚 From your library.
3. Send a normal note. The reply should say "🧠 Saved to Personal (my thought)" with buttons. Tap **Move to Library**: it changes, and the bot asks for a takeaway (ignore it).
4. Send `/me sleep`, then `/lib sleep`. Personal-only and Library-only results.
5. Send `/takeaway`. You should see your Library items without a takeaway.
6. After the GitHub push: the web app's Recent tab has All / Personal / Library, and a kind picker on each card.

## What's next

1. Add harder retrieval test cases, so the test can show improvements and not only regressions.
2. After a week of Helpful/Wrong taps: decide whether Haiku is good enough or Ask should move to Sonnet 5.5 (about 1–2¢ per question).
