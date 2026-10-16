-- Inventory levels view
create or replace view inventory_levels with (security_invoker = true) as
select
  s.id as sku_id, s.org_id, s.sku, s.name, s.variant, s.packaging, s.low_stock_threshold, s.active, s.is_physical,
  coalesce((select sum(m.qty) from inventory_moves m where m.sku_id = s.id), 0)::int as on_hand,
  coalesce((select sum(ol.qty) from order_lines ol join orders o on o.id = ol.order_id
            where ol.sku_id = s.id and o.status in ('new','on_hold','backordered','picked','packed')), 0)::int as reserved
from skus s;

-- Set cutoff_at on new orders: same day at org cutoff if placed before it (local), else next ship day
create or replace function set_order_cutoff() returns trigger language plpgsql as $$
declare
  o orgs%rowtype;
  local_placed timestamp;
  ship_day date;
  dow int;
begin
  select * into o from orgs where id = new.org_id;
  local_placed := (new.received_at at time zone o.timezone);
  ship_day := local_placed::date;
  if local_placed::time > o.cutoff_time then ship_day := ship_day + 1; end if;
  loop
    dow := extract(isodow from ship_day);
    exit when dow <= 5 or (dow = 6 and o.ships_saturday);
    ship_day := ship_day + 1;
  end loop;
  new.cutoff_at := (ship_day + o.cutoff_time) at time zone o.timezone;
  return new;
end $$;
drop trigger if exists orders_set_cutoff on orders;
create trigger orders_set_cutoff before insert on orders for each row
  when (new.cutoff_at is null) execute function set_order_cutoff();

-- Ship an order: record shipment, deduct inventory, mark shipped
create or replace function ship_order(
  p_order_id uuid, p_carrier text, p_service text, p_tracking text,
  p_label_source text default 'client_shopify', p_label_cost numeric default null,
  p_packaging text default null, p_weight_oz numeric default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_ship uuid; l record;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select org_id into v_org from orders where id = p_order_id;
  if v_org is null then raise exception 'order not found'; end if;
  insert into shipments (org_id, order_id, carrier, service, tracking, label_source, label_cost, postage_billed, packaging, weight_oz, created_by)
  values (v_org, p_order_id, p_carrier, p_service, p_tracking, p_label_source, p_label_cost, p_label_cost, p_packaging, p_weight_oz, auth.uid())
  returning id into v_ship;
  -- deduct inventory once (only if no prior pick move for this order)
  if not exists (select 1 from inventory_moves where ref_type = 'order' and ref_id = p_order_id) then
    for l in select sku_id, qty from order_lines where order_id = p_order_id and sku_id is not null and is_physical loop
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, created_by)
      values (v_org, l.sku_id, -l.qty, 'pick', 'order', p_order_id, auth.uid());
    end loop;
  end if;
  update orders set status = 'shipped', shipped_at = now() where id = p_order_id;
  return v_ship;
end $$;

-- Receive an inbound: counts per line -> inventory moves, status received/discrepancy
create or replace function receive_inbound(p_inbound_id uuid, p_counts jsonb)  -- [{"line_id":..,"qty_received":..}]
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid; c jsonb; v_line inbound_lines%rowtype; v_disc boolean := false;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select org_id into v_org from inbound_shipments where id = p_inbound_id;
  for c in select * from jsonb_array_elements(p_counts) loop
    update inbound_lines set qty_received = (c->>'qty_received')::int where id = (c->>'line_id')::uuid returning * into v_line;
    if v_line.qty_received <> v_line.qty_expected then v_disc := true; end if;
    if v_line.qty_received > 0 then
      insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, created_by)
      values (v_org, v_line.sku_id, v_line.qty_received, 'receive', 'inbound', p_inbound_id, auth.uid());
    end if;
  end loop;
  update inbound_shipments set status = case when v_disc then 'discrepancy' else 'received' end, received_at = now()
  where id = p_inbound_id;
