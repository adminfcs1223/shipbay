import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
const U = { floor: 'c8000000-0000-4000-8000-000000000001', admin: 'c8000000-0000-4000-8000-000000000002', floor2: 'c8000000-0000-4000-8000-000000000003', client: 'c8000000-0000-4000-8000-000000000004' }; const A = 'd8000000-0000-4000-8000-00000000000a';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active')`, [A]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin"}'), ($3,'floor2@example.test','{"role":"wms_employee","full_name":"Second Floor"}'), ($4,'client@example.test',jsonb_build_object('role','client_user','org_id',$5::text))`, [U.floor, U.admin, U.floor2, U.client, A]);
await db.query(`insert into locations (code, zone, kind) values ('A-01','a','shelf'), ('P-01','bulk','pallet'), ('P-02','bulk','pallet')`);
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261127_wms_waves']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));
const sku = async (s) => (await db.query(`insert into skus (org_id, sku, name) values ($1,$2,$2) returning id`, [A, s])).rows[0].id;
const X = await sku('SYN-X'), W = await sku('SYN-W'), Y = await sku('SYN-Y'), Z = await sku('SYN-Z');
async function as(who, sql, p = []) { await db.query('begin'); try { await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U[who], role: 'authenticated' })]); const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } }
const order = async (no, lines, shipBy = null) => { const id = (await db.query(`insert into orders (org_id, order_number, source, status, ship_by, total_units) values ($1,$2,'connector','new',$3,$4) returning id`, [A, no, shipBy, lines.reduce((s, l) => s + l[2], 0)])).rows[0].id;
  for (const [sid, s, q] of lines) await db.query(`insert into order_lines (order_id, sku_id, sku, name, qty) values ($1,$2,$3,$3,$4)`, [id, sid, s, q]); return id; };
const stock = async (s, loc) => Number((await db.query(`select coalesce(sum(m.qty),0) n from inventory_moves m join locations l on l.id = m.location_id where m.sku_id = $1 and l.code = $2`, [s, loc])).rows[0].n);

test('waves: allocate from stock on file, route to the pack station, deduct on confirm, short goes to a manager, pack identical orders in split packages', async () => {
  // a mixed pallet (X and W) put away at P-02 through Nexus; Y is shelf stock at A-01; Z has none
  const bk = (await as('admin', `select nexus_shipment_create($1,'SYN-PO-W','Vendor',current_date,1,3,null,'[]') id`, [A]))[0].id;
  const pal = (await as('floor', `select * from wms_receive_booking($1,$2,$3::jsonb,1,null,'wv-1','final',null)`, [bk, A, JSON.stringify([{ sku: X, cartons: 2, units_per_carton: 10 }, { sku: W, cartons: 1, units_per_carton: 5 }])]))[0];
  await as('floor', 'select nexus_putaway($1,$2)', [pal.psku, 'P-02']);
  await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, location_id) values ($1,$2,20,'receive',(select id from locations where code='A-01'))`, [A, Y]);
  assert.equal(await stock(X, 'P-02'), 20); assert.equal(await stock(W, 'P-02'), 5);
  const O1 = await order('S-1001', [[X, 'SYN-X', 2], [Y, 'SYN-Y', 1]]), O3 = await order('S-1002', [[W, 'SYN-W', 3]]), O2 = await order('S-1003', [[X, 'SYN-X', 2], [Y, 'SYN-Y', 1]]);
  await order('S-1004', [[Z, 'SYN-Z', 1]]); await order('S-1005', [[Y, 'SYN-Y', 30]]);
  await assert.rejects(as('client', 'select wms_wave_start($1)', [A]), /cannot work orders/);
  const sum0 = (await as('floor', 'select wms_orders_summary($1) r', [A]))[0].r; assert.equal(sum0.to_pick, 5); assert.equal(sum0.my_wave, null); assert.deepEqual(sum0.problems, []);
  const st = (await as('floor', 'select wms_wave_start($1) r', [A]))[0].r; const w = st.wave;
  assert.deepEqual(w.orders.map((o) => o.order_number), ['S-1001', 'S-1002', 'S-1003']);
  assert.deepEqual(st.short.map((s) => [s.order_number, s.sku, s.need, s.on_file]), [['S-1005', 'SYN-Y', 30, 18], ['S-1004', 'SYN-Z', 1, 0]]);
  // route: the pallet position first with its two products back to back, the shelf by the pack station last
  assert.deepEqual(w.tasks.map((t) => [t.seq, t.location, t.sku, t.qty_planned, t.psku]), [[1, 'P-02', 'SYN-W', 3, pal.psku], [2, 'P-02', 'SYN-X', 4, pal.psku], [3, 'A-01', 'SYN-Y', 2, null]]);
  assert.equal(w.tasks[1].orders, 2); assert.equal(w.tasks[0].mixed, true);
  assert.equal((await as('floor', 'select wms_wave_start($1) r', [A]))[0].r.wave.id, w.id, 'the same picker gets the same wave back');
  assert.equal((await as('floor2', 'select wms_wave_start($1) r', [A]))[0].r.wave, null, 'nothing left for a second picker: the rest is short');
  assert.equal(await stock(X, 'P-02'), 20, 'nothing leaves stock until the picker confirms');
  const [tW, tX, tY] = w.tasks; const carton = (await db.query(`select code from wms_cartons where pallet_id = $1 and sku_id = $2 limit 1`, [pal.id, X])).rows[0].code;
  await assert.rejects(as('floor', 'select wms_wave_confirm($1,4,null)', [tX.id]), /Scan the barcode/);
  await assert.rejects(as('floor', 'select wms_wave_confirm($1,5,$2)', [tX.id, carton]), /Only 4 are needed/);
  await as('floor', 'select wms_wave_confirm($1,4,$2)', [tX.id, carton]); assert.equal(await stock(X, 'P-02'), 16);
  assert.equal((await db.query(`select pallet_id from inventory_moves where ref_type = 'wave_task' and ref_id = $1`, [tX.id])).rows[0].pallet_id, pal.id, 'the move names the pallet');
  // short at the W stop: 2 of 3
  const cW = (await db.query(`select code from wms_cartons where pallet_id = $1 and sku_id = $2 limit 1`, [pal.id, W])).rows[0].code;
  let j = (await as('floor', 'select wms_wave_confirm($1,2,$2) r', [tW.id, cW]))[0].r; assert.equal(j.orders.find((o) => o.order_number === 'S-1002').pack_state, 'problem'); assert.equal(await stock(W, 'P-02'), 3);
  // mistyped: reopen the stop, everything goes back, then confirm again
  j = (await as('floor', 'select wms_wave_unconfirm($1) r', [tW.id]))[0].r; assert.equal(await stock(W, 'P-02'), 5); assert.equal(j.orders.find((o) => o.order_number === 'S-1002').pack_state, 'pending');
  await as('floor', 'select wms_wave_confirm($1,2,$2)', [tW.id, cW]);
  await assert.rejects(as('floor', 'select wms_wave_to_pack($1)', [w.id]), /1 stop still to pick/);
  await assert.rejects(as('floor', 'select wms_wave_cancel($1)', [w.id]), /already confirmed/);
  await as('floor', 'select wms_wave_confirm($1,2,null)', [tY.id]); assert.equal(await stock(Y, 'A-01'), 18);
  j = (await as('floor', 'select wms_wave_to_pack($1) r', [w.id]))[0].r; assert.equal(j.status, 'packing');
  assert.deepEqual((await db.query(`select order_number, status from orders where id = any($1) order by 1`, [[O1, O2, O3]])).rows.map((r) => r.status), ['picked', 'new', 'picked']);
  const mgr = (await as('admin', 'select wms_orders_summary($1) r', [A]))[0].r; assert.equal(mgr.with_manager, 1); assert.equal(mgr.problems[0].order_number, 'S-1002'); assert.equal(mgr.problems[0].found, 2);
  assert.deepEqual((await as('floor', 'select wms_orders_summary($1) r', [A]))[0].r.problems, [], 'the floor login sees the count, not the manager list');
  // pack the two identical orders at once, each split into two packages
  const two = JSON.stringify([{ items: [{ key: 'SYN-X', qty: 2 }], weight_oz: 12 }, { items: [{ key: 'SYN-Y', qty: 1 }], packaging: 'mailer' }]);
  await assert.rejects(as('floor', 'select wms_wave_pack($1,$2,$3::jsonb)', [w.id, [O1, O2], JSON.stringify([{ items: [{ key: 'SYN-X', qty: 2 }] }])]), /do not add up/);
  await assert.rejects(as('floor', 'select wms_wave_pack($1,$2,$3::jsonb)', [w.id, [O3], JSON.stringify([{ items: [{ key: 'SYN-W', qty: 3 }] }])]), /not waiting to be packed/);
  j = (await as('floor', 'select wms_wave_pack($1,$2,$3::jsonb) r', [w.id, [O1, O2], two]))[0].r; assert.equal(j.status, 'done');
  const pk = (await db.query(`select o.order_number, k.seq, k.of_n, k.code from wms_packages k join orders o on o.id = k.order_id order by 1, 2`)).rows;
  assert.deepEqual(pk.map((r) => [r.order_number, r.seq, r.of_n]), [['S-1001', 1, 2], ['S-1001', 2, 2], ['S-1003', 1, 2], ['S-1003', 2, 2]]); assert.equal(new Set(pk.map((r) => r.code)).size, 4);
  assert.deepEqual((await db.query(`select status from orders where id = any($1)`, [[O1, O2]])).rows.map((r) => r.status), ['packed', 'packed']);
  const act = Object.fromEntries((await db.query('select kind, sum(qty)::int n from wms_activity group by kind')).rows.map((x) => [x.kind, x.n])); assert.equal(act.pick, 10, 'picks are tracked for billing (the reopened stop included)');
  // next wave: nothing can be allocated; the screen is told why
  const nx = (await as('floor', 'select wms_wave_start($1) r', [A]))[0].r; assert.equal(nx.wave, null); assert.equal(nx.short.length, 2);
  // trip size: a wave stops taking orders when it is full
  for (let i = 0; i < 5; i++) await order('S-20' + i, [[Y, 'SYN-Y', 1]]);
  const cap = (await as('floor2', 'select wms_wave_start($1, 3, 100) r', [A]))[0].r.wave; assert.equal(cap.orders.length, 3); assert.equal(cap.tasks.length, 1); assert.equal(cap.tasks[0].qty_planned, 3);
  await as('floor2', 'select wms_wave_cancel($1)', [cap.id]); assert.equal((await as('floor2', 'select wms_orders_summary($1) r', [A]))[0].r.my_wave, null);
});
test.after(async () => { await db.end(); });
