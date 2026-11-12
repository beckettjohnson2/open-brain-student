# Progress

_Last updated: November 12, 2026 (night)_

> **Nov 12 (night): Agent crew + bug fixes.** A "King" now takes orders
> (`/king …`, a **Send to King** button, or Claude Desktop's `king_order`),
> replies with a plan and its estimated cost, and runs nothing until you tap
> **Approve**. Workers: Librarian (searches), Tutor (study plans, quizzes),
> Reviewer (checks your writing), Writer (drafts), Critic (every claim cited,
> sends a draft back once), Fixer (housekeeping, only after a second Approve on
> its exact change list), Scout (the background jobs). Everything they do is
> logged in `orders` and `agent_runs`, with real costs, for the 3D office
> later. Limits: Haiku only, 8 steps, 5¢ per order (it asks before passing
> it). Test orders: Chem 113 study plan 1.1¢, public speaking 0.8¢, essay
> review 0.8¢, transcript check under 0.1¢ (nothing needed fixing).
> **Bug fixes:** the "/search the danger…" takeaway is archived, and a "/"
> reply to a takeaway question now runs the command (the question stays
> open). Instruction-like messages ("Delete that") get **Save as note / Send
> to King** buttons. The two instruction messages and "/ search speaking
> confidently" were already archived. The Julian Treasure transcript was
> never cut off (all 9,103 characters and 9 chunks are there); the Telegram
> `/t_` view stopped at 3,500 characters. Long thoughts now have a
> **Show more** button.

> **Nov 12 (later): Full check-up.** Found and fixed one bug: when the
> Veritasium video was re-read in English, its 11 German chunks stayed,
> because the new text also had 11 chunks and the progress tracker took that
> as done. Chunking now compares each saved chunk's text with the current
> text. Veritasium is all English now, and a new audit (`node
> scripts/chunking.mjs --audit`) shows all 59 thoughts' chunks match their
> text. Also checked: 0 unembedded thoughts, 0 without an owner, every cron
> job's last run succeeded, section filters, odd searches ("video" alone,
> quotes), library-only Ask, and all 8 functions refuse callers without the
> secret. A test "stuck" alert was sent to Telegram.

> **Nov 12: English transcripts, harder tests.** "The Science of Thinking"
> (Veritasium) had been saved with German captions. The video reader now asks
> Supadata for English, tries YouTube's own English captions if another
> language comes back, and only then keeps the other language; the language
> is recorded in `metadata.transcript_lang`. The video was re-read in English
> (same id; the German copy is in `backups/2026-11-11T07-19-46`). The other 13
> videos were already English. The retrieval test now has 16 search + 7 Ask
> cases, including 4 details buried deep in long items (all rank 1, so chunks
> work) and 2 vague phrasings.

> **Nov 11 (late night): Goals clean-up, reliable chunking, goals in Ask.**
> `/mygoals` reviews tracked goals one at a time (Keep / Pause / Drop; only the
> status changes). You now track 5 and dropped 11. Chunking (splitting long
> videos and documents into searchable pieces) stalled because each call held
> up to 5 pieces in memory and saved them together, so a call cut off by
> Supabase's ~2-second computing limit lost them all, and the hand-off to the
> next call was fire-and-forget. Now every piece is saved (with its progress)
> the moment it's ready, at most 3 per call, the hand-off is confirmed, and a
> 15-minute job (`resume-chunking`) restarts anything unfinished and messages
> you in Telegram after 3 checks with no progress. The stuck Veritasium video
> is complete (11/11). Tested: Dalio transcript 23/23 in ~20 s, Paul Graham
> essay 60/60 in ~55 s, no errors. "About me" questions in Ask now include your
> tracked goals. Retrieval unchanged (9/10, 10/10, 5/5).

