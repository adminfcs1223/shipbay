-- Stage 2, task 1 (ShipBay side): the shared RECEIVING / OUTBOUND zone RCV-OUT on HILLSBOROUGH (Nexus map 5, API 1.2.0).
-- Nexus is the authority for who stands in the zone; ShipBay keeps its usual mirror row so a pallet's stock can sit there.
--   1. RCV-OUT in ShipBay's position list: kind 'floor' (the existing kind check is left as it is), zone 'receiving_outbound',
--      shared, no capacity, NOT pickable (inbound and outbound pallets in the zone are never picked from).
--   2. Every request into the zone carries its zone_status (inbound / outbound) in ShipBay's journal, so a re-send after a lost
--      answer sends exactly the same request to Nexus.
--   3. A pallet already in the zone may be "moved" to the zone again: that is a status change (inbound ↔ outbound). Nexus refuses
--      the same status twice. Numbered and staging positions keep the Stage 1 rule ("already at").
--   4. wms_zone_begin: the one way into the zone, for a pallet not yet placed (assign) or one on the floor (move).
-- Additive: one column, one row, one new function; two existing functions re-created with only the lines named below changed.
alter table public.wms_nexus_ops add column if not exists zone_status text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'wms_nexus_ops_zone_status_check') then
    alter table public.wms_nexus_ops add constraint wms_nexus_ops_zone_status_check check (zone_status is null or zone_status in ('inbound', 'outbound'));
  end if;
end $c$;

insert into public.locations (code, zone, kind, active, shared, pickable, capacity, nexus_id, nexus_version, nexus_status, synced_at)
select 'RCV-OUT', 'receiving_outbound', 'floor', true, true, false, null, 'RCV-OUT', 5, 'active', now()
where not exists (select 1 from public.locations where code = 'RCV-OUT');

create or replace function public._wms_nexus_desc(o wms_nexus_ops, p_resumed boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('op', o.id, 'key', o.idem_key, 'kind', o.kind, 'pallet', o.psku, 'to', o.to_code, 'from', o.from_code, 'fixes', o.fixes, 'resumed', p_resumed, 'by', o.by_name, 'zone_status', o.zone_status);
$$;

-- _wms_nexus_begin: only the "already at" line changes, so a pallet in the zone can change its status there
do $b$ declare v_def text; v_old text := $q$if v_here = l.code then raise exception '% is already at %.', p.psku, l.code; end if;$q$; begin
  v_def := pg_get_functiondef('public._wms_nexus_begin(text,text,text,text,boolean)'::regprocedure);
  if position(v_old in v_def) = 0 then raise exception 'The expected line was not found in _wms_nexus_begin. Nothing was changed.'; end if;
  execute replace(v_def, v_old, $q$if v_here = l.code and l.zone is distinct from 'receiving_outbound' then raise exception '% is already at %.', p.psku, l.code; end if;$q$);
end $b$;

create or replace function public.wms_zone_begin(p_psku text, p_zone_status text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; d jsonb; o wms_nexus_ops; v_status text := lower(btrim(coalesce(p_zone_status, '')));
begin
  if not is_wms_staff() then raise exception 'This login cannot place pallets.'; end if;
  if v_status not in ('inbound', 'outbound') then raise exception 'Say whether the pallet is inbound or outbound.'; end if;
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, '')));
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(btrim(p_psku), ''), '(blank)'); end if;
  -- on the floor already (a numbered position, staging or the zone): a move; not placed yet: an assign
  d := _wms_nexus_begin(case when p.status = 'stored' then 'move' else 'assign' end, p.psku, 'RCV-OUT', null, false);
  select * into o from wms_nexus_ops where id = (d ->> 'op')::uuid for update;
  if o.zone_status is null then update wms_nexus_ops set zone_status = v_status where id = o.id returning * into o;
  elsif o.zone_status <> v_status then raise exception '% already has a request for the zone as %, not yet answered by Nexus. Finish that one first.', p.psku, o.zone_status; end if;
  return _wms_nexus_desc(o, (d ->> 'resumed')::boolean);
end $$;
revoke all on function public.wms_zone_begin(text, text) from public, anon;
grant execute on function public.wms_zone_begin(text, text) to authenticated;
