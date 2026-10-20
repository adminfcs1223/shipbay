-- Ops v1: warehouse screens (Orders, Receiving, Pack & Ship).
-- Orders carry the marketplace + ship-by date Mirakl Connect tags onto Shopify orders; receiving and packing are scanner-driven
-- through scan_receive / scan_pack; labels bought through Veeqo are stored in the private `labels` bucket.

-- ===== Orders: marketplace + ship-by (from Mirakl Connect tags), source channel, pack progress =====
alter table orders add column if not exists marketplace text;
alter table orders add column if not exists ship_by date;
alter table orders add column if not exists source text;
alter table orders add column if not exists packed_at timestamptz;
alter table orders add column if not exists hold_reason text;
alter table order_lines add column if not exists qty_verified integer not null default 0;
create index if not exists orders_open_idx on orders (org_id, status, ship_by, placed_at);

-- ===== Shipments: label provider details =====
alter table shipments add column if not exists provider text;        -- veeqo | manual | client_shopify
alter table shipments add column if not exists provider_ref text;    -- veeqo remote_shipment_id
alter table shipments add column if not exists label_path text;      -- storage path in bucket labels
alter table shipments add column if not exists rate jsonb;           -- quote snapshot
alter table shipments add column if not exists tracking_url text;

-- ===== Receiving: incremental scanning =====
alter table inbound_lines add column if not exists posted boolean not null default false;
alter table inbound_lines add column if not exists location_id uuid references locations(id);
alter table inbound_lines add column if not exists created_at timestamptz not null default now();
create unique index if not exists inbound_lines_unique_sku on inbound_lines (inbound_id, sku_id);

-- find a SKU for a scanned code: barcode first, then SKU code (case-insensitive), within the org; active SKUs win ties
create or replace function find_sku_by_code(p_org_id uuid, p_code text) returns skus
language sql stable security definer set search_path = public as $$
  select * from skus where org_id = p_org_id
    and (barcode = trim(p_code) or upper(sku) = upper(trim(p_code)))
  order by active desc, (barcode = trim(p_code)) desc limit 1;
$$;

