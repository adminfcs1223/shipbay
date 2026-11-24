-- dev_040 (shipbay-nexus-dev ONLY): ShipBay-only synthetic pallet positions SB-01..SB-06 for the development MVP.
-- Derek's limited dev-only plan, 2026-11-24 11:58 ET. Nothing here touches Nexus, a shared position or production.
--  1. Six positions, kind pallet, NOT shared, zone 'DEV SYNTHETIC', pickable: a pallet can be put away there with the WMS's own
--     put-away (wms_assign_location + wms_putaway) and picked from, with no Nexus call. The bridge refuses them (its begin
--     functions accept shared positions only), so no Nexus write can name them.
--  2. Server-side rule (trigger on wms_pallets, every writer): a pallet may be given a non-shared pallet/floor position only if it
--     is one of SB-01..SB-06. Shared positions keep their Nexus-journal rule (wms_pallets_shared_gate); shelves are not affected.
--  3. The Nexus registry sync never retires, shares or renames an SB position, and refuses a snapshot that names one.
insert into locations (code, zone, kind, active, pickable, shared, walk_seq)
select c, 'DEV SYNTHETIC', 'pallet', true, true, false, 900 + n
from (values (1, 'SB-01'), (2, 'SB-02'), (3, 'SB-03'), (4, 'SB-04'), (5, 'SB-05'), (6, 'SB-06')) v(n, c)
where not exists (select 1 from locations l where upper(l.code) = v.c);
update locations set active = true where zone = 'DEV SYNTHETIC' and code ~ '^SB-0[1-6]$' and not active;   -- re-applied after a rollback

create or replace function public.dev_synthetic_positions_only() returns trigger language plpgsql set search_path to 'public' as $f$
declare l locations;
begin
  if new.location_id is null or (tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id) then return new; end if;
  select * into l from locations where id = new.location_id;
  if l.kind in ('pallet', 'floor') and not coalesce(l.shared, false) and not (l.zone = 'DEV SYNTHETIC' and l.code ~ '^SB-0[1-6]$') then
    raise exception '% is not a development position. On this database a pallet goes to SB-01..SB-06, or to a shared position through Put away and Nexus.', l.code using errcode = '42501';
  end if;
  return new;
