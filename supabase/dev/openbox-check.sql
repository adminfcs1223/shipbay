-- Fourth database check for the isolated development database (shipbay-nexus-dev): the open-box rules of candidate 20261205
-- (dev_033). Refusals must change nothing; a box opened on a put-away pallet must move exactly its count; a corrected count
-- must be reasoned and on record. Runs as the synthetic logins and always ends by raising an exception, so everything it did is
-- rolled back. A pass ends with:  ROLLBACK-OK 8 checks passed: ...  (the first five and the last are the original six; 6 and 7
-- were added for the dev_033 verification: a wave pick and pack with boxes opened around it, and the admin, staff, floor and client roles)
-- It works only with pallets it receives itself, at positions P-60 to P-64 and shelf OB-01, and sends nothing to Nexus: a
-- "waiting" request is a row in ShipBay's own journal that the bridge would normally send. Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; uc uuid := '5b000000-0000-4000-8000-000000000004'; us uuid := '5b000000-0000-4000-8000-000000000003';
  cs text := json_build_object('sub', us, 'role', 'authenticated')::text; d wms_pallets; e wms_pallets; o_wave uuid; wave uuid; task uuid;
  cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  s1 uuid; k uuid; a wms_pallets; b wms_pallets; c wms_pallets; j jsonb; o_old uuid; l_old uuid; c1 text; c2 text; c3 text; opb uuid; n int; u int; nu int; ok text[] := '{}'; before text; act wms_activity; ob0 int;
