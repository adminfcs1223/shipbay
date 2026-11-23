// Manager access to pick corrections (supabase/candidates/20261206_wms_manager_pick_corrections.sql), end to end on this
// machine only: ShipBay's database functions on isolated synthetic rows + the bridge in-process + the REAL Nexus service code
// in a throwaway local database. Nothing here reaches Supabase, Nexus staging or production.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { calendarRoutes } from '../../functions/nexus-bridge/calendar.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Client(`${base}/staging`); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261127_wms_waves', '20261128_nexus_registry_sync', '20261129_wms_calendar_publish', '20261130_wms_nexus_putaway', '20261201_wms_nexus_departure', '20261202_wms_inventory_safeguards', '20261203_wms_inventory_workflow', '20261204_wms_pallet_stock_safety', '20261205_wms_open_box_safety', '20261206_wms_manager_pick_corrections']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));

// ---- the real Nexus, local ----
await db.query('drop database if exists nexus_manager_test'); await db.query('create database nexus_manager_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_manager_test` });
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
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_manager_test').catch(() => {}); await db.end(); });

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

// ---- this file's additions: a staff and a sales login, a second brand, a client login in each brand, more floor logins ----
const B = 'd9000000-0000-4000-8000-00000000000b'; await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Mailers','syn-b','active')`, [B]);
Object.assign(U, { staff: 'c9000000-0000-4000-8000-0000000000a1', sales: 'c9000000-0000-4000-8000-0000000000a2', clientA: 'c9000000-0000-4000-8000-0000000000a3', clientB: 'c9000000-0000-4000-8000-0000000000a4' });
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'staff@example.test','{"role":"shipbay_staff","full_name":"Test Staff"}'), ($2,'sales@example.test','{"role":"shipbay_sales","full_name":"Test Sales"}'),
  ($3,'client-a@example.test','{"role":"client_admin","full_name":"Client A"}'), ($4,'client-b@example.test','{"role":"client_admin","full_name":"Client B"}')`, [U.staff, U.sales, U.clientA, U.clientB]);
await db.query('update profiles set org_id = $2 where id = $1', [U.clientA, A]); await db.query('update profiles set org_id = $2 where id = $1', [U.clientB, B]);
for (let n = 1; n <= 12; n++) { U[`p${n}`] = `c9000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`; await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [U[`p${n}`], `picker${n}@example.test`, JSON.stringify({ role: 'wms_employee', full_name: `Picker ${n}` })]); }
await db.query(`insert into locations (code, zone, kind) values ('A-02-1','shelf','shelf'), ('A-03-1','shelf','shelf')`);
const WHY = 'Order changed after the pallet left';
/** one product of a brand, one received pallet of 10 x 10 put away at a shared position */
async function pallet(org, name, at) {
  const sku = await q1(`insert into skus (org_id, sku, name) values ($1, $2, $2) returning id`, [org, name]);
  const inb = await as('admin', 'nexus_shipment_create', { p_org: org, p_reference: `SYN-PO-${name}`, p_origin: 'Vendor', p_expected: today, p_pallets: 2, p_cartons: 20, p_notes: null, p_lines: JSON.stringify([{ sku_id: sku, qty: 200 }]) });
  await db.query('begin'); await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.floor, role: 'authenticated' })]);
  const p = (await db.query(`select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,'partial',null)`, [inb, org, JSON.stringify([{ sku, cartons: 10, units_per_carton: 10 }]), `mg-${++seq}`])).rows[0]; await db.query('commit');
  const x = { org, sku, name, id: p.id, psku: p.psku, carton: await q1('select min(code) from wms_cartons where pallet_id = $1', [p.id]) }; await put(x, at); return x;
}
async function orderFor(p, no, qty) { const id = await q1(`insert into orders (org_id, order_number, source, status, total_units) values ($1,$2,'connector','new',$3) returning id`, [p.org, no, qty]);
  await q1(`insert into order_lines (order_id, sku_id, sku, name, qty) values ($1,$2,$3,$3,$4) returning id`, [id, p.sku, p.name, qty]); return id; }
/** a picker's wave for one fresh order of this pallet's product; returns the wave and its one stop */
async function wave(who, p, no, qty) { const order = await orderFor(p, no, qty); const w = (await as(who, 'wms_wave_start', { p_org: p.org })).wave; const t = w.tasks.find((x) => x.psku === p.psku); assert.ok(t, 'the wave has a stop at this pallet'); return { w, t, order }; }
const pick = (who, t, p, qty) => as(who, 'wms_wave_confirm', { p_task: t.id, p_qty: qty, p_scan: qty ? p.carton : null });
const list = (who, org) => as(who, 'wms_manager_stops', { p_org: org });
const fix = (who, org, task, to = 'A-01-1', why = WHY) => as(who, 'wms_manager_stop_correct', { p_org: org, p_task: task, p_to_location: to, p_reason: why });
const ledger = async () => (await db.query('select count(*)::int n, coalesce(sum(qty),0)::int u from inventory_moves')).rows[0];
const lastRows = async (n) => (await db.query(`select m.qty, m.reason, l.code, m.note, m.created_by, m.org_id, m.ref_type, m.ref_id, m.pallet_id from inventory_moves m left join locations l on l.id = m.location_id order by m.created_at desc, m.id desc limit $1`, [n])).rows;
const anon = async (fn, args) => { try { await run('anon', null, fn, args); return null; } catch (e) { return String(e.message); } };
const NOBODY = '00000000-0000-4000-8000-00000000dead';

test('a manager finds a floor picker\'s stop whose pallet left, and returns the units to a shelf; the floor, client, sales and public logins cannot', async () => {
  const g = await pallet(A, 'MG-A', 'P-11'); const { w, t } = await wave('p1', g, 'MG-1001', 6); await pick('p1', t, g, 6); assert.deepEqual(await at(g), { 'P-11': 94 });
  assert.deepEqual(await list('admin', A), [], 'nothing waits for a manager while the pallet is on the floor');
  assert.equal((await release(g, 'P-11', 'shipped_out')).status, 200); const l0 = await ledger();
  assert.match(await refusal(() => as('p1', 'wms_wave_unconfirm', { p_task: t.id })), /A manager returns these units/);
  // who can see the list
  for (const who of ['p1', 'floor', 'clientA', 'clientB', 'client', 'sales']) assert.match(await refusal(() => list(who, A)), /Only ShipBay admin or staff can see picks waiting for a manager/, who);
  assert.match(await anon('wms_manager_stops', { p_org: A }), /permission denied/);
  assert.match(await refusal(() => list('admin', null)), /Name the brand/);
  for (const who of ['admin', 'staff']) {
    const s = await list(who, A); assert.equal(s.length, 1, who);
    assert.deepEqual([s[0].task, s[0].wave, s[0].wave_status, s[0].picker, s[0].mine, s[0].sku, s[0].units, s[0].planned, s[0].picked_from, s[0].pallet, s[0].pallet_status, s[0].orders, s[0].blocked],
      [t.id, w.seq, 'picking', 'Picker 1', false, 'MG-A', 6, 6, 'P-11', g.psku, 'departed', ['MG-1001'], null]);
  }
  // who can correct, and what a correction needs
  for (const who of ['p1', 'floor', 'clientA', 'clientB', 'sales']) assert.match(await refusal(() => fix(who, A, t.id)), /Only ShipBay admin or staff can correct a pick/, who);
  assert.match(await anon('wms_manager_stop_correct', { p_org: A, p_task: t.id, p_to_location: 'A-01-1', p_reason: WHY }), /permission denied/);
  for (const who of ['admin', 'staff', 'p1']) assert.match(await refusal(() => as(who, '_wms_stop_correct_block', { p_task: t.id })), /permission denied/, 'the internal check is not callable');
  assert.match(await refusal(() => fix('staff', A, t.id, 'A-01-1', '')), /Say why this pick is being corrected/);
  assert.match(await refusal(() => fix('staff', A, t.id, 'A-01-1', 'no')), /Say why this pick is being corrected/);
  assert.match(await refusal(() => fix('staff', A, t.id, 'P-11')), /shared Nexus position/);
  assert.match(await refusal(() => fix('staff', A, t.id, 'P-30')), /shared Nexus position/);
  assert.match(await refusal(() => fix('staff', A, t.id, 'NOPE-1')), /Name the ShipBay shelf/);
  assert.deepEqual(await ledger(), l0, 'no refusal posted anything'); assert.deepEqual(await stop(t.id), { code: 'P-11', has_pallet: true, confirmed: true, qty_picked: 6 });
  // the correction
  const done = await fix('staff', A, t.id);
  assert.deepEqual([done.units_returned, done.returned_to, done.pallet, done.wave, done.picker, done.stops], [6, 'A-01-1', g.psku, w.seq, 'Picker 1', []]);
  const [r] = await lastRows(1); const l1 = await ledger();
  assert.deepEqual([l1.n - l0.n, l1.u - l0.u, r.qty, r.reason, r.code, r.created_by, r.org_id, r.ref_type, r.ref_id, r.pallet_id], [1, 6, 6, 'pick', 'A-01-1', U.staff, A, 'wave_task', t.id, null], 'ONE row: +6 on the shelf, by the staff login, for this stop');
  assert.match(r.note, new RegExp(`Wave ${w.seq} stop corrected by Test Staff: ${WHY}`));
  const act = (await db.query(`select actor, actor_name, qty, ref, detail from wms_activity where kind = 'pick_corrected' order by at desc limit 1`)).rows[0];
  assert.deepEqual([act.actor, act.actor_name, act.qty, act.ref, act.detail.returned_to, act.detail.picked_at, act.detail.reason, act.detail.wave], [U.staff, 'Test Staff', 6, g.psku, 'A-01-1', 'P-11', WHY, w.seq]);
  assert.deepEqual(await at(g), { 'P-11': 94, 'A-01-1': 6 }, 'nothing went back to the position the pallet left');
  assert.deepEqual(await stop(t.id), { code: 'A-01-1', has_pallet: false, confirmed: false, qty_picked: null }, 'the picker\'s stop is open again, at the shelf');
  assert.equal(await q1('select count(*)::int from wms_picks where task_id = $1 and undone_at is null', [t.id]), 0); assert.equal(await q1(`select picked_at is null from order_lines where order_id = (select id from orders where order_number = 'MG-1001')`), true);
  // the picker carries on from their own screen
  const mine = (await as('p1', 'wms_wave', { p_wave: w.id })).tasks.find((x) => x.id === t.id); assert.deepEqual([mine.location, mine.confirmed, mine.qty_planned], ['A-01-1', false, 6]);
  // a second correction of the same stop has nothing to act on
  assert.match(await refusal(() => fix('admin', A, t.id)), /has not been picked yet/); assert.deepEqual(await ledger(), l1);
  await pick('p1', t, g, 6); assert.deepEqual(await at(g), { 'P-11': 94 }); assert.match(await refusal(() => fix('admin', A, t.id)), /picked from a ShipBay shelf\. The picker reopens it/);
  assert.equal((await receipts(g)).n, 1);
});

test('brand isolation: a brand\'s list holds only that brand\'s stops, and a stop cannot be corrected under another brand\'s name', async () => {
  const a = await pallet(A, 'MG-B', 'P-12'), b = await pallet(B, 'MG-C', 'P-13');
  const wa = await wave('p2', a, 'MG-1002', 5), wb = await wave('p3', b, 'MG-2001', 7);
  await pick('p2', wa.t, a, 5); await pick('p3', wb.t, b, 7); assert.equal((await release(a, 'P-12', 'shipped_out')).status, 200); assert.equal((await release(b, 'P-13', 'moved_off_shared_floor')).status, 200);   // brand B's pallet is off the shared floor but still in ShipBay's custody
  const la = await list('admin', A), lb = await list('admin', B);
  assert.deepEqual([la.map((s) => [s.task, s.sku, s.orders, s.pallet_status, s.blocked]), lb.map((s) => [s.task, s.sku, s.orders, s.pallet_status, s.blocked])], [[[wa.t.id, 'MG-B', ['MG-1002'], 'departed', null]], [[wb.t.id, 'MG-C', ['MG-2001'], 'off_floor', null]]]);
  assert.ok(!JSON.stringify(la).includes('MG-C') && !JSON.stringify(la).includes('MG-2001') && !JSON.stringify(lb).includes('MG-B') && !JSON.stringify(lb).includes('MG-1002'), 'neither list mentions the other brand\'s product or order');
  assert.deepEqual(await list('admin', NOBODY), [], 'a brand that does not exist has nothing');
  const l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, wb.t.id)), /That stop is not one of this brand's/, 'brand A named, brand B\'s stop');
  assert.match(await refusal(() => fix('staff', B, wa.t.id)), /That stop is not one of this brand's/, 'brand B named, brand A\'s stop');
  assert.match(await refusal(() => fix('admin', A, NOBODY)), /That stop is not one of this brand's/, 'a stop that does not exist gets the same answer');
  assert.match(await refusal(() => fix('admin', null, wa.t.id)), /That stop is not one of this brand's/);
  // client logins: not their own brand's, not the other's
  for (const [who, org, task] of [['clientA', A, wa.t.id], ['clientA', B, wb.t.id], ['clientB', B, wb.t.id], ['clientB', A, wa.t.id]]) {
    assert.match(await refusal(() => list(who, org)), /Only ShipBay admin or staff/); assert.match(await refusal(() => fix(who, org, task)), /Only ShipBay admin or staff/);
    assert.match(await refusal(() => as(who, 'wms_wave', { p_wave: who === 'clientA' ? wb.w.id : wa.w.id })), /cannot work orders/); assert.match(await refusal(() => as(who, 'wms_orders_summary', { p_org: org })), /cannot work orders/);
  }
  assert.deepEqual(await ledger(), l0, 'nothing was posted by any of it');
  // each corrected under its own brand: the ledger row belongs to that brand
  await fix('admin', B, wb.t.id, 'A-02-1'); let [r] = await lastRows(1); assert.deepEqual([r.org_id, r.qty, r.code, r.created_by], [B, 7, 'A-02-1', U.admin]);
  await fix('staff', A, wa.t.id, 'A-03-1'); [r] = await lastRows(1); assert.deepEqual([r.org_id, r.qty, r.code, r.created_by], [A, 5, 'A-03-1', U.staff]);
  assert.deepEqual([await at(a), await at(b)], [{ 'P-12': 95, 'A-03-1': 5 }, { 'OFF-FLOOR': 93, 'A-02-1': 7 }], 'the off-floor pallet\'s remaining 93 are at OFF-FLOOR; its 7 picked units are back on a shelf'); assert.deepEqual([await list('admin', A), await list('admin', B)], [[], []]);
});

test('every other state is refused in words and changes nothing: planned, on the floor, nothing picked, waiting on Nexus, at the pack station, packed, shipped, cancelled', async () => {
  // planned, then picked with the pallet still on the floor
  const c = await pallet(A, 'MG-D', 'P-14'); const wc = await wave('p4', c, 'MG-1003', 6); let l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, wc.t.id)), /has not been picked yet\. There is nothing to return/);
  await pick('p4', wc.t, c, 6); l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, wc.t.id)), new RegExp(`${c.psku} is still on the floor at P-14\\. The picker reopens this stop on their own screen`));
  assert.deepEqual([await list('admin', A), await ledger()], [[], l0]);
  // the release's answer is lost: Nexus has let the position go, ShipBay has not recorded it
  lose(); const rel = await release(c, 'P-14', 'shipped_out'); assert.notEqual(rel.status, 200); assert.equal(await q1(`select count(*)::int from wms_nexus_ops where pallet_id = $1 and state in ('pending','out_of_sync')`, [c.id]), 1);
  assert.match(await refusal(() => fix('admin', A, wc.t.id)), new RegExp(`${c.psku} is waiting for Nexus to confirm where it stands`)); assert.deepEqual(await ledger(), l0);
  const retry = await bridge('admin', 'POST', '/pending/retry', {}); assert.equal(retry.status, 200, JSON.stringify(retry)); assert.equal((await row(c)).status, 'departed');
  assert.deepEqual((await list('admin', A)).map((s) => [s.task, s.blocked]), [[wc.t.id, null]], 'once the release is settled the stop waits for a manager');
  await fix('admin', A, wc.t.id, 'A-01-1'); assert.deepEqual(await at(c), { 'P-14': 94, 'A-01-1': 6 }); await pick('p4', wc.t, c, 6);

  // nothing picked (reported short with 0), pallet then leaves
  const d = await pallet(A, 'MG-E', 'P-15'); const wd = await wave('p5', d, 'MG-1004', 6); await pick('p5', wd.t, d, 0);
  assert.equal((await release(d, 'P-15', 'shipped_out')).status, 200); l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, wd.t.id)), /Nothing was picked at that stop/); assert.deepEqual([await list('admin', A), await ledger(), await at(d)], [[], l0, { 'P-15': 100 }]);

  // at the pack station, then packed, then shipped
  const e = await pallet(A, 'MG-F', 'P-16'); const we = await wave('p6', e, 'MG-1005', 6); await pick('p6', we.t, e, 6);
  assert.equal((await as('p6', 'wms_wave_to_pack', { p_wave: we.w.id })).status, 'packing'); assert.equal((await release(e, 'P-16', 'shipped_out')).status, 200); l0 = await ledger();
  const s = await list('staff', A); assert.deepEqual(s.map((x) => [x.task, x.wave_status, x.units]), [[we.t.id, 'packing', 6]]); assert.match(s[0].blocked, new RegExp(`Wave ${we.w.seq} is at the pack station\\. A pick cannot be returned to a shelf from there; nothing was changed`));
  assert.match(await refusal(() => fix('staff', A, we.t.id)), /is at the pack station/); assert.deepEqual([await ledger(), await at(e)], [l0, { 'P-16': 94 }]);
  assert.match(await refusal(() => as('admin', 'wms_pick_correct', { p_kind: 'wave_stop', p_id: we.t.id, p_to_location: 'A-01-1', p_reason: WHY })), /is no longer being picked/, 'the function underneath refuses it too');
  assert.equal((await as('p6', 'wms_wave_pack', { p_wave: we.w.id, p_orders: [we.order], p_packages: JSON.stringify([{ items: [{ key: 'MG-F', qty: 6 }] }]) })).status, 'done'); l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, we.t.id)), /Order MG-1005 is packed\. Packed stock is not rewritten/); assert.deepEqual([await list('admin', A), await ledger()], [[], l0]);
  await db.query(`update orders set status = 'shipped', shipped_at = now() where id = $1`, [we.order]);   // staged: the order has shipped
  assert.match(await refusal(() => fix('admin', A, we.t.id)), /Order MG-1005 has shipped\. Shipped stock is not rewritten/); assert.deepEqual([await ledger(), await at(e)], [l0, { 'P-16': 94 }]);

  // a cancelled wave
  const f = await pallet(A, 'MG-G', 'P-17'); const wf = await wave('p7', f, 'MG-1006', 6); await as('p7', 'wms_wave_cancel', { p_wave: wf.w.id }); l0 = await ledger();
  assert.match(await refusal(() => fix('admin', A, wf.t.id)), new RegExp(`Wave ${wf.w.seq} was cancelled`)); assert.deepEqual(await ledger(), l0);
});

test('a short pick is returned as exactly what was picked; the reopened stop cannot be over-picked and no other order is promised those units twice', async () => {
  const h = await pallet(A, 'MG-H', 'P-18'); const wh = await wave('p8', h, 'MG-1007', 6); await pick('p8', wh.t, h, 4); assert.deepEqual(await at(h), { 'P-18': 96 });
  assert.equal((await release(h, 'P-18', 'shipped_out')).status, 200); const l0 = await ledger();
  const s = await list('admin', A); assert.deepEqual(s.map((x) => [x.task, x.units, x.planned, x.blocked]), [[wh.t.id, 4, 6, null]], 'listed with what was picked (4) and what was planned (6)');
  const done = await fix('admin', A, wh.t.id, 'A-02-1'); assert.equal(done.units_returned, 4); const l1 = await ledger(); assert.deepEqual([l1.n - l0.n, l1.u - l0.u], [1, 4]);
  assert.deepEqual(await at(h), { 'P-18': 96, 'A-02-1': 4 }); assert.deepEqual(await stop(wh.t.id), { code: 'A-02-1', has_pallet: false, confirmed: false, qty_picked: null });
  assert.match(await refusal(() => pick('p8', wh.t, h, 6)), /Only 4 on file at A-02-1/, 'the stop still asks for 6 but only the 4 returned are there');
  // while the stop is open at the shelf, another picker's wave for the same product is not given those 4 units
  await orderFor(h, 'MG-1008', 3); const other = await as('p9', 'wms_wave_start', { p_org: A });
  assert.ok(!other.wave || !other.wave.tasks.some((x) => x.sku === 'MG-H'), 'no second stop is planned against the returned units'); assert.ok((other.short || []).some((x) => x.order_number === 'MG-1008'), 'the second order is reported short instead');
  await pick('p8', wh.t, h, 4); assert.deepEqual(await at(h), { 'P-18': 96 }, 'picked again: the shelf is empty, nothing below zero');
});

test('afterwards: one ledger, nothing below zero, one receipt per pallet, every returned pick names a manager and a reason', async () => {
  const neg = (await db.query(`select s.sku, l.code, sum(m.qty)::int n from inventory_moves m join skus s on s.id = m.sku_id left join locations l on l.id = m.location_id group by 1, 2 having sum(m.qty) < 0`)).rows; assert.deepEqual(neg, []);
  const rc = (await db.query(`select p.psku, count(*)::int n, sum(m.qty)::int u from inventory_moves m join wms_pallets p on p.id = m.ref_id where m.reason = 'receive' and m.ref_type = 'wms_pallet' group by 1`)).rows;
  assert.equal(rc.length, 8); assert.ok(rc.every((x) => x.n === 1 && x.u === 100), 'eight pallets, one receipt of 100 each');
  const ret = (await db.query(`select m.qty, l.code, coalesce(l.shared, false) shared, m.note, m.created_by, m.ref_type, m.pallet_id from inventory_moves m join locations l on l.id = m.location_id where m.reason = 'pick' and m.qty > 0 and m.note like '%corrected by%' order by m.created_at`)).rows;
  assert.deepEqual(ret.map((x) => x.qty), [6, 7, 5, 6, 4], 'five corrections were accepted in this file, and only five');
  assert.ok(ret.every((x) => !x.shared && [U.admin, U.staff].includes(x.created_by) && /corrected by Test (Admin|Staff): \S.{4,}/.test(x.note) && x.ref_type === 'wave_task' && x.pallet_id === null));
  assert.equal(await q1(`select count(*)::int from wms_activity where kind = 'pick_corrected'`), 5);
  assert.equal(await q1(`select count(*)::int from inventory_moves where reason not in ('receive', 'pick', 'transfer')`), 0, 'no adjustment was written by any of it'); assert.equal(await q1(`select coalesce(sum(qty), 0)::int from inventory_moves where reason = 'transfer'`), 0, 'the only transfers are the off-floor release\'s own, and they net to zero');
  const picked = await q1(`select coalesce(sum(qty), 0)::int from inventory_moves where reason = 'pick'`); assert.equal((await ledger()).u, 800 + picked);
  assert.equal(picked, -(6 + 6 + 6 + 4), 'net picked: the three stops picked again after their correction (6, 6, 4) and the packed order (6); the two corrected and not yet re-picked net to nothing');
  assert.equal(await q1(`select count(*)::int from wms_nexus_ops where state in ('pending','out_of_sync')`), 0);
  assert.equal(await q1(`select coalesce(sum(on_hand), 0)::int from inventory_levels`), (await ledger()).u, 'the stock view agrees with the ledger');
});
