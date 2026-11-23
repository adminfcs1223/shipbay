// Open-box stock safety (supabase/candidates/20261205_wms_open_box_safety.sql), end to end on this machine only: ShipBay's
// database functions on isolated synthetic rows + the bridge in-process + the REAL Nexus service code in a throwaway local
// database. Nothing here reaches Supabase, Nexus staging or production. The harness is the one workflow.test.mjs uses.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { calendarRoutes } from '../../functions/nexus-bridge/calendar.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Client(`${base}/staging`); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261127_wms_waves', '20261128_nexus_registry_sync', '20261129_wms_calendar_publish', '20261130_wms_nexus_putaway', '20261201_wms_nexus_departure', '20261202_wms_inventory_safeguards', '20261203_wms_inventory_workflow', '20261204_wms_pallet_stock_safety', '20261205_wms_open_box_safety']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));

// ---- the real Nexus, local ----
await db.query('drop database if exists nexus_openbox_test'); await db.query('create database nexus_openbox_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_openbox_test` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await ndb.query(fs.readFileSync(path.join(NX, f), 'utf8'));
const { makeHandler } = await import(pathToFileURL(path.join(NX, 'service/handler.mjs')));
const nexus = makeHandler(async (sql, p) => (await ndb.query(sql, p)).rows);
const n1 = async (sql, p) => Object.values((await ndb.query(sql, p)).rows[0])[0];
const SOULED = await n1(`insert into nexus.companies (code, name) values ('SOULED','Souled Worldwide') returning id`), SHIPBAY = await n1(`insert into nexus.companies (code, name) values ('SHIPBAY','ShipBay3PL') returning id`);
const nkey = (c, sys, wh, scopes) => n1(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, wh, scopes]);
const KEYS = { shipbay: await nkey(SHIPBAY, 'shipbay-wms-dev', 'HILLSBOROUGH-TEST', ['read', 'move', 'calendar']), souled: await nkey(SOULED, 'souled-wms-dev', 'HILLSBOROUGH-TEST', ['read', 'move', 'calendar']),
  shipbayLive: await nkey(SHIPBAY, 'shipbay-wms', 'HILLSBOROUGH', ['read', 'move', 'calendar']), readOnly: await nkey(SHIPBAY, 'shipbay-screen', 'HILLSBOROUGH-TEST', ['read', 'calendar']) };
// how the bridge "reaches" Nexus: the fixed staging address is the only one accepted; faults can be injected
const net = { mode: 'ok', calls: [] };
const nexusFetch = async (url, init = {}) => {
  const u = new URL(url); assert.equal(u.host, STAGING_HOST, 'the bridge only ever calls the staging host'); assert.ok(!/key|token/i.test(u.search), 'no key in the address');
  const p = u.pathname.replace('/functions/v1/nexus', ''); net.calls.push(`${init.method} ${p}`);
  if (net.mode === 'down') throw new Error('network down');
  const res = await nexus(new Request(`http://nexus.local${p}${u.search}`, { method: init.method, headers: init.headers, body: init.body }));
  if (net.mode === 'lost' && init.method === 'POST') { net.mode = 'ok'; throw new Error('answer lost'); }
  return res;
};
const asSouled = async (method, p, body, idem) => { const r = await nexus(new Request(`http://nexus.local${p}`, { method, headers: { authorization: `Bearer ${KEYS.souled}`, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, body: body ? JSON.stringify(body) : undefined })); return { status: r.status, ...(await r.json()) }; };

// ---- ShipBay, local ----
const U = { floor: 'c9000000-0000-4000-8000-000000000001', admin: 'c9000000-0000-4000-8000-000000000002', client: 'c9000000-0000-4000-8000-000000000003' }; const A = 'd9000000-0000-4000-8000-00000000000a';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active')`, [A]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin","full_name":"Test Admin"}'), ($3,'client@example.test','{"role":"client_admin"}')`, [U.floor, U.admin, U.client]);
await db.query(`insert into locations (code, zone, kind) select 'P-' || lpad(g::text, 2, '0'), 'bulk', 'pallet' from generate_series(1, 3) g`);
await db.query(`insert into locations (code, zone, kind) values ('A-01-1','shelf','shelf')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
async function run(role, uid, fn, args) {
  const keys = Object.keys(args || {}); await db.query('begin');
  try { await db.query(`set local role ${role}`); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const r = await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k])); await db.query('commit'); return r.rows[0].r;
  } catch (e) { await db.query('rollback'); throw e; }
}
const hooks = { beforeCommit: null };
const port = { user: (token) => ({ rpc: (fn, args) => { if (!U[token]) throw new Error('bad token'); return run('authenticated', U[token], fn, args); } }),
  service: { rpc: async (fn, args) => { if (fn === 'wms_nexus_op_commit' && hooks.beforeCommit) { const h = hooks.beforeCommit; hooks.beforeCommit = null; await h(); } return run('service_role', null, fn, args); } } };
