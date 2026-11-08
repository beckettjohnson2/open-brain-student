-- =====================================================================
-- Levels 6 + 7 — meaning search, chunking, and the thought graph
--
-- ADD ONLY. Nothing here deletes or renames anything you already have.
-- Safe to run more than once ("if not exists" / "or replace" everywhere).
--
-- How to run: Supabase → SQL Editor → New query → paste ALL of this → Run
--
-- Embeddings come from Supabase's built-in gte-small model, which makes
-- 384 numbers per piece of text. Free — no new paid service.
-- =====================================================================

-- 1. pgvector: lets Postgres store embeddings and compare them.
create extension if not exists vector with schema extensions;


-- 2. New columns on thoughts --------------------------------------------
-- embedding:   the 384 numbers that capture what the thought MEANS
-- embedded_at: when that finished (null = still needs embedding)
alter table public.thoughts add column if not exists embedding   extensions.vector(384);
alter table public.thoughts add column if not exists embedded_at timestamptz;

-- Full-text search: Postgres pre-digests the words ("running" → "run")
-- so keyword search is fast and forgiving. Kept up to date automatically.
-- left(...) caps it so one giant transcript can never break a save.
alter table public.thoughts add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(summary, '') || ' ' || left(coalesce(content, ''), 200000))
  ) stored;

create index if not exists thoughts_content_tsv_idx on public.thoughts using gin (content_tsv);
create index if not exists thoughts_embedding_idx
  on public.thoughts using hnsw (embedding extensions.vector_cosine_ops);


-- 3. thought_chunks — long thoughts cut into ~250-word pieces -------------
-- gte-small only reads ~512 tokens, so a detail deep inside a transcript
-- would be invisible without these.
create table if not exists public.thought_chunks (
  id          bigint generated always as identity primary key,
  thought_id  uuid not null references public.thoughts(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   extensions.vector(384),
  user_id     uuid references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  unique (thought_id, chunk_index)
);

create index if not exists thought_chunks_thought_idx on public.thought_chunks (thought_id);
create index if not exists thought_chunks_user_idx    on public.thought_chunks (user_id);
create index if not exists thought_chunks_tsv_idx     on public.thought_chunks using gin (content_tsv);
create index if not exists thought_chunks_embedding_idx
  on public.thought_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.thought_chunks enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'thought_chunks' and policyname = 'own_chunks') then
    create policy own_chunks on public.thought_chunks for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 4. thought_links — the graph: "these two thoughts mean similar things" --
-- Each pair is stored once, smaller id first. That one rule blocks
-- self-links (a = a) and duplicates (a→b and b→a) at the same time.
create table if not exists public.thought_links (
  from_id    uuid not null references public.thoughts(id) on delete cascade,
  to_id      uuid not null references public.thoughts(id) on delete cascade,
  similarity real not null,
  user_id    uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  constraint thought_links_ordered_pair check (from_id < to_id)
);

create index if not exists thought_links_to_idx   on public.thought_links (to_id);
create index if not exists thought_links_user_idx on public.thought_links (user_id);

alter table public.thought_links enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'thought_links' and policyname = 'own_links') then
    create policy own_links on public.thought_links for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 5. hybrid_search — meaning search + keyword search, fused ---------------
