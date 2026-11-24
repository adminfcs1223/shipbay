-- The owner's end-to-end MVP flow on shipbay-nexus-dev, as the screens call it (dev_040 installed), run as the synthetic logins
-- inside one transaction that is ALWAYS rolled back (it ends by raising). A pass ends with: ROLLBACK-OK <n> checks.
-- Receive 30 (3 cartons of 10) -> scan -> count -> SB-01 -> put away -> three manual orders of 12 -> wave: two orders, the third
-- short -> pick 24 -> pack -> ship both (manual tracking, ship_order), repeat -> 6 left; plus the position rules and isolation.
do $t$
declare
  a uuid := '5a000000-0000-4000-8000-0000000000a1'; b uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  k uuid; kb uuid; pa wms_pallets; pb wms_pallets; j jsonb; w uuid; t record; o1 uuid; o2 uuid; o3 uuid; s1 uuid; s1b uuid; s2 uuid; s jsonb; n int; msg text; ok text[] := '{}';
  sb1 uuid; sb2 uuid; p10 uuid;
begin
  if exists (select 1 from orgs where id not in (a, b) and name <> 'Demo Brand') then raise exception 'FAIL 0: not the synthetic development database'; end if;
  select id into sb1 from locations where code = 'SB-01'; select id into sb2 from locations where code = 'SB-02'; select id into p10 from locations where code = 'P-10';
  if sb1 is null or exists (select 1 from wms_pallets where location_id in (select id from locations where code ~ '^SB-')) then raise exception 'FAIL 0: SB positions missing or in use'; end if;
  -- products (admin, row security)
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  insert into skus (org_id, sku, name, barcode) values (a, 'FLOW-A', 'Flow check product A', 'FLOW-A-BC') returning id into k;
  insert into skus (org_id, sku, name, barcode) values (b, 'FLOW-B', 'Flow check product B', 'FLOW-B-BC') returning id into kb;
  -- 1. receive 30 as 3 cartons of 10, scan, count
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true);
  select * into pa from wms_receive(a, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 3, 'units_per_carton', 10)), 1, 'flow check', 'flow-check-a');
  select * into pb from wms_receive(b, jsonb_build_array(jsonb_build_object('sku', kb, 'cartons', 1, 'units_per_carton', 10)), 1, 'flow check', 'flow-check-b');
  perform set_config('role', 'postgres', true);
  for t in select code from wms_cartons where pallet_id in (pa.id, pb.id) loop perform set_config('role', 'authenticated', true); perform wms_scan_carton(t.code); perform set_config('role', 'postgres', true); end loop;
  perform set_config('role', 'authenticated', true);
  perform wms_complete_count(pa.id); perform wms_complete_count(pb.id);
  -- 2. position rules: shared refused, SB accepted, SB-01 taken refused
  begin perform wms_assign_location(pa.id, p10); raise exception 'FAIL 2: a shared position was accepted'; exception when others then msg := sqlerrm; if msg like 'FAIL%' then raise; end if; if msg not like '%shared Nexus position%' then raise exception 'FAIL 2: %', msg; end if; end;
  perform wms_assign_location(pa.id, sb1);
  begin perform wms_assign_location(pb.id, sb1); raise exception 'FAIL 2: two pallets at SB-01'; exception when others then msg := sqlerrm; if msg like 'FAIL%' then raise; end if; if msg not like '%already has a pallet%' then raise exception 'FAIL 2b: %', msg; end if; end;
  perform wms_assign_location(pb.id, sb2);
  perform wms_putaway(pa.id, pa.psku, 'SB-01'); perform wms_putaway(pb.id, pb.psku, 'SB-02');
  begin perform wms_putaway_begin(pa.psku, 'SB-03'); raise exception 'FAIL 2: the Nexus journal accepted an SB position'; exception when others then msg := sqlerrm; if msg like 'FAIL%' then raise; end if; end;
  perform set_config('role', 'postgres', true);
  ok := ok || ('positions: P-10 refused (shared, Nexus only), SB-01 accepted, a second pallet at SB-01 refused, the Nexus journal refuses SB-03')::text;
  if (select sum(qty) from inventory_moves where sku_id = k and location_id = sb1) <> 30 or (select count(*) from inventory_moves where sku_id = k) <> 1 then raise exception 'FAIL 3: receipt not booked once at SB-01'; end if;
  ok := ok || ('receive 30 as 3 cartons, scanned, counted, put away at SB-01: 30 booked once at SB-01 (no Nexus)')::text;
  -- 3. three manual orders of 12 (admin)
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  o1 := create_manual_order(a, '{"order_number":"FLOW-1","ship_to":{"name":"One","country_code":"US"}}', jsonb_build_array(jsonb_build_object('sku_id', k, 'qty', 12)));
  o2 := create_manual_order(a, '{"order_number":"FLOW-2","ship_to":{"name":"Two","country_code":"US"}}', jsonb_build_array(jsonb_build_object('sku_id', k, 'qty', 12)));
  o3 := create_manual_order(a, '{"order_number":"FLOW-3","ship_to":{"name":"Three","country_code":"US"}}', jsonb_build_array(jsonb_build_object('sku_id', k, 'qty', 12)));
  -- 4. wave: two orders, third short; pick 24
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true);
  j := wms_wave_start(a); w := (j -> 'wave' ->> 'id')::uuid;
  if w is null or (select count(*) from jsonb_array_elements(j -> 'wave' -> 'orders')) <> 2 or not (j -> 'short') @> '[{"order_number":"FLOW-3"}]' then raise exception 'FAIL 4: wave %', left(j::text, 300); end if;
  for t in select x ->> 'id' id, (x ->> 'qty_planned')::int q, x ->> 'location' loc from jsonb_array_elements(j -> 'wave' -> 'tasks') x loop
    if t.loc <> 'SB-01' then raise exception 'FAIL 4: a stop at %', t.loc; end if;
    perform wms_wave_confirm(t.id::uuid, t.q, 'FLOW-A-BC');
  end loop;
  j := wms_wave_to_pack(w);
  perform wms_wave_pack(w, array[o1], '[{"items":[{"key":"FLOW-A","qty":12}],"weight_oz":16,"packaging":"box"}]');
  perform wms_wave_pack(w, array[o2], '[{"items":[{"key":"FLOW-A","qty":12}],"weight_oz":16,"packaging":"box"}]');
  perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves where sku_id = k) <> 6 or (select array_agg(status order by order_number) from orders where id in (o1, o2, o3)) <> array['packed', 'packed', 'new'] then raise exception 'FAIL 4: after pick and pack'; end if;
  ok := ok || ('three orders of 12 against 30: the wave takes FLOW-1 and FLOW-2 (stops at SB-01 only), FLOW-3 short; 24 picked once, both packed, 6 left')::text;
  -- 5. ship as the portal's development path does: ship_order directly, label source manual, no label bought; repeat
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  s1 := ship_order(o1, 'USPS', 'Ground Advantage', 'TEST-FLOW-0001', 'manual', null, 'Box 8×6×4', 16);
  s1b := ship_order(o1, 'USPS', 'Ground Advantage', 'TEST-FLOW-0001', 'manual', null, 'Box 8×6×4', 16);
  begin perform ship_order(o1, 'USPS', null, 'TEST-FLOW-0099', 'manual', null, null, 16); raise exception 'FAIL 5: shipped twice'; exception when others then msg := sqlerrm; if msg like 'FAIL%' then raise; end if; end;
  s2 := ship_order(o2, 'UPS', 'Ground', 'TEST-FLOW-0002', 'manual', null, 'Poly mailer', 16);
  s := (select e from jsonb_array_elements(wms_stock_summary(a) -> 'products') e where e ->> 'sku' = 'FLOW-A');
  perform set_config('role', 'postgres', true);
  if s1 is distinct from s1b or (select count(*) from shipments where order_id in (o1, o2)) <> 2 then raise exception 'FAIL 5: shipments'; end if;
  if (select sum(qty) from inventory_moves where sku_id = k) <> 6 or (s ->> 'on_hand')::int <> 6 or (s ->> 'received')::int <> 30 or (s ->> 'shipped')::int <> 24 or (s ->> 'picked_out')::int <> -24 or not (s ->> 'reconciled')::boolean then raise exception 'FAIL 5: balances %', s; end if;
  ok := ok || ('ship FLOW-1 and FLOW-2 with test tracking (ship_order, label source manual, nothing bought): the repeat returns the same shipment, a second tracking is refused, no second deduction; received 30, picked 24, shipped 24, on hand 6, reconciled')::text;
  -- 6. isolation: the Records client sees nothing of Mailers and cannot change it
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  select count(*) into n from wms_pallets where org_id = b; if n <> 0 then raise exception 'FAIL 6: client sees % Mailers pallets', n; end if;
  select count(*) into n from skus where org_id = b; if n <> 0 then raise exception 'FAIL 6: client sees Mailers products'; end if;
  update skus set name = 'changed' where id = kb; get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 6: client changed a Mailers product'; end if;
  begin perform wms_stock_summary(b); raise exception 'FAIL 6: client read Mailers stock'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform create_manual_order(b, '{"order_number":"FLOW-X"}', jsonb_build_array(jsonb_build_object('sku_id', kb, 'qty', 1))); raise exception 'FAIL 6: client made a Mailers order'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  select count(*) into n from orders where org_id = b; if n <> 0 then raise exception 'FAIL 6: client sees Mailers orders'; end if;
  perform set_config('role', 'postgres', true);
  ok := ok || ('isolation: the Synthetic Records client sees 0 Mailers pallets, products, orders; cannot read its stock, change its product or create its order')::text;
  -- 7. server-side rule for any writer, and the registry exclusion
  insert into locations (code, zone, kind, active, pickable, shared) values ('X-99', 'test', 'pallet', true, true, false);
  begin update wms_pallets set location_id = (select id from locations where code = 'X-99') where id = pb.id; raise exception 'FAIL 7: a non-SB position was accepted'; exception when others then msg := sqlerrm; if msg like 'FAIL%' then raise; end if; if msg not like '%not a development position%' then raise exception 'FAIL 7: %', msg; end if; end;
  s := nexus_registry_apply(jsonb_build_object('version', 99, 'locations', (select jsonb_agg(jsonb_build_object('code', code, 'kind', kind, 'status', 'active', 'version', 99)) from locations where shared)), true);
  if (s -> 'retired_empty') ? 'SB-01' or (s -> 'retired_but_occupied') ? 'SB-01' or (s -> 'retired_empty') ? 'SB-06' then raise exception 'FAIL 7: the registry would retire an SB position: %', s; end if;
  begin perform nexus_registry_apply('{"version":99,"locations":[{"code":"SB-01","kind":"pallet"}]}', true); raise exception 'FAIL 7: a snapshot naming SB-01 was read'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  ok := ok || ('any writer: a non-SB unshared pallet position is refused on wms_pallets; the Nexus registry never retires an SB position and refuses a snapshot naming one')::text;
  raise exception 'ROLLBACK-OK % checks: %', array_length(ok, 1), array_to_string(ok, ' | ');
end $t$;