const ON = { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: KEYS.shipbay, NEXUS_PALLET_MOVES: 'on', NEXUS_REGISTRY_WRITES: 'on', NEXUS_CALENDAR_WRITES: 'on', SUPABASE_URL: 'https://dev-project.supabase.co' };
const bridgeWith = (env) => { const h = makeBridge({ env, fetchImpl: nexusFetch, db: port, routes: [...calendarRoutes, ...palletRoutes], timeoutMs: 2000 });
  return async (who, method, p, body) => { const r = await h(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })); return { status: r.status, ...(await r.json()) }; }; };
const bridge = bridgeWith(ON);
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_openbox_test').catch(() => {}); await db.end(); });

// ---- synthetic world: the Nexus position list, two private ShipBay locations, pickers, one product per scenario ----
const sync = await bridge('admin', 'POST', '/registry/sync', { apply: true }); assert.equal(sync.applied, true); assert.equal(sync.positions, 68);
await db.query(`insert into locations (code, zone, kind) values ('B-01','private','pallet')`);
for (const n of [2, 3, 4, 5, 6]) { U[`floor${n}`] = `c9000000-0000-4000-8000-0000000000f${n}`; await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"role":"wms_employee","full_name":"Test Floor"}')`, [U[`floor${n}`], `floor${n}@example.test`]); }
const as = (who, fn, args) => run('authenticated', U[who], fn, args);
const q1 = async (sql, p) => Object.values((await db.query(sql, p)).rows[0] || { x: null })[0];
const today = await q1('select current_date::text'); let seq = 0;
/** one product, one inbound shipment, one received pallet of 10 cartons x 10 */
async function stockPallet(name) {
  const sku = await q1(`insert into skus (org_id, sku, name) values ($1, $2, $2) returning id`, [A, name]);
  const inb = await as('admin', 'nexus_shipment_create', { p_org: A, p_reference: `SYN-PO-${name}`, p_origin: 'Vendor', p_expected: today, p_pallets: 2, p_cartons: 20, p_notes: null, p_lines: JSON.stringify([{ sku_id: sku, qty: 200 }]) });
  await db.query('begin'); await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.floor, role: 'authenticated' })]);
  const p = (await db.query(`select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,'partial',null)`, [inb, A, JSON.stringify([{ sku, cartons: 10, units_per_carton: 10 }]), `wf-${++seq}`])).rows[0]; await db.query('commit');
  return { sku, name, id: p.id, psku: p.psku, carton: await q1('select min(code) from wms_cartons where pallet_id = $1', [p.id]) };
}
async function order(no, p, qty) { const id = await q1(`insert into orders (org_id, order_number, source, status, total_units) values ($1,$2,'connector','new',$3) returning id`, [A, no, qty]);
  const line = await q1(`insert into order_lines (order_id, sku_id, sku, name, qty) values ($1,$2,$3,$3,$4) returning id`, [id, p.sku, p.name, qty]); return { id, line }; }
