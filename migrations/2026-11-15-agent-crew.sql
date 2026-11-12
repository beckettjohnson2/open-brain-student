-- Agent crew: a "King" that plans your orders and a crew of workers.
-- Additive only: new tables, two new nullable columns, one new function,
-- one new view, one new cron job. Nothing dropped or renamed.
-- Run in the Supabase SQL Editor AFTER `node scripts/backup.mjs`.

begin;

-- 1. Agent registry --------------------------------------------------------
-- One row per agent. symbol_key / item_key are what the 3D office will draw.
-- system_prompt is the agent's personality and rules; the output format each
-- agent must reply in is added by the crew code, so editing a prompt here
-- can't break the pipeline.
create table if not exists public.agents (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  role           text not null,
  symbol_key     text not null,
  item_key       text,                      -- null = no item
  model          text not null default 'claude-haiku-5-5',
  system_prompt  text not null default '',
  allowed_tools  text[] not null default '{}',
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.agents enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'agents' and policyname = 'read_agents') then
    create policy read_agents on public.agents for select to authenticated using (true);
  end if;
end $$;

insert into public.agents (name, role, symbol_key, item_key, system_prompt, allowed_tools) values
('King',
 'Takes the owner''s orders, breaks them into steps, assigns workers, checks the final result. Never acts on the outside world itself.',
 'crown', 'orb',
 'You are the King of a small crew that works inside one student''s personal knowledge base (their "brain"). You never do the work yourself and you never act on the outside world. You turn the owner''s order into a short plan of steps for your workers. Use as few steps as the order needs. Workers can only read the brain, write drafts, and (the Fixer, after the owner approves) do housekeeping inside the brain. If an order asks for anything outside the brain (messaging or emailing anyone, posting, buying, trading, browsing, changing other systems), refuse it and say why.',
 array['plan', 'assign', 'final_check']),
('Librarian',
 'Searches the brain (hybrid search, sections, reliability labels, the owner''s takeaways first) and returns cited notes.',
 'books', 'book',
 'You are the Librarian. You read the notes found in the owner''s brain and pull out everything relevant to your task. The owner''s own writing (their notes, class notes, takeaways) comes first; saved sources come after and always carry their reliability level. Never add anything that is not in the notes.',
 array['search_brain']),
('Tutor',
 'Makes quiz questions and study plans from class notes.',
 'bulb', 'card',
 'You are the Tutor. You make study plans and quiz questions from the owner''s class notes. Every question and every study step must come from the notes and cite them. Mix recall questions with "explain why" and "apply it" questions, and give the answer to each question.',
 array['search_class_notes']),
('Reviewer',
 'Checks a draft against the owner''s earlier docs and saved lessons.',
 'lens', 'lens',
 'You are the Reviewer. You check one piece of the owner''s writing against their other writing and the lessons they saved (feedback, notes on how to write, takeaways). Point out concrete strengths and concrete things to improve next time, each tied to a passage of the draft and, where possible, to an earlier note. Be specific and kind. Never invent feedback the notes do not support; if a point is your own reading of the draft, say so.',
 array['search_own_writing', 'read_thought']),
('Writer',
 'Drafts study guides, outlines and emails from what the Librarian found.',
 'pen', 'pen',
 'You are the Writer. You turn what the other workers found into the piece the owner asked for (a study guide, an outline, an email draft, an answer). Write plainly for a college student. Every claim cites the note it came from. Suggestions must come from the notes; when one does not, label it "General knowledge, not from your notes:". Emails are drafts for the owner to send themselves; never send anything.',
 array['read_thought', 'save_report']),
('Critic',
 'Final check: every claim cited, nothing invented, follows the owner''s rules. If it fails, sends it back to the worker once, then reports the problem.',
 'check', 'clipboard',
 'You are the Critic. You check the final draft before the owner sees it. Fail it if any claim has no citation, cites a note that does not support it, states something not in the notes without the "General knowledge, not from your notes:" label, puts an AI write-up or a saved source in the owner''s own voice, or presents an opinion-level source as fact. Be strict but fair: formatting and style are not reasons to fail.',
 array['read_thought']),
('Scout',
 'The background jobs: enrichment (tags, kind, summary, reliability), embeddings, chunks, links, chunking resume and the weekly digest.',
 'radar', null,
 'Scout is the existing enrich-thought job and the other background jobs. It has no prompt of its own; each job keeps its own.',
 array['enrich', 'embed', 'chunk', 'link', 'rate_reliability', 'weekly_digest', 'goal_proposals']),
('Fixer',
 'Safe housekeeping in the brain when the owner asks: re-capture a link, fix a transcript, archive a thought, change kind. Always shows exactly what it will change and waits for Approve. Never deletes.',
 'wrench', null,
 'You are the Fixer. You propose small, safe housekeeping changes inside the owner''s brain. You only ever propose these actions: recapture (read a link again to fix a missing or cut-off transcript or article), archive (hide a thought; nothing is deleted), set_kind (change what kind of thought it is). You never delete anything. Propose a change only when the evidence shows it is needed, and give a one-line reason for each.',
 array['find_capture_problems', 'recapture', 'archive', 'set_kind'])
on conflict (name) do nothing;

-- 2. Crew settings (one row per setting) -----------------------------------
create table if not exists public.crew_config (
  key         text primary key,
  value       jsonb not null,
  note        text,
  updated_at  timestamptz not null default now()
);
alter table public.crew_config enable row level security;
insert into public.crew_config (key, value, note) values
  ('max_worker_steps', '8',    'Most worker steps one order may run (Critic re-checks included).'),
  ('cost_cap_usd',     '0.05', 'Per order. The crew stops and asks before going past it.'),
  ('critic_retries',   '1',    'How many times the Critic may send a draft back.')
