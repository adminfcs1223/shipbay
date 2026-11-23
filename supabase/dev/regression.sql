-- Database regression test for the isolated development database (shipbay-nexus-dev).
-- Runs as the synthetic logins, checks fifteen behaviours, and always ends by raising an exception so that
-- everything it did is rolled back. A pass ends with:  ROLLBACK-OK 15 checks passed: ...
-- A failure ends with:  FAIL <n>: ...   Either way the database is left exactly as it was.
-- Needs the synthetic records (two brands, four logins, SYN-PO-1001..1003, one pallet on HOLD) and the v4 registry.
-- Never run this against production.
do $t$
declare
  o1 uuid := '5a000000-0000-4000-8000-0000000000a1';
  ua uuid := '5b000000-0000-4000-8000-000000000001'; uf uuid := '5b000000-0000-4000-8000-000000000002'; uc uuid := '5b000000-0000-4000-8000-000000000004';
  s1 uuid; s3 uuid; k1 uuid; ids uuid[]; pa wms_pallets; pb wms_pallets; pc wms_pallets; pd wms_pallets; ph wms_pallets;
  j jsonb; op uuid; fx jsonb; n int; plan jsonb; ord uuid; task uuid; ok text[] := '{}'; before jsonb; pk uuid;
  cf text := json_build_object('sub', uf, 'role', 'authenticated')::text; ca text := json_build_object('sub', ua, 'role', 'authenticated')::text; cc text := json_build_object('sub', uc, 'role', 'authenticated')::text;