const at = async (p) => Object.fromEntries((await db.query(`select coalesce(l.code, '-') c, sum(m.qty)::int q from inventory_moves m left join locations l on l.id = m.location_id where m.sku_id = $1 group by 1 having sum(m.qty) <> 0`, [p.sku])).rows.map((r) => [r.c, r.q]));
const total = async () => Number(await q1('select coalesce(sum(qty),0) from inventory_moves'));
const receipts = async (p) => (await db.query(`select count(*)::int n, coalesce(sum(qty),0)::int u from inventory_moves where ref_id = $1 and reason = 'receive'`, [p.id])).rows[0];
const row = async (p) => (await db.query('select p.status, l.code from wms_pallets p left join locations l on l.id = p.location_id where p.id = $1', [p.id])).rows[0];
const stop = async (id) => (await db.query('select l.code, t.pallet_id is not null has_pallet, t.confirmed_at is not null confirmed, t.qty_picked from wms_wave_tasks t join locations l on l.id = t.location_id where t.id = $1', [id])).rows[0];
const put = async (p, to) => { const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: to }); assert.equal(r.status, 200, r.message); };
const move = (p, to) => bridge('floor', 'POST', '/move', { psku: p.psku, location: to });
const release = (p, from, reason, who = 'floor') => bridge(who, 'POST', '/release', { psku: p.psku, location: from, reason, confirmed: true });
const nexusPosts = () => net.calls.filter((c) => c.startsWith('POST')).length;
const lose = () => { net.mode = 'lost'; };
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };
const floorAt = async (code) => (await ndb.query(`select p.external_id from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where l.code = $1 and l.warehouse = 'HILLSBOROUGH-TEST'`, [code])).rows.map((r) => r.external_id);
const ledger = async (p) => (await db.query(`select m.reason, m.qty, coalesce(l.code, '-') at from inventory_moves m left join locations l on l.id = m.location_id where m.sku_id = $1 order by m.created_at, m.id`, [p.sku])).rows.map((r) => `${r.reason} ${r.qty} ${r.at}`);
const voidIt = (p, who = 'admin') => as(who, 'wms_void_pallet', { p_id: p.id, p_reason: 'synthetic void' });
const state = async (p) => [(await row(p)).status, (await row(p)).code, await at(p), await receipts(p)];
const setUnits = (p, n, who = 'floor') => as(who, 'wms_set_units', { p_pallet: p.id, p_item: null, p_units: n });
const fix = (p, n, why = 'Recounted at the position', who = 'admin') => as(who, 'wms_correct_units', { p_pallet: p.id, p_item: null, p_units: n, p_reason: why });
const perCarton = (p) => q1('select max(units_per_carton) from wms_cartons where pallet_id = $1', [p.id]);
const everything = async (p) => [await total(), await ledger(p), await state(p), await perCarton(p)];
const below = () => q1(`select count(*)::int from (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0) x`);
const twice = () => q1(`select count(*)::int from (select ref_id from inventory_moves where reason = 'receive' group by ref_id having count(*) > 1) x`);
await db.query(`insert into locations (code, zone, kind) values ('OB-01','open box','shelf'), ('OB-02','open box','shelf')`);
const OB2 = await q1(`select id from locations where code = 'OB-02'`);
const cartonN = (p, n) => q1('select code from wms_cartons where pallet_id = $1 and seq = $2', [p.id, n]);
const open = async (p, n, units, who = 'floor', loc = null) => as(who, 'wms_open_box', { p_carton_code: await cartonN(p, n), p_units: units, p_location: loc });
const openFix = async (p, n, units, why, who = 'admin', loc = null) => as(who, 'wms_open_box_correct', { p_carton_code: await cartonN(p, n), p_units: units, p_location: loc, p_reason: why });
const rowsOf = async (p) => (await db.query(`select m.reason, m.qty, coalesce(l.code, '-') at, m.note from inventory_moves m left join locations l on l.id = m.location_id where m.ref_type = 'wms_pallet' and m.ref_id = $1 order by m.created_at, m.id`, [p.id])).rows.map((r) => `${r.reason} ${r.qty} ${r.at}`).sort();
const unitsOf = async (p) => (await db.query(`select count(*)::int n, min(l.code) shelf, count(distinct u.code)::int codes from wms_units u join locations l on l.id = u.location_id where u.pallet_id = $1`, [p.id])).rows[0];
// a pallet opened before put-away is received in two places (cartons at the position, loose units on the shelf): one receive row per place is the design.
// A duplicate is a second receive row for the same pallet, product and place.
const dupes = () => q1(`select count(*)::int from (select 1 from inventory_moves where reason = 'receive' group by ref_id, sku_id, location_id having count(*) > 1) x`);
const all = async (p) => [await total(), await ledger(p), await state(p), await unitsOf(p), await q1('select count(*)::int from wms_cartons where pallet_id = $1 and open_box_at is not null', [p.id])];

