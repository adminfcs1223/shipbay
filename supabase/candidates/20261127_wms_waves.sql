-- Wave picking and packing for the ShipBay WMS. Additive: the old pick functions stay in place, unused by the new screen.
--   pick  : orders are released to a picker one wave at a time; a wave is a walking route of stops (position + pallet + item);
--           stock leaves the position/pallet only when the picker confirms the exact units picked at that stop
--   pack  : after the wave, the picker packs the orders just picked; identical orders are grouped; an order can be split
--           into several packages (one package label each). No carrier label is bought here.
--   issues: a short stop is written to wms_pick_problems for a manager and that order leaves the pack group; nothing blocks.
begin;

alter table public.inventory_moves add column if not exists pallet_id uuid;
alter table public.wms_picks add column if not exists pallet_id uuid;
alter table public.wms_picks add column if not exists task_id uuid;
-- steps from the pack station: the pick route runs from the highest number down, so it ends at the pack station
alter table public.locations add column if not exists walk_seq integer;

create table if not exists public.wms_waves (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id), seq integer not null,
  status text not null default 'picking' check (status in ('picking', 'packing', 'done', 'cancelled')),
  picker uuid, picker_name text, created_at timestamptz not null default now(), picked_at timestamptz, done_at timestamptz);
create index if not exists wms_waves_open on public.wms_waves (org_id, status);
create table if not exists public.wms_wave_orders (
  wave_id uuid not null references public.wms_waves(id) on delete cascade, order_id uuid not null references public.orders(id) on delete cascade,
  pack_state text not null default 'pending' check (pack_state in ('pending', 'packed', 'problem')), primary key (wave_id, order_id));
create index if not exists wms_wave_orders_order on public.wms_wave_orders (order_id);
create table if not exists public.wms_wave_tasks (
  id uuid primary key default gen_random_uuid(), wave_id uuid not null references public.wms_waves(id) on delete cascade, seq integer not null,
  sku_id uuid not null, location_id uuid not null, pallet_id uuid, qty_planned integer not null check (qty_planned > 0),
  qty_picked integer, confirmed_at timestamptz, confirmed_by_name text);
create index if not exists wms_wave_tasks_wave on public.wms_wave_tasks (wave_id);
create index if not exists wms_wave_tasks_open on public.wms_wave_tasks (sku_id, location_id) where confirmed_at is null;
create table if not exists public.wms_wave_task_lines (
  task_id uuid not null references public.wms_wave_tasks(id) on delete cascade, line_id uuid not null references public.order_lines(id) on delete cascade,
  qty integer not null check (qty > 0), primary key (task_id, line_id));
create sequence if not exists public.wms_package_no;
create table if not exists public.wms_packages (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, order_id uuid not null references public.orders(id) on delete cascade, wave_id uuid,
  seq integer not null, of_n integer not null, code text not null unique, items jsonb not null, weight_oz numeric(8, 2), packaging text,
  packed_by uuid, packed_by_name text, packed_at timestamptz not null default now());
