-- What a release does to the pallet in ShipBay, and a stock-safe carry for every position change. CANDIDATE.
-- Needs 20261127_wms_waves (the ledger's pallet_id column) and 20261130_wms_nexus_putaway.
-- Derek's decisions, 2026-11-22 9:27 PM:
--   1. A Nexus release controls physical occupancy only. Inventory changes belong to the proper ShipBay inventory or outbound transaction, once.
--   2. A departed pallet no longer shows its previous position as where it is. The history stays in the journal and the activity log.
--   3. An emptied pallet's stock is already zero through normal processing. A release never deducts.
--   4. A pallet that leaves the shared floor but stays in ShipBay custody keeps its stock and becomes 'off_floor'.
--   5. Floor staff may do ordinary scanned releases. Forced corrections and occupancy reconciliation need admin or staff.
--
-- Why the stock function is touched: _wms_post_stock rebuilds a pallet's ledger from its cartons whenever the pallet's status or
-- position changes, and treats anything that is not 'stored' as holding nothing. Left alone, marking a pallet as departed would
-- make it post a negative 'adjust' for the whole pallet, on top of the picks that already emptied it. The one added line makes it
-- leave the ledger alone for the two new statuses. Everything else in the function is production's text, unchanged.
--
-- The carry: when a pallet changes position its stock follows as 'transfer' pairs that net to zero. One pair for what the pallet
-- posted, and one for what was picked from it at the old position, so the old position ends at zero and the new one holds what
-- is really left. The earlier version carried only the posted quantity: totals were right, but a part-picked pallet left a
-- negative at the old position and its full original quantity at the new one.
begin;
insert into public.locations (code, zone, kind, active, shared)
select 'OFF-FLOOR', 'off floor', 'shelf', true, false where not exists (select 1 from public.locations where code = 'OFF-FLOOR');

CREATE OR REPLACE FUNCTION public._wms_post_stock(p_pallet uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p wms_pallets; r record; v_sum int := 0;
begin
  select * into p from wms_pallets where id = p_pallet;
  if p.id is null then return 0; end if;
  -- A pallet that left the shared floor through a Nexus release keeps its ledger exactly as it stands. Freeing a position is not an inventory transaction.
  if p.status in ('departed', 'off_floor') then return 0; end if;
  for r in
    with target as (
      select t.sku_id, t.location_id, sum(t.qty)::int as qty from (
        select coalesce(c.sku_id, p.sku_id) as sku_id, p.location_id, c.units_per_carton as qty
        from wms_cartons c where c.pallet_id = p.id and not c.cle and c.open_box_at is null and c.units_per_carton is not null
        union all
        select coalesce(c.sku_id, p.sku_id), p.location_id, c.units_per_carton
        from wms_cartons c where c.pallet_id = p.id and c.cle and c.units_per_carton is not null
        union all
        select u.sku_id, u.location_id, 1 from wms_units u where u.pallet_id = p.id and u.status = 'shelved'
        union all
        select p.sku_id, p.location_id, p.units_total
        where p.units_total is not null and not exists (select 1 from wms_cartons c where c.pallet_id = p.id)
      ) t
      where p.status = 'stored' and t.sku_id is not null and t.location_id is not null and t.qty is not null
      group by 1, 2
    ), posted as (
      select m.sku_id, m.location_id, sum(m.qty)::int as qty from inventory_moves m
      where m.ref_type = 'wms_pallet' and m.ref_id = p.id group by 1, 2
    )
    select coalesce(t.sku_id, d.sku_id) as sku_id, coalesce(t.location_id, d.location_id) as location_id,
           coalesce(t.qty, 0) - coalesce(d.qty, 0) as diff, (d.sku_id is null) as first_time
    from target t full join posted d on d.sku_id = t.sku_id and d.location_id is not distinct from t.location_id
  loop
    if r.diff <> 0 then
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      values (p.org_id, r.sku_id, r.diff, case when r.first_time and r.diff > 0 then 'receive' else 'adjust' end, 'wms_pallet', p.id,
              p.psku || case when r.first_time and r.diff > 0 then ' put away' else ' corrected' end, auth.uid(), r.location_id);
      v_sum := v_sum + r.diff;
    end if;
  end loop;
  return v_sum;
end $function$;

create or replace function public._wms_nexus_carry(p_pallet uuid, p_from uuid, p_to uuid, p_note text, p_by uuid) returns integer language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; v_n int;
begin
  select * into p from wms_pallets where id = p_pallet;
  if p.id is null or p_from is null or p_to is null or p_from = p_to then return 0; end if;
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
  select p.org_id, m.sku_id, v.sign * m.qty, 'transfer', m.ref_type, p.id, p_note, p_by, case v.sign when -1 then p_from else p_to end, case when m.ref_type = 'wms_pallet_carry' then p.id end
  from (select sku_id, 'wms_pallet'::text as ref_type, sum(qty)::int as qty from inventory_moves where ref_type = 'wms_pallet' and ref_id = p.id and location_id = p_from group by 1 having sum(qty) <> 0
        union all
        select sku_id, 'wms_pallet_carry', sum(qty)::int from inventory_moves where pallet_id = p.id and ref_type is distinct from 'wms_pallet' and location_id = p_from group by 1 having sum(qty) <> 0) m,
       (values (-1), (1)) v(sign);
  get diagnostics v_n = row_count; return v_n;
end $$;

create or replace function public._wms_nexus_begin(p_kind text, p_psku text, p_location text, p_reason text default null, p_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations; o wms_nexus_ops; v_here text; v_name text;
  v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_psku text := upper(btrim(coalesce(p_psku, '')));
begin
  if not is_wms_staff() then raise exception 'This login cannot place or release pallets.'; end if;
  select * into p from wms_pallets where upper(psku) = v_psku for update;
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(v_psku, ''), '(blank)'); end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') or not coalesce(l.shared, false) then raise exception 'Position % is not a shared pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  select code into v_here from locations where id = p.location_id;
  select * into o from wms_nexus_ops where pallet_id = p.id and state in ('pending', 'out_of_sync') and fixes is null;
  if o.id is not null then
    if o.state = 'out_of_sync' then raise exception '% needs an admin: Nexus accepted % but ShipBay did not record it. Leave the pallet where it is.', p.psku, coalesce(o.to_code, o.from_code); end if;
    if o.kind = p_kind and coalesce(o.to_code, o.from_code) = l.code then return _wms_nexus_desc(o, true); end if;
    raise exception '% already has a request for % that Nexus has not answered. Finish that one first.', p.psku, coalesce(o.to_code, o.from_code);
  end if;
  if p_kind = 'release' then
    -- leaving the floor: allowed for any pallet, voided and held ones included, because the pallet is physically gone either way
    if p_confirmed is not true then raise exception 'Confirm at the position that % is no longer standing in %.', p.psku, l.code; end if;
    if coalesce(p_reason, '') not in ('shipped_out', 'emptied_and_removed', 'moved_off_shared_floor', 'correction') then raise exception 'Say why the pallet left.'; end if;
    -- ordinary scanned releases are floor work; a forced correction is not
    if p_reason = 'correction' and not wms_nexus_admin() then raise exception 'A correction needs a ShipBay admin or staff login.'; end if;
    if p_reason <> 'correction' and p.status in ('departed', 'off_floor') then raise exception '% already left the shared floor.', p.psku; end if;
    if v_here is not null and v_here <> l.code then raise exception 'ShipBay has % at %, not %. Reconcile before releasing.', p.psku, v_here, l.code; end if;
  else
    if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
    if p.held then raise exception '% is on HOLD (%): an admin must release it first.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
    if p.status = 'departed' then raise exception '% left the building. If it has come back, receive it as a new pallet.', p.psku; end if;
    if p_kind = 'assign' then
      if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
    else
      if p.status <> 'stored' or v_here is null then raise exception '% is not put away yet.', p.psku; end if;
      if v_here = l.code then raise exception '% is already at %.', p.psku, l.code; end if;
    end if;
  end if;
  -- no local "is the position free" check: that is Nexus's answer, for both companies
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into wms_nexus_ops (kind, idem_key, pallet_id, psku, from_code, to_code, reason, confirmed_at_position, by_uid, by_name)
  values (p_kind, 'SB-' || upper(p_kind) || '-' || gen_random_uuid()::text, p.id, p.psku, case p_kind when 'move' then v_here when 'release' then l.code end,
    case when p_kind <> 'release' then l.code end, case when p_kind = 'release' then p_reason end, p_kind = 'release', auth.uid(), v_name) returning * into o;
  return _wms_nexus_desc(o, false);
end $$;

create or replace function public._wms_nexus_apply(o public.wms_nexus_ops) returns void language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations; h locations; v_units int;
begin
  select * into p from wms_pallets where id = o.pallet_id for update;
  select * into h from locations where code = 'OFF-FLOOR';
  if o.kind = 'release' then
    -- Freeing the position is all a release does to occupancy. In ShipBay the pallet stops showing that position as where it is;
    -- where it stood stays in this journal and in the activity log. Stock is never deducted here.
    select * into l from locations where upper(code) = upper(o.from_code);
    if l.id is null or p.location_id is distinct from l.id then return; end if;   -- ShipBay did not have it there: nothing to change on the pallet
    if p.status = 'stored' then
      select coalesce(sum(qty), 0)::int into v_units from inventory_moves where location_id = l.id and ((ref_type = 'wms_pallet' and ref_id = p.id) or (ref_type is distinct from 'wms_pallet' and pallet_id = p.id));
      if o.reason in ('shipped_out', 'emptied_and_removed') then
        -- gone from the building: its stock should already be zero through picking or an outbound transaction. Whatever is still on the books stays on the books, and is reported.
        update wms_pallets set status = 'departed', location_id = null where id = p.id;
        if v_units <> 0 then update wms_nexus_ops set problem = v_units || ' units are still on the books at ' || l.code || '. The release did not change them: post the outbound or inventory transaction.' where id = o.id; end if;
      else
        -- still in ShipBay custody (moved off the shared floor, or a forced correction): stock is kept and follows the pallet to the holding location
        if h.id is null then raise exception 'The OFF-FLOOR holding location is missing.'; end if;
        perform _wms_nexus_carry(p.id, l.id, h.id, p.psku || ' left the shared floor from ' || l.code, o.by_uid);
        update wms_pallets set status = 'off_floor', location_id = null where id = p.id;
      end if;
      insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail)
      values (p.org_id, 'pallet_left_floor', 1, p.psku, o.by_uid, o.by_name, jsonb_build_object('from', l.code, 'reason', o.reason, 'units_on_books', v_units, 'request', o.id));
    else
      update wms_pallets set location_id = null where id = p.id;   -- a voided or not-yet-stored pallet: only the position is cleared
    end if;
    return;
  end if;
  select * into l from locations where upper(code) = upper(o.to_code) and active;
  if l.id is null then raise exception 'Position % is no longer active in ShipBay.', o.to_code; end if;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if p.status = 'departed' then raise exception '% left the building.', p.psku; end if;
  if o.kind = 'assign' then
    if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
    -- back from off the floor: its stock returns from the holding location as a transfer, it is not received again
    if p.status = 'off_floor' and h.id is not null then perform _wms_nexus_carry(p.id, h.id, l.id, p.psku || ' back on the shared floor at ' || l.code, o.by_uid); end if;
    update wms_pallets set location_id = l.id, status = 'stored', stored_at = now(), stored_by_name = o.by_name,
      counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, o.by_name) where id = p.id;
  else
    if p.status <> 'stored' then raise exception '% is not put away.', p.psku; end if;
    if p.location_id is not null and p.location_id <> l.id then perform _wms_nexus_carry(p.id, p.location_id, l.id, p.psku || ' moved ' || o.from_code || ' to ' || l.code, o.by_uid); end if;
    update wms_pallets set location_id = l.id where id = p.id;
  end if;