test('before put-away nothing changes: the count found in the box is entered, nothing is posted until put-away, and then once', async () => {
  const a = await stockPallet('OB-A'); const t0 = await total();
  const r = await open(a, 3, 7); assert.deepEqual([r.units, r.location, r.seq], [7, 'OB-01', 3]);   // a short box found at receiving: normal
  assert.deepEqual([await total(), await at(a), await unitsOf(a)], [t0, {}, { n: 7, shelf: 'OB-01', codes: 7 }]);
  assert.match(await refusal(() => open(a, 3, 7)), /already an open box with 7 units/);
  await put(a, 'P-01'); assert.deepEqual([await at(a), await total()], [{ 'P-01': 90, 'OB-01': 7 }, t0 + 97], 'nine cartons at the position, the seven loose units on the shelf');
  assert.deepEqual(await rowsOf(a), ['receive 7 OB-01', 'receive 90 P-01'], 'one posting per place, no adjustments');
  assert.match(await refusal(() => open(a, 4, 5, 'client')), /cannot open a box/);
});

test('on a put-away pallet: the same count leaves the position and arrives on the shelf, as one transfer pair; any other count is refused for the floor', async () => {
  const b = await stockPallet('OB-B'); await put(b, 'P-02'); const t0 = await total(); const before = await all(b);
  assert.match(await refusal(() => open(b, 1, 25)), /Carton 1 of .* holds 10 on file, not 25\. Opening it with a different count changes stock: a ShipBay admin or staff login does that, with a reason/);
  assert.match(await refusal(() => open(b, 1, 4)), /holds 10 on file, not 4/);
  assert.match(await refusal(async () => open(b, 1, 10, 'floor', await q1(`select id from locations where code = 'P-30'`))), /P-30 is a shared Nexus position\. Loose units go on a ShipBay shelf/);
  assert.match(await refusal(async () => open(b, 1, 10, 'floor', await q1(`select id from locations where code = 'P-02'`))), /shared Nexus position|where the pallet stands/);
  assert.deepEqual(await all(b), before, 'none of the refusals changed anything: no stock, no unit rows, no carton opened');
  await open(b, 1, 10);
  assert.deepEqual([await at(b), await total(), await unitsOf(b), await receipts(b)], [{ 'P-02': 90, 'OB-01': 10 }, t0, { n: 10, shelf: 'OB-01', codes: 10 }, { n: 1, u: 100 }], 'exactly ten moved; the total and the receipt are untouched');
  assert.deepEqual(await rowsOf(b), ['receive 100 P-02', 'transfer -10 P-02', 'transfer 10 OB-01'].sort());
  assert.deepEqual((await db.query(`select note from inventory_moves where ref_id = $1 and reason = 'transfer' order by qty`, [b.id])).rows.map((r) => r.note), [`${b.psku} carton 1 opened: 10 to OB-01`, `${b.psku} carton 1 opened: 10 from P-02`]);
  // a second carton, to the other shelf; then the pallet moves and the shelves stay
  await open(b, 2, 10, 'floor', OB2); assert.deepEqual([await at(b), await total()], [{ 'P-02': 80, 'OB-01': 10, 'OB-02': 10 }, t0]);
  assert.equal((await move(b, 'P-03')).status, 200); assert.deepEqual([await at(b), await total(), await receipts(b)], [{ 'P-03': 80, 'OB-01': 10, 'OB-02': 10 }, t0, { n: 1, u: 100 }]);
  await open(b, 3, 10); assert.deepEqual([await at(b), await total()], [{ 'P-03': 70, 'OB-01': 20, 'OB-02': 10 }, t0], 'opened where the pallet stands now');
  assert.deepEqual([await below(), await dupes()], [0, 0]);
});

