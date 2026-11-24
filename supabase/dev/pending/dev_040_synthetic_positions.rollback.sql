-- Rollback of dev_040 on shipbay-nexus-dev. The registry function goes back to its exact previous text (md5 a0514959 of the
-- definition), the position rule is removed, and the SB positions are switched off (never deleted: pallets, stock or picks may
-- name them; anything still stored there must be released or moved first, and the rollback refuses while it is).
do $$ begin
  if exists (select 1 from wms_pallets p join locations l on l.id = p.location_id where l.code ~ '^SB-0[1-6]$' and p.status in ('counted', 'stored'))
     or exists (select 1 from inventory_moves m join locations l on l.id = m.location_id where l.code ~ '^SB-0[1-6]$' group by l.id having sum(m.qty) <> 0) then
    raise exception 'A pallet or stock is still at an SB position. Release or ship it first. Nothing was changed.';
  end if;
end $$;
drop trigger if exists dev_synthetic_positions_only on public.wms_pallets;
drop function if exists public.dev_synthetic_positions_only();
update locations set active = false where zone = 'DEV SYNTHETIC' and code ~ '^SB-0[1-6]$';
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
  for l in select * from locations x where x.kind in ('pallet', 'floor') and coalesce(x.nexus_status, '') <> 'retired'
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
