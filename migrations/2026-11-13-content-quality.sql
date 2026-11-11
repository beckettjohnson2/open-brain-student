-- =====================================================================
-- Content quality: archive status, source reliability, goals, digest
-- ranking, bot prompts
--
-- No rows are deleted. Things are hidden by setting status = 'archived'.
-- Back up first:  node scripts/backup.mjs
--
-- NOTE: two CHECK constraints are swapped for wider ones (status gains
-- 'archived'; telegram_prompts.purpose gains new prompt types). This only
-- ALLOWS new values — no data changes. Each swap happens inside one
-- transaction, so the column is never unchecked.
-- =====================================================================

-- 1. status: add 'archived' ----------------------------------------------
begin;
alter table public.thoughts drop constraint if exists thoughts_status_check;
alter table public.thoughts add constraint thoughts_status_check
  check (status is null or status in ('active', 'paused', 'done', 'dropped', 'reference', 'archived'));
commit;


-- 2. reliability — how much to trust a saved source ----------------------
-- research = peer-reviewed / official; expert = credentialed person or
-- established outlet; opinion = influencer, sales, hype; unknown.
alter table public.thoughts add column if not exists reliability text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'thoughts_reliability_check') then
    alter table public.thoughts add constraint thoughts_reliability_check
      check (reliability is null or reliability in ('research', 'expert', 'opinion', 'unknown'));
  end if;
end $$;


-- 3. telegram_prompts: more prompt types + a little extra data -----------
alter table public.telegram_prompts add column if not exists data jsonb not null default '{}'::jsonb;
begin;
alter table public.telegram_prompts drop constraint if exists telegram_prompts_purpose_check;
alter table public.telegram_prompts add constraint telegram_prompts_purpose_check
  check (purpose in ('takeaway', 'replace_link', 'recap', 'recap_answer'));
commit;


-- 4. Goals — only created when the owner taps Track ----------------------
create table if not exists public.goals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  text              text not null,
  source_thought_id uuid references public.thoughts(id) on delete set null,
  status            text not null default 'active'
                    check (status in ('active', 'paused', 'done', 'dropped')),
  confirmed_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
alter table public.goals enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'goals' and policyname = 'own_goals') then
    create policy own_goals on public.goals for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Proposed goals waiting for Track / Not a goal. Proposals are NOT goals.
create table if not exists public.goal_candidates (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  text              text not null,
  source_thought_id uuid references public.thoughts(id) on delete set null,
  decision          text check (decision is null or decision in ('track', 'not_goal')),
  goal_id           uuid references public.goals(id) on delete set null,
  sent_at           timestamptz,
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);
alter table public.goal_candidates enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'goal_candidates' and policyname = 'own_goal_candidates') then
    create policy own_goal_candidates on public.goal_candidates for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 5. hybrid_search_v2 — same inputs and outputs; now also:
--    - leaves out archived thoughts
--    - ranks kind = report (weekly digests, AI write-ups) at half weight,
--      so the original notes they summarize come first
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
       and coalesce(t.status, '') <> 'archived'
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
  ),
  weighted as (
    select f.*, f.score * case when t.kind = 'report' then 0.5 else 1.0 end as adj
      from fused f join public.thoughts t on t.id = f.thought_id
  )
  select t.id, t.content, t.created_at, t.tags::text[], t.category, t.summary,
         w.sim::float, w.rank::float, w.adj::float, w.chunk, t.kind, t.status
    from weighted w
    join public.thoughts t on t.id = w.thought_id
   order by w.adj desc, t.created_at desc
   limit match_count;
$$;


-- 6. related_thoughts and find_link_candidates — same inputs and outputs;
--    archived thoughts are left out.
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
     and coalesce(t.status, '') <> 'archived'
   order by l.similarity desc
   limit match_count;
$$;

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
     and coalesce(t.status, '') <> 'archived'
   where s.id = p_thought_id
     and s.embedding is not null
     and 1 - (t.embedding <=> s.embedding) >= min_similarity
   order by t.embedding <=> s.embedding
   limit match_count;
$$;


-- 7. Check
select
  (select count(*) from public.thoughts where kind = 'source') as sources_to_rate,
  (select count(*) from public.goals)                          as goals,
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'thoughts_status_check') as status_rule;
