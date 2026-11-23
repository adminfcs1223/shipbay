-- Sixth database check for the isolated development database (shipbay-nexus-dev): the stock-ledger hardening of candidate
-- 20261207 (dev_035). No login may write the ledger directly; the ledger is append-only for everyone; an adjustment says where,
-- what, why and who; the sanctioned stock correction works for admin and staff only; the older writers still work.
-- Runs as the synthetic logins and always ends by raising an exception, so everything it did is rolled back.
-- A pass ends with:  ROLLBACK-OK 8 checks passed: ...
-- It works only with brands, products, shelves, bookings and orders it creates itself (plus the shelf A-01), never touches a
-- pallet or a Nexus position, and sends nothing to Nexus. Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; us uuid := '5b000000-0000-4000-8000-000000000003'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; cs text := json_build_object('sub', us, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  k1 uuid; k2 uuid; k3 uuid; kw uuid; ot uuid; kt uuid; lx uuid; la uuid; r_old uuid; r_new uuid; r_loc uuid; ib uuid; il uuid; ord uuid; shp uuid; wv uuid; tk uuid; j jsonb; n int; u bigint; n1 int; u1 bigint; before text; m inventory_moves; act wms_activity;
  ok text[] := '{}'; who record; stmt text; refused int := 0; msg text; st text; sales_role text;
begin
  if exists (select 1 from orgs where id <> all (array[o1, o2])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if not exists (select 1 from pg_proc where proname = 'wms_stock_correct') or not exists (select 1 from pg_trigger where tgname = 'inventory_moves_append_only') then raise exception 'FAIL 0: the ledger hardening (dev_035) is not installed.'; end if;
  if exists (select 1 from wms_waves where status in ('picking', 'packing') and picker = uf) then raise exception 'FAIL 0: the floor login has a wave open. Not running.'; end if;
  select id into la from locations where code = 'A-01' and active and not coalesce(shared, false); if la is null then raise exception 'FAIL 0: shelf A-01 is missing'; end if;
  select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x),
    (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x))) into before;
  create temp table _lhc_old on commit drop as select 'p' kind, id::text from wms_pallets union all select 'm', id::text from inventory_moves union all select 'o', id::text from wms_nexus_ops union all select 'c', id::text from wms_cartons union all select 'r', id::text from orders;

  insert into skus (org_id, sku, name) values (o1, 'LHC-1', 'Ledger check product 1') returning id into k1; insert into skus (org_id, sku, name) values (o2, 'LHC-2', 'Ledger check product 2') returning id into k2;
  insert into skus (org_id, sku, name) values (o1, 'LHC-3', 'Ledger check product 3, no history') returning id into k3; insert into skus (org_id, sku, name, barcode) values (o1, 'LHC-W', 'Ledger check wave product', 'LHC-W-BARCODE') returning id into kw;
  insert into locations (code, zone, kind) values ('LHC-01', 'shelf', 'shelf') returning id into lx;
  -- one row "from an earlier day" and one row from this transaction, written the way a function owned by postgres writes them
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id, created_at) values (o1, k1, 10, 'receive', 'inbound', gen_random_uuid(), 'LHC older receipt', lx, now() - interval '1 day') returning id into r_old;
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) values (o1, k1, 4, 'receive', 'inbound', gen_random_uuid(), 'LHC receipt of this transaction', lx) returning id into r_new;
  select count(*), coalesce(sum(qty), 0) into n, u from inventory_moves;

  -- 1. no login can write the ledger directly: admin, staff, sales, floor, client and the public key; insert, edit, delete, empty
  select role into sales_role from profiles where id = us;
  for who in select * from (values ('admin', ca, 'authenticated'), ('staff', cs, 'authenticated'), ('sales', cs, 'authenticated'), ('floor', cf, 'authenticated'), ('client', cc, 'authenticated'), ('public key', '{"role":"anon"}', 'anon')) v(name, claims, dbrole) loop
    if who.name = 'sales' then perform set_config('request.jwt.claims', '', true); update profiles set role = 'shipbay_sales' where id = us; end if;
    perform set_config('request.jwt.claims', who.claims, true); perform set_config('role', who.dbrole, true);
    if who.name = 'sales' and not is_shipbay() then raise exception 'FAIL 1: the sales stand-in is not a ShipBay login'; end if;
    if who.name in ('admin', 'staff', 'sales') then if (select count(*) from inventory_moves) < 2 then raise exception 'FAIL 1: % cannot read the ledger any more', who.name; end if; end if;
    if who.name = 'client' then if exists (select 1 from inventory_moves where org_id <> o1) or not exists (select 1 from inventory_moves where org_id = o1) then raise exception 'FAIL 1: the client does not read its own brand''s ledger and only that'; end if; end if;
    if who.name = 'floor' then select count(*) into n1 from inventory_moves; if n1 <> 0 then raise exception 'FAIL 1: the floor login reads % ledger rows directly', n1; end if; end if;
    if who.name = 'public key' then begin select count(*) into n1 from inventory_moves; if n1 <> 0 then raise exception 'FAIL 1: the public key reads the ledger'; end if; exception when insufficient_privilege then null; end; end if;
    foreach stmt in array array[format('insert into inventory_moves (org_id, sku_id, qty, reason) values (%L, %L, 5, ''receive'')', o1, k1), 'update inventory_moves set qty = qty + 1', 'delete from inventory_moves', 'truncate inventory_moves'] loop
      begin execute stmt; raise exception 'FAIL 1: % ran "%" on the ledger', who.name, left(stmt, 30);
      exception when insufficient_privilege then refused := refused + 1; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL 1: % on "%": unexpected refusal %', who.name, left(stmt, 30), sqlerrm; end;
    end loop;
    perform set_config('role', 'postgres', true);
    if who.name = 'sales' then perform set_config('request.jwt.claims', '', true); update profiles set role = sales_role where id = us; end if;
  end loop;
  select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if refused <> 24 or (n1, u1) is distinct from (n, u) then raise exception 'FAIL 1: % of 24 refused, ledger % rows / % units (was % / %)', refused, n1, u1, n, u; end if;
  ok := ok || 'direct writes: admin, staff, sales, floor, client and the public key each tried to insert, edit, delete and empty the ledger; all 24 refused for lack of permission; admin, staff and sales still read it, the client reads its own brand only, the public key reads nothing'::text;

  -- 2. even if the table permissions were handed back by mistake, the access rules still refuse
  grant insert, update, delete on inventory_moves to authenticated;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin insert into inventory_moves (org_id, sku_id, qty, reason, created_by) values (o1, k1, 5, 'receive', ua); raise exception 'FAIL 2: with permissions back, an admin inserted a ledger row';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL 2: unexpected refusal %', sqlerrm; end;
  update inventory_moves set qty = qty + 1; get diagnostics n1 = row_count; if n1 <> 0 then raise exception 'FAIL 2: with permissions back, an admin edited % ledger rows', n1; end if;
  delete from inventory_moves; get diagnostics n1 = row_count; if n1 <> 0 then raise exception 'FAIL 2: with permissions back, an admin deleted % ledger rows', n1; end if;
  perform set_config('role', 'postgres', true); revoke insert, update, delete on inventory_moves from authenticated;
  select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if (n1, u1) is distinct from (n, u) then raise exception 'FAIL 2: the ledger changed'; end if;
  ok := ok || 'second lock: with insert, edit and delete permission handed back to signed-in logins, an admin''s insert is still refused and the edit and delete touch 0 rows'::text;

  -- 3. append-only for everyone, the service login and the database owner included
  foreach st in array array['postgres', 'service_role'] loop
    perform set_config('request.jwt.claims', case when st = 'service_role' then '{"role":"service_role"}' else '' end, true); perform set_config('role', st, true);
    foreach stmt in array array[format('delete from inventory_moves where id = %L', r_old), format('delete from inventory_moves where id = %L', r_new), format('update inventory_moves set qty = 99 where id = %L', r_old), format('update inventory_moves set note = ''rewritten'' where id = %L', r_old),
        format('update inventory_moves set reason = ''adjust'' where id = %L', r_old), format('update inventory_moves set location_id = %L where id = %L', la, r_new), format('update inventory_moves set sku_id = %L where id = %L', k3, r_new),
        format('update inventory_moves set created_by = %L where id = %L', ua, r_new), format('update inventory_moves set created_at = now() where id = %L', r_old), format('update inventory_moves set ref_id = %L where id = %L', gen_random_uuid(), r_new), 'truncate inventory_moves'] loop
      begin execute stmt; raise exception 'FAIL 3: % ran "%"', st, left(stmt, 60);
      exception when insufficient_privilege then if sqlerrm not like '%append-only%' then raise exception 'FAIL 3: % refused "%" for another cause: %', st, left(stmt, 40), sqlerrm; end if; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL 3: % on "%": unexpected refusal %', st, left(stmt, 40), sqlerrm; end;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true); perform set_config('role', 'postgres', true);
  -- what stays allowed: a row of this transaction may have quantity, reason and note finalised; an older pick may be tied to its pallet, once
  update inventory_moves set qty = 5, note = 'LHC receipt, finalised' where id = r_new; update inventory_moves set qty = 4 where id = r_new;
  update inventory_moves set pallet_id = gen_random_uuid() where id = r_old;
  begin update inventory_moves set pallet_id = gen_random_uuid() where id = r_old; raise exception 'FAIL 3: a row''s pallet was changed a second time'; exception when insufficient_privilege then null; end;
  -- history can no longer be taken away by deleting what it belongs to
  begin delete from skus where id = k1; raise exception 'FAIL 3: a product with stock history was deleted'; exception when insufficient_privilege then if sqlerrm not like '%append-only%' then raise; end if; end;
  begin delete from locations where id = lx; raise exception 'FAIL 3: a location with stock history was deleted'; exception when insufficient_privilege then if sqlerrm not like '%append-only%' then raise; end if; end;
  insert into orgs (name, slug, status) values ('LHC temporary brand', 'lhc-temp', 'active') returning id into ot; insert into skus (org_id, sku, name) values (ot, 'LHC-T', 'Ledger check temp') returning id into kt;
  insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, location_id) values (ot, kt, 1, 'receive', 'inbound', gen_random_uuid(), lx);
  begin delete from orgs where id = ot; raise exception 'FAIL 3: a brand with stock history was deleted'; exception when insufficient_privilege then if sqlerrm not like '%append-only%' then raise; end if; end;
  delete from skus where id = k3; if exists (select 1 from skus where id = k3) then raise exception 'FAIL 3: a product with no history could not be deleted'; end if;
  if (select (qty, note) from inventory_moves where id = r_old) is distinct from (10, 'LHC older receipt'::text) or (select count(*) from inventory_moves) <> n + 1 then raise exception 'FAIL 3: the ledger is not as expected'; end if;
  ok := ok || 'append-only: the database owner and the service login each tried 11 deletes, edits and an emptying (22 in all), every one refused as append-only; a row may be finalised only inside the transaction that wrote it, an older pick may be tied to its pallet once; a product, a location and a brand with stock history can no longer be deleted (a product with none still can)'::text;

  -- 4. what a new row must carry (tried as the database owner, the level the stock functions run at)
  foreach stmt in array array[
      format('insert into inventory_moves (org_id, sku_id, qty, reason) values (%L, %L, 5, ''receive'')', o2, k1),
      format('insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note) values (%L, %L, 5, ''adjust'', ''stock_correction'', %L, ''No position named'')', o1, k1, gen_random_uuid()),
      format('insert into inventory_moves (org_id, sku_id, qty, reason, note, location_id) values (%L, %L, 5, ''adjust'', ''No reference named'', %L)', o1, k1, la),
      format('insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) values (%L, %L, 5, ''damage'', ''stock_correction'', %L, ''  '', %L)', o1, k1, gen_random_uuid(), la),
      format('insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, location_id) values (%L, %L, 5, ''cycle_count'', ''stock_correction'', %L, %L)', o1, k1, gen_random_uuid(), la)] loop
    begin execute stmt; raise exception 'FAIL 4: accepted "%"', left(stmt, 110); exception when check_violation then null; when others then if sqlerrm like 'FAIL%' then raise; end if; raise exception 'FAIL 4: unexpected refusal %', sqlerrm; end;
  end loop;
  perform set_config('request.jwt.claims', ca, true);   -- during an admin's request
  begin insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) values (o1, k1, 5, 'adjust', 'stock_correction', gen_random_uuid(), 'No login named', la); raise exception 'FAIL 4: an adjustment with no author was accepted during a signed-in request'; exception when check_violation then null; end;
  begin insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id, created_by) values (o1, k1, 5, 'adjust', 'stock_correction', gen_random_uuid(), 'In another name', la, uf); raise exception 'FAIL 4: a row in another login''s name was accepted'; exception when check_violation then null; end;
  perform set_config('request.jwt.claims', '', true);
  ok := ok || 'new rows: refused when the product is another brand''s; an adjustment is refused without a position, without a reference, without a reason, or without its author during a signed-in request; a row cannot be written in another login''s name'::text;

  -- 5. the sanctioned stock correction: who may, and what it refuses
  select count(*), coalesce(sum(qty), 0) into n, u from inventory_moves;
  for who in select * from (values ('floor', cf, 'authenticated', 'Only ShipBay admin or staff%'), ('client', cc, 'authenticated', 'Only ShipBay admin or staff%'), ('sales', cs, 'authenticated', 'Only ShipBay admin or staff%'), ('public key', '{"role":"anon"}', 'anon', 'permission denied%')) v(name, claims, dbrole, expect) loop
    if who.name = 'sales' then perform set_config('request.jwt.claims', '', true); update profiles set role = 'shipbay_sales' where id = us; end if;
    perform set_config('request.jwt.claims', who.claims, true); perform set_config('role', who.dbrole, true);
    begin perform wms_stock_correct(o1, k1, 'A-01', 5, 'Found five on the shelf'); raise exception 'FAIL 5: % corrected stock', who.name; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like who.expect then raise exception 'FAIL 5: % refused for another cause: %', who.name, sqlerrm; end if; end;
    perform set_config('role', 'postgres', true); if who.name = 'sales' then perform set_config('request.jwt.claims', '', true); update profiles set role = sales_role where id = us; end if;
  end loop;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_stock_correct(o1, k1, 'A-01', 5, ' ok '); raise exception 'FAIL 5: no reason accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_stock_correct(o2, k1, 'A-01', 5, 'Wrong brand named'); raise exception 'FAIL 5: another brand accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'That product is not one of this brand%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_stock_correct(o1, k1, 'A-01', 0, 'Zero units named'); raise exception 'FAIL 5: zero accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Enter how many%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_stock_correct(o1, k1, 'NO-SUCH', 5, 'Unknown shelf named'); raise exception 'FAIL 5: unknown shelf accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Name the ShipBay shelf%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_stock_correct(o1, k1, (select code from locations where shared and active order by code desc limit 1), 5, 'Shared position named'); raise exception 'FAIL 5: a shared Nexus position accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%is a shared Nexus position%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_stock_correct(o1, k1, 'A-01', -1, 'Nothing there to take off'); raise exception 'FAIL 5: went below zero'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot take it below zero%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true); select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if (n1, u1) is distinct from (n, u) then raise exception 'FAIL 5: a refused correction changed the ledger'; end if;
  ok := ok || 'stock correction refused, nothing written: floor, client, sales and the public key; no reason; another brand''s product; zero units; an unknown shelf; a shared Nexus position; taking a shelf below zero'::text;

  -- 6. an accepted correction: one row with where, what, why and who; one activity entry; a wave's planned units are protected
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  j := wms_stock_correct(o1, kw, 'a-01', 10, 'Ten found behind the shelf'); perform set_config('role', 'postgres', true);
  select * into m from inventory_moves where ref_type = 'stock_correction' and ref_id = (j ->> 'correction')::uuid;
  if m.qty <> 10 or m.reason <> 'adjust' or m.org_id <> o1 or m.sku_id <> kw or m.location_id <> la or m.created_by <> ua or m.note not like 'Stock corrected by %: Ten found behind the shelf' or (j ->> 'on_hand')::int <> 10 then raise exception 'FAIL 6: the correction row is wrong: %', to_jsonb(m); end if;
  select * into act from wms_activity where kind = 'stock_corrected' and detail ->> 'correction' = j ->> 'correction';
  if act.id is null or act.actor <> ua or act.org_id <> o1 or act.qty <> 10 or act.ref <> 'LHC-W' or act.detail ->> 'reason' <> 'Ten found behind the shelf' or act.detail ->> 'location' <> 'A-01' or (act.detail ->> 'on_hand_before')::int <> 0 or (act.detail ->> 'on_hand_after')::int <> 10 then raise exception 'FAIL 6: the activity entry is wrong: %', to_jsonb(act); end if;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'LHC-ORD-W', 'connector', 'connector', 'new', 6) returning id into ord; insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, kw, 'LHC-W', 'Ledger check wave product', 6);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); perform wms_wave_start(o1); perform set_config('role', 'postgres', true);
  select w.id into wv from wms_waves w join wms_wave_tasks t on t.wave_id = w.id where w.picker = uf and w.status = 'picking' and t.sku_id = kw and t.location_id = la and t.qty_planned = 6; if wv is null then raise exception 'FAIL 6: the staged wave has no stop of 6 at A-01'; end if;
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true);   -- staff
  begin perform wms_stock_correct(o1, kw, 'A-01', -5, 'Would leave five for a wave of six'); raise exception 'FAIL 6: a correction went below what a wave has planned'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%planned on a wave%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  j := wms_stock_correct(o1, kw, 'A-01', -4, 'Four were damaged stock'); perform set_config('role', 'postgres', true);
  select * into m from inventory_moves where ref_type = 'stock_correction' and ref_id = (j ->> 'correction')::uuid; if m.qty <> -4 or m.created_by <> us or (j ->> 'on_hand')::int <> 6 then raise exception 'FAIL 6: the staff correction is wrong'; end if;
  if (select count(*) from inventory_moves where sku_id = kw) <> 2 or (select count(*) from wms_activity where kind = 'stock_corrected' and ref = 'LHC-W') <> 2 then raise exception 'FAIL 6: not exactly one row and one entry per correction'; end if;
  ok := ok || 'stock correction accepted: an admin adds 10 at A-01 and a staff login takes 4 off: one adjust row each naming the brand, product, shelf, reason and login, one activity entry each with the before and after count; taking the shelf below the 6 a wave has planned there is refused'::text;

  -- 7. the older writers still work through their functions: the floor picks the wave stop, the old receiving and shipping functions post, the demo brand is rebuilt
  select t.id into tk from wms_wave_tasks t where t.wave_id = wv and t.sku_id = kw; perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  perform wms_wave_confirm(tk, 6, 'LHC-W-BARCODE'); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(qty), 0) from inventory_moves where sku_id = kw and location_id = la) <> 0 or not exists (select 1 from inventory_moves where sku_id = kw and reason = 'pick' and qty = -6 and created_by = uf) then raise exception 'FAIL 7: the wave pick did not post'; end if;
  insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values (o1, 'LHC-PO', 'expected', 1, 1, current_date, now()) returning id into ib; insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (ib, k1, 7, 0) returning id into il;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'LHC-ORD-S', 'connector', 'connector', 'new', 2) returning id into ord; insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, k1, 'LHC-1', 'Ledger check product 1', 2);
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  perform receive_inbound(ib, jsonb_build_array(jsonb_build_object('line_id', il, 'qty_received', 7)));
  shp := ship_order(ord, 'TEST', 'ground', 'LHC-TRACK', 'other', 0, null, 8);
  perform wms_demo_reset(); perform wms_demo_reset();   -- the second run deletes and rebuilds the demo brand's sample rows
  perform set_config('role', 'postgres', true);
  if not exists (select 1 from inventory_moves where ref_type = 'inbound' and ref_id = ib and qty = 7 and reason = 'receive' and created_by = ua) or not exists (select 1 from inventory_moves where ref_type = 'order' and ref_id = ord and qty = -2 and reason = 'pick' and created_by = ua) then raise exception 'FAIL 7: the old receiving or shipping function did not post'; end if;
  select count(*) into n1 from inventory_moves x join orgs g on g.id = x.org_id where g.slug = 'demo-brand'; if n1 = 0 then raise exception 'FAIL 7: the demo brand was not rebuilt'; end if;
  ok := ok || format('older writers: the floor login''s wave pick posts -6 in its own name; receive_inbound posts +7 and ship_order posts -2 for an admin; wms_demo_reset run twice deletes and rebuilds the demo brand''s %s sample rows (the one delete the ledger allows)', n1);

  -- 8. the database afterwards
  if exists (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0 and location_id is not null) then raise exception 'FAIL 8: a position is below zero'; end if;
  if exists (select 1 from inventory_moves where ref_type = 'wms_pallet' and reason = 'receive' group by ref_id, sku_id having count(*) > 1) then raise exception 'FAIL 8: a pallet was received twice'; end if;
  if exists (select 1 from inventory_moves where reason in ('adjust', 'cycle_count', 'damage', 'return_restock') and id::text not in (select id from _lhc_old where kind = 'm') and (location_id is null or ref_id is null or created_by is null or length(btrim(coalesce(note, ''))) < 5)) then raise exception 'FAIL 8: an adjustment written here lacks its position, reference, reason or author'; end if;
  if before is distinct from (select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x where x.id::text in (select id from _lhc_old where kind = 'p')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x where x.id::text in (select id from _lhc_old where kind = 'm')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x where x.id::text in (select id from _lhc_old where kind = 'o')),
      (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x where x.id::text in (select id from _lhc_old where kind = 'c')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x where x.id::text in (select id from _lhc_old where kind = 'r'))))) then raise exception 'FAIL 8: something that was on file before this test changed'; end if;
  if has_table_privilege('anon', 'public.inventory_moves', 'insert,update,delete,truncate,references,trigger') or has_table_privilege('authenticated', 'public.inventory_moves', 'insert,update,delete,truncate,references,trigger')
     or not has_table_privilege('authenticated', 'public.inventory_moves', 'select') or has_function_privilege('anon', 'public.wms_stock_correct(uuid, uuid, text, integer, text)', 'execute') or not has_function_privilege('authenticated', 'public.wms_stock_correct(uuid, uuid, text, integer, text)', 'execute')
     or has_function_privilege('authenticated', 'public._inventory_moves_guard()', 'execute') or has_function_privilege('anon', 'public._inventory_moves_insert_guard()', 'execute') then raise exception 'FAIL 8: a privilege is wrong'; end if;
  ok := ok || 'the database afterwards: no position below zero, no pallet received twice, every adjustment written here has its position, reference, reason and author, everything on file before is byte-for-byte unchanged, and the privileges are as designed'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