> **Nov 11 (night): Content quality check-up.** All six content-quality pieces
> were already live. The 3 YouTube search links now hold their transcripts
> (Veritasium "The Science of Thinking", Ray Dalio "How The Economic Machine
> Works", Julian Treasure's TED talk), same ids, with the search link kept in
> `metadata.original_content`. Both junk messages are archived. Retrieval
> unchanged (9/10, 10/10, 5/5).
>
> **Nov 11 (late): Security re-check, no changes needed.** Without the right
> secret, call-llm, enrich-thought, weekly-digest, telegram-bot, the MCP server,
> search-brain and capture-url all return 401. With it, everything works (save →
> enrich, Ask, digest, call-llm). 0 thoughts without an owner. Only 2 thoughts
> lack tags ("Mathew 5:27-32", "Delete that"), both too short to tag. The only
> key in git (current files and history) is the public anon key in `config.js`,
> so there's nothing to rotate. Working rules for Claude are now in `CLAUDE.md`.
>
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
| **Web app sections** (Nov 11) | All / Personal / Library filters on Recent; each card shows its section and has a kind picker | Recent tab |
| **Goal review** (Nov 11) | `/mygoals` shows each tracked goal with **Keep / Pause / Drop**, one at a time. Pause and Drop only change its status (nothing deleted); only active goals count in `/goals` and Ask | `/mygoals` |
| **Goals in Ask** (Nov 11) | "About me" questions (what are my goals, what do I think about…) add the notes behind your active goals, marked as tracked; goal questions list them first, cited | `? what are my goals` |
| **Agent crew** (Nov 12) | The King turns an order into 1–7 worker steps plus a Critic check, shows the plan and an estimated cost, and waits for **Approve / Edit / Cancel**. Steps run one at a time through call-llm (Haiku), each passing its output on. The result comes back with numbered citations (`/t_` links), the crew that worked on it, and the actual cost, plus **Save as report** (kind = report). Max 8 worker steps, 5¢ per order (it stops and asks **Go on / Stop**). It refuses anything outside your brain (emailing, posting, buying) | `/king make me a study plan for…` · `/orders` · `/o_xxxxxxxx` for one order step by step · Claude Desktop: `king_order` |
| **Fixer** (Nov 12) | Housekeeping when you ask: re-capture a link (first reads it without saving, shows old vs new size, and only proposes a longer text), archive, change kind. Lists the exact changes and waits for **Approve / Reject**. Never deletes; replaced text is kept in the thought's metadata | `/king find saved videos with cut-off transcripts and fix them` |
| **Send to King** (Nov 12) | Messages that read like an instruction to the bot ("Delete that", "Look up the videos and add them", "Can you…") get **Save as note / Send to King** instead of being saved | Telegram |
| **Run log** (Nov 12) | `agents` (8 agents with symbol/item keys for the 3D office), `orders`, `agent_runs` (every step and background job: queued → working → done / failed / waiting on me, with task, output, tokens, cost). Every AI call is tied to a run; run, order and receipt totals match | `select * from agent_board;` · `select * from agent_runs order by created_at desc limit 20;` |
| **Show more** (Nov 12) | `/t_` shows long thoughts 3,500 characters at a time with a **Show more** button | Tap a `/t_` link to a long video |
| **Reliable chunking** (Nov 11) | Long thoughts are chunked in small resumable steps (max 3 chunks per call, each saved with its progress in `chunk_progress`). Every 15 minutes `resume-chunking` restarts anything unfinished; after 3 checks with no progress you get a Telegram message (once) | `select * from chunk_progress where done_at is null;` |

## Maintenance scripts

- `node scripts/backup.mjs`: back up before any schema change.
- `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1`: embed anything not yet embedded (free).
- `powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1`: classify anything with no kind (rules, then Haiku).
- `powershell -ExecutionPolicy Bypass -File scripts\backfill-tags.ps1`: tag and summarize anything saved without tags (Haiku, skips course_setup). `-Preview 5` shows 5 without saving.
- `node scripts/chunking.mjs`: resume unfinished chunking now (what the 15-minute job does). `node scripts/chunking.mjs <id>` continues one thought; add `--redo` to rebuild its chunks from 0, in place. `--audit` lists thoughts whose chunks do not match their text (read-only). All free.
- `node scripts/retrieval-test.mjs`: rerun after every change and compare with `tests/retrieval-history.csv`.
- All scripts read `INTERNAL_SECRET` from `.env`. If you ever lose `.env`: in the SQL Editor run `select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret';` and put `INTERNAL_SECRET=<that>` in `.env`.

## Known issues

- Very generic questions with no specific word (e.g. "what did I learn this week") rely on meaning alone, because filler words are left out of keyword matching. Use a specific word when you can.
- "What are my goals" lists your 5 tracked goals first, then goals mentioned in other notes ("Beyond those…"), which can include ones you dropped. They're still in your notes, just not tracked.
- If a thought's text is ever replaced by a shorter one, chunks past the new end stay (chunks are never deleted). Doesn't happen today: only bare links get refilled, and they had no chunks.
- Retrieval test A4 ("what did I decide about investing") is variable. Answers draw on several relevant notes and don't always cite the expected voice note. The answer itself is correct and cited.
- Your "About Me" profile is a `project_doc`, so it sits in Library. If you think of it as about you, move it to Personal with one tap.
- A takeaway counts only if you *reply* to the bot's question. A plain next message is saved as a normal thought.
- "Mathew 5:27-32" is too short to tag, so it stays untagged.
- The Telegram bot can't receive voice notes (it would need a paid transcription service). Dictate with your keyboard's mic key instead.
- `?` used to mean search in Telegram; it now asks a question. Use `/search` for the plain list.
- The crew's Critic is strict: in all 3 drafting tests it sent the first draft back once (each order cost about 1.5× its estimate). The revised drafts passed.
- YouTube won't tell Supabase how long a video is, so the Fixer can't compare a transcript with the video's length. Instead it flags punctuated transcripts that stop mid-sentence and re-reads those. The AI-trading video's transcript ends "…trading harder. I", but re-reading gave the same text, so the video's own captions end there.
- Instruction detection is a word rule ("delete that", "look up…", "can you…"). A note that starts like an order ("Find a study group") gets the two buttons; tap Save as note.
- You can't approve an order from Claude Desktop, on purpose: approval only happens in Telegram.

## Retrieval scores

| Date | Change | Search top 3 | Search top 10 | Ask cited |
|---|---|---|---|---|
| Nov 11 | Before tag backfill | 10/10 | 10/10 | 5/5 |
| Nov 11 | After tag backfill (38 thoughts) | 10/10 | 10/10 | 4/5 (A4: Tesla write-up now leads; see Known issues) |
| Nov 11 | After Sections | 10/10 | 10/10 | 4/5 (A4 variable; see Known issues) |
| Nov 11 | Before content quality | 10/10 | 10/10 | 5/5 |
| Nov 11 | After content quality | 9/10 | 10/10 | 5/5 (#7 rank 3 → 4; see Known issues) |
| Nov 11 | Security re-check (no backfill needed) | 9/10 | 10/10 | 5/5 |
| Nov 11 | After filling the 3 YouTube search links | 9/10 | 10/10 | 5/5 |
| Nov 11 | Reliable chunking + goals in Ask | 9/10 | 10/10 | 5/5 |
| Nov 12 | Harder cases added (16 search, 7 Ask) + English Veritasium | 14/16 | 16/16 | 7/7 (#15 vague phrasing: rank 5) |
| Nov 12 | Filler words left out of keyword matching | 16/16 | 16/16 | 7/7 (#7 rank 4 → 1, #15 rank 5 → 1) |
| Nov 12 | Agent crew + run log (Ask now logs as Librarian runs) | 16/16 | 16/16 | 7/7 |

Cases 1–10 are easy and mostly catch regressions. Cases 11–14 check details only found deep inside long items (chunks); 15–16 use vague wording. All 16 rank 1–3 now; add new cases whenever a real search disappoints you.

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

1. **Old "paste the video link" messages**: all 3 videos are filled now. Ignore those bot messages (replying would only re-read the same video).
2. **Goals**: done. 5 active, 11 dropped (`/mygoals` to change).

## How to test the crew on your phone

1. Scroll up in Telegram: you'll find the 4 test orders' plans and results. Tap a `/t_` link in a result to open the note it cites.
2. **One Fixer proposal is waiting for you:** change your "About Me" profile from project doc to my thought, which moves it to Personal (this was in Known issues). Tap **Approve** to do it or **Reject** to leave it. Either way you then get a short report.
3. Send `/king make me 5 quiz questions on projectile motion`. You get a plan with Approve / Edit / Cancel. Tap **Edit**, reply with "make it 3 questions", and check that a new plan comes. Tap **Approve**; about a minute later the result arrives with sources and its cost. Tap **Save as report**.
4. Send `/orders`. Your last 10 orders, each with its status and cost. Tap one `/o_…` to see every step.
5. Send `Delete that`. You should get **Save as note / Send to King** (not "Saved").
6. Send `/king email my professor that I'm sick`. The King should refuse.
7. Find an old takeaway question ("💡 What's your takeaway…"), reply to it with `/search sleep`. You get search results and "your earlier question is still open", and nothing is saved.
8. Send `/t_d26d9372` (Julian Treasure). Tap **Show more** until "(End.)". The transcript ends with "(Applause)".

## How to test goals and chunking on your phone

1. Send `/mygoals`. You should see your first active goal with Keep / Pause / Drop. Tap **Keep** on each; at the end: "Active: 5, paused: 0, dropped: 11".
2. Send `? what are my goals`. The 5 tracked goals come first, each cited.
3. Send a long YouTube video link (20+ minutes). A minute later, `/search` a detail from the middle of the video; it should be found.
4. Nothing else to do for chunking. If a long thought ever gets stuck, you'll get "⚠️ Chunking is stuck on …" in Telegram.

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
6. The web app's Recent tab has All / Personal / Library, and a kind picker on each card.

## What's next

1. **The 3D office** (next session): it reads only `agents` (symbol_key, item_key), `agent_board`, `orders` and `agent_runs`. Row-level security already lets your login read your own rows.
2. Tune the agents' prompts after a week of orders (they're in the `agents` table; the output format stays in code, so editing a prompt can't break the pipeline).
3. Add a new test case whenever a real search or answer disappoints you (copy the question and the thought it should find into `tests/retrieval-cases.txt`).
4. After a week of Helpful/Wrong taps: decide whether Haiku is good enough or Ask should move to Sonnet 5.5 (about 1–2¢ per question).