test('a put-away carton that really holds a different number: admin or staff, with a reason; the difference is one adjustment on record', async () => {
  const c = await stockPallet('OB-C'); await put(c, 'P-04'); const t0 = await total(); const before = await all(c);
  assert.match(await refusal(() => openFix(c, 1, 8, 'Two missing', 'floor')), /Only ShipBay admin or staff can open a box with a count that differs/);
  assert.match(await refusal(() => openFix(c, 1, 8, 'Two missing', 'client')), /cannot open a box/);
  assert.match(await refusal(() => openFix(c, 1, 8, '  ')), /Say why the count differs/); assert.match(await refusal(() => openFix(c, 1, 8, null)), /Say why the count differs/);
  assert.match(await refusal(() => openFix(c, 1, 10, 'Same count')), /A correction is only for a put-away carton whose count on file \(10\) differs/);
  assert.deepEqual(await all(c), before);
  await openFix(c, 1, 8, 'Two units missing from the box');
  assert.deepEqual([await at(c), await total(), await unitsOf(c), await receipts(c)], [{ 'P-04': 90, 'OB-01': 8 }, t0 - 2, { n: 8, shelf: 'OB-01', codes: 8 }, { n: 1, u: 100 }]);
  assert.deepEqual(await rowsOf(c), ['receive 100 P-04', 'transfer -8 P-04', 'transfer 8 OB-01', 'adjust -2 P-04'].sort());
  assert.equal(await q1(`select note from inventory_moves where ref_id = $1 and reason = 'adjust'`, [c.id]), `${c.psku} carton 1 held 8, not 10: Two units missing from the box`);
  assert.deepEqual((await db.query(`select qty, actor_name, detail - 'carton_code' detail from wms_activity where kind = 'open_box_corrected' and ref = $1`, [c.psku])).rows,
    [{ qty: 2, actor_name: 'Test Admin', detail: { carton: 1, on_file: 10, found: 8, units_change: -2, position: 'P-04', shelf: 'OB-01', reason: 'Two units missing from the box' } }]);
  // more than on file: the extra arrives on the shelf as the adjustment
  await openFix(c, 2, 12, 'Twelve in this one'); assert.deepEqual([await at(c), await total()], [{ 'P-04': 80, 'OB-01': 20 }, t0]);
  assert.deepEqual(await rowsOf(c), ['receive 100 P-04', 'transfer -8 P-04', 'transfer 8 OB-01', 'adjust -2 P-04', 'transfer -10 P-04', 'transfer 10 OB-01', 'adjust 2 OB-01'].sort());
  // not yet put away: the count is entered the usual way, a "correction" does not apply
  const c2 = await stockPallet('OB-C2'); assert.match(await refusal(() => openFix(c2, 1, 8, 'Two missing')), /Open this one the usual way/);
});

