-- =====================================================================
-- Security + orphans
--
-- ADD ONLY: new Vault secrets, new functions, a new trigger, an updated cron
-- job. The old webhook trigger is DISABLED (not dropped), so it can be
-- switched back on with:
--   alter table public.thoughts enable trigger "enrich-on-insert";
-- Safe to run more than once. Back up first:  node scripts/backup.mjs
--
-- No secret values appear in this file. The internal secret is generated
-- inside the database, straight into Vault; read it from there once to set
-- the INTERNAL_SECRET edge-function secret.
-- =====================================================================

-- 1. Vault secrets ------------------------------------------------------
do $$
declare
  owners int;
begin
  -- internal_secret: 64 random hex characters, generated here, never typed.
  if not exists (select 1 from vault.secrets where name = 'internal_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'internal_secret',
      'Shared secret for internal calls (x-internal-secret). Same value as the INTERNAL_SECRET edge-function secret.'
    );
  end if;

  -- owner_user_id: the one person whose brain this is.
  if not exists (select 1 from vault.secrets where name = 'owner_user_id') then
    select count(distinct user_id) into owners from public.thoughts where user_id is not null;
    if owners <> 1 then
      raise exception 'Expected exactly one owner in thoughts, found %', owners;
    end if;
    perform vault.create_secret(
      (select user_id::text from public.thoughts where user_id is not null limit 1),
      'owner_user_id',
      'The owner of this brain. New thoughts saved without a user_id get this one.'
    );
  end if;
end $$;

create or replace function public.owner_user_id()
returns uuid
language sql stable security definer
set search_path = public, vault
as $$
  select decrypted_secret::uuid from vault.decrypted_secrets where name = 'owner_user_id';
$$;
revoke all on function public.owner_user_id() from public, anon, authenticated;


-- 2. Orphans: give the 4 ownerless thoughts (and their pieces) to the owner -
update public.thoughts        set user_id = public.owner_user_id() where user_id is null;
update public.thought_chunks  set user_id = public.owner_user_id() where user_id is null;
update public.thought_links   set user_id = public.owner_user_id() where user_id is null;
update public.thought_sources set user_id = public.owner_user_id() where user_id is null;

-- Safety net: a thought saved without an owner gets the owner, so it can
-- never again be invisible. (Every code path also sets user_id itself.)
create or replace function public.thoughts_default_owner()
returns trigger
language plpgsql security definer
set search_path = public, vault
as $$
begin
  if new.user_id is null then
    new.user_id := public.owner_user_id();
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'thoughts_default_owner'
                 and tgrelid = 'public.thoughts'::regclass) then
    create trigger thoughts_default_owner
      before insert on public.thoughts
      for each row execute function public.thoughts_default_owner();
  end if;
end $$;


-- 3. Enrichment webhook that sends the internal secret from Vault --------
-- Same payload as the old Database Webhook ({type, table, schema, record,
-- old_record}). A failed call never blocks the save.
create or replace function public.notify_enrich_thought()
returns trigger
language plpgsql security definer
set search_path = public, extensions, vault
as $$
declare
  secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'internal_secret';
  perform net.http_post(
    url := 'https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', secret),
    body := jsonb_build_object(
      'type', 'INSERT', 'table', 'thoughts', 'schema', 'public',
      'record', to_jsonb(new) - 'embedding' - 'content_tsv',
      'old_record', null
    ),
    timeout_milliseconds := 30000
  );
  return new;
exception when others then
  raise warning 'notify_enrich_thought failed for %: %', new.id, sqlerrm;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'enrich_on_insert_v2'
                 and tgrelid = 'public.thoughts'::regclass) then
    create trigger enrich_on_insert_v2
      after insert on public.thoughts
      for each row execute function public.notify_enrich_thought();
  end if;
end $$;

-- The old Database Webhook had the service_role key written into it. Disable
-- it (it would now get 401s anyway). Not dropped — see the note at the top.
alter table public.thoughts disable trigger "enrich-on-insert";


-- 4. Weekly digest cron: also send the internal secret from Vault --------
-- Same name and schedule; cron.schedule updates the existing job.
select cron.schedule(
  'weekly-brain-digest',
  '0 15 * * 0',
  $CRON$
    select net.http_post(
      url := 'https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/weekly-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $CRON$
);


-- 5. Check
select
  (select count(*) from public.thoughts where user_id is null)               as ownerless_thoughts,
  (select count(*) from vault.secrets where name in ('internal_secret', 'owner_user_id')) as vault_secrets,
  (select string_agg(tgname::text || '=' || tgenabled::text, ', ') from pg_trigger
    where tgrelid = 'public.thoughts'::regclass and not tgisinternal)         as triggers;
