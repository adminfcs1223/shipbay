-- Rollback of 20261124_nexus.sql. Nexus added only its own objects, so this removes only those.
-- Stops while cycle-count records exist (they are records: export or decide first). Connections are dropped (keys stop working).
begin;
do $$ declare f text; begin
  if exists (select 1 from public.nexus_counts) then raise exception 'Rollback stopped: % cycle count(s) exist.', (select count(*) from public.nexus_counts); end if;
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'nexus\_%' or p.proname like '\_nexus\_%') loop
    execute format('drop function %s cascade', f);
  end loop;
end $$;
drop view if exists public.v_nexus_pallets;
drop table public.nexus_count_lines; drop table public.nexus_counts; drop table public.nexus_clients;
commit;
