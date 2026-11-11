-- =====================================================================
-- Metadata: status + kind on every thought
--
-- ADD ONLY. Nothing is dropped or renamed. Safe to run more than once.
-- Back up first:  node scripts/backup.mjs
--
-- status: active | paused | done | dropped | reference   (null = not set)
-- kind:   my_thought | source | course_setup | project_doc | class_note | report
--         (null = not classified yet; scripts/backfill-kind.ps1 fills it)
--
-- course_setup (the long Level 0-7 build prompts) is left OUT of search,
-- related thoughts, new graph links and weekly digests by default.
-- =====================================================================

-- 1. New nullable columns ---------------------------------------------------
alter table public.thoughts add column if not exists status      text;
alter table public.thoughts add column if not exists kind        text;
-- How kind was decided: 'rule', 'llm' or 'manual'. Lets you find and
-- re-check the LLM's guesses later.
alter table public.thoughts add column if not exists kind_set_by text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'thoughts_status_check') then
    alter table public.thoughts add constraint thoughts_status_check
      check (status is null or status in ('active', 'paused', 'done', 'dropped', 'reference'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'thoughts_kind_check') then
    alter table public.thoughts add constraint thoughts_kind_check
      check (kind is null or kind in ('my_thought', 'source', 'course_setup', 'project_doc', 'class_note', 'report'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'thoughts_kind_set_by_check') then
    alter table public.thoughts add constraint thoughts_kind_set_by_check
      check (kind_set_by is null or kind_set_by in ('rule', 'llm', 'manual'));
  end if;
end $$;

create index if not exists thoughts_kind_idx   on public.thoughts (kind);
create index if not exists thoughts_status_idx on public.thoughts (status);


-- 2. hybrid_search_v2 — hybrid_search plus kind/status, with a kind filter --
-- include_kinds: null  = everything except course_setup (the default)
--                array = only these kinds (add 'course_setup' to search the
--                        build prompts on purpose). Thoughts with no kind yet
--                        count as matching when include_kinds is null.
-- Same meaning + keyword search and rank fusion as hybrid_search.
create or replace function public.hybrid_search_v2(
  query_embedding extensions.vector(384),
  query_text      text,
  match_count     int     default 10,
  p_user_id       uuid    default null,
  min_similarity  float   default 0.70,
  rrf_k           int     default 60,
  include_kinds   text[]  default null
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
  matched_chunk text,
  kind          text,
  status        text
)
language sql stable security invoker
set search_path = public, extensions
as $$
  with me as (select coalesce(p_user_id, auth.uid()) as uid),
  q  as (select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq),
  allowed as (
    select t.id
      from public.thoughts t, me
     where t.user_id = me.uid
       and case when include_kinds is null
                then coalesce(t.kind, '') <> 'course_setup'
                else t.kind = any(include_kinds) end
  ),
  vec_hits as (
    (select t.id as thought_id, 1 - (t.embedding <=> query_embedding) as sim, null::text as chunk
       from public.thoughts t
       join allowed a on a.id = t.id
      where t.embedding is not null
      order by t.embedding <=> query_embedding
      limit 50)
    union all
    (select c.thought_id, 1 - (c.embedding <=> query_embedding), c.content
       from public.thought_chunks c
       join allowed a on a.id = c.thought_id
      where c.embedding is not null
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
       from public.thoughts t
       join allowed a on a.id = t.id, q
      where t.content_tsv @@ q.tsq
      order by 2 desc
      limit 50)
    union all
    (select c.thought_id, ts_rank_cd(c.content_tsv, q.tsq), c.content
       from public.thought_chunks c
       join allowed a on a.id = c.thought_id, q
      where c.content_tsv @@ q.tsq
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
         f.sim::float, f.rank::float, f.score::float, f.chunk, t.kind, t.status
    from fused f
    join public.thoughts t on t.id = f.thought_id
   order by f.score desc, t.created_at desc
   limit match_count;
$$;


-- 3. hybrid_search — same name, same inputs and outputs as before, so the
-- web app, Telegram bot and MCP server keep working untouched. It now hands
-- off to hybrid_search_v2, which leaves course_setup out.
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
  select h.id, h.content, h.created_at, h.tags, h.category, h.summary,
         h.similarity, h.keyword_rank, h.score, h.matched_chunk
    from public.hybrid_search_v2(query_embedding, query_text, match_count,
                                 p_user_id, min_similarity, rrf_k, null) h;
$$;


-- 4. related_thoughts — same inputs and outputs; skips course_setup -------
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
     and coalesce(t.kind, '') <> 'course_setup'
   order by l.similarity desc
   limit match_count;
$$;


-- 5. find_link_candidates — same inputs and outputs; new links never point
-- at course_setup (existing links are left alone, related_thoughts hides them).
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
     and coalesce(t.kind, '') <> 'course_setup'
   where s.id = p_thought_id
     and s.embedding is not null
     and 1 - (t.embedding <=> s.embedding) >= min_similarity
   order by t.embedding <=> s.embedding
   limit match_count;
$$;


-- 6. llm_usage_by_job — tokens and cost per job, so you can see what costs what
-- Run:  select * from llm_usage_by_job;
create or replace view public.llm_usage_by_job
with (security_invoker = true) as
select coalesce(source, '(unlabelled)')       as job,
       model,
       count(*)                               as calls,
       sum(prompt_tokens)                     as prompt_tokens,
       sum(completion_tokens)                 as completion_tokens,
       round(sum(cost_usd), 4)                as cost_usd,
       min(created_at)                        as first_call,
       max(created_at)                        as last_call
  from public.llm_usage
 group by 1, 2
 order by cost_usd desc nulls last;


-- 7. Check — kind counts (all null until the backfill runs)
select coalesce(kind, '(not set)') as kind, count(*) from public.thoughts group by 1 order by 2 desc;
