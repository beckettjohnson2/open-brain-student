# Setup notes — Levels 6 + 7 (meaning search, chunking, graph)

Done November 7, 2026. Everything was **added**. Nothing was deleted or renamed.
There are no keys in this file or anywhere in the repo.

## What changed

**Database** ([migrations/level-6-7.sql](migrations/level-6-7.sql), run once in the SQL Editor)
- pgvector extension.
- `thoughts`: new columns `embedding` (384 numbers from gte-small), `embedded_at`, and `content_tsv` (keyword index, kept up to date automatically).
- New table `thought_chunks`: long thoughts cut into ~250-word pieces with ~50 words of overlap, each with its own embedding.
- New table `thought_links`: the graph. Each pair is stored once with its similarity score. Self-links and duplicates are impossible.
- Both new tables have row-level security, so only the owner (`user_id`) can read them.
- New functions: `hybrid_search` (meaning + keyword search merged with reciprocal rank fusion), `related_thoughts`, and `find_link_candidates`.

**Edge functions**
- `enrich-thought`: tagging through `call-llm` is unchanged. It now also embeds every new thought, chunks long ones, and links each thought to up to 5 neighbours. A long capture's chunks are done in ~1-second steps, because Supabase limits computing per call; the function hands the rest to a fresh call of itself. It has new modes `BACKFILL`, `CONTINUE` and `RELINK`. These only do the free embedding work and never call Anthropic.
- `search-brain` (new): the web app's search. Deployed **with** login checking, and it queries as the logged-in user.
- `open-brain-mcp`: `search_thoughts` now uses hybrid search, and there's a new `related_thoughts` tool. `list_recent` and `add_thought` keep their names. `add_thought` now saves with `OWNER_USER_ID`, so Claude Desktop thoughts aren't ownerless any more.
- `telegram-bot`: `/search` and `?` use hybrid search and fall back to keyword search if needed. All other commands are unchanged.

**Web app** (`index.html`): the Search tab calls `search-brain` and shows "Related:" under each result. Nothing else changed.

**Unchanged:** the Database Webhook (still the only trigger on `thoughts`), both cron jobs, the GitHub Actions keep-alive, the Vercel project, the Telegram webhook, `MCP_ACCESS_KEY`, and the Claude Desktop config.

## Settings chosen

- **Link threshold: 0.875** (`LINK_THRESHOLD` in enrich-thought). gte-small scores run high: on this brain the 80 closest pairs all scored above 0.875. 0.875 was the lowest score where pairs were still clearly related. Weekly digests are left out of links, because they summarize everything.
- **Search cut-off: 0.78** (`MIN_SIMILARITY` in search-brain, open-brain-mcp and telegram-bot). Below that score, a result only shows if its keywords match.

## Cost

Embeddings use Supabase's built-in gte-small model, which is **free**. The backfill made no Anthropic calls. New thoughts still make one Anthropic tagging call each, the same as before.

## Maintenance

- **Backfill** anything with no `embedded_at`. It's safe to run any time and free: `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1`
- **After changing `LINK_THRESHOLD`:** redeploy enrich-thought, then run `powershell -ExecutionPolicy Bypass -File scripts\backfill.ps1 -Relink`

## Known leftovers

- 4 older thoughts have no `user_id` (probably saved by Claude Desktop before this fix). They don't appear in the web app or the new search. To claim them, run this in the SQL Editor, using your user id: `update thoughts set user_id = '<your user id>' where user_id is null;` Then run the backfill so they get linked properly.
- `enrich-thought` is deployed without login checking, as it was before. The new modes only do free embedding work on unfinished thoughts and never return any content.

## How to undo

1. Redeploy the old functions from the git tag `before-level-6-7`:
   ```
   git checkout before-level-6-7 -- supabase/functions index.html
   npx supabase functions deploy enrich-thought --no-verify-jwt
   npx supabase functions deploy open-brain-mcp --no-verify-jwt
   npx supabase functions deploy telegram-bot --no-verify-jwt
   ```
   Then commit and push, so Vercel serves the old `index.html`.
2. Leave the database alone. The old code simply ignores the new tables and columns. (`search-brain` can stay deployed; nothing calls it.)
