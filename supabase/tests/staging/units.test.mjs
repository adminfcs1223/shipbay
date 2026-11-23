// Unit-count safety (part 2 of supabase/candidates/20261204_wms_pallet_stock_safety.sql), end to end on this machine only:
// ShipBay's database functions on isolated synthetic rows + the bridge in-process + the REAL Nexus service code in a throwaway
// local database. Nothing here reaches Supabase, Nexus staging or production. The harness is the one workflow.test.mjs uses.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { calendarRoutes } from '../../functions/nexus-bridge/calendar.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Client(`${base}/staging`); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261127_wms_waves', '20261128_nexus_registry_sync', '20261129_wms_calendar_publish', '20261130_wms_nexus_putaway', '20261201_wms_nexus_departure', '20261202_wms_inventory_safeguards', '20261203_wms_inventory_workflow', '20261204_wms_pallet_stock_safety']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));

// ---- the real Nexus, local ----
await db.query('drop database if exists nexus_units_test'); await db.query('create database nexus_units_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_units_test` });
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
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_units_test').catch(() => {}); await db.end(); });

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

test('clean changes: the count is entered freely before put-away; on a put-away pallet it is a correction by admin or staff with a reason, posted once and on record', async () => {
  const a = await stockPallet('UN-A');
  assert.equal(await setUnits(a, 12), 0, 'before put-away: any floor login, no stock yet'); assert.deepEqual([await perCarton(a), await at(a)], [12, {}]);
  await put(a, 'P-01'); assert.deepEqual(await state(a), ['stored', 'P-01', { 'P-01': 120 }, { n: 1, u: 120 }]);
  const before = await everything(a);
  assert.match(await refusal(() => setUnits(a, 10)), /is put away, so changing its count changes stock\. A ShipBay admin or staff login corrects it, with a reason/);
  assert.match(await refusal(() => fix(a, 10, 'Recount', 'floor')), /Only ShipBay admin or staff/);
  assert.match(await refusal(() => fix(a, 10, 'Recount', 'client')), /Only ShipBay admin or staff/);
  assert.match(await refusal(() => fix(a, 10, '  ')), /Say why/); assert.match(await refusal(() => fix(a, -1)), /whole number/);
  assert.deepEqual(await everything(a), before, 'none of the refusals changed anything');
  const t0 = await total(); const r = await fix(a, 10, 'Recounted: 10 per carton');
  assert.deepEqual([r.units_change, r.from, r.to, await at(a), await total(), await receipts(a)], [-20, 12, 10, { 'P-01': 100 }, t0 - 20, { n: 1, u: 120 }]);
  assert.equal(await q1(`select note from inventory_moves where ref_id = $1 and reason = 'adjust'`, [a.id]), `${a.psku} count corrected: Recounted: 10 per carton`);
  assert.deepEqual((await db.query(`select kind, qty, ref, actor_name, detail from wms_activity where kind = 'pallet_units_corrected' and ref = $1`, [a.psku])).rows,
    [{ kind: 'pallet_units_corrected', qty: 20, ref: a.psku, actor_name: 'Test Admin', detail: { item: null, from: 12, to: 10, units_change: -20, position: 'P-01', reason: 'Recounted: 10 per carton' } }]);
  assert.equal((await fix(a, 11, 'Found one more per carton')).units_change, 10); assert.deepEqual(await at(a), { 'P-01': 110 });
  const n = (await ledger(a)).length; assert.equal((await fix(a, 11, 'Same again')).units_change, 0); assert.equal((await ledger(a)).length, n, 'no change, no ledger row');
  assert.equal(await q1(`select count(*)::int from wms_activity where kind = 'pallet_units_corrected' and ref = $1`, [a.psku]), 2);
  assert.match(await refusal(async () => fix(await stockPallet('UN-A2'), 5)), /is not put away yet\. Enter its count the usual way/);
});

test('partial pick, unpick, moved pallet: the count cannot go below what was picked, wherever the pallet stands now', async () => {
  const b = await stockPallet('UN-B'); await put(b, 'P-02'); const o = await order('UN-1001', b, 30);
  await as('floor', 'wms_pick_scan', { p_lines: [o.line], p_scan: b.carton }); assert.deepEqual(await at(b), { 'P-02': 70 });
  const before = await everything(b);
  assert.match(await refusal(() => fix(b, 2)), /would make .* hold 20 of UN-B, and 30 have been picked from it\. The count cannot go below that/);
  assert.match(await refusal(() => fix(b, 0)), /hold 0 of UN-B, and 30 have been picked/);
  assert.deepEqual([await everything(b), await below()], [before, 0], 'refused: 70 at P-02, the pick on record, nothing below zero');
  await fix(b, 9); assert.deepEqual(await at(b), { 'P-02': 60 }, 'a correction that leaves real stock is allowed');
  // it moves: the pick travels with it and still counts
  assert.equal((await move(b, 'P-03')).status, 200); assert.deepEqual(await at(b), { 'P-03': 60 });
  assert.match(await refusal(() => fix(b, 2)), /30 have been picked from it/); assert.deepEqual(await at(b), { 'P-03': 60 });
  await fix(b, 3); assert.deepEqual([await at(b), await below()], [{}, 0], 'down to exactly what was picked: the new position is empty, the old one untouched');
  await fix(b, 10); assert.deepEqual(await at(b), { 'P-03': 70 });
  // the pick is undone: nothing has been picked any more, so the floor is zero again
  await as('floor', 'wms_unpick', { p_lines: [o.line] }); assert.deepEqual(await at(b), { 'P-03': 100 });
  await fix(b, 1); assert.deepEqual([await at(b), await receipts(b), await below()], [{ 'P-03': 10 }, { n: 1, u: 100 }, 0]);
});

test('planned wave stops and packed orders: a correction cannot take stock a wave has planned, or stock already picked and packed', async () => {
  const c = await stockPallet('UN-C'); await put(c, 'P-04'); const o = await order('UN-1002', c, 12);
  const w = (await as('floor2', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0]; assert.deepEqual([t.location, t.qty_planned], ['P-04', 12]);
  const before = await everything(c);
  assert.match(await refusal(() => fix(c, 1)), /hold 10 of UN-C, and 0 have been picked from it with 12 more planned by a wave/);
  assert.deepEqual(await everything(c), before);
  await fix(c, 2); assert.deepEqual(await at(c), { 'P-04': 20 }, 'enough is left for the planned stop');
  await as('floor2', 'wms_wave_confirm', { p_task: t.id, p_qty: 12, p_scan: c.carton }); assert.deepEqual(await at(c), { 'P-04': 8 });
  assert.match(await refusal(() => fix(c, 1)), /12 have been picked from it/);
  // packed: the units are in a labelled package; the pick still stands
  assert.equal((await as('floor2', 'wms_wave_to_pack', { p_wave: w.id })).status, 'packing');
  assert.equal((await as('floor2', 'wms_wave_pack', { p_wave: w.id, p_orders: [o.id], p_packages: JSON.stringify([{ items: [{ key: 'UN-C', qty: 12 }] }]) })).status, 'done');
  const packed = await everything(c);
  assert.match(await refusal(() => fix(c, 1)), /12 have been picked from it/); assert.match(await refusal(() => fix(c, 0)), /12 have been picked/);
  assert.deepEqual([await everything(c), await q1('select count(*)::int from wms_packages where order_id = $1', [o.id])], [packed, 1]);
  await fix(c, 5); assert.deepEqual([await at(c), await below()], [{ 'P-04': 38 }, 0], 'an increase is fine after packing');
  // an older pick that names no pallet: the position itself cannot go below zero
  const d = await stockPallet('UN-D'); await put(d, 'P-05');
  await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) select $1, $2, -25, 'pick', 'order_line', gen_random_uuid(), 'older pick', id from locations where code = 'P-05'`, [A, d.sku]);
  assert.match(await refusal(() => fix(d, 2)), /would leave -5 of UN-D at P-05, and 0 are needed there \(it cannot go below zero\)/); assert.deepEqual(await at(d), { 'P-05': 75 });
});

test('pending and ambiguous Nexus requests: no count change until the request is settled; reconciliation then works as before', async () => {
  const e = await stockPallet('UN-E');
  lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: e.psku, location: 'P-06' })).status, 503);
  assert.match(await refusal(() => setUnits(e, 5)), /cannot be changed yet: it has a request for P-06 that Nexus has not answered/); assert.equal(await perCarton(e), 10);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true); assert.deepEqual(await state(e), ['stored', 'P-06', { 'P-06': 100 }, { n: 1, u: 100 }]);
  lose(); assert.equal((await move(e, 'P-07')).status, 503);
  const before = await everything(e);
  assert.match(await refusal(() => fix(e, 5)), /cannot be corrected yet: it has a request for P-07 that Nexus has not answered/);
  assert.match(await refusal(() => setUnits(e, 5)), /cannot be changed yet/); assert.deepEqual(await everything(e), before, 'no stock changed under a move Nexus already holds');
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true); assert.deepEqual(await at(e), { 'P-07': 100 });
  await fix(e, 9); assert.deepEqual([await at(e), await floorAt('P-07')], [{ 'P-07': 90 }, [e.psku]], 'settled: corrected where it stands now');
  // ambiguous: Nexus accepted, ShipBay could not record
  const f = await stockPallet('UN-F'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: f.psku, location: 'P-08' })).status, 503);
  await db.query(`update wms_pallets set held = true, hold_reason = 'synthetic' where id = $1`, [f.id]);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].error, 'out_of_sync');
  assert.match(await refusal(() => setUnits(f, 5)), /Nexus accepted P-08 and ShipBay has not recorded it\. An admin settles that/);
  assert.match(await refusal(() => fix(f, 5)), /An admin settles that/); assert.equal(await perCarton(f), 10);
  await as('admin', 'wms_hold_disposition', { p_pallet: f.id, p_action: 'release', p_ref: 'SYN' });
  const op = await q1(`select id from wms_nexus_ops where pallet_id = $1 and state = 'out_of_sync'`, [f.id]);
  assert.equal((await bridge('admin', 'POST', '/reconcile/record', { op, confirmed: true })).status, 200);
  assert.deepEqual(await state(f), ['stored', 'P-08', { 'P-08': 100 }, { n: 1, u: 100 }], 'recorded with the count it was received with');
  await fix(f, 8); assert.deepEqual(await at(f), { 'P-08': 80 });
});

test('pallets that left: the count is frozen for a departed pallet and for one off the shared floor; nothing is below zero and no pallet has two receipts', async () => {
  const g = await stockPallet('UN-G'); await put(g, 'P-09'); assert.equal((await release(g, 'P-09', 'shipped_out')).status, 200);
  const h = await stockPallet('UN-H'); await put(h, 'P-10'); assert.equal((await release(h, 'P-10', 'moved_off_shared_floor')).status, 200);
  const before = [await everything(g), await everything(h)];
  assert.match(await refusal(() => setUnits(g, 1)), /has left the building\. Its count stays as it is/); assert.match(await refusal(() => fix(g, 1)), /has left the building/);
  assert.match(await refusal(() => setUnits(h, 1)), /is off the shared floor\. Put it away again/); assert.match(await refusal(() => fix(h, 1)), /is off the shared floor/);
  assert.deepEqual([await everything(g), await everything(h)], before, 'cartons and ledger both untouched: they still agree');
  await voidIt(await stockPallet('UN-V')).catch(() => {}); assert.match(await refusal(async () => setUnits({ id: await q1(`select id from wms_pallets where status = 'void' limit 1`) }, 1)), /is void/);
  assert.deepEqual([await below(), await twice()], [0, 0]);
});
