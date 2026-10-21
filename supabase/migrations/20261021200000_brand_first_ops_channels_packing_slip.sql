-- Brand-first ops: order channels per client (Shopify / Veeqo / manual), Veeqo order intake, manual orders,
-- packing slip template step in onboarding, expected lines on inbound creation.

-- Which systems we pull a client's orders from. Steel Horse: Veeqo (Dave prefers not to connect Shopify for now).
alter table orgs add column if not exists order_channels jsonb not null default '{"shopify": true, "veeqo": false, "manual": true}'::jsonb;
alter table orgs add column if not exists packing_slip text not null default 'shipbay' check (packing_slip in ('shipbay','custom'));
update orgs set order_channels = '{"shopify": false, "veeqo": true, "manual": true}'::jsonb where id = 'a1b2c3d4-0000-4000-8000-000000000001';

-- Orders from Veeqo and orders keyed in by hand
alter table orders add column if not exists veeqo_order_id bigint;
create unique index if not exists orders_org_veeqo_idx on orders (org_id, veeqo_order_id) where veeqo_order_id is not null;
alter table orders add column if not exists created_by uuid references profiles(id);
alter table order_lines add column if not exists veeqo_line_id bigint;

-- Onboarding: packing slip template (upload theirs, or use ShipBay's)
-- (packing-slip uploads are stored with documents.kind = 'other'; the task key carries the meaning)
insert into onboarding_tasks (org_id, key, label, phase, sort, kind, optional, accept)
select id, 'packing_slip', 'Packing slip template', 'inventory', 245, 'document', true, 'pdf,doc,image' from orgs
on conflict (org_id, key) do nothing;

create or replace function ensure_onboarding(p_org_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into onboarding_tasks (org_id, key, label, phase, sort, kind, optional, accept) values
    (p_org_id, 'intake_form',      'Intake form',                            'paperwork', 10, 'document', false, null),
    (p_org_id, 'w9',               'W-9',                                    'paperwork', 20, 'document', false, null),
    (p_org_id, 'formation_cert',   'Formation Certificate',                  'paperwork', 30, 'document', false, null),
    (p_org_id, 'rate_card',        'Rate Card Signed',                       'paperwork', 40, 'document', false, null),
    (p_org_id, 'agreement',        'Account Agreement',                      'paperwork', 50, 'document', false, null),
    (p_org_id, 'sla',              'SLA',                                    'paperwork', 60, 'document', false, null),
    (p_org_id, 'billing_method',   'Billing method',                         'paperwork', 70, 'billing',  false, null),
    (p_org_id, 'additional_docs',  'Additional documents',                   'paperwork', 80, 'document', true,  null),
    (p_org_id, 'portal_login',     'Client Portal',                          'systems',   100, 'portal',      false, null),
    (p_org_id, 'label_access',     'Shipping Label Access',                  'systems',   110, 'integration', false, null),
    (p_org_id, 'shopify_connected','Commerce Channel Access',                'systems',   120, 'integration', false, null),
    (p_org_id, 'sku_catalog',      'SKU Catalog',                            'inventory', 210, 'catalog',  false, null),
    (p_org_id, 'packaging_spec',   'Packaging spec',                         'inventory', 220, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'returns_rules',    'Returns / exchange rules',               'inventory', 230, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'packing_sops',     'Packing methods & general SOPs',         'inventory', 240, 'document', false, 'pdf,doc,image'),
    (p_org_id, 'packing_slip',     'Packing slip template',                  'inventory', 245, 'document', true,  'pdf,doc,image'),
    (p_org_id, 'inbound_scheduled','Initial inbound transfer',               'inventory', 250, 'schedule', false, null),
    (p_org_id, 'inbound_received', 'Initial inventory received & counted',   'inventory', 260, 'manual',   false, null),
    (p_org_id, 'test_orders',      'Test orders shipped end to end',         'go_live',   310, 'manual', false, null),
    (p_org_id, 'go_live_date',     'Go-live date set',                       'go_live',   320, 'manual', false, null),
    (p_org_id, 'go_live',          'Live — first real orders shipped',       'go_live',   330, 'manual', false, null)
  on conflict (org_id, key) do nothing;
$$;

-- Queue view carries the channel + tracking url so the overview and the client's Orders page can show them
create or replace view v_orders_queue with (security_invoker = true) as
select o.id, o.org_id, g.name as org_name, o.order_number, o.shopify_order_id, o.status, o.source, o.marketplace, o.ship_by, o.placed_at, o.received_at,
  o.customer_name, o.ship_to, o.shipping_method, o.is_international, o.tags, o.notes, o.hold_reason, o.packed_at, o.shipped_at,
  (select count(*) from order_lines l where l.order_id = o.id and l.is_physical and l.qty > 0) as line_count,
  (select coalesce(sum(l.qty),0) from order_lines l where l.order_id = o.id and l.is_physical) as units,
  (select coalesce(sum(l.qty_verified),0) from order_lines l where l.order_id = o.id and l.is_physical) as units_verified,
  (select s.tracking from shipments s where s.order_id = o.id order by s.created_at desc limit 1) as tracking,
  (select s.carrier from shipments s where s.order_id = o.id order by s.created_at desc limit 1) as carrier,
  o.veeqo_order_id, o.channel,
  (select s.tracking_url from shipments s where s.order_id = o.id order by s.created_at desc limit 1) as tracking_url
from orders o join orgs g on g.id = o.org_id;

-- Manual order (keyed in at the station or on the Orders page). Staff only. Returns the order id.
create or replace function create_manual_order(p_org_id uuid, p_order jsonb, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
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
end $$;

-- Receiving by SKU: a scan must match the SKU the receiver chose; unknown codes are reported, mismatches refused.
create or replace function scan_receive_sku(p_inbound_id uuid, p_sku_id uuid, p_code text, p_qty int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inb inbound_shipments%rowtype; v_sku skus%rowtype; v_match skus%rowtype; v_line inbound_lines%rowtype;
begin
  if not is_shipbay() then raise exception 'not authorized'; end if;
  select * into v_inb from inbound_shipments where id = p_inbound_id;
  if v_inb.id is null then raise exception 'inbound not found'; end if;
  if v_inb.status in ('received','cancelled') then raise exception 'this inbound is already finalized'; end if;
  select * into v_sku from skus where id = p_sku_id and org_id = v_inb.org_id;
  if v_sku.id is null then raise exception 'SKU not found for this client'; end if;
  -- what did they scan?
  select * into v_match from skus where org_id = v_inb.org_id and (barcode = p_code or sku = p_code or lower(sku) = lower(p_code)) limit 1;
  if v_match.id is null then
    return jsonb_build_object('found', false, 'code', p_code);
  end if;
  if v_match.id <> v_sku.id then
    return jsonb_build_object('found', true, 'wrong_item', true, 'sku', v_match.sku, 'name', v_match.name, 'expected_sku', v_sku.sku);
  end if;
  insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (p_inbound_id, v_sku.id, 0, greatest(0, p_qty))
  on conflict (inbound_id, sku_id) do update set qty_received = greatest(0, inbound_lines.qty_received + p_qty)
  returning * into v_line;
  if v_inb.status = 'expected' then update inbound_shipments set status = 'in_transit' where id = p_inbound_id; end if;
  return jsonb_build_object('found', true, 'wrong_item', false, 'sku', v_sku.sku, 'name', v_sku.name, 'variant', v_sku.variant, 'qty_received', v_line.qty_received, 'qty_expected', v_line.qty_expected);
end $$;
