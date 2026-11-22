import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));
const U = { floor: 'c7000000-0000-4000-8000-000000000001', admin: 'c7000000-0000-4000-8000-000000000002' }; const A = 'd7000000-0000-4000-8000-00000000000a';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active')`, [A]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin"}')`, [U.floor, U.admin]);
await db.query(`insert into locations (code, zone, kind) values ('P-01','bulk','pallet'), ('P-02','bulk','pallet')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
async function as(who, sql, p = []) { await db.query('begin'); try { await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U[who], role: 'authenticated' })]); const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } }
test('book a shipment in Nexus with its items; the WMS sees it and its lines; receive against it; put away in Nexus posts stock', async () => {
  await assert.rejects(as('floor', `select nexus_shipment_create($1,'SYN-PO-1','Vendor',current_date,2,20,null,'[]')`, [A]), /Only ShipBay admin or staff/);
  const id = (await as('admin', `select nexus_shipment_create($1,'SYN-PO-1','Vendor',current_date,2,20,null,$2::jsonb) id`, [A, JSON.stringify([{ sku_id: SKU, qty: 200 }])]))[0].id;
  const cal = (await as('floor', 'select nexus_shipments(current_date, current_date) r'))[0].r; assert.equal(cal.length, 1); assert.deepEqual(cal[0].lines, [{ sku: 'SYN-LP', name: 'Synthetic LP', qty: 200 }]); assert.equal(cal[0].approved, true);
  assert.deepEqual((await as('floor', 'select reference from wms_bookings($1)', [A])).map((r) => r.reference), ['SYN-PO-1']);
  assert.deepEqual((await as('floor', 'select sku, qty_expected from wms_booking_lines($1)', [id])), [{ sku: 'SYN-LP', qty_expected: 200 }]);
  const due = (await as('floor', 'select wms_shipments_due() r'))[0].r; assert.equal(due.length, 1); assert.equal(due[0].reference, 'SYN-PO-1'); assert.equal(due[0].lines[0].qty, 200);
  await db.query('update orgs set external_wms = true where id = $1', [A]); assert.equal((await as('floor', 'select wms_shipments_due() r'))[0].r.length, 0); await db.query('update orgs set external_wms = false where id = $1', [A]);
  const L = JSON.stringify([{ sku: SKU, cartons: 10, units_per_carton: 10 }]);
  const p1 = (await as('floor', `select * from wms_receive_booking($1,$2,$3::jsonb,1,null,'dk-1','partial',null)`, [id, A, L]))[0];
  const p2 = (await as('floor', `select * from wms_receive_booking($1,$2,$3::jsonb,1,null,'dk-2','hold','crushed')`, [id, A, L]))[0];
  const stock = async () => Number((await db.query('select coalesce(sum(qty),0) n from inventory_moves')).rows[0].n); assert.equal(await stock(), 0);
  await assert.rejects(as('floor', 'select nexus_putaway($1,$2)', [p1.psku, 'ZZ-9']), /not a pallet position/);
  const r = (await as('floor', 'select nexus_putaway($1,$2) r', [p1.psku, 'LOC-P-01']))[0].r; assert.equal(r.location, 'P-01'); assert.equal(Number(r.units_posted), 100); assert.equal(await stock(), 100);
  await assert.rejects(as('floor', 'select nexus_putaway($1,$2)', [p1.psku, 'P-02']), /already put away/);
  await assert.rejects(as('floor', 'select nexus_putaway($1,$2)', [p2.psku, 'P-02']), /on HOLD/);
  await as('admin', `select wms_hold_disposition($1,'release','SYN-OK')`, [p2.id]);
  await assert.rejects(as('floor', 'select nexus_putaway($1,$2)', [p2.psku, 'P-01']), /already holds a pallet/);
  await as('floor', 'select nexus_putaway($1,$2)', [p2.psku, 'P-02']); assert.equal(await stock(), 200);
  assert.equal((await as('floor', 'select nexus_shipments(current_date, current_date) r'))[0].r[0].received_pallets, 2);
  const k = Object.fromEntries((await db.query('select kind, count(*)::int n from wms_activity group by kind')).rows.map((x) => [x.kind, x.n])); assert.equal(k.pallet_putaway, 2); assert.equal(k.pallet_hold, 1);
});
test.after(async () => { await db.end(); });
