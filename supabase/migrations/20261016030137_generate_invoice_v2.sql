alter table invoice_lines add column if not exists active boolean not null default true;
create index if not exists invoice_lines_active_idx on invoice_lines(invoice_id) where active;

create or replace function generate_invoice(p_org_id uuid, p_period date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rc rate_cards%rowtype; v_start date := date_trunc('month', p_period)::date; v_end date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_inv uuid; v_num text; v_orders int; v_addl int; v_mailers int; v_box1 int; v_box2 int; v_postage numeric; v_intl int;
  v_pallets int; v_cartons int; v_waived int; v_returns int; ss storage_snapshots%rowtype; v_sub numeric := 0; v_min numeric := 0; v_sort int := 0;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into rc from rate_cards where org_id = p_org_id and effective_from <= v_end and (effective_to is null or effective_to >= v_start)
    order by effective_from desc limit 1;
  if rc.id is null then raise exception 'no rate card for org'; end if;

  select count(*), coalesce(sum(greatest(o.total_units - 1, 0)),0), coalesce(sum(case when o.is_international then 1 else 0 end),0)
    into v_orders, v_addl, v_intl
    from orders o where o.org_id = p_org_id and o.status = 'shipped' and (o.shipped_at at time zone 'America/New_York')::date between v_start and v_end;
  select coalesce(sum(case when packaging='mailer' then 1 else 0 end),0), coalesce(sum(case when packaging='box_single' then 1 else 0 end),0),
         coalesce(sum(case when packaging='box_double' then 1 else 0 end),0),
         coalesce(sum(case when label_source='shipbay_platform' then coalesce(postage_billed, label_cost, 0) else 0 end),0)
    into v_mailers, v_box1, v_box2, v_postage
    from shipments where org_id = p_org_id and (shipped_at at time zone 'America/New_York')::date between v_start and v_end;
  select coalesce(sum(case when receiving_waived then 0 else pallets end),0), coalesce(sum(case when receiving_waived then 0 else cartons end),0), coalesce(sum(case when receiving_waived then 1 else 0 end),0)
    into v_pallets, v_cartons, v_waived
    from inbound_shipments where org_id = p_org_id and status in ('received','discrepancy') and (received_at at time zone 'America/New_York')::date between v_start and v_end;
  select count(*) into v_returns from returns where org_id = p_org_id and (received_at at time zone 'America/New_York')::date between v_start and v_end;
  select * into ss from storage_snapshots where org_id = p_org_id and period = v_start;

  v_num := 'SB-' || to_char(v_start,'YYYYMM') || '-' || upper(left(replace(p_org_id::text,'-',''),6));
  select id into v_inv from invoices where invoice_number = v_num;
  if v_inv is null then
    insert into invoices (org_id, invoice_number, period_start, period_end, status, due_at)
    values (p_org_id, v_num, v_start, v_end, 'draft', v_end + 15) returning id into v_inv;
  elsif exists (select 1 from invoices where id = v_inv and status <> 'draft') then
    raise exception 'invoice % is not a draft', v_num;
  end if;
  -- supersede prior draft lines (kept for audit)
  update invoice_lines set active = false where invoice_id = v_inv and active;

  if v_orders > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'pick_pack', 'Pick & pack — first unit', v_orders, rc.pick_pack_first, round(v_orders*rc.pick_pack_first,2), v_sort); v_sub := v_sub + round(v_orders*rc.pick_pack_first,2); end if;
  if v_addl > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'additional_units', 'Additional units', v_addl, rc.pick_pack_addl, round(v_addl*rc.pick_pack_addl,2), v_sort); v_sub := v_sub + round(v_addl*rc.pick_pack_addl,2); end if;
  if v_mailers > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'packaging', 'Poly mailers', v_mailers, rc.packaging_mailer, round(v_mailers*rc.packaging_mailer,2), v_sort); v_sub := v_sub + round(v_mailers*rc.packaging_mailer,2); end if;
  if v_box1 > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'packaging', 'Shipper boxes (single)', v_box1, rc.packaging_box_single, round(v_box1*rc.packaging_box_single,2), v_sort); v_sub := v_sub + round(v_box1*rc.packaging_box_single,2); end if;
  if v_box2 > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'packaging', 'Shipper boxes (double)', v_box2, rc.packaging_box_double, round(v_box2*rc.packaging_box_double,2), v_sort); v_sub := v_sub + round(v_box2*rc.packaging_box_double,2); end if;
  if v_postage > 0 then
    v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'postage', 'Postage (ShipBay labels, at cost' || case when rc.postage_markup_pct>0 then ' +'||rc.postage_markup_pct||'%' else '' end || ')', 1, round(v_postage*(1+rc.postage_markup_pct/100),2), round(v_postage*(1+rc.postage_markup_pct/100),2), v_sort);
    v_sub := v_sub + round(v_postage*(1+rc.postage_markup_pct/100),2);
  end if;
  if v_intl > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'international', 'International handling', v_intl, rc.intl_surcharge, round(v_intl*rc.intl_surcharge,2), v_sort); v_sub := v_sub + round(v_intl*rc.intl_surcharge,2); end if;
  if ss.id is not null then
    if rc.storage_waived_until is not null and rc.storage_waived_until >= v_end then
      v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'storage', format('Storage — %s pallets, %s shelves, %s bins (waived through %s)', ss.pallets, ss.shelves, ss.bins, to_char(rc.storage_waived_until,'Mon DD, YYYY')), 1, 0, 0, v_sort);
    else
      if ss.pallets > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'storage', 'Storage — pallets', ss.pallets, rc.storage_pallet, round(ss.pallets*rc.storage_pallet,2), v_sort); v_sub := v_sub + round(ss.pallets*rc.storage_pallet,2); end if;
      if ss.shelves > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'storage', 'Storage — shelves', ss.shelves, rc.storage_shelf, round(ss.shelves*rc.storage_shelf,2), v_sort); v_sub := v_sub + round(ss.shelves*rc.storage_shelf,2); end if;
      if ss.bins > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'storage', 'Storage — bins', ss.bins, rc.storage_bin, round(ss.bins*rc.storage_bin,2), v_sort); v_sub := v_sub + round(ss.bins*rc.storage_bin,2); end if;
    end if;
  end if;
  if v_pallets > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'receiving', 'Receiving — pallets', v_pallets, rc.receiving_pallet, round(v_pallets*rc.receiving_pallet,2), v_sort); v_sub := v_sub + round(v_pallets*rc.receiving_pallet,2); end if;
  if v_cartons > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'receiving', 'Receiving — cartons', v_cartons, rc.receiving_carton, round(v_cartons*rc.receiving_carton,2), v_sort); v_sub := v_sub + round(v_cartons*rc.receiving_carton,2); end if;
  if v_waived > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'receiving', format('Receiving — %s inbound shipment(s) waived per agreement', v_waived), 1, 0, 0, v_sort); end if;
  if v_returns > 0 then v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'returns', 'Returns processing', v_returns, rc.returns_fee, round(v_returns*rc.returns_fee,2), v_sort); v_sub := v_sub + round(v_returns*rc.returns_fee,2); end if;

  if (rc.minimum_waived_until is null or rc.minimum_waived_until < v_end) and v_sub - coalesce(v_postage,0) < rc.monthly_minimum then
    v_min := rc.monthly_minimum - (v_sub - coalesce(v_postage,0));
    v_sort := v_sort+1; insert into invoice_lines (id, invoice_id, category, description, qty, unit_price, amount, sort) values (gen_random_uuid(), v_inv, 'minimum', 'Monthly minimum adjustment', 1, v_min, round(v_min,2), v_sort);
    v_sub := v_sub + round(v_min,2);
  end if;

  update invoices set subtotal = v_sub, total = v_sub where id = v_inv;
  return v_inv;
end $$;