test('picks, planned waves, unpick and packing: a box cannot be opened from under picked or planned stock, and the normal flow is unchanged', async () => {
  // heavily picked: 100 received, 95 picked with the older pick list, 5 on the books at the position
  const d = await stockPallet('OB-D'); await put(d, 'P-05'); const o = await order('OB-1001', d, 95);
  await as('floor', 'wms_pick_scan', { p_lines: [o.line], p_scan: d.carton }); assert.deepEqual(await at(d), { 'P-05': 5 });
  const before = await all(d);
  assert.match(await refusal(() => open(d, 2, 10)), /cannot be opened now: that would leave -5 of OB-D at P-05, and 0 are needed there \(units have been picked from that position; it cannot go below zero\)/);
  assert.deepEqual([await all(d), await below()], [before, 0]);
  await as('floor', 'wms_unpick', { p_lines: [o.line] }); assert.deepEqual(await at(d), { 'P-05': 100 }, 'unpick works as before');
  await open(d, 2, 10); assert.deepEqual(await at(d), { 'P-05': 90, 'OB-01': 10 });
  // a wave has 85 planned at the position: 90 there, so a carton cannot leave; after the pick it can
  const o2 = await order('OB-1002', d, 85); await db.query(`update locations set pickable = false where code = 'OB-01'`);
  const w = (await as('floor2', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0]; assert.deepEqual([t.location, t.qty_planned], ['P-05', 85]);
  const planned = await all(d);
  assert.match(await refusal(() => open(d, 3, 10)), /that would leave 80 of OB-D at P-05, and 85 are needed there for picks a wave has planned/);
  assert.match(await refusal(() => openFix(d, 3, 9, 'One missing')), /85 are needed there for picks a wave has planned/);
  assert.deepEqual(await all(d), planned);
  await as('floor2', 'wms_wave_confirm', { p_task: t.id, p_qty: 85, p_scan: d.carton }); assert.deepEqual(await at(d), { 'P-05': 5, 'OB-01': 10 });
  assert.equal((await as('floor2', 'wms_wave_to_pack', { p_wave: w.id })).status, 'packing');
  assert.equal((await as('floor2', 'wms_wave_pack', { p_wave: w.id, p_orders: [o2.id], p_packages: JSON.stringify([{ items: [{ key: 'OB-D', qty: 85 }] }]) })).status, 'done');
  assert.match(await refusal(() => open(d, 3, 10)), /would leave -5 of OB-D at P-05/, 'packed stock is still picked stock');
  assert.deepEqual([await at(d), await receipts(d), await below(), await q1('select count(*)::int from wms_packages where order_id = $1', [o2.id])], [{ 'P-05': 5, 'OB-01': 10 }, { n: 1, u: 100 }, 0, 1]);
  await db.query(`update locations set pickable = true where code = 'OB-01'`);
});

test('unsettled Nexus requests, pallets that left, NCC cartons: no box is opened and nothing changes', async () => {
  const e = await stockPallet('OB-E'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: e.psku, location: 'P-06' })).status, 503);
  const waiting = await all(e);
  assert.match(await refusal(() => open(e, 1, 10)), /No box of .* can be opened yet: it has a request for P-06 that Nexus has not answered/); assert.deepEqual(await all(e), waiting);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true);
  lose(); assert.equal((await move(e, 'P-07')).status, 503); const moving = await all(e);
  assert.match(await refusal(() => open(e, 1, 10)), /it has a request for P-07 that Nexus has not answered/);
  assert.match(await refusal(() => openFix(e, 1, 9, 'One missing')), /it has a request for P-07/); assert.deepEqual(await all(e), moving);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true);
  const t0 = await total(); await open(e, 1, 10); assert.deepEqual([await at(e), await total(), await floorAt('P-07')], [{ 'P-07': 90, 'OB-01': 10 }, t0, [e.psku]], 'settled: opened at the position Nexus confirmed');
  // out of sync
  const f = await stockPallet('OB-F'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: f.psku, location: 'P-08' })).status, 503);
  await db.query(`update wms_pallets set held = true, hold_reason = 'synthetic' where id = $1`, [f.id]); assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].error, 'out_of_sync');
  const oos = await all(f);
  assert.match(await refusal(() => open(f, 1, 10)), /Nexus accepted P-08 and ShipBay has not recorded it\. An admin settles that/); assert.deepEqual(await all(f), oos);
  await as('admin', 'wms_hold_disposition', { p_pallet: f.id, p_action: 'release', p_ref: 'SYN' });
  const op = await q1(`select id from wms_nexus_ops where pallet_id = $1 and state = 'out_of_sync'`, [f.id]);
  assert.equal((await bridge('admin', 'POST', '/reconcile/record', { op, confirmed: true })).status, 200); assert.deepEqual(await at(f), { 'P-08': 100 }, 'reconciliation is as before');
  // departed, off the floor
  const g = await stockPallet('OB-G'); await put(g, 'P-09'); assert.equal((await release(g, 'P-09', 'shipped_out')).status, 200);
  const h = await stockPallet('OB-H'); await put(h, 'P-10'); assert.equal((await release(h, 'P-10', 'moved_off_shared_floor')).status, 200);
  const left = [await all(g), await all(h)];
  assert.match(await refusal(() => open(g, 1, 10)), /has left the building\. Its cartons stay as they are/); assert.match(await refusal(() => openFix(g, 1, 9, 'One missing')), /has left the building/);
  assert.match(await refusal(() => open(h, 1, 10)), /is off the shared floor\. Put it away again before opening a box/);
  assert.deepEqual([await all(g), await all(h)], left, 'cartons and ledger still agree');
  // a no-carton-count carton: its units are counted on the pallet
  const k = await stockPallet('OB-K'); await put(k, 'P-11'); await db.query('update wms_cartons set cle = true where pallet_id = $1 and seq = 1', [k.id]); const ncc = await all(k);
  assert.match(await refusal(() => open(k, 1, 10)), /has no carton count \(NCC\)/); assert.deepEqual(await all(k), ncc);
  // voiding a pallet whose opened units are untouched takes the shelf units with it; nothing is left below zero
  await voidIt(e).catch((x) => assert.fail(String(x.message)));
  assert.deepEqual([await at(e), await below(), await dupes()], [{}, 0, 0]);
  assert.equal(await q1(`select count(*)::int from inventory_moves where reason = 'transfer' group by ref_id having sum(qty) <> 0 limit 1`), null, 'every pallet\'s transfers net to zero');
});
