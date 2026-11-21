// Activity tracking on the production schema rebuilt locally (dedicated local cluster only; synthetic data).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const here = path.dirname(new URL(import.meta.url).pathname); const cand = (f) => fs.readFileSync(path.join(here, '../../candidates', f), 'utf8');
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') { await db.end(); throw new Error('REFUSED'); }
  if ((await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED: not fresh'); } }
for (const f of ['20261123_wms_booking_receiving.sql', '20261124_nexus.sql', '20261124_nexus_map.sql', '20261125_wms_activity.sql']) await db.query(cand(f));
const U = { floor: 'c6000000-0000-4000-8000-000000000001', admin: 'c6000000-0000-4000-8000-000000000002', client: 'c6000000-0000-4000-8000-000000000003' };
const A = 'd6000000-0000-4000-8000-00000000000a';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active')`, [A]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin"}'), ($3,'c@example.test',jsonb_build_object('role','client_user','org_id',$4::text))`, [U.floor, U.admin, U.client, A]);
await db.query(`insert into locations (code, zone, kind) values ('P-01','bulk','pallet'), ('P-02','bulk','pallet')`);
const BAR = '000555444333'; const SKU = (await db.query(`insert into skus (org_id, sku, name, barcode) values ($1,'SYN-LP','Synthetic LP',$2) returning id`, [A, BAR])).rows[0].id;
async function as(who, sql, p = []) { await db.query('begin'); try { await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U[who], role: 'authenticated' })]); const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } }
const kinds = async () => Object.fromEntries((await db.query('select kind, count(*)::int n, sum(qty)::int q from wms_activity group by kind')).rows.map((r) => [r.kind, [r.n, r.q]]));
test('receive, print, scan, count, put away, pick, pack, ship, cycle count: each is logged once with brand and person', async () => {
  const p = (await as('floor', `select * from wms_receive($1,$2::jsonb,1,null,'act-1')`, [A, JSON.stringify([{ sku: SKU, cartons: 3, units_per_carton: 10 }])]))[0];
  await as('floor', 'select wms_mark_printed($1)', [[p.id]]);
  for (const c of (await db.query('select code from wms_cartons where pallet_id=$1', [p.id])).rows) await as('floor', 'select wms_scan_carton($1)', [c.code]);
  const k = (await as('floor', 'select * from wms_complete_count($1)', [p.id]))[0];
  await as('floor', 'select wms_putaway($1,$2,(select code from locations where id=$3))', [p.id, k.psku, k.location_id]);
  const o = (await db.query(`insert into orders (org_id, order_number, channel, status, source) values ($1,'SYN-1','api','new','connector') returning id`, [A])).rows[0].id;
  const l = (await db.query(`insert into order_lines (order_id, sku_id, sku, name, qty) values ($1,$2,'SYN-LP','Synthetic LP',2) returning id`, [o, SKU])).rows[0].id;
  await as('floor', 'select wms_pick_scan($1,$2)', [[l], BAR]); await as('admin', 'select scan_pack($1,$2,2)', [o, BAR]);
  await as('admin', `select ship_order($1,'UPS','Ground','1ZSYN','client_shopify',null,'mailer',8)`, [o]);
  const cid = (await as('floor', 'select nexus_count_start(null,null) id'))[0].id; await as('floor', 'select nexus_count_scan($1,$2,$3)', [cid, 'P-01', k.psku]);
  const a = await kinds();
  assert.deepEqual([a.pallet_received, a.carton_received, a.pallet_label_print, a.carton_scan, a.pallet_counted, a.pallet_putaway], [[1, 1], [3, 3], [1, 1], [3, 3], [1, 1], [1, 1]]);
  assert.deepEqual([a.pick, a.pack_scan, a.shipment, a.cycle_count_scan], [[1, 2], [1, 2], [1, 1], [1, 1]]);
  const r = (await db.query(`select org_id, actor_name from wms_activity where kind='carton_scan' limit 1`)).rows[0]; assert.equal(r.org_id, A); assert.equal(r.actor_name, 'Test Floor');
});
test('billing view: admin sees the month by brand and action; floor and client logins are refused; raw table closed', async () => {
  const s = await as('admin', 'select * from wms_activity_summary(current_date)'); assert.ok(s.length >= 10); assert.ok(s.every((x) => x.brand === 'Synthetic Records'));
  assert.ok((await as('admin', 'select * from wms_activity_recent(null, 5)')).length === 5);
  for (const who of ['floor', 'client']) await assert.rejects(as(who, 'select * from wms_activity_summary(current_date)'), /Only ShipBay admin or staff/);
  await assert.rejects(as('admin', 'select * from wms_activity'), /permission denied/);
});
test('a tracking failure never blocks the floor', async () => {
  await db.query('alter table wms_activity rename to wms_activity_broken');
  const p = await as('floor', `select * from wms_receive($1,$2::jsonb,1,null,'act-2')`, [A, JSON.stringify([{ sku: SKU, cartons: 1, units_per_carton: 5 }])]);
  assert.equal(p.length, 1); await db.query('alter table wms_activity_broken rename to wms_activity');
});
test.after(async () => { await db.end(); });