create index if not exists wms_packages_order on public.wms_packages (order_id);
do $$ declare t text; begin
  foreach t in array array['wms_waves', 'wms_wave_orders', 'wms_wave_tasks', 'wms_wave_task_lines', 'wms_packages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.wms_package_no from anon, authenticated;

-- the stored pallet that holds this product at this position (null for shelf stock)
create or replace function public._wms_pallet_at(p_sku uuid, p_location uuid) returns uuid language sql stable security definer set search_path to 'public' as $$
  select p.id from wms_pallets p where p.location_id = p_location and p.status = 'stored'
    and exists (select 1 from inventory_moves m where m.ref_type = 'wms_pallet' and m.ref_id = p.id and m.sku_id = p_sku)
  order by p.stored_at nulls last, p.psku limit 1;
$$;
revoke all on function public._wms_pallet_at(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public._wms_floor(out uid uuid, out who text, out role text) language plpgsql stable security definer set search_path to 'public' as $$
begin
  select p.id, coalesce(p.full_name, p.email), p.role into uid, who, role from profiles p
  where p.id = auth.uid() and p.active and p.role in ('shipbay_admin', 'shipbay_staff', 'wms_employee');
  if uid is null then raise exception 'This login cannot work orders.'; end if;
end $$;
revoke all on function public._wms_floor() from public, anon, authenticated, service_role;

-- everything one wave screen needs
create or replace function public._wms_wave_json(p_wave uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', w.id, 'seq', w.seq, 'status', w.status, 'org_id', w.org_id, 'picker', w.picker_name, 'created_at', w.created_at,
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'seq', t.seq, 'location', l.code, 'zone', l.zone, 'psku', p.psku, 'mixed', coalesce(p.mixed, false),
        'sku', s.sku, 'name', s.name, 'image_url', s.image_url, 'needs_scan', _wms_needs_scan(t.sku_id),
        'qty_planned', t.qty_planned, 'qty_picked', t.qty_picked, 'confirmed', t.confirmed_at is not null,
        'orders', (select count(distinct ol.order_id) from wms_wave_task_lines x join order_lines ol on ol.id = x.line_id where x.task_id = t.id)) order by t.seq), '[]')
      from wms_wave_tasks t join locations l on l.id = t.location_id join skus s on s.id = t.sku_id left join wms_pallets p on p.id = t.pallet_id where t.wave_id = w.id),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'order_number', o.order_number, 'ship_by', o.ship_by, 'customer', o.customer_name, 'notes', o.notes,
        'ship_to', o.ship_to, 'shipping_method', o.shipping_method, 'pack_state', wo.pack_state, 'status', o.status,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(ol.sku, ol.name), 'sku', ol.sku, 'name', ol.name, 'qty', ol.qty, 'image_url', coalesce(ol.image_url, s.image_url),
            'picked', coalesce((select sum(k.qty) from wms_picks k where k.line_id = ol.id and k.undone_at is null), 0)) order by coalesce(ol.sku, ol.name)), '[]')
          from order_lines ol left join skus s on s.id = ol.sku_id where ol.order_id = o.id and ol.is_physical and ol.qty > 0),
        'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', k.code, 'seq', k.seq, 'of', k.of_n, 'items', k.items, 'weight_oz', k.weight_oz, 'packaging', k.packaging) order by k.seq), '[]') from wms_packages k where k.order_id = o.id and k.wave_id = w.id))
        order by o.ship_by nulls first, o.order_number), '[]')
      from wms_wave_orders wo join orders o on o.id = wo.order_id where wo.wave_id = w.id))
  from wms_waves w where w.id = p_wave;
$$;
revoke all on function public._wms_wave_json(uuid) from public, anon, authenticated, service_role;

