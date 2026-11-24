-- CANDIDATE. Tested on the local synthetic database only. Not applied to shipbay-nexus-dev, not applied to production.
-- ShipBay MVP sprint, 2026-11-24: make one complete, safe order path: manual order -> WMS wave pick -> pack -> ship with tracking.
-- Needs dev_035 (ledger) and dev_036 revision 2 (order integrity).
--
-- What was broken (each reproduced on a copy of dev with dev_034..dev_036 loaded):
--   a. The portal's "Mark shipped" (labels function, action manual) always failed, twice over: it passes label source 'manual'
--      and a box name such as 'Box 8×6×4' as packaging, and the shipments table accepts neither (label sources 'client_shopify',
--      'shipbay_platform', 'other'; packaging 'mailer', 'box_single', 'box_double', 'client_supplied').
--   b. Shipping an order that was picked in the WMS took its stock off AGAIN: ship_order only looked for an earlier deduction
--      under ref_type 'order', and WMS picks are recorded as 'wave_task' or 'order_line'. 20 received, 6 picked, shipped: 8 left.
--   c. Asking to ship the same order again made a second shipment (postage billed twice).
--   d. An order never picked through a position was shipped with no stock check: on hand went to -12.
--   e. A manual order was invisible to the WMS (every WMS order screen and the wave plan take only source 'connector' orders),
--      so it could never be picked at a position.
--   f. Nothing reported what has shipped; nothing reconciled the ledger per product.
--
-- What this does (no DROP; no table, access rule or row is changed):
--   1. ship_order (REPLACED, same signature and permissions):
--        - ShipBay admin or staff only (it was any ShipBay login, sales included);
--        - takes the order row lock, so two requests for one order run one after the other;
--        - a repeat request with the same tracking number returns the first shipment and changes nothing; a different tracking
--          number on a shipped order, or a tracking number already used on another order, is refused;
--        - only a new, picked or packed order can ship (not cancelled, on hold or backordered);
--        - label source: 'manual' is recorded as 'other' and 'veeqo' as 'shipbay_platform', and the portal's box names ('Poly
--          mailer', 'Box 8×6×4') as the table's kinds ('mailer', 'box_single'; anything else as none), so the portal's paths work;
--        - stock: an order picked in the WMS must be completely picked, and nothing more is deducted (it left its positions when
--          it was picked). An order never picked is the older pack-station path: it may only take stock that has no position
--          (what the older portal receiving books), never more than is there, and never twice.
--   2. create_manual_order (REPLACED, same signature and permissions): ShipBay admin or staff only; every line must be a product
--      of that brand with a whole quantity of at least 1 (it was silently made 1); an order number already used by the brand is
--      refused; the order is made a WMS order (source 'connector', channel 'manual') so the WMS can plan, pick and pack it.
--   3. wms_stock_summary(brand): NEW, read-only. Per product: on hand, at positions, without a position, on open orders (not yet
--      picked), planned on waves being picked, picked and waiting to ship, shipped, available (on hand minus on open orders),
--      and per-product reconciliation flags. ShipBay logins, floor logins and the brand's own client only.
begin;