end $$;

create or replace function public._wms_nexus_result(p_op uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('op', o.id, 'kind', o.kind, 'psku', o.psku, 'location', o.to_code, 'from', o.from_code, 'state', o.state, 'fixes', o.fixes, 'reason', o.reason, 'note', o.problem,
    'pallet_status', (select p.status from wms_pallets p where p.id = o.pallet_id),
    'units_posted', (select coalesce(sum(qty), 0) from inventory_moves where ref_type = 'wms_pallet' and ref_id = o.pallet_id)) from wms_nexus_ops o where o.id = p_op;
$$;

create or replace function public.wms_nexus_journal() returns jsonb language sql stable security definer set search_path to 'public' as $$
  with last as (select distinct on (o.pallet_id) o.* from wms_nexus_ops o where o.state = 'done' and o.fixes is null order by o.pallet_id, o.finished_at desc, o.created_at desc)
  select coalesce(jsonb_agg(jsonb_build_object('pallet', l.psku, 'journal', case when l.kind <> 'release' then l.to_code end, 'left_floor', l.kind = 'release',
    'pallet_row', (select c.code from wms_pallets p join locations c on c.id = p.location_id where p.id = l.pallet_id), 'pallet_status', (select p.status from wms_pallets p where p.id = l.pallet_id)) order by l.psku), '[]')
  from last l where wms_nexus_admin();
$$;

revoke all on function public._wms_nexus_carry(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
commit;
