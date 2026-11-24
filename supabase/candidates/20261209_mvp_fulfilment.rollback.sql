-- ROLLBACK for 20261209_mvp_fulfilment.sql. Puts ship_order and create_manual_order back to the text they had before (dev, as of
-- dev_035; body md5: ship_order 5e1d4974, create_manual_order 1cdf8286) and closes wms_stock_summary to every login. No DROP.
-- WARNING: after this rollback the four shipping defects come back (the portal's manual ship fails; a picked order is deducted
-- twice; a repeat ship makes a second shipment; an unpicked order can drive stock below zero) and manual orders leave the WMS.
-- Orders created as WMS orders while the candidate was on stay WMS orders. Roll back only to recover.
begin;
CREATE OR REPLACE FUNCTION public.ship_order(p_order_id uuid, p_carrier text, p_service text, p_tracking text, p_label_source text DEFAULT 'client_shopify'::text, p_label_cost numeric DEFAULT NULL::numeric, p_packaging text DEFAULT NULL::text, p_weight_oz numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.create_manual_order(p_org_id uuid, p_order jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_num text; l jsonb; v_sku skus%rowtype; v_units int := 0;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  v_num := coalesce(nullif(trim(p_order->>'order_number'), ''), 'M-' || to_char(now(), 'YYMMDD') || '-' || lpad((floor(random()*9000)+1000)::text, 4, '0'));
  for l in select * from jsonb_array_elements(p_lines) loop v_units := v_units + coalesce((l->>'qty')::int, 0); end loop;
  insert into orders (org_id, order_number, channel, source, status, customer_name, customer_email, ship_to, shipping_method, is_international, placed_at, total_units, notes, ship_by, created_by)
  values (p_org_id, v_num, 'manual', 'manual', 'new', p_order->'ship_to'->>'name', nullif(p_order->>'email',''), p_order->'ship_to', nullif(p_order->>'shipping_method',''),
          coalesce(p_order->'ship_to'->>'country_code','US') <> 'US', now(), v_units, nullif(p_order->>'notes',''), nullif(p_order->>'ship_by','')::date, auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into v_sku from skus where id = (l->>'sku_id')::uuid;
    insert into order_lines (order_id, sku_id, sku, name, qty, is_physical) values (v_id, v_sku.id, v_sku.sku, coalesce(v_sku.name,'Item') || coalesce(' — ' || v_sku.variant, ''), greatest(1, coalesce((l->>'qty')::int,1)), true);
  end loop;
  return v_id;
end $function$;
revoke all on function public.wms_stock_summary(uuid) from public, anon, authenticated, service_role;
commit;
