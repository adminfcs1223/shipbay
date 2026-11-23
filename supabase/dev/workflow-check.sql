-- Second database check for the isolated development database (shipbay-nexus-dev): the parts of the day-to-day flow
-- regression.sql does not walk. Pick, pack-station hand-over, packing into a labelled package, the older pick list with a
-- pallet that moves, the manager's pick correction, and a client login's view. Runs as the synthetic logins and always ends
-- by raising an exception, so everything it did is rolled back. A pass ends with:  ROLLBACK-OK 6 checks passed: ...
-- It works only with a pallet it receives itself, at positions P-53 to P-55, and leaves every existing pallet alone.
-- Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
  s1 uuid; k uuid; p wms_pallets; j jsonb; o_wave uuid; o_old uuid; l_old uuid; task uuid; wave uuid; n int; base int; carton text; ok text[] := '{}'; before jsonb;
begin
  if exists (select 1 from orgs where id <> all (array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2']::uuid[])) then raise exception 'FAIL 0: not the synthetic development database. Not running.'; end if;
  if exists (select 1 from wms_pallets x join locations l on l.id = x.location_id where l.code in ('P-53', 'P-54', 'P-55')) then raise exception 'FAIL 0: a position this test uses is taken. Not running.'; end if;
  select jsonb_build_object('pallets', (select md5(jsonb_agg(to_jsonb(x) order by x.psku)::text) from wms_pallets x), 'rows', (select count(*) from inventory_moves), 'units', (select coalesce(sum(qty), 0) from inventory_moves), 'ops', (select count(*) from wms_nexus_ops)) into before;
  select id into s1 from inbound_shipments where reference = 'SYN-PO-1001'; select id into k from skus where sku = 'SYN-LP-001';
  update locations set pickable = false where id in (select m.location_id from inventory_moves m group by 1 having sum(m.qty) <> 0);   -- stock already on file stays out of this test's picks
  select coalesce(sum(qty), 0) into base from inventory_moves;

  -- 1 receive, labels, put away
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select * into p from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k, 'cartons', 10, 'units_per_carton', 10)), 1, null, 'wfc-1', 'partial', null);
  j := wms_putaway_begin(p.psku, 'P-53'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  select min(code) into carton from wms_cartons where pallet_id = p.id;
  if p.psku !~ '^PSKU-[0-9]{6}$' or carton !~ '^C[0-9]{8}$' or (select count(*) from wms_cartons where pallet_id = p.id and code ~ '^C[0-9]{8}$') <> 10 or (select sum(qty) from inventory_moves) <> base + 100 then raise exception 'FAIL 1: receive/labels/put-away % %', p.psku, carton; end if;
  ok := ok || 'receiving makes one pallet label and ten carton labels in the usual formats; put-away posts its 100 units once'::text;

  -- 2 wave pick, hand over to the pack station, pack into one labelled package
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-WFC1', 'connector', 'connector', 'new', 3) returning id into o_wave;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_wave, k, 'SYN-LP-001', 'Synthetic LP, Black', 3);
  perform set_config('role', 'authenticated', true); j := wms_wave_start(o1); wave := (j -> 'wave' ->> 'id')::uuid; task := (j -> 'wave' -> 'tasks' -> 0 ->> 'id')::uuid;
  begin perform wms_wave_to_pack(wave); raise exception 'FAIL 2: went to packing with a stop unpicked';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%still to pick%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform wms_wave_confirm(task, 3, carton); j := wms_wave_to_pack(wave);
  if (j ->> 'status') <> 'packing' then raise exception 'FAIL 2: not at the pack station: %', j ->> 'status'; end if;
  begin perform wms_wave_pack(wave, array[o_wave], '[{"items":[{"key":"SYN-LP-001","qty":2}],"weight_oz":12,"packaging":"mailer"}]'::jsonb); raise exception 'FAIL 2: packed with a unit missing';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%do not add up%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  j := wms_wave_pack(wave, array[o_wave], '[{"items":[{"key":"SYN-LP-001","qty":3}],"weight_oz":12,"packaging":"mailer"}]'::jsonb); perform set_config('role', 'postgres', true);
  if (select status from orders where id = o_wave) <> 'packed' or (j ->> 'status') <> 'done' or (select count(*) from wms_packages where order_id = o_wave and code ~ '^PKG-[0-9]{7}$' and seq = 1 and of_n = 1) <> 1
     or (select sum(qty) from inventory_moves) <> base + 97 then raise exception 'FAIL 2: pack'; end if;
  ok := ok || 'wave pick and pack: a wave cannot go to packing with a stop unpicked, packages must hold every unit, the order ends packed with one package label, and stock is down by exactly the 3 picked'::text;

  -- 3 the older pick list: the pick names its pallet, travels with it, and an undo lands where the pallet stands now
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-WFC2', 'connector', 'connector', 'new', 7) returning id into o_old;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (o_old, k, 'SYN-LP-001', 'Synthetic LP, Black', 7) returning id into l_old;
  perform set_config('role', 'authenticated', true); perform wms_pick_scan(array[l_old], carton); perform set_config('role', 'postgres', true);
  if (select pallet_id from inventory_moves where ref_id = l_old and reason = 'pick') is distinct from p.id or (select pallet_id from wms_picks where line_id = l_old) is distinct from p.id then raise exception 'FAIL 3: the older pick does not name its pallet'; end if;
  perform set_config('role', 'authenticated', true); j := wms_move_begin(p.psku, 'P-54'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-53') <> 0 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-54') <> 90 or (select sum(qty) from inventory_moves) <> base + 90 then raise exception 'FAIL 3: the move did not carry what was left'; end if;
  perform set_config('role', 'authenticated', true); perform wms_unpick(array[l_old]); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-53') <> 0 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-54') <> 97 then raise exception 'FAIL 3: the undo went to the old position'; end if;
  ok := ok || 'older pick list: the pick names its pallet; after a move the old position holds nothing and the new one holds what is left; an undo puts the units back where the pallet stands now'::text;

  -- 4 the pallet leaves the floor: undo is refused, the manager's correction returns the units to a ShipBay shelf only
  perform set_config('role', 'authenticated', true); perform wms_pick_scan(array[l_old], carton);
  j := wms_release_begin(p.psku, 'P-54', 'moved_off_shared_floor', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  n := (select sum(qty) from inventory_moves);
  begin perform wms_unpick(array[l_old]); raise exception 'FAIL 4: a pick was undone onto a pallet that has left the floor';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the shared floor%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  begin perform wms_pick_correct('order_line', l_old, 'A-01', 'Units came back from packing'); raise exception 'FAIL 4: the floor login corrected a pick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Only ShipBay admin or staff%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_pick_correct('order_line', l_old, 'P-54', 'Units came back from packing'); raise exception 'FAIL 4: units were returned to a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  begin perform wms_pick_correct('order_line', l_old, 'A-01', ' '); raise exception 'FAIL 4: corrected without a reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Say why%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  j := wms_pick_correct('order_line', l_old, 'A-01', 'Units came back from packing'); perform set_config('role', 'postgres', true);
  if (j ->> 'units_returned')::int <> 7 or (select sum(qty) from inventory_moves) <> n + 7 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'A-01') <> 7
     or (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code in ('P-53', 'P-54')) <> 0 or (select picked_at from order_lines where id = l_old) is not null
     or (select count(*) from wms_activity where kind = 'pick_corrected') <> 1 or exists (select 1 from inventory_moves where reason = 'adjust') then raise exception 'FAIL 4: correction'; end if;
  ok := ok || 'pallet off the floor: undo is refused; the correction is admin-only, needs a reason, refuses a shared position, and returns exactly the 7 picked units to the shelf with a log entry and no adjustment'::text;

  -- 5 inventory totals: one receipt, transfers net to zero, the view equals the ledger
  if (select count(*) from inventory_moves where ref_id = p.id and reason = 'receive') <> 1 or (select coalesce(sum(qty), 0) from inventory_moves where reason = 'transfer') <> 0
     or (select sum(qty) from inventory_moves) <> (select sum(on_hand) from inventory_levels) or (select sum(qty) from inventory_moves) <> base + 97 then raise exception 'FAIL 5: totals'; end if;
  ok := ok || 'totals: one receipt for the pallet, transfers net to zero, the stock view equals the ledger, and the only change from 100 is the 3 units packed'::text;

  -- 6 authorization: a client login can do none of it and sees only its own brand; nobody without a login reaches these functions
  perform set_config('request.jwt.claims', cc, true); perform set_config('role', 'authenticated', true);
  begin perform wms_wave_start(o1); raise exception 'FAIL 6: a client login started a pick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot work orders%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  begin perform wms_pick_scan(array[l_old], carton); raise exception 'FAIL 6: a client login picked';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot pick%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  begin perform wms_nexus_exceptions(); raise exception 'FAIL 6: a client login read the exceptions report';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Only ShipBay admin or staff%' then raise exception 'FAIL 6: %', sqlerrm; end if; end;
  if (select count(*) from orgs) <> 1 or exists (select 1 from wms_pallets where org_id <> o1) then raise exception 'FAIL 6: a client login sees another brand'; end if;
  perform set_config('role', 'postgres', true);
  if has_function_privilege('anon', 'public.wms_pick_correct(text, uuid, text, text)', 'execute') or has_function_privilege('anon', 'public.wms_nexus_exceptions()', 'execute') or has_function_privilege('anon', 'public.wms_wave_start(uuid, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public._wms_can_pick(uuid, uuid)', 'execute') or has_function_privilege('authenticated', 'public.dev_fault_hold(text, text)', 'execute') or has_function_privilege('authenticated', 'public.dev_movement_snapshot()', 'execute')
     or has_table_privilege('authenticated', 'public.dev_runner_runs', 'select') then raise exception 'FAIL 6: a privilege is too wide'; end if;
  ok := ok || 'authorization: a client login cannot pick, start a wave or read the report and sees only its own brand; the new functions are closed to the public key and the helpers to every login'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
