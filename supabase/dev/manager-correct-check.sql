-- Fifth database check for the isolated development database (shipbay-nexus-dev): the manager's access to pick corrections of
-- candidate 20261206 (dev_034). A manager must find a floor picker's stop under its own brand and nowhere else; every unsupported
-- state must be refused with nothing changed; an accepted correction must post once, with the reason and who. Runs as the
-- synthetic logins and always ends by raising an exception, so everything it did is rolled back.
-- A pass ends with:  ROLLBACK-OK 5 checks passed: ...
-- It works only with products, bookings, orders and pallets it creates itself, at positions P-60 to P-62 and shelves A-01 and
-- A-02, and sends nothing to Nexus: a put-away or release "accepted by Nexus" is the journal row committed the way the bridge
-- does it. Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1'; o2 uuid := '5a000000-0000-4000-8000-0000000000a2';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; us uuid := '5b000000-0000-4000-8000-000000000003'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; cs text := json_build_object('sub', us, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  ka uuid; kb uuid; kk uuid; ba uuid; bb uuid; pa wms_pallets; pb wms_pallets; pk wms_pallets; ta uuid; tb uuid; tk uuid; wk uuid; ord uuid; j jsonb; n int; u int; n1 int; u1 int; before text; m inventory_moves; act wms_activity; ok text[] := '{}'; who text; msg text;
begin
  if exists (select 1 from orgs where id <> all (array[o1, o2])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if exists (select 1 from wms_pallets x join locations l on l.id = x.location_id where l.code in ('P-60', 'P-61', 'P-62')) then raise exception 'FAIL 0: a position this test uses is taken. Not running.'; end if;
  if not exists (select 1 from pg_proc where proname = 'wms_manager_stop_correct') then raise exception 'FAIL 0: the manager pick-correction functions (dev_034) are not installed.'; end if;
  if exists (select 1 from wms_waves where status in ('picking', 'packing') and picker in (uf, us)) then raise exception 'FAIL 0: a synthetic login has a wave open. Not running.'; end if;
  select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x),
    (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x))) into before;
  create temp table _mgc_old on commit drop as select 'p' kind, id::text from wms_pallets union all select 'm', id::text from inventory_moves union all select 'o', id::text from wms_nexus_ops union all select 'c', id::text from wms_cartons union all select 'r', id::text from orders;

  -- staging: one product and booking per pallet, three pallets put away, three orders, three waves
  insert into skus (org_id, sku, name) values (o1, 'MGC-A', 'Check product A') returning id into ka; insert into skus (org_id, sku, name) values (o2, 'MGC-B', 'Check product B') returning id into kb; insert into skus (org_id, sku, name) values (o1, 'MGC-K', 'Check product K') returning id into kk;
  insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values (o1, 'MGC-PO-A', 'expected', 2, 20, current_date, now()) returning id into ba;
  insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values (o2, 'MGC-PO-B', 'expected', 1, 10, current_date, now()) returning id into bb;
  insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (ba, ka, 100, 0), (ba, kk, 100, 0), (bb, kb, 100, 0);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into pa from wms_receive_booking(ba, o1, jsonb_build_array(jsonb_build_object('sku', ka, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'mgc-a', 'partial', null);
  select * into pk from wms_receive_booking(ba, o1, jsonb_build_array(jsonb_build_object('sku', kk, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'mgc-k', 'partial', null);
  select * into pb from wms_receive_booking(bb, o2, jsonb_build_array(jsonb_build_object('sku', kb, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'mgc-b', 'partial', null);
  j := wms_putaway_begin(pa.psku, 'P-60'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_putaway_begin(pb.psku, 'P-61'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_putaway_begin(pk.psku, 'P-62'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'MGC-ORD-A', 'connector', 'connector', 'new', 6) returning id into ord; insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, ka, 'MGC-A', 'Check product A', 6);
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o2, 'MGC-ORD-B', 'connector', 'connector', 'new', 7) returning id into ord; insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, kb, 'MGC-B', 'Check product B', 7);
  perform set_config('role', 'authenticated', true); perform wms_wave_start(o1); perform wms_wave_start(o2); perform set_config('role', 'postgres', true);
  select t.id into ta from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where w.picker = uf and w.status = 'picking' and t.pallet_id = pa.id; select t.id into tb from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where w.picker = uf and w.status = 'picking' and t.pallet_id = pb.id;
  if ta is null or tb is null then raise exception 'FAIL 0: the staged waves have no stop at the staged pallets'; end if;
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'MGC-ORD-K', 'connector', 'connector', 'new', 6) returning id into ord; insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, kk, 'MGC-K', 'Check product K', 6);
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true); perform wms_wave_start(o1); perform set_config('role', 'postgres', true);
  select t.id, t.wave_id into tk, wk from wms_wave_tasks t join wms_waves w on w.id = t.wave_id where w.picker = us and w.status = 'picking' and t.pallet_id = pk.id; if tk is null then raise exception 'FAIL 0: the staff wave has no stop'; end if;

  -- 1. states that are refused, and change nothing: not picked yet, pallet on the floor, at the pack station
  select count(*), coalesce(sum(qty), 0) into n, u from inventory_moves;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_manager_stop_correct(o1, ta, 'A-01', 'Checked before the pick'); raise exception 'FAIL 1: a stop that was not picked was corrected'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has not been picked yet%' then raise exception 'FAIL 1: wrong refusal for a planned stop: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cf, true); perform wms_wave_confirm(ta, 6, (select min(code) from wms_cartons where pallet_id = pa.id)); perform wms_wave_confirm(tb, 7, (select min(code) from wms_cartons where pallet_id = pb.id));
  perform set_config('request.jwt.claims', cs, true); perform wms_wave_confirm(tk, 6, (select min(code) from wms_cartons where pallet_id = pk.id)); perform wms_wave_to_pack(wk);
  perform set_config('role', 'postgres', true); select count(*), coalesce(sum(qty), 0) into n, u from inventory_moves; perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_manager_stop_correct(o1, ta, 'A-01', 'Checked while on the floor'); raise exception 'FAIL 1: a stop whose pallet is on the floor was corrected'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%is still on the floor at P-60%' then raise exception 'FAIL 1: wrong refusal on the floor: %', sqlerrm; end if; end;
  if jsonb_array_length(wms_manager_stops(o1)) <> 0 or jsonb_array_length(wms_manager_stops(o2)) <> 0 then raise exception 'FAIL 1: a pick is listed while its pallet is on the floor'; end if;
  -- the three pallets leave the building (release accepted by Nexus = the journal row committed)
  perform set_config('request.jwt.claims', cf, true);
  j := wms_release_begin(pa.psku, 'P-60', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_release_begin(pb.psku, 'P-61', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_release_begin(pk.psku, 'P-62', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_manager_stop_correct(o1, tk, 'A-01', 'Checked at the pack station'); raise exception 'FAIL 1: a pick at the pack station was corrected'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%is at the pack station%' then raise exception 'FAIL 1: wrong refusal at the pack station: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true); select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if (n1, u1) <> (n, u) then raise exception 'FAIL 1: a refusal changed the ledger'; end if;
  ok := ok || 'a stop not picked yet, a stop whose pallet is still on the floor and a pick at the pack station are each refused in words, and none of it touched the ledger'::text;

  -- 2. who can see and correct
  foreach who in array array[cf, cc] loop
    perform set_config('request.jwt.claims', who, true); perform set_config('role', 'authenticated', true);
    begin perform wms_manager_stops(o1); raise exception 'FAIL 2: a floor or client login read the manager list'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
    begin perform wms_manager_stop_correct(o1, ta, 'A-01', 'Tried by a login that may not'); raise exception 'FAIL 2: a floor or client login corrected a pick'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
    begin perform _wms_stop_correct_block(ta); raise exception 'FAIL 2: the internal check was callable'; exception when insufficient_privilege then null; end;
    perform set_config('role', 'postgres', true);
  end loop;
  select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if (n1, u1) <> (n, u) then raise exception 'FAIL 2: a refused login changed the ledger'; end if;
  ok := ok || 'the floor and client logins can neither read the list nor correct, and cannot call the internal check'::text;

  -- 3. brand isolation
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true);
  j := wms_manager_stops(o1);
  if jsonb_array_length(j) <> 2 or j::text like '%MGC-B%' or not exists (select 1 from jsonb_array_elements(j) x where x ->> 'task' = ta::text and x ->> 'picker' like 'Test Floor%' and (x ->> 'units')::int = 6 and x ->> 'picked_from' = 'P-60' and x ->> 'pallet' = pa.psku and x -> 'blocked' = 'null'::jsonb)
     or not exists (select 1 from jsonb_array_elements(j) x where x ->> 'task' = tk::text and x ->> 'wave_status' = 'packing' and x ->> 'blocked' like '%is at the pack station%') then raise exception 'FAIL 3: brand A list is wrong: %', j; end if;
  j := wms_manager_stops(o2); if jsonb_array_length(j) <> 1 or j -> 0 ->> 'task' <> tb::text or j::text like '%MGC-A%' or j::text like '%MGC-K%' then raise exception 'FAIL 3: brand B list is wrong: %', j; end if;
  begin perform wms_manager_stop_correct(o2, ta, 'A-01', 'Brand A stop under brand B'); raise exception 'FAIL 3: a stop was corrected under another brand''s name'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm <> 'That stop is not one of this brand''s.' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  begin perform wms_manager_stop_correct(o1, tb, 'A-01', 'Brand B stop under brand A'); raise exception 'FAIL 3: a stop was corrected under another brand''s name'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm <> 'That stop is not one of this brand''s.' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true); select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; if (n1, u1) <> (n, u) then raise exception 'FAIL 3: a cross-brand attempt changed the ledger'; end if;
  ok := ok || 'each brand''s list holds only its own picks (the floor picker''s, and staff''s at the pack station with the reason it is refused); a stop named under the other brand is refused'::text;

  -- 4. the correction: reason required, shelf must be a private one, then once
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true);
  begin perform wms_manager_stop_correct(o1, ta, 'A-01', 'no'); raise exception 'FAIL 4: corrected with no reason'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm <> 'Say why this pick is being corrected.' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  begin perform wms_manager_stop_correct(o1, ta, 'P-60', 'Back to where it was'); raise exception 'FAIL 4: units returned to a shared position'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%is a shared Nexus position%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  j := wms_manager_stop_correct(o1, ta, 'A-01', 'Order changed after the pallet shipped'); perform set_config('role', 'postgres', true);
  select count(*), coalesce(sum(qty), 0) into n1, u1 from inventory_moves; select * into m from inventory_moves where ref_id = ta and qty > 0; select * into act from wms_activity where kind = 'pick_corrected' and ref = pa.psku;   -- every row of this check carries the same timestamp: find the row by its stop, not by time
  if (n1 - n, u1 - u) <> (1, 6) or (select count(*) from inventory_moves where ref_id = ta and qty > 0) <> 1 or m.qty <> 6 or m.reason <> 'pick' or m.created_by <> us or m.org_id <> o1 or m.ref_id <> ta or m.pallet_id is not null or m.location_id <> (select id from locations where code = 'A-01')
     or m.note not like '%stop corrected by Test Staff%: Order changed after the pallet shipped' then raise exception 'FAIL 4: the ledger row is wrong: %', to_jsonb(m); end if;
  if act.actor <> us or act.detail ->> 'reason' <> 'Order changed after the pallet shipped' or act.detail ->> 'returned_to' <> 'A-01' or act.detail ->> 'picked_at' <> 'P-60' then raise exception 'FAIL 4: the activity entry is wrong: %', act.detail; end if;
  if (j ->> 'units_returned')::int <> 6 or j ->> 'picker' not like 'Test Floor%' or jsonb_array_length(j -> 'stops') <> 1 then raise exception 'FAIL 4: the answer is wrong: %', j; end if;
  if not exists (select 1 from wms_wave_tasks t join locations l on l.id = t.location_id where t.id = ta and l.code = 'A-01' and t.confirmed_at is null and t.qty_picked is null and t.pallet_id is null and t.qty_planned = 6) then raise exception 'FAIL 4: the stop did not reopen at the shelf'; end if;
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_manager_stop_correct(o1, ta, 'A-02', 'A second time'); raise exception 'FAIL 4: the same pick was corrected twice'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has not been picked yet%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  j := wms_manager_stop_correct(o2, tb, 'A-02', 'Customer cancelled after the pallet left'); perform set_config('role', 'postgres', true);
  select * into m from inventory_moves where ref_id = tb and qty > 0; if m.qty <> 7 or m.org_id <> o2 or m.created_by <> ua or m.location_id <> (select id from locations where code = 'A-02') then raise exception 'FAIL 4: brand B''s correction row is wrong: %', to_jsonb(m); end if;
  ok := ok || 'a correction needs a reason and a private shelf; staff''s posts ONE row (+6 on A-01) naming staff, the stop and the reason, with an activity entry, and the picker''s stop reopens at the shelf; a second correction of the same pick is refused; the admin''s for the other brand posts under that brand'::text;

  -- 5. the database afterwards
  if exists (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0) then raise exception 'FAIL 5: a position is below zero'; end if;
  if exists (select 1 from inventory_moves where reason = 'receive' and ref_type = 'wms_pallet' group by ref_id, sku_id, location_id having count(*) > 1) then raise exception 'FAIL 5: a pallet was received twice'; end if;
  if (select sum(qty) from inventory_moves) <> (select sum(on_hand) from inventory_levels) then raise exception 'FAIL 5: the stock view and the ledger disagree'; end if;
  if (select coalesce(sum(qty), 0) from inventory_moves where sku_id in (ka, kb, kk)) <> 300 - 6 then raise exception 'FAIL 5: the staged stock does not add up (300 received, 6 picked and packed-bound, 13 returned to shelves)'; end if;
  if before is distinct from (select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x where x.id::text in (select id from _mgc_old where kind = 'p')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x where x.id::text in (select id from _mgc_old where kind = 'm')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x where x.id::text in (select id from _mgc_old where kind = 'o')),
      (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x where x.id::text in (select id from _mgc_old where kind = 'c')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from orders x where x.id::text in (select id from _mgc_old where kind = 'r'))))) then raise exception 'FAIL 5: something that was on file before this test changed'; end if;
  if has_function_privilege('anon', 'public.wms_manager_stops(uuid)', 'execute') or has_function_privilege('anon', 'public.wms_manager_stop_correct(uuid, uuid, text, text)', 'execute') or has_function_privilege('authenticated', 'public._wms_stop_correct_block(uuid)', 'execute')
     or has_function_privilege('service_role', 'public._wms_stop_correct_block(uuid)', 'execute') or not has_function_privilege('authenticated', 'public.wms_manager_stop_correct(uuid, uuid, text, text)', 'execute') then raise exception 'FAIL 5: a privilege is wrong'; end if;
  ok := ok || 'the database afterwards: no position below zero, no pallet received twice, the stock view equals the ledger, the staged stock adds up, everything on file before is byte-for-byte unchanged, and the functions are closed to the public key'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
