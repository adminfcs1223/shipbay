// Inventory workflow repairs (supabase/candidates/20261203_wms_inventory_workflow.sql), end to end on this machine only:
// ShipBay's database functions on isolated synthetic rows + the bridge in-process + the REAL Nexus service code in a throwaway
// local database. Nothing here reaches Supabase, Nexus staging or production.
// Each test names the gap it closes (numbers as in Derek's 2026-11-23 list).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { calendarRoutes } from '../../functions/nexus-bridge/calendar.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Client(`${base}/staging`); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261127_wms_waves', '20261128_nexus_registry_sync', '20261129_wms_calendar_publish', '20261130_wms_nexus_putaway', '20261201_wms_nexus_departure', '20261202_wms_inventory_safeguards', '20261203_wms_inventory_workflow', '20261204_wms_void_safety']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));

// ---- the real Nexus, local ----
await db.query('drop database if exists nexus_workflow_test'); await db.query('create database nexus_workflow_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_workflow_test` });
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
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_workflow_test').catch(() => {}); await db.end(); });

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

test('1. a planned wave stop follows its pallet when Nexus confirms a move; a pallet with a planned stop cannot be released', async () => {
  const a = await stockPallet('WF-A'); await put(a, 'P-01'); await order('WF-1001', a, 5);
  const w = (await as('floor', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0]; assert.deepEqual([t.location, t.qty_planned, t.psku], ['P-01', 5, a.psku]);
  // release while the pick is planned: refused by ShipBay before Nexus is asked
  const n = nexusPosts(); const rel = await release(a, 'P-01', 'shipped_out'); assert.equal(rel.status, 409); assert.equal(rel.error, 'refused_by_shipbay'); assert.match(rel.message, /still has a pick planned/); assert.equal(nexusPosts(), n);
  const before = await total(); const mv = await move(a, 'P-02'); assert.equal(mv.status, 200);
  assert.deepEqual(await stop(t.id), { code: 'P-02', has_pallet: true, confirmed: false, qty_picked: null }, 'the stop now points at the position Nexus confirmed');
  assert.equal((await as('floor', 'wms_wave_start', { p_org: A })).wave.tasks[0].location, 'P-02', 'and the picker\'s screen shows it');
  assert.deepEqual([await at(a), await total(), await receipts(a)], [{ 'P-02': 100 }, before, { n: 1, u: 100 }], 'the move changed no quantity and made no receipt');
  await as('floor', 'wms_wave_confirm', { p_task: t.id, p_qty: 5, p_scan: a.carton }); assert.deepEqual(await at(a), { 'P-02': 95 });
  // even a stop that was never re-pointed (written before this fix) is picked where the pallet stands
  await as('floor', 'wms_wave_unconfirm', { p_task: t.id }); await db.query(`update wms_wave_tasks set location_id = (select id from locations where code = 'P-01') where id = $1`, [t.id]);
  await as('floor', 'wms_wave_confirm', { p_task: t.id, p_qty: 5, p_scan: a.carton }); assert.deepEqual([await at(a), (await stop(t.id)).code], [{ 'P-02': 95 }, 'P-02']);
  // with the pick done, the pallet may leave
  assert.equal((await release(a, 'P-02', 'moved_off_shared_floor')).status, 200); assert.deepEqual(await at(a), { 'OFF-FLOOR': 95 });
});

test('5. while Nexus has not settled a pallet\'s movement: its stock is not planned or picked, its stop cannot be confirmed or reopened, and it cannot be moved again', async () => {
  const b = await stockPallet('WF-B'); await put(b, 'P-03'); const o = await order('WF-1002', b, 4);
  lose(); assert.equal((await move(b, 'P-04')).status, 503);   // Nexus has it at P-04, ShipBay still at P-03: not settled
  const start = await as('floor2', 'wms_wave_start', { p_org: A }); assert.equal(start.wave, null, 'the planner offers nothing from it'); assert.deepEqual(start.short.map((s) => [s.order_number, s.need, s.on_file]), [['WF-1002', 4, 0]]);
  const old = await as('floor2', 'wms_pick_scan', { p_lines: [o.line], p_scan: b.carton }); assert.deepEqual([old.picked, old.unposted_units, await at(b)], [1, 4, { 'P-03': 100 }], 'the older pick list takes nothing from it either');
  await as('floor2', 'wms_unpick', { p_lines: [o.line] }); await db.query(`update wms_pick_problems set resolved_at = now() where line_id = $1`, [o.line]);
  const again = await move(b, 'P-05'); assert.equal(again.status, 409); assert.match(again.message, /already has a request for P-04/);
  const rel = await release(b, 'P-03', 'shipped_out'); assert.equal(rel.status, 409); assert.match(rel.message, /already has a request/);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true); assert.deepEqual([(await row(b)).code, await at(b)], ['P-04', { 'P-04': 100 }]);
  const w = (await as('floor2', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0]; assert.equal(t.location, 'P-04', 'settled: planned from the confirmed position');
  lose(); assert.equal((await move(b, 'P-03')).status, 503);
  assert.match(await refusal(() => as('floor2', 'wms_wave_confirm', { p_task: t.id, p_qty: 4, p_scan: b.carton })), /waiting for Nexus/); assert.deepEqual(await at(b), { 'P-04': 100 });
  await bridge('floor', 'POST', '/pending/retry'); assert.equal((await stop(t.id)).code, 'P-03', 'the planned stop followed the settled move');
  await as('floor2', 'wms_wave_confirm', { p_task: t.id, p_qty: 4, p_scan: b.carton }); assert.deepEqual(await at(b), { 'P-03': 96 });
  lose(); assert.equal((await move(b, 'P-04')).status, 503);
  assert.match(await refusal(() => as('floor2', 'wms_wave_unconfirm', { p_task: t.id })), /waiting for Nexus/); assert.deepEqual(await at(b), { 'P-03': 96 });
  await bridge('floor', 'POST', '/pending/retry'); assert.deepEqual(await at(b), { 'P-04': 96 }, 'the move carried what was really left');
  await as('floor2', 'wms_wave_unconfirm', { p_task: t.id }); assert.deepEqual([await at(b), (await stop(t.id)).code, await receipts(b)], [{ 'P-04': 100 }, 'P-04', { n: 1, u: 100 }], 'reopened at the position the pallet stands at now');
  // accepted by Nexus but not recorded by ShipBay (out of sync) counts as not settled too
  const c = await stockPallet('WF-B2'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: c.psku, location: 'P-06' })).status, 503);
  await db.query(`update wms_pallets set held = true, hold_reason = 'synthetic' where id = $1`, [c.id]); assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].error, 'out_of_sync');
  assert.match(await refusal(async () => as('floor', 'wms_assign_location', { p_pallet: c.id, p_location: await q1(`select id from locations where code = 'B-01'`) })), /waiting on cartons|waiting for put-away|waiting for Nexus/);
});