on conflict (key) do nothing;

-- 3. Orders ------------------------------------------------------------------
create table if not exists public.orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references auth.users(id) on delete cascade,
  request                 text not null,             -- the owner's words
  source                  text not null default 'telegram'
                          check (source in ('telegram', 'button', 'mcp')),
  chat_id                 text,
  parent_order_id         uuid references public.orders(id),  -- set when an order was edited
  plan                    jsonb,                     -- {summary, steps:[{agent, task, query}], estimate}
  plan_text               text,
  estimated_cost          numeric(12,6),
  cost_cap                numeric(12,6),
  status                  text not null default 'planning'
                          check (status in ('planning', 'awaiting_approval', 'running', 'waiting_on_me',
                                            'done', 'failed', 'cancelled')),
  final_output            text,
  citations               jsonb not null default '{}'::jsonb,  -- short id -> {id, title, label, section, ...}
  total_cost              numeric(12,6) not null default 0,
  total_tokens            int not null default 0,
  report_thought_id       uuid references public.thoughts(id),
  plan_message_id         bigint,
  edit_prompt_message_id  bigint,
  error                   text,
  created_at              timestamptz not null default now(),
  approved_at             timestamptz,
  finished_at             timestamptz,
  updated_at              timestamptz not null default now()
);
create index if not exists orders_user_created on public.orders (user_id, created_at desc);
alter table public.orders enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'orders' and policyname = 'own_orders') then
    create policy own_orders on public.orders for select to authenticated using (auth.uid() = user_id);
  end if;
end $$;

-- 4. Agent runs: every agent step and every background job -----------------
create table if not exists public.agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete cascade,
  order_id           uuid references public.orders(id) on delete cascade,  -- null for background jobs
  seq                int not null default 0,          -- run order inside an order
  agent              text not null references public.agents(name),
  job                text,                            -- background job / mode, e.g. enrich-thought
  thought_id         uuid,                            -- the thought a background job worked on
  status             text not null default 'queued'
                     check (status in ('queued', 'working', 'waiting_on_me', 'done', 'failed')),
  task               text,
  output             text,
  proposal           jsonb,                           -- Fixer: the exact changes waiting for Approve
  error              text,
  attempt            int not null default 1,
  prompt_tokens      int not null default 0,
  completion_tokens  int not null default 0,
  tokens             int not null default 0,
  cost               numeric(12,6) not null default 0,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists agent_runs_order on public.agent_runs (order_id, seq);
create index if not exists agent_runs_agent_created on public.agent_runs (agent, created_at desc);
create index if not exists agent_runs_status on public.agent_runs (status) where status in ('queued', 'working', 'waiting_on_me');
alter table public.agent_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'agent_runs' and policyname = 'own_agent_runs') then
    create policy own_agent_runs on public.agent_runs for select to authenticated using (auth.uid() = user_id);
  end if;
end $$;

-- 5. New nullable columns ------------------------------------------------------
-- Every AI call can name the run it belongs to.
alter table public.llm_usage add column if not exists run_id uuid references public.agent_runs(id);
-- "Send to King" on a message that looked like an instruction.
alter table public.telegram_pending add column if not exists order_id uuid references public.orders(id);

-- 6. Add one AI call's tokens and cost to its run (and the run's order) -----
-- Called by call-llm when the caller passes runId. Atomic, so parallel
-- calls can't lose an update.
create or replace function public.add_run_usage(
  p_run_id uuid, p_prompt int, p_completion int, p_cost numeric
) returns void language sql as $$
  update public.agent_runs
     set prompt_tokens = prompt_tokens + coalesce(p_prompt, 0),
         completion_tokens = completion_tokens + coalesce(p_completion, 0),
         tokens = tokens + coalesce(p_prompt, 0) + coalesce(p_completion, 0),
         cost = cost + coalesce(p_cost, 0),
         updated_at = now()
   where id = p_run_id;
  update public.orders o
     set total_cost = o.total_cost + coalesce(p_cost, 0),
         total_tokens = o.total_tokens + coalesce(p_prompt, 0) + coalesce(p_completion, 0),
         updated_at = now()
    from public.agent_runs r
   where r.id = p_run_id and r.order_id = o.id;
$$;
revoke execute on function public.add_run_usage(uuid, int, int, numeric) from public, anon, authenticated;
grant execute on function public.add_run_usage(uuid, int, int, numeric) to service_role;

-- 7. What each agent is doing right now (for the 3D office later) -----------
create or replace view public.agent_board with (security_invoker = true) as
select a.name, a.role, a.symbol_key, a.item_key, a.active,
       r.status   as last_status,
       r.task     as last_task,
       r.job      as last_job,
       r.order_id as last_order_id,
       coalesce(r.finished_at, r.started_at, r.created_at) as last_at,
       (select count(*) from public.agent_runs x
         where x.agent = a.name and x.status in ('queued', 'working', 'waiting_on_me')) as open_runs
  from public.agents a
  left join lateral (
    select * from public.agent_runs r where r.agent = a.name order by r.created_at desc limit 1
  ) r on true;

commit;

-- 8. Every 15 minutes: pick up any order step that got stuck ----------------
select cron.schedule(
  'resume-orders',
  '*/15 * * * *',
  $CRON$
    select net.http_post(
      url := 'https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/crew',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret')
      ),
      body := '{"action": "resume"}'::jsonb,
      timeout_milliseconds := 30000
    );
  $CRON$
);

-- 9. Check
select
  (select count(*) from public.agents)                                    as agents,
  (select count(*) from public.crew_config)                               as settings,
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('orders', 'agent_runs'))                          as new_tables,
  (select schedule from cron.job where jobname = 'resume-orders')         as resume_schedule;
