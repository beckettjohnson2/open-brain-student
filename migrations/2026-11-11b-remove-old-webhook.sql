-- Remove the old, disabled Database Webhook "enrich-on-insert", and the test
-- thought saved on Nov 11 to check the lock-down.
-- The webhook's definition had the service_role key written into it. It was
-- replaced by enrich_on_insert_v2 (2026-11-11-security-orphans.sql), which
-- reads the internal secret from Vault. Approved by the owner on Nov 11, 2026.
-- Back up first:  node scripts/backup.mjs
-- Run in Supabase: SQL Editor -> New query -> paste -> Run.

drop trigger if exists "enrich-on-insert" on public.thoughts;

delete from public.thoughts
 where id = '8cacccd4-da92-4e51-b377-111bd85db6a5'
   and content like '[TEST - safe to delete]%';

-- Expect: enrich_on_insert_v2=O, thoughts_default_owner=O
select string_agg(tgname::text || '=' || tgenabled::text, ', ') as triggers
  from pg_trigger where tgrelid = 'public.thoughts'::regclass and not tgisinternal;