-- what the brand's order screen shows before a wave is open: counts only, never the full list
create or replace function public.wms_orders_summary(p_org uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c record; v_mgr boolean;
begin
  select * into c from _wms_floor(); v_mgr := c.role in ('shipbay_admin', 'shipbay_staff');
  return jsonb_build_object(
    'manager', v_mgr,
    'my_wave', (select w.id from wms_waves w where w.org_id = p_org and w.picker = c.uid and w.status in ('picking', 'packing') order by w.created_at limit 1),
    'to_pick', (select count(*) from orders o where o.org_id = p_org and o.source = 'connector' and o.closed_at is null and o.status = 'new'
        and not exists (select 1 from wms_wave_orders x join wms_waves w on w.id = x.wave_id where x.order_id = o.id and w.status in ('picking', 'packing'))
        and not exists (select 1 from wms_pick_problems b where b.order_id = o.id and b.resolved_at is null)),
    'in_waves', (select count(*) from wms_wave_orders x join wms_waves w on w.id = x.wave_id where w.org_id = p_org and w.status in ('picking', 'packing') and x.pack_state = 'pending'),
    'packed_today', (select count(*) from orders o where o.org_id = p_org and o.packed_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'),
    'with_manager', (select count(distinct b.order_id) from wms_pick_problems b join orders o on o.id = b.order_id where b.org_id = p_org and b.resolved_at is null and o.closed_at is null and o.status in ('new', 'picked')),
    'other_waves', (select coalesce(jsonb_agg(jsonb_build_object('seq', w.seq, 'picker', w.picker_name, 'status', w.status) order by w.seq), '[]') from wms_waves w where w.org_id = p_org and w.status in ('picking', 'packing') and w.picker is distinct from c.uid),
    'problems', case when v_mgr then (select coalesce(jsonb_agg(jsonb_build_object('line_id', b.line_id, 'order_number', o.order_number, 'sku', ol.sku, 'name', ol.name, 'need', ol.qty, 'kind', b.kind, 'found', b.found,
        'note', b.note, 'location', b.location_code, 'by', b.reported_by_name, 'at', b.reported_at) order by b.reported_at), '[]')
      from wms_pick_problems b join orders o on o.id = b.order_id join order_lines ol on ol.id = b.line_id where b.org_id = p_org and b.resolved_at is null and o.closed_at is null and o.status in ('new', 'picked')) else '[]'::jsonb end);
end $$;

-- open (or reopen) the caller's wave for a brand. Orders are taken oldest ship-by first with identical orders side by side,
-- only when every unit can be allocated from stock on file, until the trip is full.
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
  from inventory_moves m join locations l on l.id = m.location_id where m.org_id = p_org group by m.sku_id, m.location_id, l.zone, l.code having sum(m.qty) > 0;
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

create or replace function public.wms_wave(p_wave uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin perform 1 from _wms_floor(); return _wms_wave_json(p_wave); end $$;

-- the picker says exactly how many units came off this stop; only now does stock leave the position (and its pallet)
create or replace function public.wms_wave_confirm(p_task uuid, p_qty integer, p_scan text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; t wms_wave_tasks; w wms_waves; x record; v_left int; v_take int; v_on int; v_code text; v_name text;
begin
  select * into c from _wms_floor();
  select * into t from wms_wave_tasks where id = p_task for update;
  if t.id is null then raise exception 'That stop is not on file.'; end if;
  select * into w from wms_waves where id = t.wave_id for update;
  if w.status <> 'picking' then raise exception 'Wave % is no longer being picked.', w.seq; end if;
  if t.confirmed_at is not null then raise exception 'That stop is already confirmed.'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many units you picked.'; end if;
  if p_qty > t.qty_planned then raise exception 'Only % are needed from here. Put the extra back.', t.qty_planned; end if;
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

-- wrong number typed: put that stop back as it was (only while the wave is still being picked)
create or replace function public.wms_wave_unconfirm(p_task uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; t wms_wave_tasks; w wms_waves;
begin
  select * into c from _wms_floor();
  select * into t from wms_wave_tasks where id = p_task for update;
  select * into w from wms_waves where id = t.wave_id for update;
  if t.id is null or t.confirmed_at is null then raise exception 'That stop is not confirmed.'; end if;
  if w.status <> 'picking' then raise exception 'Wave % has gone to packing. A manager must correct it.', w.seq; end if;
  if t.qty_picked > 0 then
    insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, created_by, location_id, pallet_id)
    values (w.org_id, t.sku_id, t.qty_picked, 'pick', 'wave_task', t.id, 'Wave ' || w.seq || ' stop reopened', c.uid, t.location_id, t.pallet_id);
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

-- every stop is answered: go to the pack station. Short orders stay with the manager; the rest are ready to pack.
create or replace function public.wms_wave_to_pack(p_wave uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; w wms_waves; v_left int;
begin
  select * into c from _wms_floor();
  select * into w from wms_waves where id = p_wave for update;
  if w.id is null then raise exception 'That wave is not on file.'; end if;
  if w.status = 'packing' then return _wms_wave_json(w.id); end if;
  if w.status <> 'picking' then raise exception 'Wave % is closed.', w.seq; end if;
  select count(*) into v_left from wms_wave_tasks where wave_id = w.id and confirmed_at is null;
  if v_left > 0 then raise exception '% stop% still to pick.', v_left, case when v_left = 1 then '' else 's' end; end if;
  update orders o set status = 'picked' where o.status = 'new' and o.id in (select order_id from wms_wave_orders where wave_id = w.id and pack_state = 'pending')
    and not exists (select 1 from order_lines l where l.order_id = o.id and l.is_physical and l.qty > 0 and l.sku_id is not null and l.picked_at is null);
  update wms_waves set status = case when exists (select 1 from wms_wave_orders where wave_id = w.id and pack_state = 'pending') then 'packing' else 'done' end,
    picked_at = now(), done_at = case when exists (select 1 from wms_wave_orders where wave_id = w.id and pack_state = 'pending') then null else now() end where id = w.id;
  return _wms_wave_json(w.id);
end $$;

-- hand an untouched wave back (nothing picked yet)
create or replace function public.wms_wave_cancel(p_wave uuid) returns void language plpgsql security definer set search_path to 'public' as $$
declare c record; w wms_waves;
begin
  select * into c from _wms_floor();
  select * into w from wms_waves where id = p_wave for update;
  if w.id is null or w.status <> 'picking' then raise exception 'Only a wave that is still being picked can be handed back.'; end if;
  if w.picker is distinct from c.uid and c.role not in ('shipbay_admin', 'shipbay_staff') then raise exception 'That wave belongs to %.', w.picker_name; end if;
  if exists (select 1 from wms_wave_tasks where wave_id = w.id and confirmed_at is not null) then raise exception 'Stops on this wave are already confirmed. Reopen them first, or finish the wave.'; end if;
  update wms_waves set status = 'cancelled', done_at = now() where id = w.id;
end $$;

-- pack one order, or several identical ones at once, into one or more packages each
--   p_packages: [{"items": [{"key": "<sku>", "qty": 2}], "weight_oz": 12, "packaging": "mailer"}]
create or replace function public.wms_wave_pack(p_wave uuid, p_orders uuid[], p_packages jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; w wms_waves; ord record; k jsonb; v_n int := coalesce(jsonb_array_length(p_packages), 0); v_want jsonb; v_got jsonb; i int;
begin
  select * into c from _wms_floor();
  select * into w from wms_waves where id = p_wave for update;
  if w.id is null or w.status <> 'packing' then raise exception 'This wave is not at the pack station yet.'; end if;
  if coalesce(array_length(p_orders, 1), 0) = 0 then raise exception 'Choose the order to pack.'; end if;
  if v_n < 1 or v_n > 20 then raise exception 'An order goes out in 1 to 20 packages.'; end if;
  if exists (select 1 from jsonb_array_elements(p_packages) p where coalesce(jsonb_array_length(p -> 'items'), 0) = 0) then raise exception 'A package has nothing in it.'; end if;
  if exists (select 1 from jsonb_array_elements(p_packages) p, jsonb_array_elements(p -> 'items') it where coalesce((it ->> 'qty')::int, 0) < 1) then raise exception 'A package item needs a quantity.'; end if;
  select coalesce(jsonb_object_agg(g.key, g.qty), '{}') into v_got from (select it ->> 'key' as key, sum((it ->> 'qty')::int)::int as qty from jsonb_array_elements(p_packages) p, jsonb_array_elements(p -> 'items') it group by 1) g;
  for ord in select o.* from orders o join wms_wave_orders x on x.order_id = o.id and x.wave_id = w.id where o.id = any (p_orders) order by o.order_number for update of o loop
    if (select pack_state from wms_wave_orders where wave_id = w.id and order_id = ord.id) <> 'pending' then raise exception 'Order % is not waiting to be packed.', ord.order_number; end if;
    if ord.status not in ('new', 'picked') then raise exception 'Order % is already %.', ord.order_number, ord.status; end if;
    select coalesce(jsonb_object_agg(g.key, g.qty), '{}') into v_want from (select coalesce(l.sku, l.name) as key, sum(l.qty)::int as qty from order_lines l where l.order_id = ord.id and l.is_physical and l.qty > 0 group by 1) g;
    if v_want <> v_got then raise exception 'The packages do not add up to order %. Every unit must be in exactly one package.', ord.order_number; end if;
    i := 0;
    for k in select * from jsonb_array_elements(p_packages) loop
      i := i + 1;
      insert into wms_packages (org_id, order_id, wave_id, seq, of_n, code, items, weight_oz, packaging, packed_by, packed_by_name)
      values (ord.org_id, ord.id, w.id, i, v_n, 'PKG-' || lpad(nextval('wms_package_no')::text, 7, '0'), k -> 'items', nullif(k ->> 'weight_oz', '')::numeric, nullif(trim(k ->> 'packaging'), ''), c.uid, c.who);
    end loop;
    update order_lines set qty_verified = qty where order_id = ord.id and is_physical and qty > 0 and qty_verified < qty;
    update orders set status = 'packed', packed_at = now() where id = ord.id;
    update wms_wave_orders set pack_state = 'packed' where wave_id = w.id and order_id = ord.id;
  end loop;
  if not found then raise exception 'Those orders are not in this wave.'; end if;
  if not exists (select 1 from wms_wave_orders where wave_id = w.id and pack_state = 'pending') then update wms_waves set status = 'done', done_at = now() where id = w.id; end if;
  return _wms_wave_json(w.id);
end $$;

-- route seed (a first guess until the real walk order is set in Nexus): shelves are nearest the pack station, then pallet positions in code order
update public.locations l set walk_seq = r.n from (select id, row_number() over (order by (kind in ('pallet', 'floor')), code)::int n from public.locations where active) r where r.id = l.id and l.walk_seq is null;
-- the demo reset must also clear the demo brand's waves
do $$ declare d text; begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'wms_demo_reset';
  if d is not null and position('delete from wms_waves' in d) = 0 then
    execute replace(d, 'delete from wms_picks where org_id = v_org;', 'delete from wms_waves where org_id = v_org; delete from wms_picks where org_id = v_org;');
  end if;
end $$;

do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('wms_orders_summary', 'wms_wave_start', 'wms_wave', 'wms_wave_confirm', 'wms_wave_unconfirm', 'wms_wave_to_pack', 'wms_wave_cancel', 'wms_wave_pack') loop
    execute format('revoke all on function %s from public, anon, service_role', f); execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
commit;
