-- Brain HQ (the 3D office, hq.html): live updates through Supabase Realtime.
-- Additive only: four existing tables join the supabase_realtime publication.
-- Nothing is dropped, renamed or rewritten. Row-level security still decides
-- who receives what: the page signs in as the owner, and every one of these
-- tables only lets a login read its own rows (agent_runs, orders, thoughts,
-- llm_usage all have "auth.uid() = user_id" select policies).
-- Cost: Realtime is included in the plan; one viewer produces a few hundred
-- messages a day, far under the free 2 million a month. No polling.
-- Run AFTER `node scripts/backup.mjs`. Safe to re-run.

do $$
declare t text;
begin
  foreach t in array array['agent_runs', 'orders', 'thoughts', 'llm_usage'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Check: should list the four tables.
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
