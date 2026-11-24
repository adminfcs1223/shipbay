-- Eighth database check for the isolated development database (shipbay-nexus-dev): the ShipBay MVP order path end to end
-- (candidate 20261209 / dev_037, with dev_035 and dev_036 revision 2). Receive -> count -> put-away (the Nexus journal, with the
-- bridge's commit done here as the service login) -> manual orders -> wave pick -> pack -> ship with tracking -> reconcile, as the
-- synthetic logins, with every critical case of the MVP sprint: brand isolation, two orders and two pickers against the same
-- units, repeated receiving, put-away, picking and shipping requests, shipped orders that cannot be rewritten, the store sync
-- against orders the warehouse has started on, and PSKU-000001 and the Nexus journal unchanged.
-- Runs as the synthetic logins and always ends by raising an exception, so everything it did is rolled back.
-- A pass ends with:  ROLLBACK-OK 10 checks passed: ...
-- It uses positions P-50 and P-51 only (never P-01, P-02 or P-03), sends nothing to Nexus, and never runs against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; us uuid := '5b000000-0000-4000-8000-000000000003'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  ka uuid; kb uuid; pa wms_pallets; pb wms_pallets; c record; j jsonb; op uuid; wave uuid; task uuid; od1 uuid; od2 uuid; od3 uuid; sh1 uuid; sh2 uuid; x uuid; n int; n1 int; v text; s jsonb; before text;
  ok text[] := '{}'; r record; got text; msg text; sales_role text; stage int := 0;
begin
  if exists (select 1 from orgs where id <> all (array[o1, o2])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if not exists (select 1 from pg_proc where proname = 'wms_stock_summary') or not exists (select 1 from pg_trigger where tgname = 'order_lines_sync_guard') then raise exception 'FAIL 0: dev_036 revision 2 and dev_037 are not both installed.'; end if;
  if exists (select 1 from wms_pallets p join locations l on l.id = p.location_id where l.code in ('P-50', 'P-51')) or exists (select 1 from inventory_moves m join locations l on l.id = m.location_id where l.code in ('P-50', 'P-51')) then raise exception 'FAIL 0: P-50 or P-51 is in use. Not running.'; end if;
  if exists (select 1 from wms_waves where status in ('picking', 'packing') and picker in (uf, us)) then raise exception 'FAIL 0: a synthetic login has a wave open. Not running.'; end if;
  select md5(concat_ws('|', (select to_jsonb(p)::text from wms_pallets p where psku = 'PSKU-000001'), (select jsonb_agg(to_jsonb(m) order by m.id)::text from inventory_moves m where m.ref_id = (select id from wms_pallets where psku = 'PSKU-000001')),
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from wms_nexus_ops o), (select jsonb_agg(to_jsonb(m) order by m.id)::text from inventory_moves m), (select jsonb_agg(to_jsonb(o) order by o.id)::text from orders o), (select jsonb_agg(to_jsonb(z) order by z.id)::text from shipments z))) into before;
  select role into sales_role from profiles where id = us;
  insert into skus (org_id, sku, name, barcode) values (o1, 'MVP-A', 'MVP product A', 'MVP-A-BC') returning id into ka;
  insert into skus (org_id, sku, name, barcode) values (o2, 'MVP-B', 'MVP product B', 'MVP-B-BC') returning id into kb;
  -- every step: who runs it, the statement, and what must happen ('ok', or 'refused' with the start of the message)
  create temp table _mvp (seq serial primary key, stage int, who text, stmt text, expect text, msg_like text) on commit drop;

  -- 1-3. receive, count, put away (brand A: 3 cartons of 10 at P-50; brand B: 1 carton of 10 at P-51)
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  select * into pa from wms_receive(o1, jsonb_build_array(jsonb_build_object('sku', ka, 'cartons', 3, 'units_per_carton', 10)), 1, 'MVP check', 'mvp-check-rcv-a');
  select * into pb from wms_receive(o2, jsonb_build_array(jsonb_build_object('sku', kb, 'cartons', 1, 'units_per_carton', 10)), 1, 'MVP check', 'mvp-check-rcv-b');
  perform wms_receive(o1, jsonb_build_array(jsonb_build_object('sku', ka, 'cartons', 3, 'units_per_carton', 10)), 1, 'MVP check', 'mvp-check-rcv-a');   -- the same request again
  perform set_config('role', 'postgres', true);
  if pa.psku !~ '^PSKU-[0-9]{6}$' or pb.psku !~ '^PSKU-[0-9]{6}$' or pa.psku = pb.psku then raise exception 'FAIL 1: pallet labels are wrong: % %', pa.psku, pb.psku; end if;
  select count(*) into n from wms_pallets where org_id = o1 and id = pa.id; select count(*) into n1 from wms_cartons where pallet_id = pa.id;
  if (select count(*) from wms_pallets where batch_key = 'mvp-check-rcv-a' or client_key like 'mvp-check-rcv-a%') <> 1 or n1 <> 3 or exists (select 1 from inventory_moves where sku_id in (ka, kb)) then raise exception 'FAIL 1: the repeated receipt made a second pallet (%), the wrong cartons (%), or stock was booked before put-away', (select count(*) from wms_pallets where batch_key = 'mvp-check-rcv-a' or client_key like 'mvp-check-rcv-a%'), n1; end if;
  if exists (select 1 from wms_cartons where pallet_id = pa.id and code !~ ('^' || replace(pa.psku, 'PSKU-', 'C') || '|^C')) then null; end if;
  for c in select code from wms_cartons where pallet_id in (pa.id, pb.id) loop
    perform set_config('role', 'authenticated', true); perform wms_scan_carton(c.code); perform set_config('role', 'postgres', true);
  end loop;
  perform set_config('role', 'authenticated', true);
  perform wms_complete_count(pa.id); perform wms_complete_count(pb.id);
  j := wms_putaway_begin(pa.psku, 'P-50'); op := (j ->> 'op')::uuid;
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform wms_nexus_op_commit(op); perform wms_nexus_op_commit(op);   -- what the bridge does once Nexus accepts; and the same answer again
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  j := wms_putaway_begin(pb.psku, 'P-51');
  perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform wms_nexus_op_commit((j ->> 'op')::uuid);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  select * into pa from wms_pallets where id = pa.id; select * into pb from wms_pallets where id = pb.id;
  if pa.status <> 'stored' or (select code from locations where id = pa.location_id) <> 'P-50' or pb.status <> 'stored' or (select code from locations where id = pb.location_id) <> 'P-51' then raise exception 'FAIL 2: pallets not stored at P-50 / P-51'; end if;
  if (select count(*) from inventory_moves where sku_id = ka) <> 1 or (select sum(qty) from inventory_moves where sku_id = ka and location_id = pa.location_id and reason = 'receive') <> 30 or (select sum(qty) from inventory_moves where sku_id = kb) <> 10 then raise exception 'FAIL 2: put-away did not book 30 and 10 exactly once'; end if;
  if (select count(*) from wms_nexus_ops where pallet_id = pa.id) <> 1 or (select state from wms_nexus_ops where id = op) <> 'done' or (select to_code from wms_nexus_ops where id = op) <> 'P-50' then raise exception 'FAIL 2: the Nexus journal entry is wrong'; end if;
  ok := ok || format('receiving: brand A 3 cartons of 10 and brand B 1 carton of 10 make pallets %s and %s; the same receiving request again makes nothing new; no stock is booked before put-away', pa.psku, pb.psku);
  ok := ok || 'put-away through the Nexus journal (the bridge''s commit done here as the service login, twice): A stored at P-50, B at P-51, 30 and 10 booked exactly once each, one journal entry, done, naming P-50'::text;

  -- 4. what each brand sees: the stock summary, and isolation
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  s := wms_stock_summary((select org_id from profiles where id = uc));
  begin perform wms_stock_summary(case when (select org_id from profiles where id = uc) = o1 then o2 else o1 end); raise exception 'FAIL 3: a client read another brand''s stock summary'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'This login cannot see%' then raise; end if; end;
  select count(*) into n from orders where org_id <> (select org_id from profiles where id = uc); select count(*) into n1 from inventory_moves where org_id <> (select org_id from profiles where id = uc);
  perform set_config('role', 'postgres', true);
  if n <> 0 or n1 <> 0 then raise exception 'FAIL 3: the client reads % orders and % stock rows of another brand', n, n1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  s := (select e from jsonb_array_elements(wms_stock_summary(o1) -> 'products') e where e ->> 'sku' = 'MVP-A'); perform set_config('role', 'postgres', true);
  if (s ->> 'on_hand')::int <> 30 or (s ->> 'at_positions')::int <> 30 or (s ->> 'available')::int <> 30 or (s ->> 'on_open_orders')::int <> 0 or (s ->> 'shipped')::int <> 0 or not (s ->> 'reconciled')::boolean then raise exception 'FAIL 3: summary after receiving is wrong: %', s; end if;
  ok := ok || 'stock summary for A after receiving: 30 on hand, all at a position, 30 available, reconciled; the brand''s client reads only its own brand (another brand''s summary refused, 0 orders and 0 stock rows of the other brand)'::text;

  -- 5. manual orders (three of 12 against 30 on hand) and what may not create one
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  od1 := create_manual_order(o1, jsonb_build_object('order_number', 'MVP-O1', 'ship_to', jsonb_build_object('name', 'One', 'address1', '1 Test St', 'city', 'Newark', 'province_code', 'NJ', 'zip', '07102', 'country_code', 'US')), jsonb_build_array(jsonb_build_object('sku_id', ka, 'qty', 12)));
  od2 := create_manual_order(o1, jsonb_build_object('order_number', 'MVP-O2', 'ship_to', jsonb_build_object('name', 'Two', 'country_code', 'US')), jsonb_build_array(jsonb_build_object('sku_id', ka, 'qty', 12)));
  od3 := create_manual_order(o1, jsonb_build_object('order_number', 'MVP-O3', 'ship_to', jsonb_build_object('name', 'Three', 'country_code', 'US')), jsonb_build_array(jsonb_build_object('sku_id', ka, 'qty', 12)));
  perform set_config('role', 'postgres', true);
  insert into _mvp (stage, who, stmt, expect, msg_like) values
    (5, 'admin', format($q$select create_manual_order(%L, '{"order_number":"MVP-X1"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, kb), 'refused', '%not one of this brand%'),
    (5, 'admin', format($q$select create_manual_order(%L, '{"order_number":"MVP-X2"}', '[{"sku_id":"%s","qty":0}]')$q$, o1, ka), 'refused', 'Every line needs a whole quantity%'),
    (5, 'admin', format($q$select create_manual_order(%L, '{"order_number":"MVP-X3"}', '[{"sku_id":"%s","qty":-3}]')$q$, o1, ka), 'refused', 'Every line needs a whole quantity%'),
    (5, 'admin', format($q$select create_manual_order(%L, '{"order_number":"MVP-X4"}', '[]')$q$, o1), 'refused', 'Add at least one product%'),
    (5, 'staff', format($q$select create_manual_order(%L, '{"order_number":"mvp-o1"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, ka), 'refused', 'Order number % is already used%'),
    (5, 'sales', format($q$select create_manual_order(%L, '{"order_number":"MVP-X5"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, ka), 'refused', 'Only ShipBay admin or staff%'),
    (5, 'floor', format($q$select create_manual_order(%L, '{"order_number":"MVP-X6"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, ka), 'refused', 'Only ShipBay admin or staff%'),
    (5, 'client', format($q$select create_manual_order(%L, '{"order_number":"MVP-X7"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, ka), 'refused', 'Only ShipBay admin or staff%'),
    (5, 'public key', format($q$select create_manual_order(%L, '{"order_number":"MVP-X8"}', '[{"sku_id":"%s","qty":1}]')$q$, o1, ka), 'refused', 'permission denied%');
  stage := 5;
  for r in select * from _mvp where _mvp.stage = 5 order by seq loop
    if r.who = 'sales' then update profiles set role = 'shipbay_sales' where id = us; end if;
    perform set_config('request.jwt.claims', case r.who when 'admin' then json_build_object('sub', ua, 'role', 'authenticated')::text when 'staff' then json_build_object('sub', us, 'role', 'authenticated')::text when 'sales' then json_build_object('sub', us, 'role', 'authenticated')::text when 'floor' then json_build_object('sub', uf, 'role', 'authenticated')::text when 'client' then json_build_object('sub', uc, 'role', 'authenticated')::text else '{"role":"anon"}' end, true);
    perform set_config('role', case r.who when 'public key' then 'anon' else 'authenticated' end, true);
    begin execute r.stmt; got := 'ok'; exception when others then got := 'refused'; msg := sqlerrm; end;
    perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); if r.who = 'sales' then update profiles set role = sales_role where id = us; end if;
    if got <> r.expect or (got = 'refused' and msg not like r.msg_like) then raise exception 'FAIL 4: % ran "%": expected % (%), got % (%)', r.who, left(r.stmt, 80), r.expect, r.msg_like, got, coalesce(msg, ''); end if;
  end loop;
  if (select count(*) from orders where org_id = o1 and order_number like 'MVP-%') <> 3 or (select source || '/' || channel from orders where id = od1) <> 'connector/manual' or (select qty from order_lines where order_id = od1) <> 12 then raise exception 'FAIL 4: manual orders are not as expected'; end if;
  ok := ok || 'manual orders: admin makes three orders of 12 (WMS orders, channel manual); refused with a reason and nothing made: another brand''s product, quantity 0 or -3, no product, an order number already used (any capitals), sales, floor, client, the public key'::text;

  -- 6. pick: two pickers, three orders, 30 units: two orders get the units, the third is short for both pickers
  perform set_config('request.jwt.claims', json_build_object('sub', uf, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  j := wms_wave_start(o1); wave := (j -> 'wave' ->> 'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  s := wms_wave_start(o1);
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if wave is null or (select array_agg(o.order_number order by o.order_number) from wms_wave_orders wo join orders o on o.id = wo.order_id where wo.wave_id = wave) <> array['MVP-O1', 'MVP-O2'] then raise exception 'FAIL 5: the floor wave does not hold O1 and O2: %', j; end if;
  if not (j -> 'short') @> jsonb_build_array(jsonb_build_object('order_number', 'MVP-O3')) or (s -> 'wave') <> 'null'::jsonb or not (s -> 'short') @> jsonb_build_array(jsonb_build_object('order_number', 'MVP-O3', 'on_file', 6)) then raise exception 'FAIL 5: O3 was not held back as short for both pickers: % / %', j -> 'short', s; end if;
  select id into task from wms_wave_tasks where wave_id = wave and sku_id = ka; if (select qty_planned from wms_wave_tasks where id = task) <> 24 or (select code from locations where id = (select location_id from wms_wave_tasks where id = task)) <> 'P-50' then raise exception 'FAIL 5: the stop is not 24 at P-50'; end if;
  truncate _mvp;
  insert into _mvp (stage, who, stmt, expect, msg_like) values
    (6, 'floor', format('select wms_wave_confirm(%L, 24, ''WRONG-BC'')', task), 'refused', 'That barcode is not%'),
    (6, 'floor', format('select wms_wave_confirm(%L, 25, ''MVP-A-BC'')', task), 'refused', 'Only 24 are needed from here%'),
    (6, 'client', format('select wms_wave_confirm(%L, 24, ''MVP-A-BC'')', task), 'refused', '%'),
    (6, 'floor', format('select wms_wave_to_pack(%L)', wave), 'refused', '% still to pick%'),
    (6, 'floor', format('select wms_wave_confirm(%L, 24, ''MVP-A-BC'')', task), 'ok', null),
    (6, 'floor', format('select wms_wave_confirm(%L, 24, ''MVP-A-BC'')', task), 'refused', 'That stop is already confirmed%'),
    (6, 'floor', format('select wms_wave_to_pack(%L)', wave), 'ok', null),
    (6, 'floor', format($q$select wms_wave_pack(%L, array[%L]::uuid[], '[{"items":[{"key":"MVP-A","qty":11}],"weight_oz":20,"packaging":"box"}]')$q$, wave, od1), 'refused', 'The packages do not add up%'),
    (6, 'floor', format($q$select wms_wave_pack(%L, array[%L]::uuid[], '[{"items":[{"key":"MVP-A","qty":12}],"weight_oz":20,"packaging":"box"}]')$q$, wave, od1), 'ok', null),
    (6, 'floor', format($q$select wms_wave_pack(%L, array[%L]::uuid[], '[{"items":[{"key":"MVP-A","qty":12}],"weight_oz":20,"packaging":"box"}]')$q$, wave, od1), 'refused', '%not waiting to be packed%'),
    (6, 'floor', format($q$select wms_wave_pack(%L, array[%L]::uuid[], '[{"items":[{"key":"MVP-A","qty":6}],"weight_oz":10,"packaging":"box"},{"items":[{"key":"MVP-A","qty":6}],"weight_oz":10,"packaging":"box"}]')$q$, wave, od2), 'ok', null);
  for r in select * from _mvp order by seq loop
    perform set_config('request.jwt.claims', case r.who when 'floor' then json_build_object('sub', uf, 'role', 'authenticated')::text else json_build_object('sub', uc, 'role', 'authenticated')::text end, true); perform set_config('role', 'authenticated', true);
    begin execute r.stmt; got := 'ok'; exception when others then got := 'refused'; msg := sqlerrm; end;
    perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
    if got <> r.expect or (got = 'refused' and msg not like r.msg_like) then raise exception 'FAIL 6: % ran "%": expected % (%), got % (%)', r.who, left(r.stmt, 90), r.expect, coalesce(r.msg_like, ''), got, coalesce(msg, ''); end if;
  end loop;
  if (select count(*) from inventory_moves where sku_id = ka and reason = 'pick') <> 1 or (select sum(qty) from inventory_moves where sku_id = ka) <> 6 or (select sum(qty) from wms_picks where order_id in (od1, od2) and undone_at is null) <> 24 then raise exception 'FAIL 6: the pick did not take exactly 24 once'; end if;
  if (select array_agg(status order by order_number) from orders where id in (od1, od2, od3)) <> array['packed', 'packed', 'new'] or (select count(*) from wms_packages where order_id = od2) <> 2 then raise exception 'FAIL 6: order states or packages are wrong'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  s := (select e from jsonb_array_elements(wms_stock_summary(o1) -> 'products') e where e ->> 'sku' = 'MVP-A'); perform set_config('role', 'postgres', true);
  if (s ->> 'on_hand')::int <> 6 or (s ->> 'picked_not_shipped')::int <> 24 or (s ->> 'on_open_orders')::int <> 12 or (s ->> 'available')::int <> -6 or (s ->> 'planned_on_waves')::int <> 0 or not (s ->> 'reconciled')::boolean then raise exception 'FAIL 6: summary after picking is wrong: %', s; end if;
  ok := ok || 'pick: with 30 on hand and three orders of 12, the floor wave takes O1 and O2 (one stop, 24 at P-50) and O3 is short; the staff login''s wave start right after gets nothing (O3 short, 6 on file): two pickers cannot take the same units'::text;
  ok := ok || 'pick and pack refusals: a wrong barcode, 25 of 24, a client login, packing before the pick, a package one short, and confirming or packing the same thing twice; then 24 picked once (one ledger row), O1 in one package and O2 in two, both packed; the summary shows 6 on hand, 24 picked and waiting to ship, 12 on open orders (O3), available -6 (short by 6), reconciled'::text;

  -- 7. ship with tracking: the portal's manual path, repeats, wrong orders and wrong logins
  truncate _mvp;
  insert into _mvp (stage, who, stmt, expect, msg_like) values
    (7, 'admin', format('select ship_order(%L, ''USPS'', ''Ground Advantage'', ''9400100000000000000001'', ''manual'', 5.25, ''Box 8×6×4'', 20)', od1), 'ok', null),
    (7, 'admin', format('select ship_order(%L, ''USPS'', ''Ground Advantage'', '' 9400100000000000000001 '', ''manual'', 5.25, ''Box 8×6×4'', 20)', od1), 'ok', null),
    (7, 'staff', format('select ship_order(%L, ''USPS'', ''Ground Advantage'', ''9400100000000000000099'', ''manual'', 5.25, ''box'', 20)', od1), 'refused', 'Order MVP-O1 has already shipped%'),
    (7, 'staff', format('select ship_order(%L, ''USPS'', ''Ground Advantage'', ''9400100000000000000001'', ''manual'', 5.25, ''box'', 20)', od2), 'refused', 'Tracking % is already on order MVP-O1%'),
    (7, 'staff', format('select ship_order(%L, ''USPS'', null, '''', ''manual'', 5.25, ''box'', 20)', od2), 'refused', 'Enter the tracking number%'),
    (7, 'staff', format('select ship_order(%L, ''USPS'', null, ''X'', ''carrier-pigeon'', 1, null, 1)', od2), 'refused', 'Unknown label source%'),
    (7, 'sales', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000002'', ''manual'', 1, null, 1)', od2), 'refused', 'Only ShipBay admin or staff%'),
    (7, 'floor', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000002'', ''manual'', 1, null, 1)', od2), 'refused', 'Only ShipBay admin or staff%'),
    (7, 'client', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000002'', ''manual'', 1, null, 1)', od2), 'refused', 'Only ShipBay admin or staff%'),
    (7, 'public key', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000002'', ''manual'', 1, null, 1)', od2), 'refused', 'permission denied%'),
    (7, 'staff', format('select ship_order(%L, ''UPS'', ''Ground'', ''1Z999AA10000000002'', ''manual'', 7.10, ''Poly mailer'', 20)', od2), 'ok', null),
    (7, 'admin', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000003'', ''manual'', 1, null, 1)', od3), 'refused', 'Order MVP-O3 needs 12 of MVP-A, and only 0 are on file without a position%'),
    (7, 'admin', format('update orders set status = ''cancelled'' where id = %L', od3), 'ok', null),
    (7, 'admin', format('select ship_order(%L, ''USPS'', null, ''9400100000000000000003'', ''manual'', 1, null, 1)', od3), 'refused', 'Order MVP-O3 is cancelled%');
  for r in select * from _mvp order by seq loop
    if r.who = 'sales' then update profiles set role = 'shipbay_sales' where id = us; end if;
    perform set_config('request.jwt.claims', case r.who when 'admin' then json_build_object('sub', ua, 'role', 'authenticated')::text when 'staff' then json_build_object('sub', us, 'role', 'authenticated')::text when 'sales' then json_build_object('sub', us, 'role', 'authenticated')::text when 'floor' then json_build_object('sub', uf, 'role', 'authenticated')::text when 'client' then json_build_object('sub', uc, 'role', 'authenticated')::text else '{"role":"anon"}' end, true);
    perform set_config('role', case r.who when 'public key' then 'anon' else 'authenticated' end, true);
    x := null; begin if r.stmt like 'select%' then execute r.stmt into x; else execute r.stmt; end if; got := 'ok'; exception when others then got := 'refused'; msg := sqlerrm; end;
    perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); if r.who = 'sales' then update profiles set role = sales_role where id = us; end if;
    if got <> r.expect or (got = 'refused' and msg not like r.msg_like) then raise exception 'FAIL 7: % ran "%": expected % (%), got % (%)', r.who, left(r.stmt, 90), r.expect, coalesce(r.msg_like, ''), got, coalesce(msg, ''); end if;
    if r.seq = (select min(seq) from _mvp) then sh1 := x; elsif r.seq = (select min(seq) + 1 from _mvp) then sh2 := x; end if;
  end loop;
  if sh1 is distinct from sh2 or (select count(*) from shipments where order_id = od1) <> 1 or (select label_source from shipments where id = sh1) <> 'other' or (select tracking from shipments where id = sh1) <> '9400100000000000000001'
     or (select postage_billed from shipments where id = sh1) <> 5.25 or (select packaging from shipments where id = sh1) <> 'box_single' or (select packaging from shipments where order_id = od2) <> 'mailer' or (select count(*) from shipments where order_id = od2) <> 1 or (select count(*) from shipments where order_id = od3) <> 0 then raise exception 'FAIL 7: shipments are not as expected'; end if;
  if (select array_agg(status order by order_number) from orders where id in (od1, od2, od3)) <> array['shipped', 'shipped', 'cancelled'] or (select sum(qty) from inventory_moves where sku_id = ka) <> 6 or (select count(*) from inventory_moves where sku_id = ka) <> 2 then raise exception 'FAIL 7: shipping changed stock or states wrongly'; end if;
  if not exists (select 1 from events where entity_id = od1 and to_value = 'shipped' and actor_id = ua) or not exists (select 1 from events where entity_id = od2 and to_value = 'shipped' and actor_id = us) or not exists (select 1 from events where entity_id = od3 and to_value = 'cancelled' and actor_id = ua) then raise exception 'FAIL 7: the status history does not name who shipped and cancelled'; end if;
  ok := ok || 'ship: the portal''s manual path (label source "manual", recorded as "other") ships O1 for admin (box name ''Box 8×6×4'' recorded as box_single, ''Poly mailer'' as mailer); the same request again (even with spaces) returns the same shipment; another tracking number on O1, O1''s tracking on O2, a blank tracking number, an unknown label source, sales, floor, client and the public key are refused; staff ships O2; O3 (never picked, no stock without a position) is refused, then cancelled, then refused as cancelled; stock stays at 6 (shipping took nothing more), one shipment per order, postage billed once, history names who shipped and cancelled'::text;

  -- 8. shipped and packed orders cannot be rewritten: directly, or by the store sync (service login)
  truncate _mvp;
  insert into _mvp (stage, who, stmt, expect, msg_like) values
    (8, 'admin', format('update orders set ship_to = ''{"name":"Elsewhere"}'' where id = %L', od1), 'refused', 'Only an order''s hold, release and cancel%'),
    (8, 'staff', format('update orders set status = ''on_hold'', hold_reason = ''late'' where id = %L', od1), 'refused', 'An order that is shipped cannot be set to on_hold%'),
    (8, 'admin', format('update order_lines set qty = 1 where order_id = %L', od1), 'refused', 'permission denied%'),
    (8, 'admin', format('delete from shipments where order_id = %L', od1), 'refused', 'permission denied%'),
    (8, 'admin', format('update shipments set postage_billed = 0 where order_id = %L', od1), 'refused', 'permission denied%'),
    (8, 'service login', format('update orders set ship_to = ''{"name":"Synced"}'', total_units = 1 where id = %L', od1), 'refused', 'Order MVP-O1 is shipped in the warehouse; the store sync cannot change%'),
    (8, 'service login', format('update orders set status = ''cancelled'' where id = %L', od2), 'refused', '%'),
    (8, 'service login', format('update order_lines set qty = 0 where order_id = %L', od2), 'refused', 'Order MVP-O2 is shipped in the warehouse; the store sync cannot change its lines%'),
    (8, 'service login', format('delete from order_lines where order_id = %L', od1), 'refused', 'An order line with pick, pack, wave or shipment history cannot be deleted%'),
    (8, 'service login', format('insert into order_lines (order_id, sku_id, sku, name, qty) values (%L, %L, ''MVP-A'', ''extra'', 1)', od1, ka), 'refused', '%the store sync cannot change its lines%'),
    (8, 'service login', format('update orders set raw = ''{"veeqo":"late event"}'', tags = array[''synced''] where id = %L', od1), 'ok', null),
    (8, 'owner', format('delete from orders where id = %L', od1), 'refused', 'An order cannot be deleted%'),
    (8, 'owner', format('update orders set org_id = %L where id = %L', o2, od2), 'refused', '%brand, id, creation time and author cannot be changed%');
  for r in select * from _mvp order by seq loop
    perform set_config('request.jwt.claims', case r.who when 'admin' then json_build_object('sub', ua, 'role', 'authenticated')::text when 'staff' then json_build_object('sub', us, 'role', 'authenticated')::text when 'service login' then '{"role":"service_role"}' else '' end, true);
    perform set_config('role', case r.who when 'service login' then 'service_role' when 'owner' then 'postgres' else 'authenticated' end, true);
    begin execute r.stmt; get diagnostics n = row_count; got := case when n = 0 and r.stmt like 'update%' then 'refused' else 'ok' end; msg := 'touched 0 rows';
    exception when others then got := 'refused'; msg := sqlerrm; end;
    perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
    if got <> r.expect or (got = 'refused' and msg not like r.msg_like) then raise exception 'FAIL 8: % ran "%": expected % (%), got % (%)', r.who, left(r.stmt, 90), r.expect, coalesce(r.msg_like, ''), got, coalesce(msg, ''); end if;
  end loop;
  if (select ship_to ->> 'name' from orders where id = od1) <> 'One' or (select total_units from orders where id = od1) <> 12 or (select qty from order_lines where order_id = od1) <> 12 or (select status from orders where id = od2) <> 'shipped' or (select raw ->> 'veeqo' from orders where id = od1) <> 'late event' then raise exception 'FAIL 8: a shipped order changed'; end if;
  ok := ok || 'shipped orders cannot be rewritten: admin and staff cannot change the address, hold it, edit its lines, delete or zero its shipment; the store sync (service login) cannot change its address or units, cancel it, zero, delete or add lines; the owner cannot delete it or move it to the other brand; the sync may still record its raw event and tags; address, units, lines and status unchanged'::text;

  -- 9. reconciliation and the database afterwards
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true);
  j := wms_stock_summary(o1); s := (select e from jsonb_array_elements(j -> 'products') e where e ->> 'sku' = 'MVP-A');
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (s ->> 'on_hand')::int <> 6 or (s ->> 'received')::int <> 30 or (s ->> 'picked_out')::int <> -24 or (s ->> 'shipped')::int <> 24 or (s ->> 'picked_not_shipped')::int <> 0 or (s ->> 'on_open_orders')::int <> 0 or (s ->> 'available')::int <> 6 or (s ->> 'transfers_net')::int <> 0 or not (s ->> 'reconciled')::boolean or not (j ->> 'reconciled')::boolean then raise exception 'FAIL 9: final summary is wrong: %', s; end if;
  if exists (select 1 from inventory_moves where location_id is not null group by sku_id, location_id having sum(qty) < 0) or exists (select 1 from inventory_moves where ref_type = 'wms_pallet' and reason = 'receive' group by ref_id, sku_id having count(*) > 1) then raise exception 'FAIL 9: a position is below zero or a pallet was received twice'; end if;
  if (select sum(qty) from inventory_moves where sku_id = kb) <> 10 or exists (select 1 from orders where org_id = o2 and order_number like 'MVP-%') then raise exception 'FAIL 9: brand B changed'; end if;
  ok := ok || 'reconciliation for A: received 30, picked out 24, shipped 24, nothing picked and waiting, nothing on open orders, 6 on hand and available, transfers net zero, reconciled for the brand; no position below zero, no pallet received twice, brand B''s 10 untouched'::text;
  if md5(concat_ws('|', (select to_jsonb(p)::text from wms_pallets p where psku = 'PSKU-000001'), (select jsonb_agg(to_jsonb(m) order by m.id)::text from inventory_moves m where m.ref_id = (select id from wms_pallets where psku = 'PSKU-000001')),
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from wms_nexus_ops o where o.pallet_id not in (pa.id, pb.id)), (select jsonb_agg(to_jsonb(m) order by m.id)::text from inventory_moves m where m.sku_id not in (ka, kb)), (select jsonb_agg(to_jsonb(o) order by o.id)::text from orders o where o.id not in (od1, od2, od3)), (select jsonb_agg(to_jsonb(z) order by z.id)::text from shipments z where z.order_id not in (od1, od2, od3))))
     is distinct from before then raise exception 'FAIL 10: PSKU-000001, its receipt, the Nexus journal, or stock, orders or shipments on file before this test changed'; end if;
  ok := ok || 'everything on file before this test is byte-for-byte unchanged: PSKU-000001 and its receipt, the Nexus journal, every stock row, order and shipment'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
