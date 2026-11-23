-- Third database check for the isolated development database (shipbay-nexus-dev): the void and unit-count safety rules of
-- candidate 20261204 (dev_032). Refusals must change nothing; a legitimate correction must be exact, reasoned and on record.
-- Runs as the synthetic logins and always ends by raising an exception, so everything it did is rolled back.
-- A pass ends with:  ROLLBACK-OK 7 checks passed: ...
-- It works only with pallets it receives itself, at positions P-56 to P-59, and sends nothing to Nexus: a "waiting" request is a
-- row in ShipBay's own journal that the bridge would normally send. Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  s1 uuid; k uuid; a wms_pallets; b wms_pallets; c wms_pallets; j jsonb; o_old uuid; l_old uuid; o_wave uuid; carton text; opb uuid; n int; u int; ok text[] := '{}'; before text; m inventory_moves; act wms_activity;
  t text; r record;
begin
  if exists (select 1 from orgs where id <> all (array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2']::uuid[])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if exists (select 1 from wms_pallets x join locations l on l.id = x.location_id where l.code in ('P-56', 'P-57', 'P-58', 'P-59')) then raise exception 'FAIL 0: a position this test uses is taken. Not running.'; end if;
  if not exists (select 1 from pg_proc where proname = 'wms_correct_units') then raise exception 'FAIL 0: the safety rules (dev_032) are not installed.'; end if;
  -- everything on file before this test: must be byte-for-byte the same at the end
  select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x),
    (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x))) into before;
  create temp table _ssc_old on commit drop as select 'p' kind, id::text from wms_pallets union all select 'm', id::text from inventory_moves union all select 'o', id::text from wms_nexus_ops union all select 'c', id::text from wms_cartons;
  select id into s1 from inbound_shipments where reference = 'SYN-PO-1001'; select id into k from skus where sku = 'SYN-LP-001';
  update locations set pickable = false where id in (select x.location_id from inventory_moves x group by 1 having sum(x.qty) <> 0);   -- stock already on file stays out of this test's picks (rolled back)

  -- pallet A: received, put away at P-56, 30 picked with the older pick list
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into a from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'ssc-a', 'partial', null);
  j := wms_putaway_begin(a.psku, 'P-56'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  select min(code) into carton from wms_cartons where pallet_id = a.id;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-SSC1', 'connector', 'connector', 'new', 30) returning id into o_old;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_old, k, 'SYN-LP-001', 'Synthetic LP, Black', 30) returning id into l_old;
  perform set_config('role', 'authenticated', true); perform wms_pick_scan(array[l_old], carton); perform set_config('role', 'postgres', true);
  if (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-56') <> 70 then raise exception 'FAIL 1: setup, P-56 should hold 70'; end if;

  -- 1 void after a partial pick: refused for admin and floor, nothing changes
  select count(*), sum(qty) into n, u from inventory_moves;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_void_pallet(a.id, 'synthetic void'); raise exception 'FAIL 1: a part-picked pallet was voided';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '30 of %units have been picked. A pallet that has been picked from cannot be voided%' then raise exception 'FAIL 1: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cf, true);
  begin perform wms_void_pallet(a.id, 'synthetic void'); raise exception 'FAIL 1: a part-picked pallet was voided by the floor login';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%have been picked%' then raise exception 'FAIL 1: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select status from wms_pallets where id = a.id) <> 'stored'
     or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-56') <> 70 or (select count(*) from wms_picks where pallet_id = a.id and undone_at is null) <> 1 then raise exception 'FAIL 1: a refused void changed something'; end if;
  ok := ok || 'void after a partial pick (100 received, 30 picked): refused for admin and floor; the ledger, the pallet, the 70 at the position and the pick are unchanged'::text;

  -- 2 unsafe unit-count changes on the same pallet: every route refused, nothing changes
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  begin perform wms_set_units(a.id, null, 2); raise exception 'FAIL 2: the floor login changed the count of a put-away pallet';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%is put away, so changing its count changes stock. A ShipBay admin or staff login corrects it, with a reason%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_correct_units(a.id, null, 9, 'Recount'); raise exception 'FAIL 2: the floor login made a correction';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cc, true);
  begin perform wms_correct_units(a.id, null, 9, 'Recount'); raise exception 'FAIL 2: a client login made a correction';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_set_units(a.id, null, 9); raise exception 'FAIL 2: a client login changed a count';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot change a pallet%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_void_pallet(a.id, 'x'); raise exception 'FAIL 2: a client login voided';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot void pallets%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_correct_units(a.id, null, 2, 'Recount'); raise exception 'FAIL 2: the count went below what was picked';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%hold 20 of SYN-LP-001, and 30 have been picked from it. The count cannot go below that%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_correct_units(a.id, null, 0, 'Recount'); raise exception 'FAIL 2: the count went to zero under 30 picked';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%30 have been picked from it%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_correct_units(a.id, null, 9, '   '); raise exception 'FAIL 2: a correction with no reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_correct_units(a.id, null, 9, null); raise exception 'FAIL 2: a correction with no reason at all';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select max(units_per_carton) from wms_cartons where pallet_id = a.id) <> 10 or (select min(units_per_carton) from wms_cartons where pallet_id = a.id) <> 10
     or exists (select 1 from wms_activity where kind = 'pallet_units_corrected' and ref = a.psku) then raise exception 'FAIL 2: a refused count change changed something'; end if;
  ok := ok || 'unsafe unit-count changes: floor and client refused, below-picked and zero refused, a missing reason refused; cartons, ledger and activity log unchanged'::text;

  -- 3 a legitimate correction: admin, with a reason; exactly one ledger row and one activity row, both accurate
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  j := wms_correct_units(a.id, null, 9, 'Recounted at the position: 9 per carton'); perform set_config('role', 'postgres', true);
  if (j ->> 'units_change')::int <> -10 or (j ->> 'from')::int <> 10 or (j ->> 'to')::int <> 9 or (select count(*) from inventory_moves) <> n + 1 or (select sum(qty) from inventory_moves) <> u - 10
     or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-56') <> 60 then raise exception 'FAIL 3: the correction posted the wrong amount: %', j; end if;
  select * into m from inventory_moves where ref_type = 'wms_pallet' and ref_id = a.id and reason = 'adjust';
  if m.qty <> -10 or m.note <> a.psku || ' count corrected: Recounted at the position: 9 per carton' or m.created_by <> ua or m.sku_id <> k or (select code from locations where id = m.location_id) <> 'P-56' or m.org_id <> o1
     or (select count(*) from inventory_moves where ref_type = 'wms_pallet' and ref_id = a.id and reason = 'adjust') <> 1 then raise exception 'FAIL 3: the ledger row is wrong: %', to_jsonb(m); end if;
  select * into act from wms_activity where kind = 'pallet_units_corrected' and ref = a.psku;
  if (select count(*) from wms_activity where kind = 'pallet_units_corrected' and ref = a.psku) <> 1 or act.qty <> 10 or act.actor <> ua or act.org_id <> o1 or act.actor_name is null
     or act.detail <> jsonb_build_object('item', null, 'from', 10, 'to', 9, 'units_change', -10, 'position', 'P-56', 'reason', 'Recounted at the position: 9 per carton') then raise exception 'FAIL 3: the activity record is wrong: %', to_jsonb(act); end if;
  if (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = a.id and reason = 'receive') <> '1:100' then raise exception 'FAIL 3: the receipt changed'; end if;
  -- staff can too, upward, and the same value again posts nothing
  perform set_config('role', 'authenticated', true); j := wms_correct_units(a.id, null, 10, 'Tenth unit found in each carton'); t := (wms_correct_units(a.id, null, 10, 'Checked again')) ->> 'units_change'; perform set_config('role', 'postgres', true);
  if (j ->> 'units_change')::int <> 10 or t <> '0' or (select count(*) from inventory_moves) <> n + 2 or (select sum(qty) from inventory_moves) <> u
     or (select count(*) from wms_activity where kind = 'pallet_units_corrected' and ref = a.psku) <> 2 then raise exception 'FAIL 3: the second correction'; end if;
  ok := ok || 'a legitimate correction (admin, reason given): exactly the difference is posted once, the ledger row carries the reason, position and who, the activity log has old count, new count, change, position and reason; a repeat of the same value posts nothing; the receipt is untouched'::text;

  -- 4 a wave has a pick planned from the pallet: no void, no count below picked + planned
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-SSC2', 'connector', 'connector', 'new', 12) returning id into o_wave;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_wave, k, 'SYN-LP-001', 'Synthetic LP, Black', 12);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); j := wms_wave_start(o1);
  if (j -> 'wave' -> 'tasks' -> 0 ->> 'location') <> 'P-56' or (j -> 'wave' -> 'tasks' -> 0 ->> 'qty_planned')::int <> 12 then raise exception 'FAIL 4: setup, the wave did not plan 12 from P-56: %', j -> 'wave' -> 'tasks'; end if;
  perform set_config('role', 'postgres', true); select count(*), sum(qty) into n, u from inventory_moves; perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_void_pallet(a.id, 'synthetic void'); raise exception 'FAIL 4: voided under a planned pick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Wave % still has a pick planned from %' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  begin perform wms_correct_units(a.id, null, 4, 'Recount'); raise exception 'FAIL 4: the count went below picked plus planned';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%hold 40 of SYN-LP-001, and 30 have been picked from it with 12 more planned by a wave%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select count(*) from wms_wave_tasks t2 where t2.pallet_id = a.id and t2.confirmed_at is null and t2.qty_planned = 12) <> 1 then raise exception 'FAIL 4: a refusal changed something'; end if;
  ok := ok || 'planned wave stop: the void is refused and the count cannot go below what was picked plus the 12 the wave has planned; the ledger and the stop are unchanged'::text;

  -- 5 a movement Nexus has not settled: no void and no count change, for a waiting put-away, a waiting move and an out-of-sync request
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into b from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'ssc-b', 'partial', null);
  j := wms_putaway_begin(b.psku, 'P-57'); opb := (j ->> 'op')::uuid;   -- waiting: the bridge has not sent it, nothing is committed
  perform set_config('role', 'postgres', true); select count(*), sum(qty) into n, u from inventory_moves; perform set_config('role', 'authenticated', true);
  begin perform wms_set_units(b.id, null, 5); raise exception 'FAIL 5: count changed under a waiting put-away';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot be changed yet: it has a request for P-57 that Nexus has not answered%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_void_pallet(b.id, 'synthetic void'); raise exception 'FAIL 5: voided under a waiting put-away';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot be voided yet: it has a request for P-57 that Nexus has not answered%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_commit(opb);
  perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claims', cf, true); j := wms_move_begin(b.psku, 'P-58'); opb := (j ->> 'op')::uuid; perform set_config('request.jwt.claims', ca, true);
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n + 1 or (select sum(qty) from inventory_moves) <> u + 100 then raise exception 'FAIL 5: setup, the put-away should have posted one receipt of 100'; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_void_pallet(b.id, 'synthetic void'); raise exception 'FAIL 5: voided under a waiting move';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot be voided yet: it has a request for P-58 that Nexus has not answered%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_correct_units(b.id, null, 5, 'Recount'); raise exception 'FAIL 5: corrected under a waiting move';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot be corrected yet: it has a request for P-58 that Nexus has not answered%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  -- Nexus accepted, ShipBay could not record: still not settled
  perform set_config('role', 'service_role', true); perform wms_nexus_op_note(opb, 'out_of_sync', 200, 'not_recorded', 'synthetic'); perform set_config('role', 'authenticated', true);
  begin perform wms_void_pallet(b.id, 'synthetic void'); raise exception 'FAIL 5: voided while out of sync';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Nexus accepted P-58 and ShipBay has not recorded it. An admin settles that%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  begin perform wms_correct_units(b.id, null, 5, 'Recount'); raise exception 'FAIL 5: corrected while out of sync';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Nexus accepted P-58 and ShipBay has not recorded it. An admin settles that%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n + 1 or (select sum(qty) from inventory_moves) <> u + 100 or (select status from wms_pallets where id = b.id) <> 'stored' or (select max(units_per_carton) from wms_cartons where pallet_id = b.id) <> 10
     or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-57') <> 100 or (select state from wms_nexus_ops where id = opb) <> 'out_of_sync' then raise exception 'FAIL 5: a refusal changed something'; end if;
  ok := ok || 'unsettled Nexus movement (waiting put-away, waiting move, out of sync): void and count change refused each time; the only ledger change is the one receipt from the put-away that was committed; the request is still waiting for its admin'::text;

  -- 6 a pallet that left the building: no void, no count change, its units stay on the books
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into c from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'ssc-c', 'partial', null);
  j := wms_putaway_begin(c.psku, 'P-59'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_release_begin(c.psku, 'P-59', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  perform set_config('role', 'postgres', true); select count(*), sum(qty) into n, u from inventory_moves; perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_void_pallet(c.id, 'synthetic void'); raise exception 'FAIL 6: a departed pallet was voided';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the building and cannot be voided%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  begin perform wms_correct_units(c.id, null, 1, 'Recount'); raise exception 'FAIL 6: a departed pallet was corrected';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the building%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  begin perform wms_set_units(c.id, null, 1); raise exception 'FAIL 6: a departed pallet was recounted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the building%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select status from wms_pallets where id = c.id) <> 'departed' or (select max(units_per_carton) from wms_cartons where pallet_id = c.id) <> 10
     or (select sum(qty) from inventory_moves where ref_id = c.id or pallet_id = c.id) <> 100 then raise exception 'FAIL 6: a refusal changed something'; end if;
  ok := ok || 'departed pallet: void and count change refused; it stays departed with its 100 units on the books for the outbound transaction'::text;

  -- 7 the whole database after all of that
  if exists (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0) then raise exception 'FAIL 7: a position is below zero'; end if;
  if exists (select 1 from inventory_moves where reason = 'receive' group by ref_id having count(*) > 1) then raise exception 'FAIL 7: a pallet has two receipts'; end if;
  if (select count(*) from inventory_moves where reason = 'receive' and ref_id in (a.id, b.id, c.id)) <> 3 or (select sum(qty) from inventory_moves where reason = 'receive' and ref_id in (a.id, b.id, c.id)) <> 300 then raise exception 'FAIL 7: receipts of the test pallets'; end if;
  if (select coalesce(sum(qty), 0) from inventory_moves where reason = 'transfer') <> 0 or (select sum(qty) from inventory_moves) <> (select sum(on_hand) from inventory_levels) then raise exception 'FAIL 7: totals'; end if;
  if before is distinct from (select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x where x.id::text in (select id from _ssc_old where kind = 'p')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x where x.id::text in (select id from _ssc_old where kind = 'm')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x where x.id::text in (select id from _ssc_old where kind = 'o')),
      (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x where x.id::text in (select id from _ssc_old where kind = 'c'))))) then raise exception 'FAIL 7: something that was on file before this test changed'; end if;
  if has_function_privilege('anon', 'public.wms_correct_units(uuid, text, integer, text)', 'execute') or has_function_privilege('anon', 'public.wms_set_units(uuid, text, integer)', 'execute') or has_function_privilege('anon', 'public.wms_void_pallet(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.wms_correct_units(uuid, text, integer, text)', 'execute') then raise exception 'FAIL 7: a privilege is wrong'; end if;
  ok := ok || 'the database afterwards: no position below zero, no pallet with two receipts, one receipt of 100 for each test pallet, transfers net to zero, the stock view equals the ledger, every pallet, ledger row, journal entry and carton that was on file before is byte-for-byte unchanged, and none of the three functions is open to the public key'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