begin
  if current_database() is null or exists (select 1 from orgs where id <> all (array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a2']::uuid[])) then
    raise exception 'FAIL 0: this database holds brands other than the two synthetic ones. Not running.';
  end if;
  select id into s1 from inbound_shipments where reference = 'SYN-PO-1001'; select id into s3 from inbound_shipments where reference = 'SYN-PO-1003';
  select id into k1 from skus where sku = 'SYN-LP-001'; select * into ph from wms_pallets w where w.held limit 1;

  -- 1 receiving: pallets and cartons are created, stock is not
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  select array_agg(id order by batch_pos) into ids from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k1, 'cartons', 10, 'units_per_carton', 10)), 4, null, 'reg-1', 'partial', null);
  perform 1 from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k1, 'cartons', 10, 'units_per_carton', 10)), 4, null, 'reg-1', 'partial', null);   -- same request again
  begin perform 1 from wms_receive_booking(s1, o1, jsonb_build_array(jsonb_build_object('sku', k1, 'cartons', 9, 'units_per_carton', 10)), 4, null, 'reg-1', 'partial', null); raise exception 'FAIL 1: a reused key with different content was accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%already used for a different receipt%' then raise exception 'FAIL 1: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  select * into pa from wms_pallets where id = ids[1]; select * into pb from wms_pallets where id = ids[2]; select * into pc from wms_pallets where id = ids[3]; select * into pd from wms_pallets where id = ids[4];
  if (select count(*) from wms_pallets where batch_key = 'reg-1') <> 4 or (select count(*) from wms_cartons where pallet_id = any(ids)) <> 40 then raise exception 'FAIL 1: pallets/cartons'; end if;
  if (select count(*) from inventory_moves) <> 0 then raise exception 'FAIL 1: stock posted at receipt'; end if;
  if pa.psku !~ '^PSKU-[0-9]{6}$' then raise exception 'FAIL 1: label format %', pa.psku; end if;
  ok := ok || 'receiving creates pallets and cartons with PSKU labels, is idempotent per request key, refuses a reused key, and posts no stock'::text;

  -- 2 existing put-away path and stock trigger: stock posts once, as one receipt
  perform set_config('role', 'authenticated', true);
  begin perform nexus_putaway(pa.psku, 'P-01'); raise exception 'FAIL 2: the old direct put-away stored a pallet in a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  j := wms_putaway_begin(pa.psku, 'P-01'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'authenticated', true);
  begin perform wms_putaway_begin(pa.psku, 'P-05'); raise exception 'FAIL 2: stored twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%already put away%' then raise exception 'FAIL 2: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(qty), 0) from inventory_moves where ref_id = pa.id) <> 100 or (select count(*) from inventory_moves where ref_id = pa.id and reason = 'receive') <> 1 or (select count(*) from inventory_moves where ref_id = pa.id) <> 1 then raise exception 'FAIL 2: ledger'; end if;
  if (select l.code from wms_pallets p join locations l on l.id = p.location_id where p.id = pa.id) <> 'P-01' then raise exception 'FAIL 2: position'; end if;
  ok := ok || 'stock trigger posts 100 units exactly once, as one receive entry at the position, when a pallet is stored'::text;

  -- 3 HOLD safeguard at the table
  perform set_config('role', 'authenticated', true);
  begin perform nexus_putaway(ph.psku, 'P-06'); raise exception 'FAIL 3: held pallet stored';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%on HOLD%' and sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  begin perform wms_putaway_begin(ph.psku, 'P-06'); raise exception 'FAIL 3: held pallet accepted by the bridge path';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%on HOLD%' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  begin update wms_pallets set status = 'stored', location_id = (select id from locations where code = 'P-06') where id = ph.id; raise exception 'FAIL 3: direct write stored a held pallet';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%on HOLD%' then raise exception 'FAIL 3: %', sqlerrm; end if; end;
  ok := ok || 'a pallet on HOLD cannot be stored by either put-away path or by a direct write'::text;

  -- 4 bridge path: begin changes nothing; only the bridge role can commit; commit stores and posts once; safe to repeat
  perform set_config('role', 'authenticated', true); j := wms_putaway_begin(pb.psku, 'LOC-P-02'); op := (j ->> 'op')::uuid;
  if (wms_putaway_begin(pb.psku, 'P-02') ->> 'key') <> (j ->> 'key') then raise exception 'FAIL 4: a repeat did not reuse the key'; end if;
  begin perform wms_putaway_begin(pb.psku, 'P-07'); raise exception 'FAIL 4: second open request allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%already has a request for P-02%' then raise exception 'FAIL 4: %', sqlerrm; end if; end;
  begin perform wms_nexus_op_commit(op); raise exception 'FAIL 4: a signed-in user committed';
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true);
  if (select status from wms_pallets where id = pb.id) = 'stored' or (select count(*) from inventory_moves where ref_id = pb.id) <> 0 then raise exception 'FAIL 4: begin changed the pallet'; end if;
  perform set_config('role', 'service_role', true); j := wms_nexus_op_commit(op); j := wms_nexus_op_commit(op); perform set_config('role', 'postgres', true);
  if (select l.code from wms_pallets p join locations l on l.id = p.location_id where p.id = pb.id and p.status = 'stored') is distinct from 'P-02' then raise exception 'FAIL 4: not stored'; end if;
  if (select count(*) from inventory_moves where ref_id = pb.id) <> 1 or (j ->> 'units_posted')::int <> 100 then raise exception 'FAIL 4: ledger %', j; end if;
  ok := ok || 'put-away through the journal: begin changes nothing, one open request per pallet with one key, only the bridge role can commit, commit stores and posts stock once and can be repeated safely'::text;

  -- 5 wave pick from the stored pallet: stock leaves the position only on confirm
  insert into orders (org_id, order_number, channel, source, status, total_units) values (o1, 'SYN-ORD-REG', 'connector', 'connector', 'new', 5) returning id into ord;
  insert into order_lines (order_id, sku_id, sku, name, qty) values (ord, k1, 'SYN-LP-001', 'Synthetic LP, Black', 5);
  perform set_config('role', 'authenticated', true); j := wms_wave_start(o1); task := (j -> 'wave' -> 'tasks' -> 0 ->> 'id')::uuid; perform set_config('role', 'postgres', true);
  if task is null or (select count(*) from inventory_moves where ref_type = 'wave_task') <> 0 then raise exception 'FAIL 5: wave %', j; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_wave_confirm(task, 5, null); raise exception 'FAIL 5: picked without the barcode scan';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Scan the barcode%' then raise exception 'FAIL 5: %', sqlerrm; end if; end;
  perform wms_wave_confirm(task, 5, '000000000011'); perform set_config('role', 'postgres', true);
  if (select sum(qty) from inventory_moves where ref_type = 'wave_task' and reason = 'pick') <> -5 then raise exception 'FAIL 5: pick ledger'; end if;
  if (select on_hand from inventory_levels where sku_id = k1) <> 195 then raise exception 'FAIL 5: on hand %', (select on_hand from inventory_levels where sku_id = k1); end if;
  ok := ok || 'wave pick: stock leaves the position only when the stop is confirmed with the barcode scan; on hand goes 200 to 195'::text;

  -- 6 move: position changes, quantity does not, nothing is received again
  n := (select count(*) from inventory_moves);
  perform set_config('role', 'authenticated', true); j := wms_move_begin(pb.psku, 'P-40'); perform set_config('role', 'service_role', true); j := wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select l.code from wms_pallets p join locations l on l.id = p.location_id where p.id = pb.id) <> 'P-40' or (j ->> 'from') <> 'P-02' then raise exception 'FAIL 6: position'; end if;
  if (select count(*) from inventory_moves) <> n + 2 or (select count(*) from inventory_moves where ref_id = pb.id and reason = 'receive') <> 1 or (select count(*) from inventory_moves where ref_id = pb.id and reason = 'transfer') <> 2
     or (select sum(qty) from inventory_moves where ref_id = pb.id) <> 100 or (select on_hand from inventory_levels where sku_id = k1) <> 195 then raise exception 'FAIL 6: ledger'; end if;
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where m.ref_id = pb.id and l.code = 'P-02') <> 0 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where m.ref_id = pb.id and l.code = 'P-40') <> 100 then raise exception 'FAIL 6: per position'; end if;
  ok := ok || 'move: position changes, on-hand quantity is unchanged, stock follows as one transfer pair, still exactly one receive entry'::text;

  -- 7 release: only with a stated confirmation and a reason, only from where the pallet stands. It frees the position and clears it on the pallet; the ledger is untouched
  select jsonb_build_object('moves', (select count(*) from inventory_moves), 'sum', (select sum(qty) from inventory_moves), 'p40', (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-40')) into before;
  perform set_config('role', 'authenticated', true);
  begin perform wms_release_begin(pb.psku, 'P-40', 'shipped_out', false); raise exception 'FAIL 7: released without confirmation';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Confirm at the position%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  begin perform wms_release_begin(pb.psku, 'P-40', null, true); raise exception 'FAIL 7: released without a reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Say why%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  begin perform wms_release_begin(pb.psku, 'P-41', 'shipped_out', true); raise exception 'FAIL 7: released from the wrong position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%at P-40, not P-41%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  j := wms_release_begin(pb.psku, 'P-40', 'shipped_out', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if before is distinct from jsonb_build_object('moves', (select count(*) from inventory_moves), 'sum', (select sum(qty) from inventory_moves), 'p40', (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-40')) then raise exception 'FAIL 7: release changed the ledger'; end if;
  if (select status || '/' || coalesce(location_id::text, 'no position') from wms_pallets where id = pb.id) <> 'departed/no position' then raise exception 'FAIL 7: the departed pallet still shows a position'; end if;
  if (select problem from wms_nexus_ops where pallet_id = pb.id and kind = 'release') not like '100 units are still on the books at P-40%' then raise exception 'FAIL 7: stock left on the books was not reported'; end if;
  if (select detail ->> 'from' from wms_activity where kind = 'pallet_left_floor' and ref = pb.psku) is distinct from 'P-40' then raise exception 'FAIL 7: history'; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_putaway_begin(pb.psku, 'P-22'); raise exception 'FAIL 7: a departed pallet was put away again';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%left the building%' then raise exception 'FAIL 7: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  if (select count(*) from wms_nexus_ops where pallet_id = pb.id and kind = 'release' and state = 'done' and confirmed_at_position and reason = 'shipped_out' and by_name is not null) <> 1 then raise exception 'FAIL 7: audit'; end if;
  ok := ok || 'release: refused without confirmation, without a reason, or from the wrong position; when confirmed it is audited, the pallet becomes departed with no position, its old position stays in the log, the stock ledger is exactly as it was, and stock still on the books is reported, not deducted'::text;

  -- 8 Nexus accepted, ShipBay did not record: stays reserved in the journal, locked, admin-only, confirmation required; record path
  perform set_config('role', 'authenticated', true); j := wms_putaway_begin(pc.psku, 'P-03'); op := (j ->> 'op')::uuid;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_note(op, 'out_of_sync', 200, 'not_recorded', 'synthetic: could not record'); perform set_config('role', 'authenticated', true);
  begin perform wms_putaway_begin(pc.psku, 'P-08'); raise exception 'FAIL 8: an out-of-sync pallet took a new request';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%needs an admin%' then raise exception 'FAIL 8: %', sqlerrm; end if; end;
  begin perform wms_nexus_resolve_record(op, true); raise exception 'FAIL 8: floor staff resolved it';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Only ShipBay admin or staff%' then raise exception 'FAIL 8: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true);
  begin perform wms_nexus_resolve_record(op, false); raise exception 'FAIL 8: resolved without confirmation';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Confirm at the position%' then raise exception 'FAIL 8: %', sqlerrm; end if; end;
  perform wms_nexus_resolve_record(op, true); perform set_config('role', 'postgres', true);
  if (select l.code from wms_pallets p join locations l on l.id = p.location_id where p.id = pc.id and p.status = 'stored') is distinct from 'P-03'
     or (select state || '/' || resolved_by_name from wms_nexus_ops where id = op) <> 'done/Test Admin (synthetic)' then raise exception 'FAIL 8: record'; end if;
  -- correction path: the pallet is not there; a corrective request with its own key closes the original, nothing is stored
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); j := wms_putaway_begin(pd.psku, 'P-04'); op := (j ->> 'op')::uuid;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_note(op, 'out_of_sync', 200, 'not_recorded', 'synthetic'); perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', ca, true); fx := wms_nexus_fix_begin(op, true);
  if (fx ->> 'kind') <> 'release' or (fx ->> 'from') <> 'P-04' or (fx ->> 'key') = (j ->> 'key') or (fx ->> 'fixes')::uuid <> op then raise exception 'FAIL 8: correction %', fx; end if;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((fx ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select state from wms_nexus_ops where id = op) <> 'undone' or (select status from wms_pallets where id = pd.id) = 'stored' or (select count(*) from inventory_moves where ref_id = pd.id) <> 0 then raise exception 'FAIL 8: undo'; end if;
  ok := ok || 'out of sync: the pallet is locked, only admin or staff can resolve it and only with a confirmation; record stores it, correct opens a separately keyed request and stores nothing'::text;

  -- 9 voiding a pallet releases nothing and writes nothing to the journal
  n := (select count(*) from wms_nexus_ops); perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); perform wms_void_pallet(pc.id, 'synthetic void'); perform set_config('role', 'postgres', true);
  if (select count(*) from wms_nexus_ops) <> n or (select count(*) from wms_nexus_ops where pallet_id = pc.id and kind = 'release') <> 0 then raise exception 'FAIL 9'; end if;
  ok := ok || 'voiding a pallet creates no release and no journal entry'::text;

  -- 10 privileges
  if has_function_privilege('authenticated', 'public.wms_nexus_op_commit(uuid)', 'execute') or has_function_privilege('anon', 'public.wms_putaway_begin(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.nexus_registry_apply(jsonb, boolean)', 'execute') or has_function_privilege('authenticated', 'public.wms_calendar_plan()', 'execute')
     or has_table_privilege('anon', 'public.wms_nexus_ops', 'select') or has_table_privilege('authenticated', 'public.wms_nexus_ops', 'select, insert, update, delete')
     or has_function_privilege('authenticated', 'public._wms_nexus_carry(uuid, uuid, uuid, text, uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.wms_receipt_links', 'select') or has_table_privilege('anon', 'public.wms_pins', 'select') then raise exception 'FAIL 10: a privilege is too wide'; end if;
  perform set_config('request.jwt.claims', cc, true); perform set_config('role', 'authenticated', true);
  begin perform wms_putaway_begin(pa.psku, 'P-09'); raise exception 'FAIL 10: a client login placed a pallet';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%cannot place or release%' then raise exception 'FAIL 10: %', sqlerrm; end if; end;
  if (select count(*) from wms_pallets) <> (select count(*) from wms_pallets where org_id = o1) or (select count(*) from orgs) <> 1 then raise exception 'FAIL 10: client row access'; end if;
  perform set_config('role', 'postgres', true);
  ok := ok || 'privileges: commit, registry and calendar plan are bridge-only; the journal and receipt links have no API access; a client login cannot place pallets and sees only its own brand'::text;

  -- 11 calendar: a confirmed time is a "put" with only public fields; a date-only shipment is held; a moved date cancels
  perform set_config('role', 'service_role', true); plan := wms_calendar_plan(); perform set_config('role', 'postgres', true);
  if (select count(*) from jsonb_array_elements(plan) a where a ->> 'action' = 'put') <> 1 or (select a -> 'body' from jsonb_array_elements(plan) a where a ->> 'action' = 'put') - 'starts_at' - 'ends_at' <> '{"direction": "inbound", "pallets": 4, "status": "scheduled"}'::jsonb
     or (select (a -> 'body' ->> 'starts_at') from jsonb_array_elements(plan) a where a ->> 'action' = 'put') !~ 'T1[45]:00:00Z$' then raise exception 'FAIL 11: put %', plan; end if;
  if (select count(*) from jsonb_array_elements(plan) a where a ->> 'action' = 'hold_date_only') <> 2 or plan::text ~ 'SYN-PO|Synthetic|SYNTHETIC' then raise exception 'FAIL 11: hold or privacy %', plan; end if;
  perform set_config('role', 'service_role', true); perform wms_calendar_mark(s3, 'published', (select a ->> 'hash' from jsonb_array_elements(plan) a where a ->> 'action' = 'put')); plan := wms_calendar_plan(); perform set_config('role', 'postgres', true);
  if exists (select 1 from jsonb_array_elements(plan) a where a ->> 'action' in ('put', 'cancel')) then raise exception 'FAIL 11: republish'; end if;
  update inbound_shipments set expected_at = expected_at + 1 where id = s3;
  if (select appt_starts_at from inbound_shipments where id = s3) is not null then raise exception 'FAIL 11: time kept after the date moved'; end if;
  perform set_config('role', 'service_role', true); plan := wms_calendar_plan(); perform set_config('role', 'postgres', true);
  if (select count(*) from jsonb_array_elements(plan) a where a ->> 'action' = 'cancel' and (a ->> 'shipment')::uuid = s3) <> 1 then raise exception 'FAIL 11: cancel %', plan; end if;
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  begin perform wms_shipment_set_appointment(s3, now(), null); raise exception 'FAIL 11: floor set an appointment';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Only ShipBay admin or staff%' then raise exception 'FAIL 11: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  ok := ok || 'calendar: a confirmed time plans one publish at 10:00 Eastern with direction, time, pallets and status only; date-only shipments are held; nothing repeats once published; moving the date clears the time and plans a cancel'::text;

  -- 13 a part-picked pallet keeps its real quantity through a move, off the shared floor and back; a forced correction is admin work
  select pallet_id into pk from inventory_moves where reason = 'pick' limit 1;
  if pk is distinct from pa.id then raise exception 'FAIL 13: the pick is not tied to the first-in pallet'; end if;
  n := (select sum(qty) from inventory_moves);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); j := wms_move_begin(pa.psku, 'P-20'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-01') <> 0 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-20') <> 95 or (select sum(qty) from inventory_moves) <> n then raise exception 'FAIL 13: move of a part-picked pallet'; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_release_begin(pa.psku, 'P-20', 'correction', true); raise exception 'FAIL 13: floor staff forced a correction';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%needs a ShipBay admin or staff login%' then raise exception 'FAIL 13: %', sqlerrm; end if; end;
  if wms_nexus_journal() <> '[]'::jsonb then raise exception 'FAIL 13: floor staff read the reconciliation journal'; end if;
  j := wms_release_begin(pa.psku, 'P-20', 'moved_off_shared_floor', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select status || '/' || coalesce(location_id::text, 'no position') from wms_pallets where id = pa.id) <> 'off_floor/no position' or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OFF-FLOOR') <> 95
     or (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-20') <> 0 or (select sum(qty) from inventory_moves) <> n then raise exception 'FAIL 13: off the floor'; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_wave_unconfirm(task); raise exception 'FAIL 13: a stop was reopened for a pallet that has left the floor';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has left the shared floor%' then raise exception 'FAIL 13: %', sqlerrm; end if; end;
  j := wms_putaway_begin(pa.psku, 'P-21'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select l.code from wms_pallets p join locations l on l.id = p.location_id where p.id = pa.id and p.status = 'stored') is distinct from 'P-21' or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-21') <> 95
     or (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'OFF-FLOOR') <> 0 or (select sum(qty) from inventory_moves) <> n
     or (select count(*) from inventory_moves where ref_type = 'wms_pallet' and ref_id = pa.id and reason in ('receive', 'adjust')) <> 1 then raise exception 'FAIL 13: back on the floor'; end if;
  ok := ok || 'a part-picked pallet (95 of 100 left) moves, leaves the shared floor and comes back with 95 at each step, total unchanged, one receipt and no adjustment; floor staff cannot force a correction or read the reconciliation journal'::text;

  -- 14 inventory safeguards: reopen follows the pallet; the old put-away paths cannot touch shared positions; stock without a stored pallet is not offered for picking
  n := (select sum(qty) from inventory_moves);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true); perform wms_wave_unconfirm(task); perform set_config('role', 'postgres', true);
  if (select coalesce(sum(m.qty), 0) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-01') <> 0 or (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code = 'P-21') <> 100
     or (select sum(qty) from inventory_moves) <> n + 5 or (select l.code from wms_wave_tasks t join locations l on l.id = t.location_id where t.id = task) <> 'P-21' then raise exception 'FAIL 14: reopen did not follow the pallet'; end if;
  update wms_pallets set status = 'counted', counted_at = now() where id = pd.id;   -- counted: the state the old paths expect
  -- a counted pallet cannot be given a shared position from ShipBay's side at all (20261203): not by a direct write, not by the old screen
  begin update wms_pallets set location_id = (select id from locations where code = 'P-30') where id = pd.id; raise exception 'FAIL 14: a counted pallet reserved a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  perform set_config('role', 'authenticated', true);
  begin perform wms_assign_location(pd.id, (select id from locations where code = 'P-30')); raise exception 'FAIL 14: the old screen reserved a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  begin perform nexus_putaway(pd.psku, 'P-30'); raise exception 'FAIL 14: old put-away stored a pallet in a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  begin perform wms_putaway(pd.id, pd.psku, 'P-30'); raise exception 'FAIL 14: old station put-away stored a pallet in a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%has no position yet%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  perform set_config('role', 'postgres', true);
  begin update wms_pallets set status = 'stored', location_id = (select id from locations where code = 'P-30') where id = pd.id; raise exception 'FAIL 14: a direct write stored a pallet in a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%shared Nexus position%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  begin update wms_pallets set location_id = (select id from locations where code = 'P-31') where id = pa.id; raise exception 'FAIL 14: a direct write moved a pallet between shared positions';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%through Nexus%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  begin update wms_pallets set location_id = null, status = 'counted' where id = pa.id; raise exception 'FAIL 14: a direct write took a pallet out of a shared position';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%through Nexus%' then raise exception 'FAIL 14: %', sqlerrm; end if; end;
  -- cancel the wave, take the pallet off the shared floor: 100 at OFF-FLOOR and 100 still on the books at P-40 (a departed pallet). None of it is offered.
  op := (select wave_id from wms_wave_tasks where id = task); perform set_config('role', 'authenticated', true); perform wms_wave_cancel(op);
  j := wms_release_begin(pa.psku, 'P-21', 'moved_off_shared_floor', true); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid);
  perform set_config('role', 'authenticated', true); j := wms_wave_start(o1); perform set_config('role', 'postgres', true);
  if jsonb_typeof(j -> 'wave') <> 'null' or (j -> 'short' -> 0 ->> 'on_file')::int <> 0 then raise exception 'FAIL 14: stock with no stored pallet was offered for picking: %', j; end if;
  if (select sum(m.qty) from inventory_moves m join locations l on l.id = m.location_id where l.code in ('OFF-FLOOR', 'P-40')) <> 200 then raise exception 'FAIL 14: setup'; end if;
  -- back on the shared floor through Nexus, it is offered again, at its new position
  perform set_config('role', 'authenticated', true); j := wms_putaway_begin(pa.psku, 'P-23'); perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid);
  perform set_config('role', 'authenticated', true); j := wms_wave_start(o1); perform set_config('role', 'postgres', true);
  if (select l.code from wms_wave_tasks t join locations l on l.id = t.location_id where t.id = (j -> 'wave' -> 'tasks' -> 0 ->> 'id')::uuid) is distinct from 'P-23' then raise exception 'FAIL 14: not offered after returning: %', j; end if;
  ok := ok || 'safeguards: a reopened stop returns units to where the pallet stands now; the old put-away paths and direct writes cannot store, move or remove a pallet at a shared position; stock at OFF-FLOOR or left on the books at a vacated position is not offered for picking, and is offered again once the pallet is back through Nexus'::text;

  -- 15 workflow repairs (20261203): a planned stop and its pallet; an unsettled move; the exceptions report and the one close-out
  task := (j -> 'wave' -> 'tasks' -> 0 ->> 'id')::uuid; n := (select sum(qty) from inventory_moves);
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'authenticated', true);
  begin perform wms_release_begin(pa.psku, 'P-23', 'shipped_out', true); raise exception 'FAIL 15: a pallet was released under a planned pick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%still has a pick planned%' then raise exception 'FAIL 15: %', sqlerrm; end if; end;
  j := wms_move_begin(pa.psku, 'P-24');   -- asked, not yet answered by Nexus
  begin perform wms_wave_confirm(task, 1, null); raise exception 'FAIL 15: a stop was picked while its pallet''s move was not settled';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%waiting for Nexus%' then raise exception 'FAIL 15: %', sqlerrm; end if; end;
  begin perform wms_assign_location(pa.id, (select id from locations where code = 'A-01')); raise exception 'FAIL 15: reserved while not settled';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('role', 'service_role', true); perform wms_nexus_op_commit((j ->> 'op')::uuid); perform set_config('role', 'postgres', true);
  if (select l.code from wms_wave_tasks t join locations l on l.id = t.location_id where t.id = task) is distinct from 'P-24' then raise exception 'FAIL 15: the planned stop did not follow the pallet to P-24'; end if;
  if (select sum(qty) from inventory_moves) <> n or (select count(*) from inventory_moves where ref_id = pa.id and reason = 'receive') <> 1 then raise exception 'FAIL 15: the move changed a quantity or made a receipt'; end if;
  perform set_config('role', 'authenticated', true);
  begin perform wms_nexus_exceptions(); raise exception 'FAIL 15: the floor login read the exceptions report';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Only ShipBay admin or staff%' then raise exception 'FAIL 15: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', ca, true); fx := wms_nexus_exceptions();
  if jsonb_array_length(fx -> 'departed_with_stock') <> 1 or (fx -> 'departed_with_stock' -> 0 ->> 'units')::int <> 100 or jsonb_array_length(fx -> 'stops_without_pallet') <> 0 or jsonb_array_length(fx -> 'held_in_shipbay_only') <> 0 then raise exception 'FAIL 15: report %', fx; end if;
  begin perform wms_departed_stock_close((fx -> 'departed_with_stock' -> 0 ->> 'pallet_id')::uuid, ' '); raise exception 'FAIL 15: closed out without a reference';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%reference%' then raise exception 'FAIL 15: %', sqlerrm; end if; end;
  perform wms_departed_stock_close((fx -> 'departed_with_stock' -> 0 ->> 'pallet_id')::uuid, 'SYN-BOL-1');
  if (select sum(qty) from inventory_moves) <> n - 100 or jsonb_array_length(wms_nexus_exceptions() -> 'departed_with_stock') <> 0 then raise exception 'FAIL 15: the close-out did not take exactly the 100 units off the books'; end if;
  begin perform wms_departed_stock_close((fx -> 'departed_with_stock' -> 0 ->> 'pallet_id')::uuid, 'SYN-BOL-1'); raise exception 'FAIL 15: closed out twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm not like '%Nothing is left on the books%' then raise exception 'FAIL 15: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', cf, true); perform set_config('role', 'postgres', true);
  ok := ok || 'workflow: a pallet with a planned pick cannot be released; while its move is not settled the stop cannot be picked and it cannot be reserved; once Nexus confirms, the planned stop follows the pallet and no quantity changes; the exceptions report is admin-only and lists the departed pallet with its 100 units; the close-out takes exactly those units off the books, with a reference, once'::text;

  -- 12 ledger integrity
  if exists (select 1 from inventory_moves where location_id is null) or (select sum(qty) from inventory_moves) <> (select sum(on_hand) from inventory_levels) then raise exception 'FAIL 12'; end if;
  if (select count(*) from wms_activity where kind in ('pallet_received', 'pallet_putaway', 'pick')) < 3 or (select count(*) from events where entity = 'order') < 1 then raise exception 'FAIL 12: activity or status history'; end if;
  ok := ok || 'ledger: every entry has a position, the stock view equals the ledger total, activity and status history are being written'::text;

  raise exception 'ROLLBACK-OK % checks passed: %', array_length(ok, 1), array_to_string(ok, ' || ');
end $t$;
