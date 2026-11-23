// Void safety (supabase/candidates/20261204_wms_pallet_stock_safety.sql), end to end on this machine only: ShipBay's database functions on
// isolated synthetic rows + the bridge in-process + the REAL Nexus service code in a throwaway local database. Nothing here
// reaches Supabase, Nexus staging or production. The harness is the one workflow.test.mjs uses.
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
await db.query('drop database if exists nexus_void_test'); await db.query('create database nexus_void_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_void_test` });
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
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_void_test').catch(() => {}); await db.end(); });

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

test('defect 1. void after a partial pick: refused, nothing below zero, the picks stay; allowed again once the picks are undone', async () => {
  const a = await stockPallet('VD-A'); await put(a, 'P-01'); const o = await order('VD-1001', a, 30);
  await as('floor', 'wms_pick_scan', { p_lines: [o.line], p_scan: a.carton }); assert.deepEqual(await at(a), { 'P-01': 70 });
  const before = [await total(), await ledger(a), await state(a)];
  assert.match(await refusal(() => voidIt(a)), /30 of .* units have been picked\. A pallet that has been picked from cannot be voided/);
  assert.match(await refusal(() => voidIt(a, 'floor')), /have been picked/, 'the same for the floor login');
  assert.deepEqual([await total(), await ledger(a), await state(a)], before, 'the refusal changed nothing: 70 at P-01, one receipt, the pick on record');
  assert.equal(await q1('select count(*)::int from wms_picks where pallet_id = $1 and undone_at is null', [a.id]), 1);
  // the picks are put back: now it is only a pallet entered by mistake
  await as('floor', 'wms_unpick', { p_lines: [o.line] }); assert.deepEqual(await at(a), { 'P-01': 100 });
  const t0 = await total(); await voidIt(a); assert.equal((await row(a)).status, 'void');
  assert.deepEqual([await at(a), await total(), await receipts(a)], [{}, t0 - 100, { n: 1, u: 100 }], 'a clean void takes off exactly what the pallet put on, once, and adds no receipt');
  assert.ok((await ledger(a)).every((l) => !/^receive/.test(l) || l === 'receive 100 P-01'), 'still one receipt');
  assert.equal(await q1(`select min(q) from (select sum(qty) q from inventory_moves group by sku_id, location_id) x`) >= 0, true, 'no position anywhere is below zero');
  assert.match(await refusal(() => voidIt(a)), /already voided/);
});

test('defect 1. void with a wave: refused while a stop is planned, refused after the stop is picked, also after the pallet moved', async () => {
  const b = await stockPallet('VD-B'); await put(b, 'P-02'); await order('VD-1002', b, 12);
  const w = (await as('floor2', 'wms_wave_start', { p_org: A })).wave; const t = w.tasks[0];
  assert.match(await refusal(() => voidIt(b)), /Wave \d+ still has a pick planned from/);
  await as('floor2', 'wms_wave_confirm', { p_task: t.id, p_qty: 12, p_scan: b.carton }); assert.deepEqual(await at(b), { 'P-02': 88 });
  assert.match(await refusal(() => voidIt(b)), /12 of .* units have been picked/);
  assert.equal((await move(b, 'P-03')).status, 200); assert.deepEqual(await at(b), { 'P-03': 88 });
  const before = [await total(), await ledger(b)];
  assert.match(await refusal(() => voidIt(b)), /12 of .* units have been picked/, 'the pick travelled with the pallet and still counts');
  assert.deepEqual([await total(), await ledger(b), await at(b)], [...before, { 'P-03': 88 }]);
});

test('defect 1. picks that name no pallet (older rows): the void is refused when it would leave the position below zero', async () => {
  const c = await stockPallet('VD-C'); await put(c, 'P-04');
  // an older pick: a ledger row at the position with no pallet reference
  await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id) select $1, $2, -25, 'pick', 'order_line', gen_random_uuid(), 'older pick', id from locations where code = 'P-04'`, [A, c.sku]);
  const before = [await total(), await ledger(c)];
  assert.match(await refusal(() => voidIt(c)), /it put 100 of VD-C at P-04 and only 75 are on the books there/);
  assert.deepEqual([await total(), await ledger(c), await at(c)], [...before, { 'P-04': 75 }]);
});

test('defect 2. void while Nexus has not answered: refused for a put-away and for a move; the retry then records normally', async () => {
  const d = await stockPallet('VD-D'); const n0 = nexusPosts();
  lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: d.psku, location: 'P-05' })).status, 503);
  assert.match(await refusal(() => voidIt(d)), /cannot be voided yet: it has a request for P-05 that Nexus has not answered/);
  assert.deepEqual([(await row(d)).status, await floorAt('P-05')], ['open', [d.psku]], 'Nexus holds it, ShipBay still shows it open: exactly the state the void must not touch');
  const r = await bridge('floor', 'POST', '/pending/retry'); assert.equal(r.results[0].ok, true);
  assert.deepEqual(await state(d), ['stored', 'P-05', { 'P-05': 100 }, { n: 1, u: 100 }]);
  // a move
  lose(); assert.equal((await move(d, 'P-06')).status, 503);
  const before = [await total(), await ledger(d), await state(d)];
  assert.match(await refusal(() => voidIt(d)), /it has a request for P-06 that Nexus has not answered/);
  assert.deepEqual([await total(), await ledger(d), await state(d)], before, 'no stock was written off under a move Nexus already holds');
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].ok, true);
  assert.deepEqual([await state(d), await floorAt('P-05'), await floorAt('P-06')], [['stored', 'P-06', { 'P-06': 100 }, { n: 1, u: 100 }], [], [d.psku]], 'ShipBay and Nexus agree after the retry');
  // settled and never picked: a void is allowed again, and it frees nothing in Nexus
  const t0 = await total(); await voidIt(d);
  assert.deepEqual([(await row(d)).status, await at(d), await total(), await floorAt('P-06')], ['void', {}, t0 - 100, [d.psku]]);
  assert.ok(nexusPosts() > n0);
});

test('defect 2. an out-of-sync request can still be reconciled both ways; the void is refused until it is, and never decides it', async () => {
  // a) Nexus accepted, ShipBay could not record (HOLD found meanwhile), the pallet IS there: admin records it
  const e = await stockPallet('VD-E'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: e.psku, location: 'P-07' })).status, 503);
  await db.query(`update wms_pallets set held = true, hold_reason = 'synthetic' where id = $1`, [e.id]);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].error, 'out_of_sync');
  assert.match(await refusal(() => voidIt(e)), /Nexus accepted P-07 and ShipBay has not recorded it\. An admin settles that/);
  await as('admin', 'wms_hold_disposition', { p_pallet: e.id, p_action: 'release', p_ref: 'SYN' });
  const op = await q1(`select id from wms_nexus_ops where pallet_id = $1 and state = 'out_of_sync'`, [e.id]);
  const rec = await bridge('admin', 'POST', '/reconcile/record', { op, confirmed: true }); assert.equal(rec.status, 200, rec.message);
  assert.deepEqual(await state(e), ['stored', 'P-07', { 'P-07': 100 }, { n: 1, u: 100 }]);
  // b) the pallet is NOT there: admin's confirmed correction frees the position; only then may the mistaken pallet be voided
  const f = await stockPallet('VD-F'); lose(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: f.psku, location: 'P-08' })).status, 503);
  await db.query(`update wms_pallets set held = true, hold_reason = 'synthetic' where id = $1`, [f.id]);
  assert.equal((await bridge('floor', 'POST', '/pending/retry')).results[0].error, 'out_of_sync');
  assert.match(await refusal(() => voidIt(f)), /An admin settles that/); assert.deepEqual(await floorAt('P-08'), [f.psku]);
  const op2 = await q1(`select id from wms_nexus_ops where pallet_id = $1 and state = 'out_of_sync'`, [f.id]);
  // the correction itself is on its way and its answer is lost: still not voidable
  lose(); const u1 = await bridge('admin', 'POST', '/reconcile/undo', { op: op2, confirmed: true }); assert.notEqual(u1.status, 200);
  assert.match(await refusal(() => voidIt(f)), /cannot be voided yet/);
  const u2 = await bridge('admin', 'POST', '/reconcile/undo', { op: op2, confirmed: true }); assert.equal(u2.status, 200, u2.message);
  assert.deepEqual([await floorAt('P-08'), await q1('select state from wms_nexus_ops where id = $1', [op2])], [[], 'undone']);
  const t0 = await total(); await voidIt(f);
  assert.deepEqual([(await row(f)).status, await at(f), await total(), await receipts(f)], ['void', {}, t0, { n: 0, u: 0 }], 'never stored: the void posts nothing');
});

test('a pallet that left the building is not voided; one moved off the floor and unpicked still can be; totals and receipts hold throughout', async () => {
  const g = await stockPallet('VD-G'); await put(g, 'P-09'); assert.equal((await release(g, 'P-09', 'shipped_out')).status, 200);
  assert.deepEqual(await state(g), ['departed', null, { 'P-09': 100 }, { n: 1, u: 100 }]);
  const before = [await total(), await ledger(g)];
  assert.match(await refusal(() => voidIt(g)), /has left the building and cannot be voided/);
  assert.deepEqual([await total(), await ledger(g)], before, 'its units stay on the books for the outbound transaction; a void is not a way around that');
  const h = await stockPallet('VD-H'); await put(h, 'P-10'); assert.equal((await release(h, 'P-10', 'moved_off_shared_floor')).status, 200);
  const t0 = await total(); await voidIt(h); assert.deepEqual([(await row(h)).status, await at(h), await total()], ['void', {}, t0 - 100]);
  assert.equal(await q1(`select count(*)::int from (select ref_id from inventory_moves where reason = 'receive' group by ref_id having count(*) > 1) x`), 0, 'no pallet has two receipts');
  assert.equal(await q1(`select count(*)::int from (select 1 from inventory_moves group by sku_id, location_id having sum(qty) < 0) x`), 0, 'no position is below zero');
  assert.match(await refusal(() => voidIt(h, 'client')), /cannot void pallets/);
});