end $f$;
revoke all on function public.dev_synthetic_positions_only() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.wms_pallets'::regclass and tgname = 'dev_synthetic_positions_only') then
    create trigger dev_synthetic_positions_only before insert or update of location_id on public.wms_pallets for each row execute function public.dev_synthetic_positions_only();
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.nexus_registry_apply(p_snapshot jsonb, p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; l locations; v_matched int := 0; v_changed int := 0; v_added int := 0; v_retired int := 0; v_stale int := 0;
  v_keep jsonb := '[]'::jsonb; v_new jsonb := '[]'::jsonb; v_gone jsonb := '[]'::jsonb; v_has boolean;
begin
  if jsonb_typeof(p_snapshot -> 'locations') <> 'array' or jsonb_array_length(p_snapshot -> 'locations') = 0 then
    raise exception 'The registry snapshot has no locations. Nothing was changed.';   -- an empty answer must never retire the floor
  end if;
  if exists (select 1 from jsonb_array_elements(p_snapshot -> 'locations') x group by upper(x ->> 'code') having count(*) > 1) then raise exception 'The registry snapshot repeats a code.'; end if;
  -- dev_040: the synthetic positions SB-01..SB-06 are ShipBay's own (development only) and never part of the Nexus registry
  if exists (select 1 from jsonb_array_elements(p_snapshot -> 'locations') x where upper(btrim(x ->> 'code')) ~ '^SB-') then raise exception 'The registry snapshot names an SB position, which is ShipBay''s own development position. Nothing was changed.'; end if;
  for r in select upper(btrim(x ->> 'code')) code, x ->> 'id' nid, x ->> 'kind' kind, x ->> 'zone' zone, nullif(x ->> 'capacity', '')::int cap,
             coalesce(x ->> 'status', 'active') st, coalesce((x ->> 'version')::bigint, 0) ver
           from jsonb_array_elements(p_snapshot -> 'locations') x order by 1 loop
    if r.code is null or r.code = '' or r.st not in ('active', 'blocked', 'retired') or r.kind not in ('pallet', 'floor', 'dock', 'shelf', 'bin') then raise exception 'The registry snapshot has a position ShipBay cannot read (%).', coalesce(r.code, 'no code'); end if;
    select * into l from locations where upper(code) = r.code;
    if l.id is null then
      v_added := v_added + 1; v_new := v_new || to_jsonb(r.code);
      if not p_dry_run then
        insert into locations (code, zone, kind, active, nexus_id, nexus_version, nexus_status, capacity, shared, synced_at)
        values (r.code, coalesce(r.zone, 'bulk'), r.kind, r.st = 'active', coalesce(r.nid, r.code), r.ver, r.st, r.cap, true, now());
      end if;
    elsif l.nexus_version is not null and r.ver < l.nexus_version then
      v_stale := v_stale + 1;   -- older than what is held: ignored
    else
      v_matched := v_matched + 1;
      if l.nexus_version is distinct from r.ver or l.nexus_status is distinct from r.st or l.capacity is distinct from r.cap or l.nexus_id is distinct from coalesce(r.nid, r.code) or not l.shared then v_changed := v_changed + 1; end if;
      if not p_dry_run then
        update locations set nexus_id = coalesce(r.nid, r.code), nexus_version = r.ver, nexus_status = r.st, capacity = r.cap, shared = true, synced_at = now() where id = l.id;
      end if;
    end if;
  end loop;
  -- pallet and staging positions ShipBay holds that Nexus no longer lists: retired, never deleted
  for l in select * from locations x where x.kind in ('pallet', 'floor') and coalesce(x.nexus_status, '') <> 'retired' and not (x.zone = 'DEV SYNTHETIC' and x.code ~ '^SB-0[1-6]$')
           and not exists (select 1 from jsonb_array_elements(p_snapshot -> 'locations') s where upper(btrim(s ->> 'code')) = upper(x.code)) order by x.code loop
    v_has := exists (select 1 from wms_pallets p where p.location_id = l.id and p.status = 'stored')
          or coalesce((select sum(m.qty) from inventory_moves m where m.location_id = l.id), 0) <> 0;
    v_retired := v_retired + 1;
    if v_has then v_keep := v_keep || to_jsonb(l.code); else v_gone := v_gone || to_jsonb(l.code); end if;
    if not p_dry_run then
      -- still pickable while ShipBay has something recorded there; a manager maps or moves it
      update locations set nexus_status = 'retired', synced_at = now(), active = case when v_has then active else false end where id = l.id;
      if v_has then
        insert into nexus_disagreements (kind, location_code, shipbay_view, nexus_view)
        values ('retired_but_occupied', l.code, jsonb_build_object('pallets', (select coalesce(jsonb_agg(p.psku order by p.psku), '[]') from wms_pallets p where p.location_id = l.id and p.status = 'stored')), jsonb_build_object('listed', false))
        on conflict do nothing;
      end if;
    end if;
  end loop;
  if not p_dry_run then update nexus_sync_state set registry_version = (p_snapshot ->> 'version')::bigint, last_ok_at = now(), reachable = true, updated_at = now(); end if;
  return jsonb_build_object('dry_run', p_dry_run, 'matched', v_matched, 'changed', v_changed, 'added', v_added, 'added_codes', v_new, 'ignored_older', v_stale,
    'retired', v_retired, 'retired_empty', v_gone, 'retired_but_occupied', v_keep);
end $function$;
select code, kind, shared, zone, pickable, active from locations where code like 'SB-%' order by code;