-- 1. ship ----------------------------------------------------------------------------------------------------------------------
create or replace function public.ship_order(p_order_id uuid, p_carrier text, p_service text, p_tracking text, p_label_source text default 'client_shopify'::text,
  p_label_cost numeric default null::numeric, p_packaging text default null::text, p_weight_oz numeric default null::numeric) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare o orders; v_ship uuid; v_track text := btrim(coalesce(p_tracking, '')); v_src text; v_pack text; v_left text; l record; v_free int; v_other text;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can mark an order shipped.'; end if;
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception 'order not found'; end if;
  if v_track = '' then raise exception 'Enter the tracking number.'; end if;
  if btrim(coalesce(p_carrier, '')) = '' then raise exception 'Enter the carrier.'; end if;
  if o.status = 'shipped' then
    select id into v_ship from shipments where order_id = o.id and upper(btrim(tracking)) = upper(v_track) order by created_at limit 1;
    if v_ship is not null then return v_ship; end if;   -- the same request again (a retry or a double click): nothing new is made
    raise exception 'Order % has already shipped (tracking %).', o.order_number, (select string_agg(tracking, ', ' order by created_at) from shipments where order_id = o.id);
  end if;
  if o.status not in ('new', 'picked', 'packed') then raise exception 'Order % is %; it cannot ship.', o.order_number, replace(o.status, '_', ' '); end if;
  select g.order_number into v_other from shipments s join orders g on g.id = s.order_id where upper(btrim(s.tracking)) = upper(v_track) and s.order_id <> o.id limit 1;
  if v_other is not null then raise exception 'Tracking % is already on order %.', v_track, v_other; end if;
  v_src := case lower(btrim(coalesce(p_label_source, ''))) when '' then 'other' when 'manual' then 'other' when 'veeqo' then 'shipbay_platform' else lower(btrim(p_label_source)) end;
  if v_src not in ('client_shopify', 'shipbay_platform', 'other') then raise exception 'Unknown label source %.', p_label_source; end if;
  -- the portal sends its box names ('Poly mailer', 'Box 8×6×4', 'Custom'); the table keeps four kinds
  v_pack := lower(btrim(coalesce(p_packaging, '')));
  v_pack := case when v_pack in ('mailer', 'box_single', 'box_double', 'client_supplied') then v_pack when v_pack like '%mailer%' then 'mailer'
                 when v_pack like 'box%' then 'box_single' when v_pack like '%client%' then 'client_supplied' else null end;

  if exists (select 1 from wms_picks k where k.order_id = o.id and k.undone_at is null) then
    -- picked in the warehouse: the stock left its positions when it was picked. Nothing more is deducted; the pick must be whole.
    select string_agg(coalesce(l2.sku, l2.name) || ' ' || coalesce(p.got, 0) || ' of ' || l2.qty, ', ' order by l2.sku) into v_left
    from order_lines l2 left join lateral (select sum(k.qty)::int got from wms_picks k where k.line_id = l2.id and k.undone_at is null) p on true
    where l2.order_id = o.id and l2.is_physical and l2.qty > 0 and l2.sku_id is not null and coalesce(p.got, 0) < l2.qty;
    if v_left is not null then raise exception 'Order % is not fully picked (% picked). Finish the pick first.', o.order_number, v_left; end if;
  elsif not exists (select 1 from inventory_moves where ref_type = 'order' and ref_id = o.id) then
    -- never picked at a position (the older pack-station path): only stock with no position can go, never more than is there
    for l in select l2.sku_id, sum(l2.qty)::int qty, min(coalesce(l2.sku, l2.name)) sku from order_lines l2
             where l2.order_id = o.id and l2.sku_id is not null and l2.is_physical and l2.qty > 0 group by l2.sku_id loop
      perform pg_advisory_xact_lock(hashtextextended('stock:' || l.sku_id::text || ':none', 0));
      select coalesce(sum(qty), 0)::int into v_free from inventory_moves where sku_id = l.sku_id and location_id is null;
      if v_free < l.qty then
        raise exception 'Order % needs % of %, and only % are on file without a position. Pick it in the WMS first.', o.order_number, l.qty, l.sku, greatest(v_free, 0);
      end if;
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, created_by) values (o.org_id, l.sku_id, -l.qty, 'pick', 'order', o.id, auth.uid());
    end loop;
  end if;

  insert into shipments (org_id, order_id, carrier, service, tracking, label_source, label_cost, postage_billed, packaging, weight_oz, created_by)
  values (o.org_id, o.id, btrim(p_carrier), nullif(btrim(coalesce(p_service, '')), ''), v_track, v_src, p_label_cost, p_label_cost, v_pack, p_weight_oz, auth.uid())
  returning id into v_ship;
  update orders set status = 'shipped', shipped_at = now() where id = o.id;
  return v_ship;
end $$;

