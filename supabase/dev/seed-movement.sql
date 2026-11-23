-- Six more synthetic pallets and one synthetic order for the hosted movement rehearsal. DEVELOPMENT DATABASE ONLY.
-- NOT APPLIED to shipbay-nexus-dev yet: applying it is a change to that database and needs Derek's go.
-- Run after seed.sql. Safe to run again: the receipts carry fixed request keys, so a second run receives nothing.
-- It refuses on a database that holds any brand other than the two synthetic ones.
-- It touches no existing pallet: PSKU-000001 (stored at P-01), PSKU-000002 and PSKU-000003 are left exactly as they are.
--   batch syn-move-1: 4 pallets of SYN-LP-002 (10 cartons x 20 = 200 units each) for Synthetic Records, against SYN-PO-1003
--   batch syn-move-2: 2 pallets of SYN-MLR-S (10 cartons x 100 = 1000 units each) for Synthetic Mailers, against SYN-PO-1002
--   order SYN-ORD-1: 40 x SYN-MLR-S for Synthetic Mailers (for the part-pick, move and reopen check)
do $seed$
declare
  o1 constant uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 constant uuid := '5a000000-0000-4000-8000-0000000000a2';
  uf constant uuid := '5b000000-0000-4000-8000-000000000002';
  s2 uuid; s3 uuid; k2 uuid; k5 uuid;   -- looked up by name: the hosted database was seeded by hand and its product and shipment ids differ from seed.sql's
  od constant uuid := '5e000000-0000-4000-8000-000000000001';
  before_rows bigint; n1 int; n2 int; guard jsonb;
begin
  if exists (select 1 from orgs where id not in (o1, o2)) then raise exception 'This database holds brands other than the two synthetic ones. Nothing was written.'; end if;
  if not exists (select 1 from orgs where id = o1) then raise exception 'Run seed.sql first. Nothing was written.'; end if;
  select id into strict s2 from inbound_shipments where reference = 'SYN-PO-1002' and org_id = o2;
  select id into strict s3 from inbound_shipments where reference = 'SYN-PO-1003' and org_id = o1;
  select id into strict k2 from skus where sku = 'SYN-LP-002' and org_id = o1;
  select id into strict k5 from skus where sku = 'SYN-MLR-S' and org_id = o2;
  select count(*) into before_rows from inventory_moves;
  select jsonb_agg(to_jsonb(p) - 'updated_at' order by p.psku) into guard from wms_pallets p where p.psku in ('PSKU-000001', 'PSKU-000002', 'PSKU-000003');

  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true);
  select count(*) into n1 from wms_receive_booking(s3, o1, jsonb_build_array(jsonb_build_object('sku', k2, 'cartons', 10, 'units_per_carton', 20)), 4, 'SYNTHETIC', 'syn-move-1', 'partial', null);
  select count(*) into n2 from wms_receive_booking(s2, o2, jsonb_build_array(jsonb_build_object('sku', k5, 'cartons', 10, 'units_per_carton', 100)), 2, 'SYNTHETIC', 'syn-move-2', 'partial', null);
  perform set_config('request.jwt.claims', '', true);

  insert into orders (id, org_id, order_number, source, status, total_units) values (od, o2, 'SYN-ORD-1', 'connector', 'new', 40) on conflict (id) do nothing;
  if not exists (select 1 from order_lines where order_id = od) then
    insert into order_lines (order_id, sku_id, sku, name, qty) values (od, k5, 'SYN-MLR-S', 'Synthetic Mailer, Small', 40);
  end if;

  if n1 <> 4 or n2 <> 2 then raise exception 'The synthetic receipt did not come out as expected (% and % pallets). Nothing was written.', n1, n2; end if;
  if (select count(*) from inventory_moves) <> before_rows then raise exception 'Receiving wrote to the stock ledger. Nothing was written.'; end if;
  if guard is distinct from (select jsonb_agg(to_jsonb(p) - 'updated_at' order by p.psku) from wms_pallets p where p.psku in ('PSKU-000001', 'PSKU-000002', 'PSKU-000003')) then
    raise exception 'An existing pallet changed. Nothing was written.';
  end if;
  raise notice 'Movement pallets ready: %', (select string_agg(psku || ' ' || status, ', ' order by psku) from wms_pallets where batch_key in ('syn-move-1', 'syn-move-2'));
end $seed$;
