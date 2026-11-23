-- Inventory safeguards before any live-inventory use. CANDIDATE. Needs 20261127_wms_waves and 20261201_wms_nexus_departure.
-- Derek's decisions, 2026-11-22 9:48 PM:
--   * OFF-FLOOR stock must not be wave-pickable unless its pallet association and physical availability are verified.
--   * Reopening a wave stop after a pallet movement must not restore quantities to an obsolete position.
--   * Legacy direct put-away must not bypass Nexus for Nexus-managed shared warehouse positions.
--
-- 1. Picking. A position is offered for picking only if it is marked pickable, and, when it is a shared Nexus position, only if a
--    stored ShipBay pallet holding that product stands there. So stock at the OFF-FLOOR holding location is not offered, and neither
--    is stock still on the books at a shared position a pallet has left. Both the wave planner and the older scan-to-pick path.
-- 2. Reopening a wave stop puts the units back where the pallet stands now and repoints the stop there. If the pallet has left the
--    shared floor it is refused.
-- 3. A table rule on wms_pallets: a pallet becomes stored at, moves between, or leaves a shared position only through the Nexus
--    journal (_wms_nexus_apply). nexus_putaway, wms_putaway, wms_assign_location and direct writes are refused for shared positions.
--    Voiding stays allowed (it frees nothing in Nexus). APPLYING THIS FILE TO PRODUCTION IS THE CUT-OVER: after it, the old put-away
--    screens cannot store a pallet in P-01..P-66 or STG-01/02.
-- wms_pick_scan below is production's text plus the one condition. wms_wave_start and wms_wave_unconfirm are 20261127's text plus the changes described.
begin;
alter table public.locations add column if not exists pickable boolean not null default true;
update public.locations set pickable = false where code = 'OFF-FLOOR' and pickable;

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
  from inventory_moves m join locations l on l.id = m.location_id where m.org_id = p_org and l.pickable and (not coalesce(l.shared, false) or _wms_pallet_at(m.sku_id, m.location_id) is not null) group by m.sku_id, m.location_id, l.zone, l.code having sum(m.qty) > 0;
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

CREATE OR REPLACE FUNCTION public.wms_pick_scan(p_lines uuid[], p_scan text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l record; r record; v_name text; v_need int; v_take int; v_done int := 0; v_unposted int := 0;
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
        where m.sku_id = l.sku_id and lc.pickable and (not coalesce(lc.shared, false) or _wms_pallet_at(m.sku_id, m.location_id) is not null) group by m.location_id, lc.zone, lc.code having sum(m.qty) > 0
        order by (lc.zone = 'open box') desc, min(m.created_at) filter (where m.qty > 0), lc.code
      loop
        exit when v_need = 0;
        v_take := least(v_need, r.on_hand);
        insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id)
        values (l.org_id, l.sku_id, -v_take, 'pick', 'order_line', l.id, 'Order ' || l.order_number, auth.uid(), r.location_id);
        insert into wms_picks (line_id, order_id, org_id, sku_id, location_id, qty, picked_by, picked_by_name)
        values (l.id, l.order_id, l.org_id, l.sku_id, r.location_id, v_take, auth.uid(), v_name);
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
      if p.status in ('departed', 'off_floor') then raise exception 'The pallet for that stop (%) has left the shared floor. A manager must correct it.', p.psku; end if;
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
  end if;
  perform set_config('wms.nexus_apply', '', true);
end $$;

create or replace function public._wms_shared_position_gate() returns trigger language plpgsql set search_path to 'public' as $$
declare v_new boolean := false; v_old boolean := false; v_code text;
begin
  if current_setting('wms.nexus_apply', true) = '1' then return new; end if;
  if new.location_id is not null then select coalesce(shared, false), code into v_new, v_code from locations where id = new.location_id; end if;
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
drop trigger if exists wms_pallets_shared_gate on public.wms_pallets;
create trigger wms_pallets_shared_gate before insert or update on public.wms_pallets for each row execute function public._wms_shared_position_gate();
revoke all on function public._wms_shared_position_gate() from public, anon, authenticated;
commit;
