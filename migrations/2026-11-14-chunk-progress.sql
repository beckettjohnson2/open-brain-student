-- Reliable chunking: progress per thought + a 15-minute resume job.
-- Additive only: one new table, one new cron job. Nothing dropped or renamed.
-- Run in the Supabase SQL Editor AFTER `node scripts/backup.mjs`.

begin;

-- 1. Chunking progress, one row per long thought ----------------------------
-- enrich-thought writes next_index after EVERY chunk it saves, so a call that
-- is cut off mid-way loses at most one chunk of work.
create table if not exists public.chunk_progress (
  thought_id        uuid primary key references public.thoughts(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete cascade,
  total_chunks      int  not null default 0,
  next_index        int  not null default 0,   -- first chunk still to do
  stalls            int  not null default 0,   -- resume checks in a row with no progress
  last_seen_index   int,                       -- next_index at the previous resume check
  last_error        text,
  last_progress_at  timestamptz,
  notified_at       timestamptz,               -- owner told in Telegram that it's stuck
  done_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.chunk_progress enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'chunk_progress' and policyname = 'own_chunk_progress') then
    create policy own_chunk_progress on public.chunk_progress for select to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

commit;

-- 2. Every 15 minutes: resume any unfinished chunking ------------------------
-- Same secret handling as weekly-brain-digest: read from Vault at run time,
-- never written here.
select cron.schedule(
  'resume-chunking',
  '*/15 * * * *',
  $CRON$
    select net.http_post(
      url := 'https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret')
      ),
      body := '{"type": "RESUME"}'::jsonb,
      timeout_milliseconds := 30000
    );
  $CRON$
);

-- 3. Check
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'chunk_progress')   as progress_table,
  (select schedule from cron.job where jobname = 'resume-chunking')     as resume_schedule;
