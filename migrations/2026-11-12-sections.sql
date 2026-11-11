-- =====================================================================
-- Sections (Personal / Library), kind-change log, takeaways
--
-- ADD ONLY. Nothing is deleted, moved or renamed. Safe to run twice.
-- Back up first:  node scripts/backup.mjs
--
-- Sections are DERIVED from kind — never stored by hand:
--   personal = my_thought, class_note, report   (me and what I know)
--   library  = source, project_doc               (things I found or made)
--   hidden   = course_setup                      (left out, as before)
-- Change the mapping only in public.section_of(); then refresh the stored
-- column with:  update public.thoughts set kind = kind;
-- (TypeScript copy for labels: supabase/functions/_shared/kinds.ts)
-- =====================================================================

-- 1. The mapping, and a computed section column -------------------------
create or replace function public.section_of(k text)
returns text
language sql immutable
as $$
  select case
    when k in ('my_thought', 'class_note', 'report') then 'personal'
    when k in ('source', 'project_doc')              then 'library'
    when k = 'course_setup'                          then 'hidden'
    else null
  end;
$$;

alter table public.thoughts add column if not exists section text
  generated always as (public.section_of(kind)) stored;
create index if not exists thoughts_section_idx on public.thoughts (section);


-- 2. Takeaways: a my_thought linked to the library item it's about -------
alter table public.thoughts add column if not exists takeaway_of uuid
  references public.thoughts(id) on delete set null;
create index if not exists thoughts_takeaway_of_idx on public.thoughts (takeaway_of);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'thoughts_takeaway_not_self') then
    alter table public.thoughts add constraint thoughts_takeaway_not_self
      check (takeaway_of is null or takeaway_of <> id);
  end if;
end $$;


-- 3. kind_changes — every change of kind, from anywhere ------------------
create table if not exists public.kind_changes (
  id          bigint generated always as identity primary key,
  thought_id  uuid not null references public.thoughts(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  old_kind    text,
  new_kind    text,
  changed_by  text,          -- kind_set_by after the change: rule | llm | manual
  changed_at  timestamptz not null default now()
);
create index if not exists kind_changes_thought_idx on public.kind_changes (thought_id, changed_at desc);

alter table public.kind_changes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'kind_changes' and policyname = 'own_kind_changes_read') then
    create policy own_kind_changes_read on public.kind_changes for select to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

-- Written by a trigger, so the web app, Telegram, AI and plain SQL are all
-- logged the same way. Security definer: users can read their log but
-- can't write it directly.
create or replace function public.log_kind_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.kind is distinct from old.kind then
    insert into public.kind_changes (thought_id, user_id, old_kind, new_kind, changed_by)
    values (new.id, new.user_id, old.kind, new.kind, new.kind_set_by);
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'thoughts_log_kind_change'
                 and tgrelid = 'public.thoughts'::regclass) then
    create trigger thoughts_log_kind_change
      after update of kind on public.thoughts
      for each row execute function public.log_kind_change();
  end if;
end $$;


-- 4. telegram_prompts — bot questions waiting for a reply ----------------
-- The bot asks "What's your takeaway?" as a reply-mode message; a reply to
-- that exact message is saved as the takeaway.
create table if not exists public.telegram_prompts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  chat_id     text not null,
  message_id  bigint not null,          -- the bot's prompt message
  purpose     text not null check (purpose in ('takeaway')),
  thought_id  uuid references public.thoughts(id) on delete cascade,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists telegram_prompts_msg_idx on public.telegram_prompts (chat_id, message_id);

alter table public.telegram_prompts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'telegram_prompts' and policyname = 'own_telegram_prompts') then
    create policy own_telegram_prompts on public.telegram_prompts for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- 5. hybrid_search_v3 — hybrid_search_v2 + section filter + section/link --
-- p_section: null = personal and library (course_setup still left out),
--            'personal' or 'library' = only that section.
create or replace function public.hybrid_search_v3(
  query_embedding extensions.vector(384),
  query_text      text,
  match_count     int   default 10,
  p_user_id       uuid  default null,
  min_similarity  float default 0.70,
  rrf_k           int   default 60,
  p_section       text  default null
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
  status        text,
  section       text,
  takeaway_of   uuid
)
language sql stable security invoker
set search_path = public, extensions
as $$
  select h.id, h.content, h.created_at, h.tags, h.category, h.summary,
         h.similarity, h.keyword_rank, h.score, h.matched_chunk, h.kind, h.status,
         public.section_of(h.kind), t.takeaway_of
    from public.hybrid_search_v2(
           query_embedding, query_text, match_count, p_user_id, min_similarity, rrf_k,
           case when p_section is null then null
                else (select array_agg(k) from unnest(array['my_thought', 'class_note', 'report',
                                                             'source', 'project_doc']) as k
                       where public.section_of(k) = p_section) end
         ) h
    join public.thoughts t on t.id = h.id
   order by h.score desc, h.created_at desc;
$$;


-- 6. Check
select section, count(*) from public.thoughts group by 1 order by 1;
