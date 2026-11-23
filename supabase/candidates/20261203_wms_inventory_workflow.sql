-- Inventory workflow repairs before the hosted movement rehearsal. CANDIDATE. Needs every candidate through 20261202.
-- Derek, 2026-11-23: the seven gaps listed in supabase/dev/MOVEMENT-REHEARSAL.md. Nexus is the authority for where a pallet
-- physically stands on the shared floor; every ShipBay workflow below now follows that, and none of them changes a quantity rule.
--
--   1. A wave stop that is planned but not yet picked follows its pallet when Nexus confirms a move. A pallet with a planned
--      stop cannot be released from the floor (an admin's forced correction still can). A stop whose pallet is gone takes 0.
--   2. The older pick list records the pallet it picked from, so the pick travels with the pallet. Undoing it puts the units back
--      where the pallet stands NOW, never at the position recorded at pick time, and is refused if the pallet has left the floor.
--      Older picks that carry no pallet are tied to it at the moment it moves, where that is certain (a one-pallet position).
--   3. No pallet in any state can be given a shared position outside the Nexus journal: wms_assign_location refuses, and the
--      table rule refuses every other path. ShipBay's map can no longer show a shared position as taken on its own say-so.
--   4. Completing a carton count no longer suggests a shared position. A counted pallet bound for the shared floor has no
--      position until Nexus accepts the scan at put-away.
--   5. While a pallet has a request Nexus has not settled (waiting, or accepted by Nexus and not recorded by ShipBay), its stock
--      is not offered to the wave planner or the older pick list, a planned stop on it cannot be confirmed, a pick from it cannot
--      be reopened or undone, and it cannot be reserved. A second movement was already refused.
--   6. wms_nexus_exceptions(): what an admin must act on. Departed pallets with units still on the books (with the one action
--      that closes them, wms_departed_stock_close, exactly once), pallets off the floor, positions held in ShipBay only,
--      planned stops whose pallet is not where the stop says, and older picks at shared positions that carry no pallet.
--   7. wms_pick_correct(): the manager's correction for a pick that cannot be reopened because its pallet left the floor. The
--      units go back onto a ShipBay shelf the manager names, never onto a shared position, and the stop or line is reopened there.
--
-- Unchanged: receiving, labels, carton counting, HOLD, packing, wave routing and allocation order, the one-receipt rule, the rule
-- that a release never deducts stock, and every quantity a function posts. Functions below are their current text with the
-- changes marked by comments; nothing else in them was touched.
begin;

-- a pallet with a Nexus request that is not settled yet
create or replace function public._wms_pallet_busy(p_pallet uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from wms_nexus_ops o where o.pallet_id = p_pallet and o.state in ('pending', 'out_of_sync'));
$$;
-- may this product be picked at this position right now? A private ShipBay location: yes if it is pickable. A shared position:
-- only if a stored ShipBay pallet holding the product stands there and no such pallet is waiting on Nexus.
create or replace function public._wms_can_pick(p_sku uuid, p_location uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select l.pickable and (not coalesce(l.shared, false) or (
    _wms_pallet_at(p_sku, p_location) is not null
    and not exists (select 1 from wms_pallets p where p.location_id = l.id and p.status = 'stored' and _wms_pallet_busy(p.id)
      and exists (select 1 from inventory_moves m where m.ref_type = 'wms_pallet' and m.ref_id = p.id and m.sku_id = p_sku))))
  from locations l where l.id = p_location;
$$;
-- where units picked from (sku, position, pallet) go back to. Private location: where they came from. A pallet: where it stands now.
create or replace function public._wms_pick_home(p_sku uuid, p_location uuid, p_pallet uuid, out location_id uuid, out pallet_id uuid) language plpgsql stable security definer set search_path to 'public' as $$
declare l locations; p wms_pallets;
begin
  select * into l from locations where id = p_location; location_id := p_location; pallet_id := p_pallet;
  if pallet_id is null and coalesce(l.shared, false) then
    -- an older pick that recorded no pallet, at a shared position: it can only go back if a stored pallet of that product stands there
    pallet_id := _wms_pallet_at(p_sku, p_location);
    if pallet_id is null then raise exception 'The pallet these units were picked from no longer stands at %. A manager returns them to a ShipBay shelf with a pick correction.', l.code; end if;
  end if;
  if pallet_id is null then return; end if;
  select * into p from wms_pallets where id = pallet_id;
  if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands. Undo this pick after that is settled.', p.psku; end if;
  if p.status in ('departed', 'off_floor') then raise exception 'The pallet these units were picked from (%) has left the shared floor. A manager returns them to a ShipBay shelf with a pick correction.', p.psku; end if;
  if p.status = 'stored' and p.location_id is not null then location_id := p.location_id; end if;
end $$;
revoke all on function public._wms_pallet_busy(uuid) from public, anon, authenticated, service_role;
revoke all on function public._wms_can_pick(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._wms_pick_home(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ===== 1. planned stops follow the pallet; a pallet with a planned pick cannot be released =====
create or replace function public._wms_nexus_apply(o public.wms_nexus_ops) returns void language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; l locations; h locations; v_units int;
begin
  perform set_config('wms.nexus_apply', '1', true);   -- lets this function, and only this function, change a pallet's shared position (see _wms_shared_position_gate)
  select * into p from wms_pallets where id = o.pallet_id for update;
  select * into h from locations where code = 'OFF-FLOOR';
  if o.kind = 'release' then
    -- Freeing the position is all a release does to occupancy. In ShipBay the pallet stops showing that position as where it is;
    -- where it stood stays in this journal and in the activity log. Stock is never deducted here.
    select * into l from locations where upper(code) = upper(o.from_code);
    if l.id is null or p.location_id is distinct from l.id then perform set_config('wms.nexus_apply', '', true); return; end if;   -- ShipBay did not have it there: nothing to change on the pallet
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
    perform set_config('wms.nexus_apply', '', true); return;
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
    -- stops planned but not yet picked follow the pallet to the position Nexus has just confirmed
    update wms_wave_tasks t set location_id = l.id from wms_waves w where w.id = t.wave_id and w.status = 'picking' and t.confirmed_at is null and t.pallet_id = p.id and t.location_id is distinct from l.id;
  end if;
  perform set_config('wms.nexus_apply', '', true);
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
    -- a pick is planned from this pallet: it cannot leave the floor under the picker. (A move is fine: the stop follows the pallet.)
    if p_reason <> 'correction' and exists (select 1 from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where t.pallet_id = p.id and t.confirmed_at is null and w.status = 'picking') then
      raise exception 'Wave % still has a pick planned from %. Pick that stop or hand the wave back first.',
        (select min(w.seq) from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where t.pallet_id = p.id and t.confirmed_at is null and w.status = 'picking'), p.psku;
    end if;
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

create or replace function public.wms_wave_confirm(p_task uuid, p_qty integer, p_scan text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; t wms_wave_tasks; w wms_waves; x record; v_left int; v_take int; v_on int; v_code text; v_name text; p wms_pallets;
begin
  select * into c from _wms_floor();
  select * into t from wms_wave_tasks where id = p_task for update;
  if t.id is null then raise exception 'That stop is not on file.'; end if;
  select * into w from wms_waves where id = t.wave_id for update;
  if w.status <> 'picking' then raise exception 'Wave % is no longer being picked.', w.seq; end if;
  if t.confirmed_at is not null then raise exception 'That stop is already confirmed.'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many units you picked.'; end if;
  if p_qty > t.qty_planned then raise exception 'Only % are needed from here. Put the extra back.', t.qty_planned; end if;
  if t.pallet_id is not null and p_qty > 0 then
    select * into p from wms_pallets where id = t.pallet_id;
    if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands. Pick this stop after that is settled.', p.psku; end if;
    if p.status <> 'stored' or p.location_id is null then raise exception '% is no longer on the floor. Enter 0 for this stop and it goes to a manager.', p.psku; end if;
    if p.location_id <> t.location_id then   -- the pallet was moved through Nexus since this stop was planned: the stop follows it
      update wms_wave_tasks set location_id = p.location_id where id = t.id; t.location_id := p.location_id;
    end if;
  end if;
  select code into v_code from locations where id = t.location_id; select name into v_name from skus where id = t.sku_id;
  if p_qty > 0 and _wms_needs_scan(t.sku_id) and not _wms_scan_ok(t.sku_id, p_scan) then
    if coalesce(trim(p_scan), '') = '' then raise exception 'Scan the barcode on % to pick it.', v_name; else raise exception 'That barcode is not %. Check the item.', v_name; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext(t.sku_id::text));
  select coalesce(sum(qty), 0)::int into v_on from inventory_moves where sku_id = t.sku_id and location_id = t.location_id;
  if p_qty > v_on then raise exception 'Only % on file at %. Enter what is really there, then tell a manager.', v_on, v_code; end if;
  if p_qty > 0 then
    insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
    values (w.org_id, t.sku_id, -p_qty, 'pick', 'wave_task', t.id, 'Wave ' || w.seq, c.uid, t.location_id, t.pallet_id);
  end if;
  v_left := p_qty;
  for x in select tl.line_id, tl.qty, ol.order_id from wms_wave_task_lines tl join order_lines ol on ol.id = tl.line_id join orders o on o.id = ol.order_id
           where tl.task_id = t.id order by o.ship_by nulls first, o.order_number, tl.line_id loop
    v_take := least(v_left, x.qty); v_left := v_left - v_take;
    if v_take > 0 then
      insert into wms_picks (line_id, order_id, org_id, sku_id, location_id, qty, picked_by, picked_by_name, pallet_id, task_id)
      values (x.line_id, x.order_id, w.org_id, t.sku_id, t.location_id, v_take, c.uid, c.who, t.pallet_id, t.id);
    end if;
    if v_take < x.qty then   -- short: to a manager, and the order leaves this wave's pack group
      insert into wms_pick_problems (line_id, order_id, org_id, sku_id, kind, found, note, location_code, reported_by, reported_by_name)
      values (x.line_id, x.order_id, w.org_id, t.sku_id, case when p_qty = 0 then 'missing' else 'short' end, v_take, 'Wave ' || w.seq || ': ' || p_qty || ' of ' || t.qty_planned || ' picked at this stop', v_code, c.uid, c.who);
      update wms_wave_orders set pack_state = 'problem' where wave_id = w.id and order_id = x.order_id;
    end if;
  end loop;
  update wms_wave_tasks set qty_picked = p_qty, confirmed_at = now(), confirmed_by_name = c.who where id = t.id;
  update order_lines ol set picked_at = now(), picked_by = c.uid, picked_by_name = c.who
  where ol.id in (select line_id from wms_wave_task_lines where task_id = t.id) and ol.picked_at is null
    and (select coalesce(sum(k.qty), 0) from wms_picks k where k.line_id = ol.id and k.undone_at is null) >= ol.qty;
  return _wms_wave_json(w.id);
end $$;

create or replace function public.wms_wave_unconfirm(p_task uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; t wms_wave_tasks; w wms_waves; p wms_pallets; v_loc uuid;
begin
  select * into c from _wms_floor();
  select * into t from wms_wave_tasks where id = p_task for update;
  select * into w from wms_waves where id = t.wave_id for update;
  if t.id is null or t.confirmed_at is null then raise exception 'That stop is not confirmed.'; end if;
  if w.status <> 'picking' then raise exception 'Wave % has gone to packing. A manager must correct it.', w.seq; end if;
  if t.qty_picked > 0 then
    -- The units go back where the pallet stands NOW. If it was moved since the pick, that is its new position, never the old one;
    -- if it has left the shared floor there is nowhere to put them back, and a manager corrects it.
    v_loc := t.location_id;
    if t.pallet_id is not null then
      select * into p from wms_pallets where id = t.pallet_id;
      if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands. Reopen this stop after that is settled.', p.psku; end if;
      if p.status in ('departed', 'off_floor') then raise exception 'The pallet for that stop (%) has left the shared floor. A manager returns these units to a ShipBay shelf with a pick correction.', p.psku; end if;
      if p.status = 'stored' and p.location_id is not null then v_loc := p.location_id; end if;
    end if;
    insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
    values (w.org_id, t.sku_id, t.qty_picked, 'pick', 'wave_task', t.id, 'Wave ' || w.seq || ' stop reopened', c.uid, v_loc, t.pallet_id);
    if v_loc is distinct from t.location_id then update wms_wave_tasks set location_id = v_loc where id = t.id; end if;   -- the stop now points at where the pallet is
  end if;
  update wms_picks set undone_at = now(), undone_by_name = c.who where task_id = t.id and undone_at is null;
  update order_lines set picked_at = null, picked_by = null, picked_by_name = null where id in (select line_id from wms_wave_task_lines where task_id = t.id);
  update wms_pick_problems b set resolved_at = now(), resolved_by_name = c.who, resolved_how = 'stop reopened'
  where b.resolved_at is null and b.line_id in (select line_id from wms_wave_task_lines where task_id = t.id) and b.note like 'Wave ' || w.seq || ':%';
  update wms_wave_orders wo set pack_state = 'pending' where wo.wave_id = w.id and wo.pack_state = 'problem'
    and not exists (select 1 from wms_pick_problems b where b.order_id = wo.order_id and b.resolved_at is null);
  update wms_wave_tasks set qty_picked = null, confirmed_at = null, confirmed_by_name = null where id = t.id;
  return _wms_wave_json(w.id);
end $$;

-- ===== 2. the older pick list: picks are tied to their pallet, undo goes to where the pallet stands now =====
CREATE OR REPLACE FUNCTION public.wms_pick_scan(p_lines uuid[], p_scan text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l record; r record; v_name text; v_need int; v_take int; v_done int := 0; v_unposted int := 0; v_pal uuid;
begin
  if not is_wms_staff() then raise exception 'This login cannot pick.'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for l in
    select ol.*, o.org_id, o.order_number, o.status as ostatus, o.closed_at
    from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = any (p_lines) and o.source = 'connector'
    order by o.ship_by nulls first, o.order_number, ol.id
    for update of ol
  loop
    if l.picked_at is not null or l.closed_at is not null then continue; end if;
    if l.sku_id is not null and _wms_needs_scan(l.sku_id) and not _wms_scan_ok(l.sku_id, p_scan) then
      if coalesce(trim(p_scan), '') = '' then raise exception 'Scan the barcode on % to pick it.', l.name;
      else raise exception 'That barcode is not %. Check the item.', l.name; end if;
    end if;
    v_need := l.qty;
    if l.sku_id is not null then
      perform pg_advisory_xact_lock(hashtext(l.sku_id::text));
      for r in
        select m.location_id, sum(m.qty)::int as on_hand
        from inventory_moves m join locations lc on lc.id = m.location_id
        where m.sku_id = l.sku_id and _wms_can_pick(m.sku_id, m.location_id) group by m.location_id, lc.zone, lc.code having sum(m.qty) > 0
        order by (lc.zone = 'open box') desc, min(m.created_at) filter (where m.qty > 0), lc.code
      loop
        exit when v_need = 0;
        v_take := least(v_need, r.on_hand);
        v_pal := _wms_pallet_at(l.sku_id, r.location_id);   -- the pallet these units come off (null for shelf stock): the pick now travels with it
        insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
        values (l.org_id, l.sku_id, -v_take, 'pick', 'order_line', l.id, 'Order ' || l.order_number, auth.uid(), r.location_id, v_pal);
        insert into wms_picks (line_id, order_id, org_id, sku_id, location_id, qty, picked_by, picked_by_name, pallet_id)
        values (l.id, l.order_id, l.org_id, l.sku_id, r.location_id, v_take, auth.uid(), v_name, v_pal);
        v_need := v_need - v_take;
      end loop;
    end if;
    update order_lines set picked_at = now(), picked_by = auth.uid(), picked_by_name = v_name, pick_short = nullif(v_need, 0) where id = l.id;
    update wms_pick_problems set resolved_at = now(), resolved_by_name = v_name, resolved_how = 'picked' where line_id = l.id and resolved_at is null;
    v_done := v_done + 1; v_unposted := v_unposted + v_need;
    if not exists (select 1 from order_lines x where x.order_id = l.order_id and x.picked_at is null) then
      update orders set status = 'picked' where id = l.order_id and status = 'new';
    end if;
  end loop;
  return jsonb_build_object('picked', v_done, 'unposted_units', v_unposted, 'not_picked', '[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.wms_unpick(p_lines uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l record; k record; v_name text; v_done int := 0; w record;
begin
  if not is_wms_staff() then raise exception 'This login cannot pick.'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for l in
    select ol.*, o.org_id, o.order_number, o.closed_at from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = any (p_lines) and o.source = 'connector' for update of ol
  loop
    if l.picked_at is null then continue; end if;
    for k in select * from wms_picks where line_id = l.id and undone_at is null for update loop
      select * into w from _wms_pick_home(k.sku_id, k.location_id, k.pallet_id);   -- where the pallet stands NOW; refuses if it is gone or waiting for Nexus
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
      values (l.org_id, k.sku_id, k.qty, 'pick', 'order_line', l.id, 'Pick undone · order ' || l.order_number, auth.uid(), w.location_id, w.pallet_id);
      update wms_picks set undone_at = now(), undone_by_name = v_name where id = k.id;
    end loop;
    update order_lines set picked_at = null, picked_by = null, picked_by_name = null, pick_short = null where id = l.id;
    update orders set status = 'new' where id = l.order_id and status = 'picked';
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('undone', v_done);
end $function$;

create or replace function public._wms_nexus_carry(p_pallet uuid, p_from uuid, p_to uuid, p_note text, p_by uuid) returns integer language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; v_n int; f locations; v_since timestamptz;
begin
  select * into p from wms_pallets where id = p_pallet;
  if p.id is null or p_from is null or p_to is null or p_from = p_to then return 0; end if;
  -- Picks made with the older pick list before it recorded the pallet: at a one-pallet position, a pick of this pallet's product
  -- made while this pallet stood there came off this pallet. Tie those rows to it now (the pallet reference only; no quantity
  -- changes), so they travel with it like every other pick.
  select * into f from locations where id = p_from;
  if f.kind = 'pallet' and coalesce(f.capacity, 1) = 1 then
    select coalesce(max(o.finished_at), p.stored_at) into v_since from wms_nexus_ops o where o.pallet_id = p.id and o.state = 'done' and o.kind in ('assign', 'move') and upper(o.to_code) = upper(f.code);
    update inventory_moves m set pallet_id = p.id
    where m.location_id = p_from and m.pallet_id is null and m.reason = 'pick' and m.ref_type = 'order_line' and v_since is not null and m.created_at >= v_since
      and m.sku_id in (select x.sku_id from inventory_moves x where x.ref_type = 'wms_pallet' and x.ref_id = p.id);
    update wms_picks k set pallet_id = p.id
    where k.location_id = p_from and k.pallet_id is null and k.task_id is null and k.undone_at is null and v_since is not null and k.picked_at >= v_since
      and k.sku_id in (select x.sku_id from inventory_moves x where x.ref_type = 'wms_pallet' and x.ref_id = p.id);
  end if;
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
  select p.org_id, m.sku_id, v.sign * m.qty, 'transfer', m.ref_type, p.id, p_note, p_by, case v.sign when -1 then p_from else p_to end, case when m.ref_type = 'wms_pallet_carry' then p.id end
  from (select sku_id, 'wms_pallet'::text as ref_type, sum(qty)::int as qty from inventory_moves where ref_type = 'wms_pallet' and ref_id = p.id and location_id = p_from group by 1 having sum(qty) <> 0
        union all
        select sku_id, 'wms_pallet_carry', sum(qty)::int from inventory_moves where pallet_id = p.id and ref_type is distinct from 'wms_pallet' and location_id = p_from group by 1 having sum(qty) <> 0) m,
       (values (-1), (1)) v(sign);
  get diagnostics v_n = row_count; return v_n;
end $$;

-- ===== 3 and 4. shared positions are never reserved, suggested or marked taken from ShipBay's own records =====
CREATE OR REPLACE FUNCTION public.wms_assign_location(p_pallet uuid, p_location uuid)
 RETURNS wms_pallets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p wms_pallets; l locations;
begin
  if not is_wms_staff() then raise exception 'This login cannot move a pallet.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null or p.status <> 'counted' then raise exception 'Only a pallet waiting for put-away can be given a position.'; end if;
  select * into l from locations where id = p_location and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'That is not a pallet position.'; end if;
  if coalesce(l.shared, false) then raise exception '% is a shared Nexus position. It cannot be reserved here: scan the pallet there under Put away and Nexus confirms it.', l.code; end if;
  if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands.', p.psku; end if;
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status in ('counted', 'stored') and x.id <> p_pallet) then
    raise exception '% already has a pallet.', l.code;
  end if;
  update wms_pallets set location_id = l.id where id = p_pallet returning * into p;
  return p;
end $function$;

CREATE OR REPLACE FUNCTION public._wms_pick_location(p_pallet uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid; v_loc uuid;
begin
  select org_id into v_org from wms_pallets where id = p_pallet;
  select l.id into v_loc
  from locations l
  where l.active and l.kind = 'pallet' and not coalesce(l.shared, false)   -- a shared position is never suggested from ShipBay's own records: only Nexus knows whether it is free
    and not exists (select 1 from wms_pallets p where p.location_id = l.id and p.status in ('counted', 'stored'))
  order by (exists (select 1 from wms_pallets p join locations l2 on l2.id = p.location_id where p.org_id = v_org and p.status in ('counted', 'stored') and l2.zone is not distinct from l.zone)) desc, l.code
  limit 1;
  update wms_pallets set location_id = v_loc where id = p_pallet;
  return v_loc;
end $function$;

create or replace function public._wms_shared_position_gate() returns trigger language plpgsql set search_path to 'public' as $$
declare v_new boolean := false; v_old boolean := false; v_code text;
begin
  if current_setting('wms.nexus_apply', true) = '1' then return new; end if;
  if new.location_id is not null then select coalesce(shared, false), code into v_new, v_code from locations where id = new.location_id; end if;
  -- no pallet in any state is given a shared position here: that would show the position as taken on ShipBay's map without Nexus knowing
  if coalesce(v_new, false) and (tg_op = 'INSERT' or old.location_id is distinct from new.location_id) then
    raise exception '% is a shared Nexus position. It cannot be reserved here: put % away through Nexus.', v_code, new.psku;
  end if;
  if new.status = 'stored' and coalesce(v_new, false) and (tg_op = 'INSERT' or old.status is distinct from 'stored' or old.location_id is distinct from new.location_id) then
    raise exception '% is a shared Nexus position. Put % away through Nexus.', v_code, new.psku;
  end if;
  if tg_op = 'UPDATE' and old.status = 'stored' and old.location_id is not null then
    select coalesce(shared, false), code into v_old, v_code from locations where id = old.location_id;
    if coalesce(v_old, false) and (new.location_id is distinct from old.location_id or new.status not in ('stored', 'void')) then
      raise exception '% stands in shared position %. Move or release it through Nexus.', new.psku, v_code;
    end if;
  end if;
  return new;
end $$;

-- ===== 5. the wave planner only offers stock whose pallet is settled =====
create or replace function public.wms_wave_start(p_org uuid, p_max_orders integer default 40, p_max_units integer default 120) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; v_wave uuid; ord record; n record; a record; v_orders int := 0; v_units int := 0; v_need int; v_take int; v_ok boolean; v_short jsonb := '[]'::jsonb; v_seq int;
begin
  select * into c from _wms_floor();
  select w.id into v_wave from wms_waves w where w.org_id = p_org and w.picker = c.uid and w.status in ('picking', 'packing') order by w.created_at limit 1;
  if v_wave is not null then return jsonb_build_object('wave', _wms_wave_json(v_wave)); end if;
  perform pg_advisory_xact_lock(hashtext('wms_wave:' || p_org::text));
  create temp table if not exists _wv_avail (sku_id uuid, location_id uuid, pallet_id uuid, free int, first_in timestamptz, open_box boolean, code text) on commit drop;
  create temp table if not exists _wv_plan (order_id uuid, line_id uuid, sku_id uuid, location_id uuid, pallet_id uuid, qty int) on commit drop;
  truncate _wv_avail; truncate _wv_plan;
  insert into _wv_avail
  select m.sku_id, m.location_id, _wms_pallet_at(m.sku_id, m.location_id),
    sum(m.qty)::int - coalesce((select sum(t.qty_planned) from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where t.sku_id = m.sku_id and t.location_id = m.location_id and t.confirmed_at is null and w.status = 'picking'), 0)::int,
    min(m.created_at) filter (where m.qty > 0), l.zone = 'open box', l.code
  from inventory_moves m join locations l on l.id = m.location_id where m.org_id = p_org and _wms_can_pick(m.sku_id, m.location_id) group by m.sku_id, m.location_id, l.zone, l.code having sum(m.qty) > 0;
  for ord in
    select x.id, x.order_number, x.sig, x.units from (
      select o.id, o.order_number, o.ship_by,
        (select coalesce(string_agg(coalesce(l.sku, l.name) || 'x' || l.qty, '|' order by coalesce(l.sku, l.name)), '') from order_lines l where l.order_id = o.id and l.is_physical and l.qty > 0) as sig,
        (select coalesce(sum(l.qty), 0)::int from order_lines l where l.order_id = o.id and l.is_physical and l.qty > 0 and l.picked_at is null and l.sku_id is not null) as units
      from orders o where o.org_id = p_org and o.source = 'connector' and o.closed_at is null and o.status = 'new'
        and not exists (select 1 from wms_wave_orders y join wms_waves w on w.id = y.wave_id where y.order_id = o.id and w.status in ('picking', 'packing'))
        and not exists (select 1 from wms_pick_problems b where b.order_id = o.id and b.resolved_at is null)) x
    order by x.ship_by nulls first, x.sig, x.order_number
  loop
    if v_orders > 0 and (v_orders >= p_max_orders or v_units + ord.units > p_max_units) then continue; end if;
    -- can every product on the order be covered by what is free right now?
    v_ok := true;
    for n in select l.sku_id, sum(l.qty)::int need, min(l.sku) sku from order_lines l where l.order_id = ord.id and l.is_physical and l.qty > 0 and l.picked_at is null and l.sku_id is not null group by l.sku_id loop
      if coalesce((select sum(greatest(free, 0)) from _wv_avail where sku_id = n.sku_id), 0) < n.need then
        v_ok := false; v_short := v_short || jsonb_build_object('order_number', ord.order_number, 'sku', n.sku, 'need', n.need, 'on_file', coalesce((select sum(greatest(free, 0)) from _wv_avail where sku_id = n.sku_id), 0));
      end if;
    end loop;
    if not v_ok then continue; end if;
    for n in select l.id, l.sku_id, l.qty from order_lines l where l.order_id = ord.id and l.is_physical and l.qty > 0 and l.picked_at is null and l.sku_id is not null order by l.id loop
      v_need := n.qty;
      for a in select ctid, * from _wv_avail where sku_id = n.sku_id and free > 0 order by open_box desc, first_in, code loop
        exit when v_need = 0; v_take := least(v_need, a.free);
        insert into _wv_plan values (ord.id, n.id, n.sku_id, a.location_id, a.pallet_id, v_take);
        update _wv_avail set free = free - v_take where ctid = a.ctid; v_need := v_need - v_take;
      end loop;
    end loop;
    insert into _wv_plan values (ord.id, null, null, null, null, 0);   -- keeps an order with nothing to walk for
    v_orders := v_orders + 1; v_units := v_units + ord.units;
  end loop;
  if v_orders = 0 then return jsonb_build_object('wave', null, 'short', v_short); end if;
  select coalesce(max(seq), 0) + 1 into v_seq from wms_waves where org_id = p_org;
  insert into wms_waves (org_id, seq, picker, picker_name) values (p_org, v_seq, c.uid, c.who) returning id into v_wave;
  insert into wms_wave_orders (wave_id, order_id) select distinct v_wave, order_id from _wv_plan;
  -- one stop per product per position; the route runs from the far end back to the pack station, same position back to back
  insert into wms_wave_tasks (wave_id, seq, sku_id, location_id, pallet_id, qty_planned)
  select v_wave, row_number() over (order by l.walk_seq desc nulls first, l.code desc, s.sku), g.sku_id, g.location_id, g.pallet_id, g.qty
  from (select sku_id, location_id, pallet_id, sum(qty)::int qty from _wv_plan where line_id is not null group by 1, 2, 3) g join locations l on l.id = g.location_id join skus s on s.id = g.sku_id;
  insert into wms_wave_task_lines (task_id, line_id, qty)
  select t.id, p.line_id, sum(p.qty)::int from _wv_plan p join wms_wave_tasks t on t.wave_id = v_wave and t.sku_id = p.sku_id and t.location_id = p.location_id where p.line_id is not null group by t.id, p.line_id;
  return jsonb_build_object('wave', _wms_wave_json(v_wave), 'short', v_short);
end $$;
-- ===== 6. what an admin must act on =====
create or replace function public.wms_nexus_exceptions() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare j jsonb;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can see this report.'; end if;
  with books as (
    select p.id, m.sku_id, m.location_id, sum(m.qty)::int units from wms_pallets p join inventory_moves m on (m.ref_type = 'wms_pallet' and m.ref_id = p.id) or m.pallet_id = p.id
    where p.status in ('departed', 'off_floor') group by 1, 2, 3 having sum(m.qty) <> 0),
  gone as (
    select p.id, p.psku, p.status, g.name brand, r.from_code, r.finished_at, r.reason, r.by_name, r.id op,
      (select coalesce(jsonb_agg(jsonb_build_object('sku', s.sku, 'name', s.name, 'position', l.code, 'units', b.units) order by s.sku, l.code), '[]') from books b join skus s on s.id = b.sku_id left join locations l on l.id = b.location_id where b.id = p.id) lines,
      (select coalesce(sum(b.units), 0)::int from books b where b.id = p.id) units
    from wms_pallets p join orgs g on g.id = p.org_id
    left join lateral (select o.* from wms_nexus_ops o where o.pallet_id = p.id and o.kind = 'release' and o.state = 'done' order by o.finished_at desc limit 1) r on true
    where p.status in ('departed', 'off_floor'))
  select jsonb_build_object(
    'departed_with_stock', (select coalesce(jsonb_agg(jsonb_build_object('pallet', psku, 'pallet_id', id, 'brand', brand, 'left_from', from_code, 'left_at', finished_at, 'reason', reason, 'released_by', by_name, 'request', op,
        'units', units, 'lines', lines, 'action', 'Post what happened to these units: close them out with the shipment or disposal reference. The release did not deduct them.') order by finished_at), '[]')
      from gone where status = 'departed' and units <> 0),
    'off_floor', (select coalesce(jsonb_agg(jsonb_build_object('pallet', psku, 'pallet_id', id, 'brand', brand, 'left_from', from_code, 'left_at', finished_at, 'released_by', by_name, 'units', units, 'lines', lines,
        'action', 'Still in ShipBay custody and not pickable. Put it away again through Nexus, or release it as shipped out when it leaves.') order by finished_at), '[]')
      from gone where status = 'off_floor'),
    'held_in_shipbay_only', (select coalesce(jsonb_agg(jsonb_build_object('pallet', p.psku, 'pallet_id', p.id, 'brand', g.name, 'status', p.status, 'position', l.code,
        'action', 'ShipBay shows this position for a pallet Nexus has not accepted there. Scan it under Put away; Nexus confirms or refuses.') order by l.code), '[]')
      from wms_pallets p join locations l on l.id = p.location_id join orgs g on g.id = p.org_id where coalesce(l.shared, false) and p.status not in ('stored', 'void')),
    'stops_without_pallet', (select coalesce(jsonb_agg(jsonb_build_object('wave', w.seq, 'task', t.id, 'picker', w.picker_name, 'pallet', p.psku, 'pallet_status', p.status, 'stop_position', l.code, 'pallet_position', pl.code, 'units', t.qty_planned,
        'action', 'A pick is planned from a pallet that is not standing where the stop says. The picker enters 0 for this stop and the order goes to a manager.') order by w.seq, t.seq), '[]')
      from wms_wave_tasks t join wms_waves w on w.id = t.wave_id and w.status = 'picking' join wms_pallets p on p.id = t.pallet_id join locations l on l.id = t.location_id left join locations pl on pl.id = p.location_id
      where t.confirmed_at is null and (p.status <> 'stored' or p.location_id is distinct from t.location_id)),
    'picks_without_pallet', (select coalesce(jsonb_agg(jsonb_build_object('position', x.code, 'sku', x.sku, 'units', x.units, 'picks', x.n,
        'action', 'Older picks at a shared position that name no pallet. They are tied to the pallet when it next moves from a one-pallet position; check the position count if a pallet has already left.') order by x.code, x.sku), '[]')
      from (select l.code, s.sku, -sum(m.qty)::int units, count(*) n from inventory_moves m join locations l on l.id = m.location_id join skus s on s.id = m.sku_id
            where coalesce(l.shared, false) and m.pallet_id is null and m.reason = 'pick' and m.ref_type = 'order_line' group by 1, 2 having sum(m.qty) <> 0) x)
  ) into j;
  return j || jsonb_build_object('needs_action', jsonb_array_length(j -> 'departed_with_stock') + jsonb_array_length(j -> 'held_in_shipbay_only') + jsonb_array_length(j -> 'stops_without_pallet') + jsonb_array_length(j -> 'picks_without_pallet'));
end $$;

-- The one action for a departed pallet with units still on the books: an admin states what happened to them (a shipment or
-- disposal reference) and exactly those units are taken off the books at the position they are recorded at. Once. The release
-- itself never did this (Derek, 2026-11-22: "handled separately by the correct ShipBay inventory or outbound transaction, exactly once").
create or replace function public.wms_departed_stock_close(p_pallet uuid, p_ref text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare p wms_pallets; v_name text; v_units int := 0; v_rows int := 0; r record;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can close out a departed pallet.'; end if;
  if length(coalesce(trim(p_ref), '')) < 3 then raise exception 'Give the shipment or disposal reference these units left on.'; end if;
  select * into p from wms_pallets where id = p_pallet for update;
  if p.id is null or p.status <> 'departed' then raise exception 'Only a pallet that has left the building can be closed out.'; end if;
  if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands.', p.psku; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  for r in select m.sku_id, m.location_id, sum(m.qty)::int units from inventory_moves m where (m.ref_type = 'wms_pallet' and m.ref_id = p.id) or m.pallet_id = p.id group by 1, 2 having sum(m.qty) <> 0 loop
    insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
    values (p.org_id, r.sku_id, -r.units, 'adjust', 'wms_pallet_out', p.id, p.psku || ' left the building: ' || trim(p_ref), auth.uid(), r.location_id, p.id);
    v_units := v_units + r.units; v_rows := v_rows + 1;
  end loop;
  if v_rows = 0 then raise exception 'Nothing is left on the books for %.', p.psku; end if;
  insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail) values (p.org_id, 'pallet_stock_closed', 1, p.psku, auth.uid(), v_name, jsonb_build_object('units', v_units, 'reference', trim(p_ref)));
  return jsonb_build_object('pallet', p.psku, 'units_closed', v_units, 'reference', trim(p_ref));
end $$;

-- ===== 7. the manager's pick correction =====
-- For a pick that cannot be reopened the normal way because its pallet has left the shared floor (or, for an older pick that
-- named no pallet, no longer stands where the pick was made). Admin or staff only, with a reason. The picked units are put
-- back on the books at a private, pickable ShipBay location the manager names: never a shared position, never the position the
-- pallet has vacated. The stop (or order line) is reopened there. Exactly what the pick took off is put back: no more, no less.
--   p_kind 'wave_stop' : p_id is the stop. The wave must still be in picking.
--   p_kind 'order_line': p_id is the order line picked with the older pick list.
create or replace function public.wms_pick_correct(p_kind text, p_id uuid, p_to_location text, p_reason text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_name text; l locations; t wms_wave_tasks; w wms_waves; p wms_pallets; ol record; k record; v_units int := 0; v_gone boolean := false; v_from text;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can correct a pick.'; end if;
  if length(coalesce(trim(p_reason), '')) < 5 then raise exception 'Say why this pick is being corrected.'; end if;
  select * into l from locations where upper(code) = upper(regexp_replace(btrim(coalesce(p_to_location, '')), '^LOC-', '', 'i')) and active;
  if l.id is null then raise exception 'Name the ShipBay shelf the units are going back to.'; end if;
  if coalesce(l.shared, false) then raise exception '% is a shared Nexus position. Returned units go to a ShipBay shelf.', l.code; end if;
  if not l.pickable then raise exception '% is not a pickable location.', l.code; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  if p_kind = 'wave_stop' then
    select * into t from wms_wave_tasks where id = p_id for update;
    select * into w from wms_waves where id = t.wave_id for update;
    if t.id is null or t.confirmed_at is null or coalesce(t.qty_picked, 0) = 0 then raise exception 'That stop has no confirmed pick to correct.'; end if;
    if w.status <> 'picking' then raise exception 'Wave % is no longer being picked.', w.seq; end if;
    select * into p from wms_pallets where id = t.pallet_id;
    if p.id is null or p.status not in ('departed', 'off_floor') then raise exception 'The pallet for that stop is still on the floor. Reopen the stop the normal way.'; end if;
    if _wms_pallet_busy(p.id) then raise exception '% is waiting for Nexus to confirm where it stands.', p.psku; end if;
    v_units := t.qty_picked; select code into v_from from locations where id = t.location_id;
    insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
    values (w.org_id, t.sku_id, v_units, 'pick', 'wave_task', t.id, 'Wave ' || w.seq || ' stop corrected by ' || v_name || ': ' || trim(p_reason), auth.uid(), l.id);
    -- from here on: exactly what reopening a stop does
    update wms_picks set undone_at = now(), undone_by_name = v_name where task_id = t.id and undone_at is null;
    update order_lines set picked_at = null, picked_by = null, picked_by_name = null where id in (select line_id from wms_wave_task_lines where task_id = t.id);
    update wms_pick_problems b set resolved_at = now(), resolved_by_name = v_name, resolved_how = 'stop corrected' where b.resolved_at is null and b.line_id in (select line_id from wms_wave_task_lines where task_id = t.id) and b.note like 'Wave ' || w.seq || ':%';
    update wms_wave_orders wo set pack_state = 'pending' where wo.wave_id = w.id and wo.pack_state = 'problem' and not exists (select 1 from wms_pick_problems b where b.order_id = wo.order_id and b.resolved_at is null);
    update wms_wave_tasks set qty_picked = null, confirmed_at = null, confirmed_by_name = null, location_id = l.id, pallet_id = null where id = t.id;   -- the stop is now a shelf stop
    insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail) values (w.org_id, 'pick_corrected', v_units, p.psku, auth.uid(), v_name,
      jsonb_build_object('kind', 'wave_stop', 'task', t.id, 'wave', w.seq, 'picked_at', v_from, 'returned_to', l.code, 'units', v_units, 'reason', trim(p_reason)));
    return jsonb_build_object('kind', 'wave_stop', 'units_returned', v_units, 'returned_to', l.code, 'pallet', p.psku, 'wave', _wms_wave_json(w.id));
  elsif p_kind = 'order_line' then
    select x.*, o.org_id, o.order_number, o.closed_at into ol from order_lines x join orders o on o.id = x.order_id where x.id = p_id and o.source = 'connector' for update of x;
    if ol.id is null or ol.picked_at is null then raise exception 'That line has no pick to correct.'; end if;
    if ol.closed_at is not null then raise exception 'Order % is closed.', ol.order_number; end if;
    if exists (select 1 from wms_picks where line_id = ol.id and undone_at is null and task_id is not null) then raise exception 'That line was picked on a wave. Correct the wave stop instead.'; end if;
    for k in select x.*, pl.status pallet_status, pl.psku, pl.id pal, lc.code from_code, coalesce(lc.shared, false) shared from wms_picks x left join wms_pallets pl on pl.id = x.pallet_id join locations lc on lc.id = x.location_id where x.line_id = ol.id and x.undone_at is null loop
      if k.pal is not null and _wms_pallet_busy(k.pal) then raise exception '% is waiting for Nexus to confirm where it stands.', k.psku; end if;
      if k.pallet_status in ('departed', 'off_floor') or (k.pal is null and k.shared and _wms_pallet_at(k.sku_id, k.location_id) is null) then v_gone := true; end if;
    end loop;
    if not v_gone then raise exception 'The pallet for that pick is still on the floor. Undo the pick the normal way.'; end if;
    for k in select * from wms_picks where line_id = ol.id and undone_at is null for update loop
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
      values (ol.org_id, k.sku_id, k.qty, 'pick', 'order_line', ol.id, 'Pick corrected by ' || v_name || ' · order ' || ol.order_number || ': ' || trim(p_reason), auth.uid(), l.id);
      update wms_picks set undone_at = now(), undone_by_name = v_name where id = k.id; v_units := v_units + k.qty;
    end loop;
    update order_lines set picked_at = null, picked_by = null, picked_by_name = null, pick_short = null where id = ol.id;
    update orders set status = 'new' where id = ol.order_id and status = 'picked';
    insert into wms_activity (org_id, kind, qty, ref, actor, actor_name, detail) values (ol.org_id, 'pick_corrected', v_units, ol.order_number, auth.uid(), v_name,
      jsonb_build_object('kind', 'order_line', 'line', ol.id, 'returned_to', l.code, 'units', v_units, 'reason', trim(p_reason)));
    return jsonb_build_object('kind', 'order_line', 'units_returned', v_units, 'returned_to', l.code, 'order', ol.order_number);
  end if;
  raise exception 'Correct a wave stop or an order line.';
end $$;

revoke all on function public.wms_nexus_exceptions() from public, anon;
revoke all on function public.wms_departed_stock_close(uuid, text) from public, anon;
revoke all on function public.wms_pick_correct(text, uuid, text, text) from public, anon;
grant execute on function public.wms_nexus_exceptions() to authenticated;
grant execute on function public.wms_departed_stock_close(uuid, text) to authenticated;
grant execute on function public.wms_pick_correct(text, uuid, text, text) to authenticated;
commit;