test('2. the older pick list: the pick travels with the pallet, an undo goes where the pallet stands now, and nothing returns to a position the pallet has left', async () => {
  const c = await stockPallet('WF-C'); await put(c, 'P-07'); const o = await order('WF-1003', c, 30);
  await as('floor', 'wms_pick_scan', { p_lines: [o.line], p_scan: c.carton });
  assert.equal(await q1(`select pallet_id from inventory_moves where ref_id = $1 and reason = 'pick'`, [o.line]), c.id, 'the pick names its pallet'); assert.equal(await q1('select pallet_id from wms_picks where line_id = $1', [o.line]), c.id);
  const t0 = await total(); assert.equal((await move(c, 'P-08')).status, 200);
  assert.deepEqual([await at(c), await total()], [{ 'P-08': 70 }, t0], 'after the move: nothing at P-07, the 70 really left at P-08 (before the fix: -30 and 100)');
  await as('floor', 'wms_unpick', { p_lines: [o.line] }); assert.deepEqual([await at(c), await total()], [{ 'P-08': 100 }, t0 + 30], 'undo put the 30 back at P-08, where the pallet is');
  // pick again, the pallet leaves the shared floor: the undo is refused, and nothing is written
  await as('floor', 'wms_pick_scan', { p_lines: [o.line], p_scan: c.carton }); assert.equal((await release(c, 'P-08', 'moved_off_shared_floor')).status, 200); assert.deepEqual(await at(c), { 'OFF-FLOOR': 70 });
  const t1 = await total(); assert.match(await refusal(() => as('floor', 'wms_unpick', { p_lines: [o.line] })), /has left the shared floor\. A manager returns them/); assert.equal(await total(), t1);
  // 7. the manager's correction: admin only, with a reason, to a ShipBay shelf only
  const fix = (who, to, why = 'Units came back from packing') => as(who, 'wms_pick_correct', { p_kind: 'order_line', p_id: o.line, p_to_location: to, p_reason: why });
  assert.match(await refusal(() => fix('floor', 'A-01-1')), /Only ShipBay admin or staff/); assert.match(await refusal(() => fix('admin', 'A-01-1', ' ')), /Say why/);
  assert.match(await refusal(() => fix('admin', 'P-08')), /shared Nexus position/); assert.match(await refusal(() => fix('admin', 'OFF-FLOOR')), /not a pickable location/); assert.equal(await total(), t1);
  const done = await fix('admin', 'A-01-1'); assert.deepEqual([done.units_returned, done.returned_to], [30, 'A-01-1']);
  assert.deepEqual([await at(c), await total(), await receipts(c)], [{ 'OFF-FLOOR': 70, 'A-01-1': 30 }, t1 + 30, { n: 1, u: 100 }], 'exactly the 30 picked are back on the books, on the shelf');
  assert.equal(await q1('select picked_at from order_lines where id = $1', [o.line]), null); assert.match(await refusal(() => fix('admin', 'A-01-1')), /no pick to correct/);
  // a pick written before this fix (no pallet on it) at a one-pallet position: tied to the pallet when it moves, so it travels too
  const d = await stockPallet('WF-D'); await put(d, 'P-09'); const od = await order('WF-1004', d, 10);
  await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) select $1, $2, -10, 'pick', 'order_line', $3, 'Order WF-1004', id from locations where code = 'P-09'`, [A, d.sku, od.line]);
  await db.query(`insert into wms_picks (line_id, order_id, org_id, sku_id, location_id, qty) select $1, $2, $3, $4, id, 10 from locations where code = 'P-09'`, [od.line, od.id, A, d.sku]); await db.query('update order_lines set picked_at = now() where id = $1', [od.line]);
  assert.equal((await move(d, 'P-10')).status, 200); assert.deepEqual(await at(d), { 'P-10': 90 }); await as('floor', 'wms_unpick', { p_lines: [od.line] }); assert.deepEqual(await at(d), { 'P-10': 100 });
  assert.equal((await move(d, 'P-09')).status, 200); assert.equal((await move(d, 'P-10')).status, 200); assert.deepEqual(await at(d), { 'P-10': 100 }, 'coming back to the first position and leaving again carries nothing twice');
});

test('3 and 4. shared positions are never reserved, suggested or shown as taken from ShipBay\'s own records; private ShipBay positions work as before', async () => {
  const e = await stockPallet('WF-E'); await db.query('update wms_cartons set scanned_at = now() where pallet_id = $1', [e.id]);
  const counted = await as('floor', 'wms_complete_count', { p_pallet: e.id });
  assert.equal((await row(e)).code, 'B-01', 'the suggestion after counting is a private ShipBay position, never a shared one');
  const id = (code) => q1('select id from locations where code = $1', [code]);
  assert.match(await refusal(async () => as('floor', 'wms_assign_location', { p_pallet: e.id, p_location: await id('P-20') })), /shared Nexus position\. It cannot be reserved here/);
  assert.match(await refusal(() => db.query(`update wms_pallets set location_id = (select id from locations where code = 'P-20') where id = $1`, [e.id])), /shared Nexus position/);
  assert.equal(await q1(`select count(*)::int from wms_pallets p join locations l on l.id = p.location_id where l.shared and p.status <> 'stored'`), 0, 'no pallet holds a shared position on ShipBay\'s side alone');
  // with the private position taken, a second counted pallet gets no suggestion at all rather than a shared one
  const f = await stockPallet('WF-F'); await db.query('update wms_cartons set scanned_at = now() where pallet_id = $1', [f.id]); await as('floor', 'wms_complete_count', { p_pallet: f.id }); assert.equal((await row(f)).code, null);
  // the private flow is unchanged: assign, scan, stored, stock posted once
  await as('floor', 'wms_putaway', { p_pallet: e.id, p_psku: e.psku, p_location_code: 'B-01' }); assert.deepEqual([await row(e), await at(e), await receipts(e)], [{ status: 'stored', code: 'B-01' }, { 'B-01': 100 }, { n: 1, u: 100 }]);
  // the counted pallet with no suggestion goes to the shared floor the only way there is: Nexus accepts the scan
  await put(f, 'P-20'); assert.deepEqual([await row(f), await at(f)], [{ status: 'stored', code: 'P-20' }, { 'P-20': 100 }]); void counted;
});

test('6 and 7. the exceptions report lists what an admin must act on; a departed pallet\'s leftover units stay on the books and stay listed; a wave stop whose pallet left is corrected by a manager', async () => {
  const g = await stockPallet('WF-G'); await put(g, 'P-11'); await order('WF-1005', g, 6);
  const w = (await as('floor3', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0]; await as('floor3', 'wms_wave_confirm', { p_task: t.id, p_qty: 6, p_scan: g.carton }); assert.deepEqual(await at(g), { 'P-11': 94 });
  assert.equal((await release(g, 'P-11', 'shipped_out')).status, 200); const t0 = await total(); assert.deepEqual([await row(g), await at(g)], [{ status: 'departed', code: null }, { 'P-11': 94 }], 'the release deducted nothing');
  assert.match(await refusal(() => as('floor', 'wms_nexus_exceptions', {})), /Only ShipBay admin or staff/);
  let x = await as('admin', 'wms_nexus_exceptions', {});
  assert.deepEqual(x.departed_with_stock.map((r) => [r.pallet, r.left_from, r.reason, r.units, r.lines.map((l) => [l.sku, l.position, l.units])]), [[g.psku, 'P-11', 'shipped_out', 94, [['WF-G', 'P-11', 94]]]]);
  assert.deepEqual(x.stops_without_pallet, [], 'no planned stop is stranded');
  assert.ok(x.off_floor.some((r) => r.units === 95) && x.off_floor.some((r) => r.units === 70), 'the two pallets taken off the floor earlier are listed with their units');
  assert.equal(x.needs_action, 1);
  // 7. reopening the stop the normal way is refused; the manager returns the 6 units to a shelf and the stop reopens there
  assert.match(await refusal(() => as('floor3', 'wms_wave_unconfirm', { p_task: t.id })), /has left the shared floor\. A manager returns these units/); assert.equal(await total(), t0);
  const fix = (who, to) => as(who, 'wms_pick_correct', { p_kind: 'wave_stop', p_id: t.id, p_to_location: to, p_reason: 'Order changed after the pallet shipped' });
  assert.match(await refusal(() => fix('floor3', 'A-01-1')), /Only ShipBay admin or staff/); assert.match(await refusal(() => fix('admin', 'P-11')), /shared Nexus position/); assert.match(await refusal(() => fix('admin', 'P-12')), /shared Nexus position/); assert.equal(await total(), t0);
  const done = await fix('admin', 'A-01-1'); assert.deepEqual([done.units_returned, done.returned_to, done.pallet], [6, 'A-01-1', g.psku]);
  assert.deepEqual([await at(g), await total(), await stop(t.id)], [{ 'P-11': 94, 'A-01-1': 6 }, t0 + 6, { code: 'A-01-1', has_pallet: false, confirmed: false, qty_picked: null }], 'the 6 are on the shelf, nothing went back to P-11, and the stop is a shelf stop');
  assert.match(await refusal(() => fix('admin', 'A-01-1')), /no confirmed pick to correct/);
  assert.equal((await db.query(`select detail from wms_activity where kind = 'pick_corrected' and ref = $1`, [g.psku])).rows[0].detail.returned_to, 'A-01-1', 'who, what and why are in the activity log');
  await as('floor3', 'wms_wave_confirm', { p_task: t.id, p_qty: 6, p_scan: g.carton }); assert.deepEqual(await at(g), { 'P-11': 94 }, 'picked again from the shelf');
  // an admin's forced correction can take a pallet away under a planned stop: the stop is reported, takes 0, and goes to a manager
  const k = await stockPallet('WF-K'); await put(k, 'P-13'); await order('WF-1006', k, 2); const wk = (await as('floor4', 'wms_wave_start', { p_org: A })).wave; const tk = wk.tasks.find((s2) => s2.psku === k.psku);
  assert.match((await release(k, 'P-13', 'moved_off_shared_floor')).message, /still has a pick planned/); assert.equal((await release(k, 'P-13', 'correction', 'admin')).status, 200);
  x = await as('admin', 'wms_nexus_exceptions', {}); assert.deepEqual(x.stops_without_pallet.map((r) => [r.pallet, r.pallet_status, r.stop_position, r.pallet_position, r.units]), [[k.psku, 'off_floor', 'P-13', null, 2]]);
  assert.match(await refusal(() => as('floor4', 'wms_wave_confirm', { p_task: tk.id, p_qty: 2, p_scan: k.carton })), /no longer on the floor\. Enter 0/); assert.deepEqual(await at(k), { 'OFF-FLOOR': 100 });
  const short = await as('floor4', 'wms_wave_confirm', { p_task: tk.id, p_qty: 0, p_scan: null }); assert.equal(short.orders.find((o2) => o2.order_number === 'WF-1006').pack_state, 'problem'); assert.deepEqual(await at(k), { 'OFF-FLOOR': 100 });
  x = await as('admin', 'wms_nexus_exceptions', {}); assert.deepEqual(x.stops_without_pallet, []);
  // 6. the report is all there is: no close-out or deduction action exists (Derek, 2026-11-23), and the 94 units stay on the books and stay listed
  assert.equal(await q1(`select count(*)::int from pg_proc where proname = 'wms_departed_stock_close'`), 0);
  x = await as('admin', 'wms_nexus_exceptions', {}); assert.deepEqual(x.departed_with_stock.map((r) => [r.pallet, r.units]), [[g.psku, 94]]); assert.match(x.departed_with_stock[0].action, /nothing here does/); assert.deepEqual(await at(g), { 'P-11': 94 });
  const alive = await stockPallet('WF-H'); await put(alive, 'P-12');
  // a position held on ShipBay's side only (possible in records written before this fix) and an older pick with no pallet are both reported
  await db.query(`set session_replication_role = replica`); const legacy = await stockPallet('WF-L');
  await db.query(`update wms_pallets set status = 'counted', location_id = (select id from locations where code = 'P-30') where id = $1`, [legacy.id]);
  await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) select $1, $2, -3, 'pick', 'order_line', gen_random_uuid(), 'old pick', id from locations where code = 'P-12'`, [A, alive.sku]); await db.query(`set session_replication_role = origin`);
  x = await as('admin', 'wms_nexus_exceptions', {}); assert.deepEqual(x.held_in_shipbay_only.map((r) => [r.pallet, r.status, r.position]), [[legacy.psku, 'counted', 'P-30']]); assert.deepEqual(x.picks_without_pallet.map((r) => [r.position, r.sku, r.units]), [['P-12', 'WF-H', 3]]);
  await put(legacy, 'P-31'); assert.deepEqual((await as('admin', 'wms_nexus_exceptions', {})).held_in_shipbay_only, [], 'scanning it under Put away settles it: Nexus accepted P-31');
});