-- 2. manual orders are WMS orders ---------------------------------------------------------------------------------------------
create or replace function public.create_manual_order(p_org_id uuid, p_order jsonb, p_lines jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_num text; l jsonb; v_sku skus%rowtype; v_units int := 0; v_qty int; v_n int := 0;
begin
  if not wms_nexus_admin() then raise exception 'Only ShipBay admin or staff can create an order here.'; end if;
  if not exists (select 1 from orgs where id = p_org_id) then raise exception 'Choose the brand.'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product.'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce(l ->> 'qty', '') !~ '^[0-9]+$' or (l ->> 'qty')::int < 1 then raise exception 'Every line needs a whole quantity of at least 1.'; end if;
    if not exists (select 1 from skus where id = nullif(l ->> 'sku_id', '')::uuid and org_id = p_org_id) then raise exception 'A product on this order is not one of this brand''s.'; end if;
    v_units := v_units + (l ->> 'qty')::int;
  end loop;
  v_num := nullif(trim(p_order ->> 'order_number'), '');
  if v_num is not null and exists (select 1 from orders where org_id = p_org_id and upper(order_number) = upper(v_num)) then
    raise exception 'Order number % is already used for this brand.', v_num;
  end if;
  v_num := coalesce(v_num, 'M-' || to_char(now(), 'YYMMDD') || '-' || lpad((floor(random() * 9000) + 1000)::text, 4, '0'));
  insert into orders (org_id, order_number, channel, source, status, customer_name, customer_email, ship_to, shipping_method, is_international, placed_at, total_units, notes, ship_by, created_by)
  values (p_org_id, v_num, 'manual', 'connector', 'new', p_order -> 'ship_to' ->> 'name', nullif(p_order ->> 'email', ''), p_order -> 'ship_to', nullif(p_order ->> 'shipping_method', ''),
          coalesce(p_order -> 'ship_to' ->> 'country_code', 'US') <> 'US', now(), v_units, nullif(p_order ->> 'notes', ''), nullif(p_order ->> 'ship_by', '')::date, auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into v_sku from skus where id = (l ->> 'sku_id')::uuid;
    insert into order_lines (order_id, sku_id, sku, name, qty, is_physical) values (v_id, v_sku.id, v_sku.sku, coalesce(v_sku.name, 'Item') || coalesce(' — ' || v_sku.variant, ''), (l ->> 'qty')::int, true);
  end loop;
  return v_id;
end $$;

-- 3. stock summary and reconciliation -------------------------------------------------------------------------------------------
create or replace function public.wms_stock_summary(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v jsonb;
begin
  if p_org is null or not (is_shipbay() or is_wms_staff() or p_org = current_org_id()) then raise exception 'This login cannot see that brand''s stock.'; end if;
  select coalesce(jsonb_agg(r order by r ->> 'sku'), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'sku_id', s.id, 'sku', s.sku, 'name', s.name,
      'on_hand', m.on_hand, 'at_positions', m.at_positions, 'without_position', m.on_hand - m.at_positions,
      'on_open_orders', oo.qty, 'planned_on_waves', wv.qty, 'picked_not_shipped', pk.qty, 'shipped', sh.qty,
      'available', m.on_hand - oo.qty,
      'received', m.received, 'adjusted', m.adjusted, 'picked_out', m.picked_out, 'transfers_net', m.transfers_net,
      'positions_below_zero', m.neg_positions,
      'reconciled', m.transfers_net = 0 and m.neg_positions = 0 and m.on_hand >= 0 and m.on_hand = m.received + m.adjusted + m.picked_out + m.transfers_net
    ) r
    from skus s
    cross join lateral (
      select coalesce(sum(x.qty), 0)::int on_hand, coalesce(sum(x.qty) filter (where x.location_id is not null), 0)::int at_positions,
        coalesce(sum(x.qty) filter (where x.reason = 'receive'), 0)::int received,
        coalesce(sum(x.qty) filter (where x.reason in ('adjust', 'cycle_count', 'damage', 'return_restock')), 0)::int adjusted,
        coalesce(sum(x.qty) filter (where x.reason = 'pick'), 0)::int picked_out,
        coalesce(sum(x.qty) filter (where x.reason = 'transfer'), 0)::int transfers_net,
        (select count(*) from (select location_id from inventory_moves y where y.sku_id = s.id and y.location_id is not null group by 1 having sum(y.qty) < 0) z)::int neg_positions
      from inventory_moves x where x.sku_id = s.id) m
    cross join lateral (select coalesce(sum(l.qty), 0)::int qty from order_lines l join orders o on o.id = l.order_id
      where l.sku_id = s.id and l.picked_at is null and o.closed_at is null and o.status in ('new', 'on_hold', 'backordered', 'picked', 'packed')) oo
    cross join lateral (select coalesce(sum(t.qty_planned), 0)::int qty from wms_wave_tasks t join wms_waves w on w.id = t.wave_id
      where t.sku_id = s.id and t.confirmed_at is null and w.status = 'picking') wv
    cross join lateral (select coalesce(sum(k.qty), 0)::int qty from wms_picks k join orders o on o.id = k.order_id
      where k.sku_id = s.id and k.undone_at is null and o.status not in ('shipped', 'cancelled')) pk
    cross join lateral (select coalesce(sum(l.qty), 0)::int qty from order_lines l join orders o on o.id = l.order_id
      where l.sku_id = s.id and l.is_physical and o.status = 'shipped') sh
    where s.org_id = p_org) q;
  return jsonb_build_object('org_id', p_org, 'at', now(), 'products', v,
    'reconciled', not exists (select 1 from jsonb_array_elements(v) e where not (e ->> 'reconciled')::boolean));
end $$;

revoke all on function public.wms_stock_summary(uuid) from public, anon, service_role;
grant execute on function public.wms_stock_summary(uuid) to authenticated;
-- ship_order and create_manual_order keep the permissions they have (replacing a function keeps them); stated again here:
revoke all on function public.ship_order(uuid, text, text, text, text, numeric, text, numeric) from public, anon;
revoke all on function public.create_manual_order(uuid, jsonb, jsonb) from public, anon;
commit;