end $$;

-- Generate (or regenerate) a draft invoice for an org and month from the active rate card
create or replace function generate_invoice(p_org_id uuid, p_period date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rc rate_cards%rowtype; v_start date := date_trunc('month', p_period)::date; v_end date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_inv uuid; v_num text; v_orders int; v_addl int; v_mailers int; v_box1 int; v_box2 int; v_postage numeric; v_intl int;
  v_pallets int; v_cartons int; v_returns int; ss storage_snapshots%rowtype; v_sub numeric := 0; v_min numeric := 0; v_sort int := 0;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into rc from rate_cards where org_id = p_org_id and effective_from <= v_end and (effective_to is null or effective_to >= v_start)
    order by effective_from desc limit 1;
  if rc.id is null then raise exception 'no rate card for org'; end if;

  -- metrics from shipped orders in period
  select count(*), coalesce(sum(greatest(o.total_units - 1, 0)),0), coalesce(sum(case when o.is_international then 1 else 0 end),0)
    into v_orders, v_addl, v_intl
    from orders o where o.org_id = p_org_id and o.status = 'shipped' and o.shipped_at::date between v_start and v_end;
  select coalesce(sum(case when packaging='mailer' then 1 else 0 end),0), coalesce(sum(case when packaging='box_single' then 1 else 0 end),0),
         coalesce(sum(case when packaging='box_double' then 1 else 0 end),0),
         coalesce(sum(case when label_source='shipbay_platform' then coalesce(postage_billed, label_cost, 0) else 0 end),0)
    into v_mailers, v_box1, v_box2, v_postage
    from shipments where org_id = p_org_id and shipped_at::date between v_start and v_end;
  select coalesce(sum(pallets),0), coalesce(sum(cartons),0) into v_pallets, v_cartons
    from inbound_shipments where org_id = p_org_id and status in ('received','discrepancy') and received_at::date between v_start and v_end;
  select count(*) into v_returns from returns where org_id = p_org_id and received_at::date between v_start and v_end;
  select * into ss from storage_snapshots where org_id = p_org_id and period = v_start;

  -- upsert invoice header
  v_num := 'SB-' || to_char(v_start,'YYYYMM') || '-' || upper(left(replace(p_org_id::text,'-',''),6));
  select id into v_inv from invoices where invoice_number = v_num;
  if v_inv is null then
    insert into invoices (org_id, invoice_number, period_start, period_end, status, due_at)
    values (p_org_id, v_num, v_start, v_end, 'draft', v_end + 15) returning id into v_inv;
  elsif exists (select 1 from invoices where id = v_inv and status <> 'draft') then
    raise exception 'invoice % is not a draft', v_num;
  end if;
  delete from invoice_lines where invoice_id = v_inv;

  -- lines
  if v_orders > 0 then
    v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'pick_pack', 'Pick & pack — first unit', v_orders, rc.pick_pack_first, round(v_orders*rc.pick_pack_first,2), v_sort);
    v_sub := v_sub + round(v_orders*rc.pick_pack_first,2);
  end if;
  if v_addl > 0 then
    v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'additional_units', 'Additional units', v_addl, rc.pick_pack_addl, round(v_addl*rc.pick_pack_addl,2), v_sort);
    v_sub := v_sub + round(v_addl*rc.pick_pack_addl,2);
  end if;
  if v_mailers > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'packaging', 'Poly mailers', v_mailers, rc.packaging_mailer, round(v_mailers*rc.packaging_mailer,2), v_sort); v_sub := v_sub + round(v_mailers*rc.packaging_mailer,2); end if;
  if v_box1 > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'packaging', 'Shipper boxes (single)', v_box1, rc.packaging_box_single, round(v_box1*rc.packaging_box_single,2), v_sort); v_sub := v_sub + round(v_box1*rc.packaging_box_single,2); end if;
  if v_box2 > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'packaging', 'Shipper boxes (double)', v_box2, rc.packaging_box_double, round(v_box2*rc.packaging_box_double,2), v_sort); v_sub := v_sub + round(v_box2*rc.packaging_box_double,2); end if;
  if v_postage > 0 then
    v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'postage', 'Postage (ShipBay labels, at cost' || case when rc.postage_markup_pct>0 then ' +'||rc.postage_markup_pct||'%' else '' end || ')', 1, round(v_postage*(1+rc.postage_markup_pct/100),2), round(v_postage*(1+rc.postage_markup_pct/100),2), v_sort);
    v_sub := v_sub + round(v_postage*(1+rc.postage_markup_pct/100),2);
  end if;
  if v_intl > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'international', 'International handling', v_intl, rc.intl_surcharge, round(v_intl*rc.intl_surcharge,2), v_sort); v_sub := v_sub + round(v_intl*rc.intl_surcharge,2); end if;
  if ss.id is not null then
    if rc.storage_waived_until is not null and rc.storage_waived_until >= v_end then
      v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'storage', format('Storage — %s pallets, %s shelves, %s bins (waived through %s)', ss.pallets, ss.shelves, ss.bins, rc.storage_waived_until), 1, 0, 0, v_sort);
    else
      if ss.pallets > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'storage', 'Storage — pallets', ss.pallets, rc.storage_pallet, round(ss.pallets*rc.storage_pallet,2), v_sort); v_sub := v_sub + round(ss.pallets*rc.storage_pallet,2); end if;
      if ss.shelves > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'storage', 'Storage — shelves', ss.shelves, rc.storage_shelf, round(ss.shelves*rc.storage_shelf,2), v_sort); v_sub := v_sub + round(ss.shelves*rc.storage_shelf,2); end if;
      if ss.bins > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'storage', 'Storage — bins', ss.bins, rc.storage_bin, round(ss.bins*rc.storage_bin,2), v_sort); v_sub := v_sub + round(ss.bins*rc.storage_bin,2); end if;
    end if;
  end if;
  if v_pallets > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'receiving', 'Receiving — pallets', v_pallets, rc.receiving_pallet, round(v_pallets*rc.receiving_pallet,2), v_sort); v_sub := v_sub + round(v_pallets*rc.receiving_pallet,2); end if;
  if v_cartons > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'receiving', 'Receiving — cartons', v_cartons, rc.receiving_carton, round(v_cartons*rc.receiving_carton,2), v_sort); v_sub := v_sub + round(v_cartons*rc.receiving_carton,2); end if;
  if v_returns > 0 then v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'returns', 'Returns processing', v_returns, rc.returns_fee, round(v_returns*rc.returns_fee,2), v_sort); v_sub := v_sub + round(v_returns*rc.returns_fee,2); end if;

  -- monthly minimum top-up (storage + postage excluded from the minimum test is a common rule; here: fulfillment services only)
  if (rc.minimum_waived_until is null or rc.minimum_waived_until < v_end) and v_sub - coalesce(v_postage,0) < rc.monthly_minimum then
    v_min := rc.monthly_minimum - (v_sub - coalesce(v_postage,0));
    v_sort := v_sort+1; insert into invoice_lines values (gen_random_uuid(), v_inv, 'minimum', 'Monthly minimum adjustment', 1, v_min, round(v_min,2), v_sort);
    v_sub := v_sub + round(v_min,2);
  end if;

  update invoices set subtotal = v_sub, total = v_sub where id = v_inv;
  return v_inv;