begin
  if exists (select 1 from orgs where id <> all (array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2']::uuid[])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if exists (select 1 from wms_pallets x join locations l on l.id = x.location_id where l.code in ('P-60', 'P-61', 'P-62', 'P-63', 'P-64')) then raise exception 'FAIL 0: a position this test uses is taken. Not running.'; end if;
  if not exists (select 1 from pg_proc where proname = 'wms_open_box_correct') then raise exception 'FAIL 0: the open-box rules (dev_033) are not installed.'; end if;
  if not exists (select 1 from locations where code = 'OB-01' and active and not coalesce(shared, false)) then raise exception 'FAIL 0: the open-box shelf OB-01 is not on file.'; end if;
  select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x), (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x),
    (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x), (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_units x))) into before;
  create temp table _obc_old on commit drop as select 'p' kind, id::text from wms_pallets union all select 'm', id::text from inventory_moves union all select 'o', id::text from wms_nexus_ops union all select 'c', id::text from wms_cartons union all select 'u', id::text from wms_units;
  select id into s1 from inbound_shipments where reference = 'SYN-PO-1001'; select id into k from skus where sku = 'SYN-LP-001';
  select coalesce(sum(m.qty), 0) into ob0 from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OB-01' and m.sku_id = k;

  -- pallet A: received (a short box of 7 found at receiving), then put away at P-60
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into a from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'obc-a', 'partial', null);
  perform set_config('role', 'postgres', true); select count(*), coalesce(sum(qty), 0) into n, u from inventory_moves;
  select code into c1 from wms_cartons where pallet_id = a.id and seq = 1; select code into c2 from wms_cartons where pallet_id = a.id and seq = 2; select code into c3 from wms_cartons where pallet_id = a.id and seq = 3;
  perform set_config('role', 'authenticated', true); j := wms_open_box(c1, 7); perform set_config('role', 'postgres', true);
  if (j ->> 'location') <> 'OB-01' or (select count(*) from wms_units where pallet_id = a.id) <> 7 or (select count(*) from inventory_moves) <> n then raise exception 'FAIL 1: open box before put-away'; end if;
  perform set_config('role', 'authenticated', true); j := wms_putaway_begin(a.psku, 'P-60'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves) <> u + 97 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-60') <> 90
     or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OB-01' and m.sku_id = k) <> ob0 + 7 or exists (select 1 from inventory_moves where ref_id = a.id and reason <> 'receive') then raise exception 'FAIL 1: put-away after an open box'; end if;
  ok := ok || 'receiving is as before: a short box found before put-away is entered with its real count, posts nothing, and put-away then receives 90 at the position and 7 on the shelf, once each'::text;

  -- 2 on the put-away pallet: a different count is refused for the floor; the carton's own count moves exactly
  select count(*), sum(qty) into n, u from inventory_moves; select count(*) into nu from wms_units;
  perform set_config('role', 'authenticated', true);
  begin perform wms_open_box(c2, 25); raise exception 'FAIL 2: a carton of 10 was opened as 25';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%holds 10 on file, not 25. Opening it with a different count changes stock%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_open_box(c2, 4); raise exception 'FAIL 2: a carton of 10 was opened as 4';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%holds 10 on file, not 4%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_open_box(c2, 10, (select id from locations where code = 'P-61')); raise exception 'FAIL 2: loose units were put on a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  begin perform wms_open_box_correct(c2, 8, null, 'Two missing'); raise exception 'FAIL 2: the floor login corrected a count';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cc, true);
  begin perform wms_open_box(c2, 10); raise exception 'FAIL 2: a client login opened a box';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot open a box%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select count(*) from wms_units) <> nu or (select open_box_at from wms_cartons where code = c2) is not null then raise exception 'FAIL 2: a refusal changed something'; end if;
  perform set_config('role', 'authenticated', true); perform wms_open_box(c2, 10); perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n + 2 or (select sum(qty) from inventory_moves) <> u or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-60') <> 80
     or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OB-01' and m.sku_id = k) <> ob0 + 17 or (select count(*) from wms_units where pallet_id = a.id) <> 17
     or (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = a.id and reason = 'transfer') <> '2:0' or exists (select 1 from inventory_moves where ref_id = a.id and reason = 'adjust')
     or (select note from inventory_moves where ref_id = a.id and reason = 'transfer' and qty > 0) <> a.psku || ' carton 2 opened: 10 from P-60' then raise exception 'FAIL 2: the box did not move exactly its count'; end if;
  ok := ok || 'put-away pallet: a count other than the carton''s is refused for the floor, a shared position is refused as the shelf, a client login is refused, nothing changes; the carton''s own 10 then move as one transfer pair that nets to zero, with no adjustment and no new receipt'::text;

  -- 3 a real difference: admin, with a reason
  perform set_config('request.jwt.claims', ca, true); perform set_config('role', 'authenticated', true);
  begin perform wms_open_box_correct(c3, 8, null, '  '); raise exception 'FAIL 3: a correction with no reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  begin perform wms_open_box_correct(c3, 10, null, 'Same count'); raise exception 'FAIL 3: a correction with nothing to correct';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'A correction is only for%' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  perform wms_open_box_correct(c3, 8, null, 'Two units missing from the box'); perform set_config('role', 'postgres', true);
  select * into act from wms_activity where kind = 'open_box_corrected' and ref = a.psku;
  if (select sum(qty) from inventory_moves) <> u - 2 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-60') <> 70
     or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OB-01' and m.sku_id = k) <> ob0 + 25
     or (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = a.id and reason = 'transfer') <> '4:0'
     or (select count(*) || ':' || sum(qty) || ':' || min(note) || ':' || min(created_by::text) from inventory_moves where ref_id = a.id and reason = 'adjust') <> '1:-2:' || a.psku || ' carton 3 held 8, not 10: Two units missing from the box:' || ua::text
     or act.qty <> 2 or act.actor <> ua or (act.detail - 'carton_code') <> jsonb_build_object('carton', 3, 'on_file', 10, 'found', 8, 'units_change', -2, 'position', 'P-60', 'shelf', 'OB-01', 'reason', 'Two units missing from the box')
     or (select count(*) from wms_activity where kind = 'open_box_corrected' and ref = a.psku) <> 1 then raise exception 'FAIL 3: the corrected opening is wrong'; end if;
  ok := ok || 'a carton that really holds 8: admin only, reason required; 8 move as a transfer pair, the 2 missing are one adjustment carrying the reason and who, and the activity log has carton, count on file, count found, difference, position, shelf and reason'::text;

  -- 4 picked stock: 70 at P-60, pick all 70, then no carton can be opened from under it
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-OBC1', 'connector', 'connector', 'new', 70) returning id into o_old;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_old, k, 'SYN-LP-001', 'Synthetic LP, Black', 70) returning id into l_old;
  update locations set pickable = false where id in (select x.location_id from inventory_moves x group by 1 having sum(x.qty) <> 0) and code <> 'P-60';
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); perform wms_pick_scan(array[l_old], (select code from wms_cartons where pallet_id = a.id and seq = 4)); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-60') <> 0 then raise exception 'FAIL 4: setup, P-60 should hold 0 after the pick'; end if;
  select count(*), sum(qty) into n, u from inventory_moves; select count(*) into nu from wms_units; perform set_config('role', 'authenticated', true);
  begin perform wms_open_box((select code from wms_cartons where pallet_id = a.id and seq = 5), 10); raise exception 'FAIL 4: a box was opened from a position with nothing left';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%that would leave -10 of SYN-LP-001 at P-60%it cannot go below zero%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select count(*) from wms_units) <> nu then raise exception 'FAIL 4: a refusal changed something'; end if;
  ok := ok || 'picked stock: with everything at the position picked, opening another carton is refused and nothing goes below zero'::text;

  -- 5 a movement Nexus has not settled, and a pallet that left: no box is opened
  perform set_config('role', 'authenticated', true);
  select * into b from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'obc-b', 'partial', null);
  j := wms_putaway_begin(b.psku, 'P-61'); opb := (j ->> 'op')::uuid;
  begin perform wms_open_box((select code from wms_cartons where pallet_id = b.id and seq = 1), 10); raise exception 'FAIL 5: opened under a waiting put-away';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%can be opened yet: it has a request for P-61 that Nexus has not answered%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_commit(opb); perform set_config('role', 'authenticated', true);
  j := wms_move_begin(b.psku, 'P-62'); opb := (j ->> 'op')::uuid;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_note(opb, 'out_of_sync', 200, 'not_recorded', 'synthetic'); perform set_config('role', 'authenticated', true);
  begin perform wms_open_box((select code from wms_cartons where pallet_id = b.id and seq = 1), 10); raise exception 'FAIL 5: opened while out of sync';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Nexus accepted P-62 and ShipBay has not recorded it%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  select * into c from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'obc-c', 'partial', null);
  j := wms_putaway_begin(c.psku, 'P-62'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  j := wms_release_begin(c.psku, 'P-62', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  begin perform wms_open_box((select code from wms_cartons where pallet_id = c.id and seq = 1), 10); raise exception 'FAIL 5: a box of a departed pallet was opened';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the building%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from wms_units where pallet_id in (b.id, c.id)) <> 0 or exists (select 1 from wms_cartons where pallet_id in (b.id, c.id) and open_box_at is not null)
     or (select sum(qty) from inventory_moves where ref_id = b.id) <> 100 or (select sum(qty) from inventory_moves where ref_id = c.id) <> 100 then raise exception 'FAIL 5: a refusal changed something'; end if;
  ok := ok || 'unsettled Nexus request (waiting, out of sync) and a departed pallet: no box is opened, no unit label is made, each pallet still has exactly its 100 on the books'::text;

  -- 6 wave picking and packing with boxes opened around it (pallet D at P-63, 100 units, a wave planning 85)
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into d from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'obc-d', 'partial', null);
  j := wms_putaway_begin(d.psku, 'P-63'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  update locations set pickable = false where id in (select x.location_id from inventory_moves x group by 1 having sum(x.qty) <> 0) and code <> 'P-63';
  update locations set pickable = false where code = 'P-60';
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-OBC2', 'connector', 'connector', 'new', 85) returning id into o_wave;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_wave, k, 'SYN-LP-001', 'Synthetic LP, Black', 85);
  select sum(qty) into u from inventory_moves;
  perform set_config('role', 'authenticated', true); j := wms_wave_start(o1); wave := (j -> 'wave' ->> 'id')::uuid; task := (j -> 'wave' -> 'tasks' -> 0 ->> 'id')::uuid;
  if (j -> 'wave' -> 'tasks' -> 0 ->> 'location') is distinct from 'P-63' or (j -> 'wave' -> 'tasks' -> 0 ->> 'qty_planned')::int is distinct from 85 then raise exception 'FAIL 6: setup, the wave did not plan 85 from P-63: %', j; end if;
  perform wms_open_box((select code from wms_cartons where pallet_id = d.id and seq = 1), 10);   -- 100 there, 85 planned: one carton can still leave
  begin perform wms_open_box((select code from wms_cartons where pallet_id = d.id and seq = 2), 10); raise exception 'FAIL 6: a carton was opened from under a planned pick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%that would leave 80 of SYN-LP-001 at P-63, and 85 are needed there for picks a wave has planned%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_open_box_correct((select code from wms_cartons where pallet_id = d.id and seq = 2), 9, null, 'One missing'); raise exception 'FAIL 6: a corrected opening took planned stock';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%85 are needed there for picks a wave has planned%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves) <> u or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-63') <> 90 or (select count(*) from wms_units where pallet_id = d.id) <> 10 then raise exception 'FAIL 6: opening around a planned pick'; end if;
  perform set_config('role', 'authenticated', true); perform wms_wave_confirm(task, 85, (select code from wms_cartons where pallet_id = d.id and seq = 3));
  begin perform wms_open_box((select code from wms_cartons where pallet_id = d.id and seq = 2), 10); raise exception 'FAIL 6: a carton was opened from under picked stock';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%that would leave -5 of SYN-LP-001 at P-63%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  j := wms_wave_to_pack(wave); if (j ->> 'status') <> 'packing' then raise exception 'FAIL 6: not at the pack station: %', j ->> 'status'; end if;
  j := wms_wave_pack(wave, array[o_wave], '[{"items":[{"key":"SYN-LP-001","qty":85}],"weight_oz":12,"packaging":"mailer"}]'::jsonb); perform set_config('role', 'postgres', true);
  if (j ->> 'status') <> 'done' or (select status from orders where id = o_wave) <> 'packed' or (select count(*) from wms_packages where order_id = o_wave) <> 1 or (select sum(qty) from inventory_moves) <> u - 85
     or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-63') <> 5 or (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = d.id and reason = 'receive') <> '1:100' then raise exception 'FAIL 6: wave pick and pack after an opened box'; end if;
  ok := ok || 'wave pick and pack with dev_033 loaded: with 85 planned at a position holding 100, one carton can be opened and a second cannot (floor or admin); the stop is picked, a further carton is refused, the wave goes to the pack station and the order is packed into one package; stock is down by exactly the 85 picked and the pallet has its one receipt'::text;

  -- 7 who may correct a count: admin and shipbay_staff, each with a reason; not the floor, not a client, not the public key
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into e from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'obc-e', 'partial', null);
  j := wms_putaway_begin(e.psku, 'P-64'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  select count(*), sum(qty) into n, u from inventory_moves; select count(*) into nu from wms_units; c1 := (select code from wms_cartons where pallet_id = e.id and seq = 1); c2 := (select code from wms_cartons where pallet_id = e.id and seq = 2);
  perform set_config('role', 'authenticated', true);
  begin perform wms_open_box_correct(c1, 9, null, 'One missing'); raise exception 'FAIL 7: the floor login corrected a count';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Only ShipBay admin or staff%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  begin perform _wms_open_box_do(c1, 9, null, 'One missing'); raise exception 'FAIL 7: the floor login reached the internal function';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', cc, true);
  begin perform wms_open_box_correct(c1, 9, null, 'One missing'); raise exception 'FAIL 7: a client login corrected a count';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot open a box%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cs, true);
  begin perform wms_open_box_correct(c1, 9, null, ''); raise exception 'FAIL 7: staff corrected with no reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  begin perform wms_open_box_correct(c1, 9, null, 'no'); raise exception 'FAIL 7: staff corrected with a two-letter reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_open_box_correct(c1, 9, null, null); raise exception 'FAIL 7: admin corrected with no reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like 'Say why%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from inventory_moves) <> n or (select sum(qty) from inventory_moves) <> u or (select count(*) from wms_units) <> nu or exists (select 1 from wms_cartons where pallet_id = e.id and open_box_at is not null) then raise exception 'FAIL 7: a refusal changed something'; end if;
  perform set_config('request.jwt.claims', cs, true); perform set_config('role', 'authenticated', true); perform wms_open_box_correct(c1, 9, null, 'One unit missing, staff recount');
  perform set_config('request.jwt.claims', ca, true); perform wms_open_box_correct(c2, 12, null, 'Twelve in this carton, admin recount'); perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves) <> u + 1 or (select sum(x.qty) from inventory_moves x join locations l on l.id = x.location_id where l.code = 'P-64') <> 80
     or (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = e.id and reason = 'transfer') <> '4:0' or (select count(*) from inventory_moves where ref_id = e.id and reason = 'adjust') <> 2
     or (select qty || '/' || created_by::text || '/' || (select code from locations where id = x.location_id) || '/' || note from inventory_moves x where ref_id = e.id and reason = 'adjust' and qty < 0) <> '-1/' || us::text || '/P-64/' || e.psku || ' carton 1 held 9, not 10: One unit missing, staff recount'
     or (select qty || '/' || created_by::text || '/' || (select code from locations where id = x.location_id) || '/' || note from inventory_moves x where ref_id = e.id and reason = 'adjust' and qty > 0) <> '2/' || ua::text || '/OB-01/' || e.psku || ' carton 2 held 12, not 10: Twelve in this carton, admin recount'
     or (select string_agg(actor::text || ':' || actor_name || ':' || (detail ->> 'units_change') || ':' || (detail ->> 'reason'), ' | ' order by id) from wms_activity where kind = 'open_box_corrected' and ref = e.psku)
        <> us::text || ':Test Staff (synthetic):-1:One unit missing, staff recount | ' || ua::text || ':Test Admin (synthetic):2:Twelve in this carton, admin recount'
     or (select count(*) || ':' || sum(qty) from inventory_moves where ref_id = e.id and reason = 'receive') <> '1:100' then raise exception 'FAIL 7: the staff or admin correction is wrong'; end if;
  ok := ok || 'roles: floor and client logins cannot correct a count and the floor cannot reach the internal function; shipbay_staff and admin each need a reason of substance; a staff correction (9 in a carton of 10) and an admin correction (12 in a carton of 10) each post one transfer pair and one adjustment naming the person, the place and the reason, with one activity entry each'::text;

  -- 8 the whole database after all of that
  if exists (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0) then raise exception 'FAIL 8: a position is below zero'; end if;
  if exists (select 1 from inventory_moves where reason = 'receive' group by ref_id, sku_id, location_id having count(*) > 1) then raise exception 'FAIL 8: a pallet was received twice at one place'; end if;
  if exists (select 1 from inventory_moves where reason = 'transfer' group by ref_id having sum(qty) <> 0) or (select sum(qty) from inventory_moves) <> (select sum(on_hand) from inventory_levels) then raise exception 'FAIL 8: totals'; end if;
  if before is distinct from (select md5(concat_ws('|', (select jsonb_agg(to_jsonb(x) order by x.psku)::text from wms_pallets x where x.id::text in (select id from _obc_old where kind = 'p')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from inventory_moves x where x.id::text in (select id from _obc_old where kind = 'm')),
      (select jsonb_agg(to_jsonb(x) order by x.id)::text from wms_nexus_ops x where x.id::text in (select id from _obc_old where kind = 'o')),
      (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_cartons x where x.id::text in (select id from _obc_old where kind = 'c')),
      (select jsonb_agg(to_jsonb(x) order by x.code)::text from wms_units x where x.id::text in (select id from _obc_old where kind = 'u'))))) then raise exception 'FAIL 8: something that was on file before this test changed'; end if;
  if has_function_privilege('anon', 'public.wms_open_box(text, integer, uuid)', 'execute') or has_function_privilege('anon', 'public.wms_open_box_correct(text, integer, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public._wms_open_box_do(text, integer, uuid, text)', 'execute') or not has_function_privilege('authenticated', 'public.wms_open_box_correct(text, integer, uuid, text)', 'execute') then raise exception 'FAIL 8: a privilege is wrong'; end if;
  ok := ok || 'the database afterwards: no position below zero, no pallet received twice at one place, every transfer nets to zero, the stock view equals the ledger, everything on file before is byte-for-byte unchanged, and the functions are closed to the public key'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