test('across everything above: one receipt per pallet, no adjustment at all, transfers net to zero, ShipBay and Nexus agree', async () => {
  assert.equal(await q1(`select count(*)::int from (select ref_id from inventory_moves where reason = 'receive' group by 1 having count(*) > 1) x`), 0);
  assert.equal(await q1(`select count(*)::int from inventory_moves where reason = 'adjust'`), 0);
  assert.equal(await q1(`select coalesce(sum(qty),0)::int from inventory_moves where reason = 'transfer'`), 0);
  assert.equal(await q1(`select count(*)::int from (select m.sku_id, m.location_id from inventory_moves m group by 1, 2 having sum(m.qty) < 0) x`), 0, 'no position shows a negative quantity');
  assert.equal(await q1(`select count(*)::int from wms_wave_tasks t join wms_waves w on w.id = t.wave_id and w.status = 'picking' join wms_pallets p on p.id = t.pallet_id where t.confirmed_at is null and p.location_id is distinct from t.location_id`), 0, 'no planned stop points away from its pallet');
  const rec = await bridge('admin', 'GET', '/reconcile'); assert.deepEqual([rec.in_sync === false, rec.waiting.map((w2) => w2.state)], [true, ['out_of_sync']], 'only the deliberately unresolved out-of-sync request is open');
  assert.deepEqual(rec.differences, []);
});