-- one scan on the receiving dock: +p_qty (or -1 to undo) against the inbound's line for that SKU
create or replace function scan_receive(p_inbound_id uuid, p_code text, p_qty integer default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_status text; s skus; l inbound_lines;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select org_id, status into v_org, v_status from inbound_shipments where id = p_inbound_id;
  if v_org is null then raise exception 'inbound not found'; end if;
  if v_status in ('received','cancelled') then raise exception 'this inbound is already closed'; end if;
  s := find_sku_by_code(v_org, p_code);
  if s.id is null then return jsonb_build_object('found', false, 'code', trim(p_code)); end if;
  insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (p_inbound_id, s.id, 0, 0)
    on conflict (inbound_id, sku_id) do nothing;
  update inbound_lines set qty_received = greatest(0, coalesce(qty_received,0) + p_qty)
    where inbound_id = p_inbound_id and sku_id = s.id returning * into l;
  if v_status = 'expected' then update inbound_shipments set status = 'in_transit' where id = p_inbound_id; end if;
  return jsonb_build_object('found', true, 'line_id', l.id, 'sku_id', s.id, 'sku', s.sku, 'name', s.name, 'variant', s.variant,
    'qty_expected', l.qty_expected, 'qty_received', l.qty_received);
end $$;

-- close out receiving: post inventory for every counted line once, flag discrepancies, tick the onboarding step
create or replace function finalize_inbound(p_inbound_id uuid, p_location_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; l record; v_disc boolean := false; v_units int := 0; v_loc uuid; v_blind boolean;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select org_id into v_org from inbound_shipments where id = p_inbound_id;
  if v_org is null then raise exception 'inbound not found'; end if;
  v_loc := coalesce(p_location_id, (select id from locations where code = 'RCV-DOCK' limit 1));
  -- a blind receipt (nothing was declared in advance) can't have a discrepancy
  v_blind := not exists (select 1 from inbound_lines where inbound_id = p_inbound_id and qty_expected > 0);
  for l in select * from inbound_lines where inbound_id = p_inbound_id loop
    if not v_blind and l.qty_received <> l.qty_expected then v_disc := true; end if;
    if not l.posted and l.qty_received > 0 then
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, created_by, location_id)
      values (v_org, l.sku_id, l.qty_received, 'receive', 'inbound', p_inbound_id, auth.uid(), coalesce(l.location_id, v_loc));
      update inbound_lines set posted = true, location_id = coalesce(location_id, v_loc) where id = l.id;
      update skus set active = true where id = l.sku_id and not active;
      v_units := v_units + l.qty_received;
    end if;
  end loop;
  update inbound_shipments set status = case when v_disc then 'discrepancy' else 'received' end, received_at = now() where id = p_inbound_id;
  update onboarding_tasks set done = true, done_at = coalesce(done_at, now()), done_by = coalesce(done_by, auth.uid())
    where org_id = v_org and key = 'inbound_received' and not done;
  return jsonb_build_object('units', v_units, 'discrepancy', v_disc);
end $$;

-- ===== Packing: scan each item to verify against the order =====
create or replace function scan_pack(p_order_id uuid, p_code text, p_qty integer default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_status text; s skus; l order_lines; v_left int;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select org_id, status into v_org, v_status from orders where id = p_order_id;
  if v_org is null then raise exception 'order not found'; end if;
  if v_status in ('shipped','cancelled') then raise exception 'this order is already %', v_status; end if;
  s := find_sku_by_code(v_org, p_code);
  if s.id is null then return jsonb_build_object('found', false, 'code', trim(p_code)); end if;
  select * into l from order_lines where order_id = p_order_id and is_physical and qty > 0
    and (sku_id = s.id or upper(sku) = upper(s.sku)) and qty_verified < qty order by qty_verified limit 1;
  if l.id is null then
    if exists (select 1 from order_lines where order_id = p_order_id and (sku_id = s.id or upper(sku) = upper(s.sku)))
      then return jsonb_build_object('found', true, 'extra', true, 'sku', s.sku, 'name', s.name, 'message', 'All units of this item are already verified.');
      else return jsonb_build_object('found', true, 'wrong_item', true, 'sku', s.sku, 'name', s.name, 'message', 'This item is not on the order.');
    end if;
  end if;
  update order_lines set qty_verified = least(qty, greatest(0, qty_verified + p_qty)) where id = l.id returning * into l;
  select count(*) into v_left from order_lines where order_id = p_order_id and is_physical and qty > 0 and qty_verified < qty;
  if v_left = 0 then update orders set status = 'packed', packed_at = now() where id = p_order_id and status in ('new','picked');
  elsif v_status = 'new' then update orders set status = 'picked' where id = p_order_id; end if;
  return jsonb_build_object('found', true, 'line_id', l.id, 'sku', s.sku, 'name', l.name, 'qty', l.qty, 'qty_verified', l.qty_verified, 'complete', v_left = 0);
end $$;

create or replace function reset_pack(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  update order_lines set qty_verified = 0 where order_id = p_order_id;
  update orders set status = 'new', packed_at = null where id = p_order_id and status in ('picked','packed');
end $$;

revoke execute on function find_sku_by_code(uuid, text) from public, anon;
grant execute on function find_sku_by_code(uuid, text) to authenticated;
revoke execute on function scan_receive(uuid, text, integer), finalize_inbound(uuid, uuid), scan_pack(uuid, text, integer), reset_pack(uuid) from public, anon;
grant execute on function scan_receive(uuid, text, integer), finalize_inbound(uuid, uuid), scan_pack(uuid, text, integer), reset_pack(uuid) to authenticated;

-- ===== Queue view for staff screens =====
create or replace view v_orders_queue with (security_invoker = true) as
select o.id, o.org_id, g.name as org_name, o.order_number, o.shopify_order_id, o.status, o.source, o.marketplace, o.ship_by, o.placed_at, o.received_at,
  o.customer_name, o.ship_to, o.shipping_method, o.is_international, o.tags, o.notes, o.hold_reason, o.packed_at, o.shipped_at,
  (select count(*) from order_lines l where l.order_id = o.id and l.is_physical and l.qty > 0) as line_count,
  (select coalesce(sum(l.qty),0) from order_lines l where l.order_id = o.id and l.is_physical) as units,
  (select coalesce(sum(l.qty_verified),0) from order_lines l where l.order_id = o.id and l.is_physical) as units_verified,
  (select s.tracking from shipments s where s.order_id = o.id order by s.created_at desc limit 1) as tracking,
  (select s.carrier from shipments s where s.order_id = o.id order by s.created_at desc limit 1) as carrier
from orders o join orgs g on g.id = o.org_id;

-- ===== Labels bucket (private; staff only, clients read their own later) =====
insert into storage.buckets (id, name, public, file_size_limit) values ('labels', 'labels', false, 10485760) on conflict (id) do nothing;
create policy "labels staff all" on storage.objects for all using (bucket_id = 'labels' and is_shipbay()) with check (bucket_id = 'labels' and is_shipbay());