end $$;

-- ===================== RLS =====================
alter table orgs enable row level security;
alter table profiles enable row level security;
alter table rate_cards enable row level security;
alter table skus enable row level security;
alter table inventory_moves enable row level security;
alter table inbound_shipments enable row level security;
alter table inbound_lines enable row level security;
alter table orders enable row level security;
alter table order_lines enable row level security;
alter table shipments enable row level security;
alter table returns enable row level security;
alter table tickets enable row level security;
alter table ticket_messages enable row level security;
alter table storage_snapshots enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;

-- ShipBay staff: everything
create policy shipbay_all_orgs on orgs for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_profiles on profiles for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_rate_cards on rate_cards for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_skus on skus for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_moves on inventory_moves for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_inbound on inbound_shipments for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_inbound_lines on inbound_lines for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_orders on orders for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_order_lines on order_lines for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_shipments on shipments for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_returns on returns for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_tickets on tickets for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_ticket_messages on ticket_messages for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_storage on storage_snapshots for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_invoices on invoices for all using (is_shipbay()) with check (is_shipbay());
create policy shipbay_all_invoice_lines on invoice_lines for all using (is_shipbay()) with check (is_shipbay());

-- Clients: read their own org
create policy client_read_org on orgs for select using (id = current_org_id());
create policy own_profile on profiles for select using (id = auth.uid() or org_id = current_org_id());
create policy own_profile_update on profiles for update using (id = auth.uid()) with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()) and org_id is not distinct from (select org_id from profiles where id = auth.uid()));
create policy client_read_rate_cards on rate_cards for select using (org_id = current_org_id());
create policy client_read_skus on skus for select using (org_id = current_org_id());
create policy client_write_skus on skus for insert with check (org_id = current_org_id());
create policy client_update_skus on skus for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy client_read_moves on inventory_moves for select using (org_id = current_org_id());
create policy client_read_inbound on inbound_shipments for select using (org_id = current_org_id());
create policy client_create_inbound on inbound_shipments for insert with check (org_id = current_org_id());
create policy client_update_inbound on inbound_shipments for update using (org_id = current_org_id() and status in ('expected','in_transit')) with check (org_id = current_org_id());
create policy client_read_inbound_lines on inbound_lines for select using (exists (select 1 from inbound_shipments i where i.id = inbound_id and i.org_id = current_org_id()));
create policy client_write_inbound_lines on inbound_lines for insert with check (exists (select 1 from inbound_shipments i where i.id = inbound_id and i.org_id = current_org_id() and i.status in ('expected','in_transit')));
create policy client_update_inbound_lines on inbound_lines for update using (exists (select 1 from inbound_shipments i where i.id = inbound_id and i.org_id = current_org_id() and i.status in ('expected','in_transit')));
create policy client_delete_inbound_lines on inbound_lines for delete using (exists (select 1 from inbound_shipments i where i.id = inbound_id and i.org_id = current_org_id() and i.status in ('expected','in_transit')));
create policy client_read_orders on orders for select using (org_id = current_org_id());
create policy client_hold_orders on orders for update using (org_id = current_org_id() and status in ('new','on_hold')) with check (org_id = current_org_id() and status in ('new','on_hold','cancelled'));
create policy client_read_order_lines on order_lines for select using (exists (select 1 from orders o where o.id = order_id and o.org_id = current_org_id()));
create policy client_read_shipments on shipments for select using (org_id = current_org_id());
create policy client_read_returns on returns for select using (org_id = current_org_id());
create policy client_create_returns on returns for insert with check (org_id = current_org_id());
create policy client_read_tickets on tickets for select using (org_id = current_org_id());
create policy client_create_tickets on tickets for insert with check (org_id = current_org_id());
create policy client_update_tickets on tickets for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy client_read_messages on ticket_messages for select using (org_id = current_org_id() and internal = false);
create policy client_create_messages on ticket_messages for insert with check (org_id = current_org_id() and internal = false and author_id = auth.uid());
create policy client_read_storage on storage_snapshots for select using (org_id = current_org_id());
create policy client_read_invoices on invoices for select using (org_id = current_org_id() and status <> 'draft');
create policy client_read_invoice_lines on invoice_lines for select using (exists (select 1 from invoices i where i.id = invoice_id and i.org_id = current_org_id() and i.status <> 'draft'));

grant select on inventory_levels to authenticated;
