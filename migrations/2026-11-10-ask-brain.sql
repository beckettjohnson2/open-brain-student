-- =====================================================================
-- Ask my brain — conversation turns, answer feedback, pending messages
--
-- ADD ONLY. New tables; nothing existing is changed. Safe to run twice.
-- Needs 2026-11-09-metadata.sql to have been run first.
-- Back up first:  node scripts/backup.mjs
-- =====================================================================

-- 1. ask_turns — every question asked and the answer given ----------------
-- The last 5 turns of a chat (with cleared_at empty) are the bot's memory
-- for follow-ups. /new sets cleared_at instead of deleting anything.
create table if not exists public.ask_turns (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  channel           text not null check (channel in ('telegram', 'mcp')),
  chat_id           text not null,
  question          text not null,
  search_query      text,                 -- the standalone version used for search
  answer            text,
  cited_ids         uuid[] not null default '{}',
  closest_ids       uuid[] not null default '{}',  -- shown when nothing was found
  nothing_found     boolean not null default false,
  from_sources_only boolean not null default false,
  intent            text,                 -- decision | saved | last_time | changed | general
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cleared_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists ask_turns_chat_idx on public.ask_turns (chat_id, created_at desc);

alter table public.ask_turns enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'ask_turns' and policyname = 'own_ask_turns') then
    create policy own_ask_turns on public.ask_turns for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 2. answer_feedback — one row per Helpful / Wrong tap ---------------------
create table if not exists public.answer_feedback (
  id         bigint generated always as identity primary key,
  turn_id    uuid not null references public.ask_turns(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  rating     text not null check (rating in ('helpful', 'wrong')),
  created_at timestamptz not null default now()
);
create index if not exists answer_feedback_turn_idx on public.answer_feedback (turn_id);

alter table public.answer_feedback enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'answer_feedback' and policyname = 'own_answer_feedback') then
    create policy own_answer_feedback on public.answer_feedback for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 3. telegram_pending — a message waiting for "Save it" / "Answer it" ------
-- Kept until you tap, so a capture is never lost.
create table if not exists public.telegram_pending (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  chat_id     text not null,
  message_id  bigint,
  text        text not null,
  resolution  text check (resolution is null or resolution in ('saved', 'answered')),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.telegram_pending enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'telegram_pending' and policyname = 'own_telegram_pending') then
    create policy own_telegram_pending on public.telegram_pending for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 4. ask_quality — how good are the answers? -------------------------------
-- The latest tap per answer counts (you can change your mind).
-- Run:  select * from ask_quality;
create or replace view public.ask_quality
with (security_invoker = true) as
with latest as (
  select distinct on (turn_id) turn_id, rating
    from public.answer_feedback
   order by turn_id, created_at desc
)
select date_trunc('week', t.created_at)::date             as week,
       count(*)                                            as answers,
       count(*) filter (where l.rating = 'helpful')        as helpful,
       count(*) filter (where l.rating = 'wrong')          as wrong,
       count(*) filter (where t.nothing_found)             as nothing_found,
       round(sum(coalesce(u.cost, 0)), 4)                  as est_cost_usd
  from public.ask_turns t
  left join latest l on l.turn_id = t.id
  left join lateral (
    select (coalesce(t.prompt_tokens, 0) * 0.10 + coalesce(t.completion_tokens, 0) * 0.50) / 1e6 as cost
  ) u on true
 group by 1
 order by 1 desc;


-- 5. Check
select (select count(*) from public.ask_turns) as ask_turns,
       (select count(*) from public.answer_feedback) as feedback,
       (select count(*) from public.telegram_pending) as pending;
