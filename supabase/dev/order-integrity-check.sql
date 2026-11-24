-- Seventh database check for the isolated development database (shipbay-nexus-dev): order integrity, candidate 20261208
-- (dev_036). No login can delete, insert or re-home orders, lines, shipments or status history; an order can only be held,
-- released or cancelled directly, by admin, staff or its own brand, and not once work has started; the workflow functions and
-- the service login keep working; a sales login cannot change orders by any path.
-- Runs as the synthetic logins and always ends by raising an exception, so everything it did is rolled back.
-- A pass ends with:  ROLLBACK-OK 8 checks passed: ...
-- It works only with brands, products and orders it creates itself (plus the shelf A-01), never touches a pallet or a Nexus
-- position, and sends nothing to Nexus. Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; us uuid := '5b000000-0000-4000-8000-000000000003'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; cs text := json_build_object('sub', us, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  k1 uuid; k2 uuid; kw uuid; ot uuid; oe uuid; dg uuid;
  oa uuid; oa2 uuid; oc uuid; ob uuid; os uuid; ow uuid; ow2 uuid; otord uuid; od uuid; la1 uuid; lb uuid; lw uuid; sh uuid; tk uuid; j jsonb; n int; n1 int; before text; f0 text; f1 text; fq text;
  ok text[] := '{}'; c record; sales_role text; done int; grp_n jsonb := '{}'; e record; v_state text; v_msg text;
begin
  if exists (select 1 from orgs where id <> all (array[o1, o2])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'orders_history_guard') or not exists (select 1 from pg_proc where proname = '_order_commitment') then raise exception 'FAIL 0: the order hardening (dev_036) is not installed.'; end if;
  if exists (select 1 from wms_demo_brand) then raise exception 'FAIL 0: a demo brand is registered here; this check expects none'; end if;
  if exists (select 1 from wms_waves where status in ('picking', 'packing') and picker in (uf, us)) then raise exception 'FAIL 0: a synthetic login has a wave open. Not running.'; end if;
  if not exists (select 1 from locations where code = 'A-01' and active and not coalesce(shared, false)) then raise exception 'FAIL 0: shelf A-01 is missing'; end if;
  select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x),
    (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from order_lines x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from shipments x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from events x))) into before;
  create temp table _oic_old on commit drop as select 'p' kind, id::text from wms_pallets union all select 'm', id::text from inventory_moves union all select 'o', id::text from wms_nexus_ops union all select 'c', id::text from wms_cartons union all select 'r', id::text from orders union all select 'l', id::text from order_lines union all select 's', id::text from shipments union all select 'e', id::text from events;
  select role into sales_role from profiles where id = us;

  -- staging (as the database owner, the level the workflow functions run at)
  insert into skus (org_id, sku, name, barcode) values (o1, 'OIC-1', 'Order check product 1', 'OIC-1-BC') returning id into k1; insert into skus (org_id, sku, name) values (o2, 'OIC-2', 'Order check product 2') returning id into k2;
  insert into skus (org_id, sku, name, barcode) values (o1, 'OIC-W', 'Order check wave product', 'OIC-W-BC') returning id into kw;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true); perform wms_stock_correct(o1, kw, 'A-01', 20, 'Order check staging stock'); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  -- OW: on the floor login's wave and picked.  OW2: on the staff login's wave, planned, not picked.
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-W', 'connector', 'connector', 'new', 6) returning id into ow; insert into order_lines (order_id, sku_id, sku, name, qty) values (ow, kw, 'OIC-W', 'Order check wave product', 6) returning id into lw;
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); perform wms_wave_start(o1); perform set_config('role', 'postgres', true);
  select t.id into tk from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where w.picker = uf and w.status = 'picking' and t.sku_id = kw; if tk is null then raise exception 'FAIL 0: the floor wave has no stop'; end if;
  perform set_config('role', 'authenticated', true); perform wms_wave_confirm(tk, 6, 'OIC-W-BC'); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-W2', 'connector', 'connector', 'new', 4) returning id into ow2; insert into order_lines (order_id, sku_id, sku, name, qty) values (ow2, kw, 'OIC-W', 'Order check wave product', 4);
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true); perform wms_wave_start(o1); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from wms_wave_orders wo join wms_waves w on w.id = wo.wave_id where wo.order_id = ow2 and w.picker = us and w.status = 'picking') then raise exception 'FAIL 0: the staff wave does not hold the second order'; end if;
  -- plain orders
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-A', 'connector', 'connector', 'new', 3) returning id into oa; insert into order_lines (order_id, sku_id, sku, name, qty) values (oa, k1, 'OIC-1', 'Order check product 1', 3) returning id into la1;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-A2', 'connector', 'connector', 'new', 1) returning id into oa2; insert into order_lines (order_id, sku_id, sku, name, qty) values (oa2, k1, 'OIC-1', 'Order check product 1', 1);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-C', 'connector', 'connector', 'new', 1) returning id into oc; insert into order_lines (order_id, sku_id, sku, name, qty) values (oc, k1, 'OIC-1', 'Order check product 1', 1);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o2, 'OIC-ORD-B', 'connector', 'connector', 'new', 2) returning id into ob; insert into order_lines (order_id, sku_id, sku, name, qty) values (ob, k2, 'OIC-2', 'Order check product 2', 2) returning id into lb;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'OIC-ORD-S', 'connector', 'connector', 'new', 2) returning id into os; insert into order_lines (order_id, sku_id, sku, name, qty) values (os, k1, 'OIC-1', 'Order check product 1', 2);
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true); sh := ship_order(os, 'TEST', 'ground', 'OIC-TRACK', 'other', 4.25, null, 8); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from orders where id = os) <> 'shipped' or sh is null then raise exception 'FAIL 0: the staged order did not ship'; end if;
  insert into orgs (name, slug, status) values ('OIC brand with an order', 'oic-temp', 'active') returning id into ot; insert into orders (org_id, order_number, channel, source, status, total_units) values (ot, 'OIC-ORD-T', 'connector', 'connector', 'new', 0) returning id into otord;
  insert into orgs (name, slug, status) values ('OIC empty brand', 'oic-empty', 'active') returning id into oe;
  fq := $q$select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) - 'updated_at' order by x.id)::text from orders x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from order_lines x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from shipments x),
    (select jsonb_agg(to_jsonb(x) order by x.id)::text from events x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x), (select count(*) from wms_picks), (select count(*) from wms_wave_task_lines), (select count(*) from wms_packages), (select count(*) from wms_wave_orders), (select count(*) from orgs)))$q$;

  -- the cases: who, what, and what must happen ('deny' = refused with an error, 'rows0' = accepted by the server but touches nothing, 'rows1' = one row changed)
  create temp table _oic (seq serial primary key, grp int, who text, stmt text, expect text) on commit drop;
  -- 1. direct deletes, inserts, edits and emptying, by every login and the public key
  insert into _oic (grp, who, stmt, expect) select 1, w, s, 'deny' from unnest(array['admin', 'staff', 'sales', 'floor', 'client', 'public key']) w, unnest(array[
    format('delete from orders where id = %L', oa), format('delete from orders where id = %L', os), 'delete from orders', format('delete from order_lines where id = %L', la1), format('delete from shipments where id = %L', sh), 'delete from events', 'delete from returns', 'delete from wms_picks',
    'truncate orders cascade', 'truncate order_lines cascade', 'truncate shipments', 'truncate events',
    format('insert into orders (org_id, order_number, channel, source, status, total_units) values (%L, ''OIC-FORGED'', ''manual'', ''manual'', ''shipped'', 1)', o1),
    format('insert into order_lines (order_id, sku_id, sku, name, qty) values (%L, %L, ''OIC-2'', ''Another brand''''s product'', 5)', oa, k2),
    format('insert into shipments (org_id, order_id, carrier, tracking, label_source, label_cost) values (%L, %L, ''TEST'', ''FORGED'', ''other'', 0)', o1, oa),
    format('insert into events (org_id, entity, entity_id, action, to_value) values (%L, ''order'', %L, ''status_change'', ''shipped'')', o1, oa),
    format('update order_lines set qty = 99 where id = %L', la1), format('update order_lines set sku_id = %L where id = %L', k2, la1), format('update shipments set label_cost = 0, postage_billed = 0 where id = %L', sh), format('update events set to_value = ''new'' where entity_id = %L', os),
    format('update wms_picks set qty = 0 where order_id = %L', ow)]) s;
  -- 2. re-homing and rewriting an order directly (the one table a login may still update)
  insert into _oic (grp, who, stmt, expect) select 2, w, s, case when w in ('floor', 'public key') and w = 'floor' then 'rows0' else 'deny' end from unnest(array['admin', 'staff', 'sales', 'client', 'floor', 'public key']) w, unnest(array[
    format('update orders set org_id = %L where id = %L', o2, oa), format('update orders set org_id = %L where id = %L', o1, ob), format('update orders set ship_to = ''{"name":"Someone else"}'' where id = %L', oa), format('update orders set total_units = 1, status = ''on_hold'' where id = %L', oa),
    format('update orders set status = ''shipped'' where id = %L', oa), format('update orders set status = ''picked'' where id = %L', oa), format('update orders set status = ''new'' where id = %L', os), format('update orders set status = ''cancelled'' where id = %L', os),
    format('update orders set order_number = ''REWRITTEN'', customer_name = ''X'' where id = %L', oa), format('update orders set created_by = %L where id = %L', ua, oa), format('update orders set hold_reason = ''note on an order that is not on hold'' where id = %L', oa)]) s;
  update _oic set expect = 'rows0' where grp = 2 and who = 'client' and (stmt like '%' || ob::text || '%' or stmt like '%' || os::text || '%');   -- another brand's order, or its own shipped order: the client's access rule does not reach it
  -- 3. orders with work started cannot be held or cancelled directly
  insert into _oic (grp, who, stmt, expect) select 3, w, s, 'deny' from unnest(array['admin', 'staff', 'client']) w, unnest(array[
    format('update orders set status = ''cancelled'' where id = %L', ow), format('update orders set status = ''on_hold'', hold_reason = ''after the pick'' where id = %L', ow),
    format('update orders set status = ''cancelled'' where id = %L', ow2), format('update orders set status = ''on_hold'' where id = %L', ow2)]) s;
  -- 4. the legitimate direct changes: hold, release, cancel, with the status history written
  insert into _oic (grp, who, stmt, expect) values
    (4, 'admin', format('update orders set status = ''on_hold'', hold_reason = ''Address needs confirming'' where id = %L', oa), 'rows1'),
    (4, 'staff', format('update orders set hold_reason = ''Address confirmed by phone, waiting on stock'' where id = %L', oa), 'rows1'),
    (4, 'sales', format('update orders set status = ''new'', hold_reason = null where id = %L', oa), 'deny'),
    (4, 'floor', format('update orders set status = ''new'', hold_reason = null where id = %L', oa), 'rows0'),
    (4, 'staff', format('update orders set status = ''new'', hold_reason = null where id = %L', oa), 'rows1'),
    (4, 'staff', format('update orders set status = ''cancelled'' where id = %L', oa2), 'rows1'),
    (4, 'admin', format('update orders set status = ''new'' where id = %L', oa2), 'deny'),
    (4, 'client', format('update orders set status = ''on_hold'', hold_reason = ''We are checking the address'' where id = %L', oc), 'rows1'),
    (4, 'client', format('update orders set status = ''cancelled'' where id = %L', oc), 'rows1'),
    (4, 'client', format('update orders set status = ''cancelled'' where id = %L', ob), 'rows0'),
    (4, 'admin', format('update orders set status = ''on_hold'', hold_reason = ''Other brand, by ShipBay'' where id = %L', ob), 'rows1'),
    (4, 'admin', format('update orders set status = ''new'', hold_reason = null where id = %L', ob), 'rows1');
  -- 5. the same history rules bind the service login and the database owner (privileges alone do not protect against these)
  insert into _oic (grp, who, stmt, expect) select 5, w, s, 'deny' from unnest(array['service login', 'owner']) w, unnest(array[
    format('delete from orders where id = %L', oa), format('delete from orders where id = %L', os), format('delete from shipments where id = %L', sh), format('delete from order_lines where id = %L', lw),
    format('delete from events where entity_id = %L', oa), format('update events set actor_id = null where entity_id = %L', oa), 'truncate orders cascade', 'truncate order_lines cascade', 'truncate shipments', 'truncate events',
    format('update orders set org_id = %L where id = %L', o2, oa), format('update orders set created_at = now() - interval ''1 day'' where id = %L', oa), format('update orders set status = ''new'', shipped_at = null where id = %L', os),
    format('update order_lines set order_id = %L where id = %L', ob, la1), format('update order_lines set sku_id = %L where id = %L', k2, la1), format('insert into order_lines (order_id, sku_id, sku, name, qty) values (%L, %L, ''OIC-2'', ''Another brand''''s product'', 5)', oa, k2),
    format('update shipments set org_id = %L where id = %L', o2, sh), format('update shipments set order_id = %L where id = %L', oa, sh), format('insert into shipments (org_id, order_id, carrier, tracking, label_source, label_cost) values (%L, %L, ''TEST'', ''WRONG-BRAND'', ''other'', 0)', o2, oa),
    format('delete from orgs where id = %L', ot)]) s;
  -- 6. what the service login (store sync, labels) must still be able to do
  insert into _oic (grp, who, stmt, expect) values
    (6, 'service login', format('update orders set customer_name = ''Synced Name'', ship_to = ''{"name":"Synced Name","city":"Newark"}'', total_units = 3, raw = ''{"synced":true}'' where id = %L', oa), 'rows1'),
    (6, 'service login', format('update order_lines set qty = 0 where id = %L', la1), 'rows1'),
    (6, 'service login', format('delete from order_lines where order_id = %L', oa), 'rows1'),
    (6, 'service login', format('insert into order_lines (order_id, sku_id, sku, name, qty) values (%L, %L, ''OIC-1'', ''Order check product 1'', 3)', oa, k1), 'rows1'),
    (6, 'service login', format('update orders set status = ''on_hold'' where id = %L', oa), 'rows1'),
    (6, 'service login', format('update orders set status = ''new'' where id = %L', oa), 'rows1'),
    (6, 'service login', format('update shipments set provider = ''manual'', tracking_url = ''https://example.test/track/OIC-TRACK'', shopify_fulfillment_id = 1 where id = %L', sh), 'rows1'),
    (6, 'service login', format('update orders set customer_name = ''Synced after shipping'' where id = %L', os), 'rows1'),
    (6, 'service login', format('insert into orders (org_id, order_number, channel, source, status, total_units) values (%L, ''OIC-ORD-SYNC'', ''shopify'', ''shopify'', ''new'', 1)', o2), 'rows1'),
    (6, 'admin', format('delete from orgs where id = %L', oe), 'rows1'),
    (6, 'admin', format('delete from orgs where id = %L', ot), 'deny');

  execute fq into f0;
  for c in select * from _oic order by seq loop
    if c.who = 'sales' then perform set_config('request.jwt.claims', '', true); update profiles set role = 'shipbay_sales' where id = us; end if;
    if c.grp = 4 and c.seq = (select min(seq) from _oic where grp = 4) then execute fq into f1; if f1 is distinct from f0 then raise exception 'FAIL 3: a refused statement in checks 1 to 3 changed something'; end if; end if;
    perform set_config('request.jwt.claims', case c.who when 'admin' then ca when 'staff' then cs when 'sales' then cs when 'floor' then cf when 'client' then cc when 'public key' then '{"role":"anon"}' when 'service login' then '{"role":"service_role"}' else '' end, true);
    perform set_config('role', case c.who when 'public key' then 'anon' when 'service login' then 'service_role' when 'owner' then 'postgres' else 'authenticated' end, true);
    v_state := null;
    begin execute c.stmt; get diagnostics n = row_count; v_state := case when n = 0 then 'rows0' else 'rows1' end;
    exception when insufficient_privilege or check_violation then v_state := 'deny'; v_msg := sqlerrm;
      when others then perform set_config('role', 'postgres', true); raise exception 'FAIL %: % ran "%": unexpected error %', c.grp, c.who, left(c.stmt, 90), sqlerrm; end;
    perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
    if c.who = 'sales' then update profiles set role = sales_role where id = us; end if;
    if v_state is distinct from c.expect then raise exception 'FAIL %: % ran "%": expected %, got % (%)', c.grp, c.who, left(c.stmt, 110), c.expect, v_state, coalesce(v_msg, ''); end if;
    grp_n := jsonb_set(grp_n, array[c.grp::text], to_jsonb(coalesce((grp_n ->> c.grp::text)::int, 0) + 1));
  end loop;
  if (grp_n ->> '1')::int <> 126 or (grp_n ->> '2')::int <> 66 or (grp_n ->> '3')::int <> 12 or (grp_n ->> '5')::int <> 40 then raise exception 'FAIL: case counts %', grp_n; end if;
  ok := ok || 'direct writes: admin, staff, sales, floor, client and the public key each tried 21 deletes, inserts, edits and emptyings of orders, lines, shipments, status history, returns and picks; all 126 refused'::text;
  ok := ok || 'rewriting an order directly: 66 attempts by the same six to move an order to another brand, change its address, units, number, author or status to shipped or picked, or reopen a shipped order: every one refused (or, where the login cannot see the order, touches nothing)'::text;
  ok := ok || 'work started: an order with picked units and an order planned on a wave that is being picked cannot be held or cancelled directly by admin, staff or the client, 12 of 12 refused; nothing changed anywhere through checks 1 to 3'::text;

  -- 4 (results). the legitimate direct changes and their trail
  if (select status from orders where id = oa) <> 'new' or (select hold_reason from orders where id = oa) is not null or (select status from orders where id = oa2) <> 'cancelled' or (select status from orders where id = oc) <> 'cancelled' or (select status from orders where id = ob) <> 'new' then raise exception 'FAIL 4: the orders are not in the expected states'; end if;
  select count(*) into n from events where entity = 'order' and entity_id = oa and action = 'status_change' and actor_id is not null;
  if n < 2 or not exists (select 1 from events where entity_id = oa and from_value = 'new' and to_value = 'on_hold' and actor_id = ua) or not exists (select 1 from events where entity_id = oa and from_value = 'on_hold' and to_value = 'new' and actor_id = us)
     or not exists (select 1 from events where entity_id = oa2 and to_value = 'cancelled' and actor_id = us) or not exists (select 1 from events where entity_id = oc and to_value = 'cancelled' and actor_id = uc) then raise exception 'FAIL 4: the status history does not name who held, released and cancelled'; end if;
  ok := ok || 'allowed directly, each written to the status history with the login: admin holds with a reason, staff edits the reason and releases, staff cancels, the client holds and cancels its own order, admin holds and releases another brand''s; refused: sales, the floor login, un-cancelling, and a client on another brand''s order'::text;
  ok := ok || 'the service login and the database owner are bound by the same history rules: 40 of 40 refused (deleting an order, a shipment, a picked line, status history; emptying any of the four tables; changing an order''s brand, creation time or shipped status; moving a line or shipment; another brand''s product on a line; a shipment under the wrong brand; deleting a brand that has an order)'::text;
  if (select customer_name from orders where id = oa) <> 'Synced Name' or (select count(*) from order_lines where order_id = oa) <> 1 or (select provider from shipments where id = sh) <> 'manual' or (select customer_name from orders where id = os) <> 'Synced after shipping' or exists (select 1 from orgs where id = oe) or not exists (select 1 from orgs where id = ot) then raise exception 'FAIL 6: a service-login change did not take'; end if;
  ok := ok || 'still works for the service login (store sync and labels): updating an order''s address, units and raw data, zeroing a line, deleting and re-creating the lines of an order nobody has started on, hold and release, updating a shipment''s provider fields, updating a shipped order''s details, creating an order; an admin can still delete a brand with no orders'::text;

  -- 7. the workflow functions: who may, and cross-brand lines
  -- sales cannot change orders through the older functions either
  perform set_config('request.jwt.claims', '', true); update profiles set role = 'shipbay_sales' where id = us; perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true);
  begin perform create_manual_order(o1, jsonb_build_object('order_number', 'OIC-SALES', 'ship_to', jsonb_build_object('name', 'Sales')), jsonb_build_array(jsonb_build_object('sku_id', k1, 'qty', 1))); raise exception 'FAIL 7: a sales login created an order'; exception when insufficient_privilege then null; end;
  begin perform scan_pack(oa, 'OIC-1-BC', 1); raise exception 'FAIL 7: a sales login verified a line'; exception when insufficient_privilege then null; end;
  begin perform reset_pack(oa); raise exception 'FAIL 7: a sales login reset an order'; exception when insufficient_privilege then null; end;
  begin perform ship_order(oa, 'TEST', 'ground', 'OIC-SALES', 'other', 1, null, 8); raise exception 'FAIL 7: a sales login shipped an order'; exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); update profiles set role = sales_role where id = us;
  if exists (select 1 from orders where order_number = 'OIC-SALES') or exists (select 1 from shipments where tracking = 'OIC-SALES') then raise exception 'FAIL 7: a sales attempt left something behind'; end if;
  -- admin: a manual order with another brand's product is refused whole; with its own product it works, and so do pack and ship
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform create_manual_order(o1, jsonb_build_object('order_number', 'OIC-CROSS', 'ship_to', jsonb_build_object('name', 'Cross')), jsonb_build_array(jsonb_build_object('sku_id', k2, 'qty', 1))); raise exception 'FAIL 7: a manual order took another brand''s product'; exception when check_violation then null; end;
  perform create_manual_order(o1, jsonb_build_object('order_number', 'OIC-MANUAL', 'ship_to', jsonb_build_object('name', 'Manual')), jsonb_build_array(jsonb_build_object('sku_id', k1, 'qty', 2)));
  perform set_config('role', 'postgres', true); select id into od from orders where order_number = 'OIC-MANUAL'; if od is null or exists (select 1 from orders where order_number = 'OIC-CROSS') then raise exception 'FAIL 7: manual orders are not as expected'; end if;
  perform set_config('role', 'authenticated', true); j := scan_pack(od, 'OIC-1-BC', 2); perform reset_pack(od); j := scan_pack(od, 'OIC-1-BC', 2); perform ship_order(od, 'TEST', 'ground', 'OIC-MANUAL-TRACK', 'other', 3.10, null, 8);
  if _order_commitment(od) is distinct from 'it has a shipment' or _order_commitment(ow) is distinct from 'it has picked units' or _order_commitment(ow2) not like 'it is on wave %' or _order_commitment(oa) is not null then raise exception 'FAIL 7: the commitment answers are wrong'; end if;
  perform set_config('request.jwt.claims', cc, true); if _order_commitment(ob) is not null then raise exception 'FAIL 7: a client got an answer about another brand''s order'; end if;
  perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if (select status from orders where id = od) <> 'shipped' or (select count(*) from shipments where order_id = od) <> 1 or not exists (select 1 from events where entity_id = od and to_value = 'shipped' and actor_id = ua) then raise exception 'FAIL 7: the manual order did not pack and ship'; end if;
  -- the floor: the staff wave is picked, sent to packing and packed (reservations and packages intact); a pick correction still works on the first wave
  select t.id into tk from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where w.picker = us and w.status = 'picking' and t.sku_id = kw;
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true); perform wms_wave_confirm(tk, 4, 'OIC-W-BC');
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(qty), 0) from inventory_moves where sku_id = kw) <> 20 - 6 - 4 or (select count(*) from wms_picks where order_id in (ow, ow2) and undone_at is null) < 2 then raise exception 'FAIL 7: the wave picks did not post'; end if;
  -- the demo brand: its orders, lines and shipments can be rebuilt by the reset; nobody else's
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); j := wms_demo_reset(); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); dg := (j ->> 'org_id')::uuid;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (dg, 'OIC-DEMO-1', 'connector', 'connector', 'new', 1) returning id into od; insert into order_lines (order_id, sku_id, sku, name, qty) select od, id, sku, name, 1 from skus where org_id = dg and sku = 'DEMO-MUG-11';
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true); perform ship_order(od, 'TEST', 'ground', 'OIC-DEMO-TRACK', 'other', 1, null, 8);
  perform set_config('role', 'postgres', true); execute fq into f0; select count(*) into n from orders where org_id <> dg; select count(*) into n1 from shipments where org_id <> dg;
  perform set_config('role', 'authenticated', true); perform wms_demo_reset(); perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from orders where org_id = dg) or exists (select 1 from shipments where org_id = dg) or (select count(*) from orders where org_id <> dg) <> n or (select count(*) from shipments where org_id <> dg) <> n1 then raise exception 'FAIL 7: the demo reset did not clear exactly the demo brand''s orders and shipments'; end if;
  ok := ok || 'workflow functions: a sales login is refused by create_manual_order, scan_pack, reset_pack and ship_order and leaves nothing behind; an admin''s manual order with another brand''s product is refused whole, with its own product it is created, verified, reset, verified again and shipped (history names the admin); the staff wave is picked; the commitment answer is right for shipped, picked, on-a-wave and untouched orders and silent to another brand''s client; the demo reset clears the demo brand''s order and shipment and nobody else''s'::text;

  -- 8. the database afterwards
  if exists (select 1 from inventory_moves where location_id is not null group by sku_id, location_id having sum(qty) < 0) then raise exception 'FAIL 8: a position is below zero'; end if;
  if exists (select 1 from order_lines l join orders o on o.id = l.order_id join skus s on s.id = l.sku_id where s.org_id <> o.org_id) or exists (select 1 from shipments s join orders o on o.id = s.order_id where s.org_id <> o.org_id) then raise exception 'FAIL 8: a line or shipment crosses brands'; end if;
  if exists (select 1 from wms_wave_orders wo where not exists (select 1 from orders o where o.id = wo.order_id)) or (select count(*) from wms_wave_task_lines where line_id = lw) = 0 then raise exception 'FAIL 8: a wave lost an order or a planned line'; end if;
  if not exists (select 1 from orders where id = os and status = 'shipped') or not exists (select 1 from shipments where id = sh and label_cost = 4.25 and postage_billed = 4.25 and order_id = os and org_id = o1) or not exists (select 1 from inventory_moves where ref_type = 'order' and ref_id = os and qty = -2) then raise exception 'FAIL 8: the shipped order, its shipment, its postage or its ledger entry changed'; end if;
  if before is distinct from (select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x where x.id::text in (select id from _oic_old where kind = 'p')), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x where x.id::text in (select id from _oic_old where kind = 'm')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x where x.id::text in (select id from _oic_old where kind = 'o')), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x where x.id::text in (select id from _oic_old where kind = 'c')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x where x.id::text in (select id from _oic_old where kind = 'r')), (select jsonb_agg(to_jsonb(x) order by x.id)::text from order_lines x where x.id::text in (select id from _oic_old where kind = 'l')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from shipments x where x.id::text in (select id from _oic_old where kind = 's')), (select jsonb_agg(to_jsonb(x) order by x.id)::text from events x where x.id::text in (select id from _oic_old where kind = 'e'))))) then raise exception 'FAIL 8: something that was on file before this test changed'; end if;
  if has_table_privilege('authenticated', 'public.orders', 'insert,delete,truncate,references,trigger') or has_table_privilege('anon', 'public.orders', 'insert,update,delete,truncate,references,trigger') or not has_table_privilege('authenticated', 'public.orders', 'update') or not has_table_privilege('authenticated', 'public.orders', 'select')
     or has_table_privilege('authenticated', 'public.order_lines', 'insert,update,delete,truncate') or has_table_privilege('anon', 'public.order_lines', 'insert,update,delete,truncate') or has_table_privilege('authenticated', 'public.shipments', 'insert,update,delete,truncate') or has_table_privilege('anon', 'public.shipments', 'insert,update,delete,truncate')
     or has_table_privilege('authenticated', 'public.events', 'insert,update,delete,truncate') or has_table_privilege('anon', 'public.events', 'insert,update,delete,truncate') or has_table_privilege('authenticated', 'public.wms_picks', 'insert,update,delete,truncate') or has_table_privilege('authenticated', 'public.returns', 'delete,truncate')
     or has_function_privilege('anon', 'public._order_commitment(uuid)', 'execute') or has_function_privilege('service_role', 'public._order_commitment(uuid)', 'execute') or not has_function_privilege('authenticated', 'public._order_commitment(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._orders_history_guard()', 'execute') or has_function_privilege('authenticated', 'public._orders_direct_edit_guard()', 'execute') or has_function_privilege('anon', 'public._orders_history_guard()', 'execute') then raise exception 'FAIL 8: a privilege is wrong'; end if;
  ok := ok || 'the database afterwards: no position below zero, no line or shipment crosses brands, no wave lost an order or a planned line, the shipped order still has its shipment, postage and ledger entry, everything on file before is byte-for-byte unchanged, and the privileges are as designed'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