-- Meaning list: closest thoughts AND closest chunks (best one per thought).
-- Keyword list: full-text matches in thoughts and chunks.
-- Reciprocal rank fusion: score = 1/(60 + rank in list A) + 1/(60 + rank in B).
-- Showing up high in both lists wins. Each thought is returned once.
--
-- Whose thoughts: p_user_id if given (Telegram / MCP, which use the service
-- key), otherwise the logged-in user. "security invoker" means row-level
-- security still applies to web users, so nobody can read another's brain.
create or replace function public.hybrid_search(
  query_embedding extensions.vector(384),
  query_text      text,
  match_count     int   default 10,
  p_user_id       uuid  default null,
  min_similarity  float default 0.70,
  rrf_k           int   default 60
)
returns table (
  id            uuid,
  content       text,
  created_at    timestamptz,
  tags          text[],
  category      text,
  summary       text,
  similarity    float,
  keyword_rank  float,
  score         float,
  matched_chunk text
)
language sql stable security invoker
set search_path = public, extensions
as $$
  with me as (select coalesce(p_user_id, auth.uid()) as uid),
  q  as (select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq),
  vec_hits as (
    (select t.id as thought_id, 1 - (t.embedding <=> query_embedding) as sim, null::text as chunk
       from public.thoughts t, me
      where t.user_id = me.uid and t.embedding is not null
      order by t.embedding <=> query_embedding
      limit 50)
    union all
    (select c.thought_id, 1 - (c.embedding <=> query_embedding), c.content
       from public.thought_chunks c, me
      where c.user_id = me.uid and c.embedding is not null
      order by c.embedding <=> query_embedding
      limit 50)
  ),
  vec_best as (
    select distinct on (thought_id) thought_id, sim, chunk
      from vec_hits where sim >= min_similarity
     order by thought_id, sim desc
  ),
  vec_ranked as (
    select thought_id, sim, chunk, row_number() over (order by sim desc) as r from vec_best
  ),
  kw_hits as (
    (select t.id as thought_id, ts_rank_cd(t.content_tsv, q.tsq) as rank, null::text as chunk
       from public.thoughts t, me, q
      where t.user_id = me.uid and t.content_tsv @@ q.tsq
      order by 2 desc
      limit 50)
    union all
    (select c.thought_id, ts_rank_cd(c.content_tsv, q.tsq), c.content
       from public.thought_chunks c, me, q
      where c.user_id = me.uid and c.content_tsv @@ q.tsq
      order by 2 desc
      limit 50)
  ),
  kw_best as (
    select distinct on (thought_id) thought_id, rank, chunk
      from kw_hits order by thought_id, rank desc
  ),
  kw_ranked as (
    select thought_id, rank, chunk, row_number() over (order by rank desc) as r from kw_best
  ),
  fused as (
    select coalesce(v.thought_id, k.thought_id) as thought_id,
           v.sim, k.rank,
           coalesce(1.0 / (rrf_k + v.r), 0) + coalesce(1.0 / (rrf_k + k.r), 0) as score,
           coalesce(v.chunk, k.chunk) as chunk
      from vec_ranked v
      full outer join kw_ranked k on k.thought_id = v.thought_id
  )
  select t.id, t.content, t.created_at, t.tags::text[], t.category, t.summary,
         f.sim::float, f.rank::float, f.score::float, f.chunk
    from fused f
    join public.thoughts t on t.id = f.thought_id
   order by f.score desc, t.created_at desc
   limit match_count;
$$;


-- 6. related_thoughts — read the graph for one thought --------------------
create or replace function public.related_thoughts(
  p_thought_id uuid,
  match_count  int  default 3,
  p_user_id    uuid default null
)
returns table (
  id              uuid,
  content_preview text,
  summary         text,
  created_at      timestamptz,
  similarity      float
)
language sql stable security invoker
set search_path = public, extensions
as $$
  select t.id, left(t.content, 1000), t.summary, t.created_at, l.similarity::float
    from public.thought_links l
    join public.thoughts t
      on t.id = case when l.from_id = p_thought_id then l.to_id else l.from_id end
   where (l.from_id = p_thought_id or l.to_id = p_thought_id)
     and (p_user_id is null or t.user_id = p_user_id)
   order by l.similarity desc
   limit match_count;
$$;


-- 7. find_link_candidates — used by enrich-thought to build the graph -----
-- The nearest thoughts (same owner) above a similarity bar.
-- Weekly digests are left out: they summarise everything, so they would
-- link to everything and drown out the real connections.
create or replace function public.find_link_candidates(
  p_thought_id   uuid,
  match_count    int   default 5,
  min_similarity float default 0.82
)
returns table (id uuid, similarity float)
language sql stable security invoker
set search_path = public, extensions
as $$
  select t.id, (1 - (t.embedding <=> s.embedding))::float
    from public.thoughts s
    join public.thoughts t
      on t.user_id is not distinct from s.user_id
     and t.id <> s.id
     and t.embedding is not null
     and coalesce(t.category, '') <> 'digest'
   where s.id = p_thought_id
     and s.embedding is not null
     and 1 - (t.embedding <=> s.embedding) >= min_similarity
   order by t.embedding <=> s.embedding
   limit match_count;
$$;


-- 8. Check — you should see your thought count (unchanged), and zeros.
select
  (select count(*) from public.thoughts)                       as thoughts_total,
  (select count(*) from public.thoughts where user_id is null) as thoughts_without_owner,
  (select count(*) from public.thought_chunks)                 as chunks,
  (select count(*) from public.thought_links)                  as links;
