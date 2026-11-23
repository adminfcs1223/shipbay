-- ShipBay's local copy of the Nexus location registry. NOT APPLIED TO PRODUCTION (plan phase 2/3; needs approval).
-- Nexus is the authority for shared positions (2026-11-22 decision). ShipBay takes the registry from Nexus and never
-- edits it. This file only adds columns, two tables and one function. It never touches pallets, stock, movement history
-- or a pallet's position, and it never deletes a location: a code Nexus no longer lists is marked retired, kept, and
-- reported when something of ShipBay's is still recorded there.
begin;
alter table public.locations add column if not exists nexus_id text;
alter table public.locations add column if not exists nexus_version bigint;
alter table public.locations add column if not exists nexus_status text check (nexus_status in ('active', 'blocked', 'retired'));
alter table public.locations add column if not exists capacity integer;
alter table public.locations add column if not exists shared boolean not null default false;
alter table public.locations add column if not exists synced_at timestamptz;
create unique index if not exists locations_nexus_id on public.locations (nexus_id) where nexus_id is not null;

create table if not exists public.nexus_sync_state (
  id boolean primary key default true check (id), registry_version bigint, last_seq bigint not null default 0,
  last_ok_at timestamptz, reachable boolean not null default false, updated_at timestamptz not null default now());
insert into public.nexus_sync_state (id) values (true) on conflict do nothing;
create table if not exists public.nexus_disagreements (
  id bigint generated always as identity primary key, at timestamptz not null default now(), kind text not null,
  location_code text, pallet_id uuid, shipbay_view jsonb, nexus_view jsonb, resolved_at timestamptz, resolved_by_name text, resolution text);
create unique index if not exists nexus_disagreements_open on public.nexus_disagreements (kind, location_code) where resolved_at is null and pallet_id is null;
do $$ declare t text; begin
  foreach t in array array['nexus_sync_state', 'nexus_disagreements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Apply a registry snapshot from Nexus: {"version": 12, "locations": [{"id","code","kind","zone","capacity","status","version"}]}
-- p_dry_run = true reports what would happen and writes nothing.
create or replace function public.nexus_registry_apply(p_snapshot jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
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
end $$;
revoke all on function public.nexus_registry_apply(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.nexus_registry_apply(jsonb, boolean) to service_role;
commit;
