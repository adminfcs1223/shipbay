// The ShipBay-to-Nexus bridge, end to end on this machine only:
//   ShipBay's database functions (the local staging copy of the schema, synthetic rows)
//   + the bridge (supabase/functions/nexus-bridge/*.js)
//   + the REAL Nexus service code and database (branch nexus-neutral of adminfcs1223/nexus, extracted to $NEXUS_NEUTRAL), in a
//     second throwaway database on the same local cluster, called in-process instead of over the internet.
// Nothing here reaches Supabase, Netlify, Nexus staging or production. It does not prove the hosted Edge Function (index.ts)
// or the hosted Nexus staging service; it proves the rules both sides run.
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
await db.query('drop database if exists nexus_bridge_test'); await db.query('create database nexus_bridge_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_bridge_test` });
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
  return async (who, method, p, body, extra = {}) => { const r = await h(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })); return { status: r.status, ...(await r.json()) }; }; };
const bridge = bridgeWith(ON);

const shipment = async (ref, day) => run('authenticated', U.admin, 'nexus_shipment_create', { p_org: A, p_reference: ref, p_origin: 'Vendor', p_expected: day, p_pallets: 2, p_cartons: 20, p_notes: 'PRIVATE NOTE', p_lines: JSON.stringify([{ sku_id: SKU, qty: 500 }]) });
const today = (await db.query('select current_date::text d')).rows[0].d; const INB = await shipment('SYN-PO-RCV', today); let k = 0;
const pallet = async () => { await db.query('begin'); await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.floor, role: 'authenticated' })]);
  const r = await db.query(`select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,'partial',null)`, [INB, A, JSON.stringify([{ sku: SKU, cartons: 10, units_per_carton: 10 }]), `br-${++k}`]); await db.query('commit'); return r.rows[0]; };
const row = async (id) => (await db.query('select p.status, p.held, l.code from wms_pallets p left join locations l on l.id = p.location_id where p.id = $1', [id])).rows[0];
const stock = async () => Number((await db.query('select coalesce(sum(qty),0) n from inventory_moves')).rows[0].n);
const ops = async (psku) => (await db.query('select id, kind, state, nexus_http, nexus_error, attempts, idem_key, fixes, resolution, resolved_by_name, reason, confirmed_at_position from wms_nexus_ops where psku = $1 order by created_at', [psku])).rows;
const moves = async () => (await db.query('select count(*)::int n from inventory_moves')).rows[0].n;
const at = async (code) => { const o = await asSouled('GET', '/v1/occupancy'); return o.locations.find((l) => l.code === code); };
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_bridge_test').catch(() => {}); await db.end(); });

test('off by default; production is not a mode; the staging connection will not run on the production database; no key, no connection', async () => {
  for (const [env, code] of [[{}, 'bridge_off'], [{ ...ON, NEXUS_BRIDGE_MODE: 'production' }, 'mode_not_available'], [{ ...ON, SUPABASE_URL: 'https://poxlczzkpztmoiixyrth.supabase.co' }, 'wrong_database'], [{ ...ON, NEXUS_STAGING_API_KEY: '' }, 'not_configured']]) {
    const before = net.calls.length; const r = await bridgeWith(env)('floor', 'POST', '/putaway', { psku: 'X', location: 'P-01' }); assert.equal(r.status, 503); assert.equal(r.error, code); assert.equal(net.calls.length, before, 'Nexus was not called');
  }
  const s = await bridgeWith({})(null, 'GET', '/status'); assert.deepEqual([s.connection, s.pallet_moves, s.calendar_writes], ['off', false, false]); assert.ok(!JSON.stringify(await bridge(null, 'GET', '/status')).includes(KEYS.shipbay));
  assert.equal((await bridge(null, 'POST', '/putaway', {})).status, 401); assert.equal((await bridge('nobody', 'POST', '/putaway', {})).status, 401); assert.equal((await bridge('client', 'POST', '/putaway', { psku: 'X', location: 'P-01' })).status, 403);
  const off = await bridgeWith({ ...ON, NEXUS_PALLET_MOVES: '' })('floor', 'POST', '/putaway', { psku: 'X', location: 'P-01' }); assert.equal(off.error, 'pallet_moves_off');
  const live = await bridgeWith({ ...ON, NEXUS_STAGING_API_KEY: KEYS.shipbayLive })('floor', 'POST', '/putaway', { psku: 'X', location: 'P-01' }); assert.equal(live.status, 502); assert.equal(live.error, 'not_the_expected_floor');
});

test('position list: ShipBay takes P-01..P-66 and STG-01/STG-02 from the Nexus map; a report by default, written only when switched on and asked by an admin', async () => {
  const count = async () => (await db.query(`select count(*)::int n from locations where kind in ('pallet','floor')`)).rows[0].n; assert.equal(await count(), 3);
  assert.equal((await bridge('floor', 'POST', '/registry/sync', { apply: true })).status, 403);
  const dry = await bridge('admin', 'POST', '/registry/sync', {}); assert.deepEqual([dry.applied, dry.map_version, dry.positions, dry.report.dry_run, dry.report.matched, dry.report.added, dry.report.retired], [false, 4, 68, true, 3, 65, 0]); assert.equal(await count(), 3);
  const off = await bridgeWith({ ...ON, NEXUS_REGISTRY_WRITES: '' })('admin', 'POST', '/registry/sync', { apply: true }); assert.equal(off.applied, false); assert.equal(await count(), 3);
  const done = await bridge('admin', 'POST', '/registry/sync', { apply: true }); assert.equal(done.applied, true); assert.equal(await count(), 68);
  const codes = (await db.query(`select code, kind, shared, nexus_status from locations where kind in ('pallet','floor') order by code`)).rows;
  assert.deepEqual(codes.filter((c) => c.kind === 'floor').map((c) => c.code), ['STG-01', 'STG-02']); assert.deepEqual([codes[0].code, codes[65].code], ['P-01', 'P-66']); assert.ok(codes.every((c) => c.shared && c.nexus_status === 'active'));
  assert.equal((await db.query(`select count(*)::int n from locations where code = 'RCV-DOCK'`)).rows[0].n, 0, 'the dock is not a shared pallet position'); assert.equal((await db.query(`select active from locations where code = 'A-01-1'`)).rows[0].active, true, 'ShipBay\'s own shelf is untouched');
  const again = await bridge('admin', 'POST', '/registry/sync', { apply: true }); assert.deepEqual([again.report.added, again.report.changed, again.report.retired], [0, 0, 0]);
});

let P1, P2;
test('put-away: ShipBay checks its rules, Nexus takes the position, then the pallet is stored and stock posts once', async () => {
  P1 = await pallet(); assert.equal(await stock(), 0);
  const bad = net.calls.length; const r0 = await bridge('floor', 'POST', '/putaway', { psku: P1.psku, location: 'A-01-1' }); assert.equal(r0.status, 409); assert.equal(r0.error, 'refused_by_shipbay'); assert.match(r0.message, /not a shared pallet position/);
  assert.ok(!net.calls.slice(bad).some((c) => c.startsWith('POST')), 'a ShipBay refusal never reaches Nexus');
  const r = await bridge('floor', 'POST', '/putaway', { psku: P1.psku, location: 'LOC-P-01' }); assert.equal(r.status, 200); assert.equal(r.location, 'P-01'); assert.equal(Number(r.units_posted), 100);
  assert.deepEqual(await row(P1.id), { status: 'stored', held: false, code: 'P-01' }); assert.equal(await stock(), 100);
  const l = await at('P-01'); assert.equal(l.used, 1); assert.deepEqual(l.occupants.map((c) => c.company), ['SHIPBAY']);
  const mine = (await bridge('floor', 'GET', '/floor')); assert.equal(mine.warehouse, 'HILLSBOROUGH-TEST'); assert.equal(mine.map_version, 4); assert.ok(mine.locations.find((x) => x.code === 'P-01').your_pallets.includes(P1.psku), 'the PSKU label is the pallet id in Nexus, unchanged');
  assert.ok(!JSON.stringify(await asSouled('GET', '/v1/occupancy')).includes(P1.psku), 'Souled sees a ShipBay pallet stands there, not which one');
  assert.deepEqual((await ops(P1.psku)).map((o) => [o.kind, o.state]), [['assign', 'done']]);
  const again = await bridge('floor', 'POST', '/putaway', { psku: P1.psku, location: 'P-02' }); assert.equal(again.status, 409); assert.match(again.message, /already put away/); assert.equal(await stock(), 100);
});

test('a position Souled holds: Nexus refuses, and nothing changes in ShipBay', async () => {
  assert.equal((await asSouled('POST', '/v1/pallets/assign', { pallet: 'SOULED-T-1', to: 'P-02' }, 'sw-1')).status, 200);
  assert.equal((await db.query(`select count(*)::int n from wms_pallets p join locations l on l.id = p.location_id where l.code = 'P-02'`)).rows[0].n, 0, 'ShipBay has no record of Souled\'s pallet');
  P2 = await pallet(); const r = await bridge('floor', 'POST', '/putaway', { psku: P2.psku, location: 'P-02' }); assert.equal(r.status, 409); assert.equal(r.error, 'location_full'); assert.match(r.message, /P-02 is taken in Nexus/);
  assert.equal((await row(P2.id)).status !== 'stored', true); assert.equal((await row(P2.id)).code, null); assert.equal(await stock(), 100);
  assert.deepEqual((await ops(P2.psku)).map((o) => [o.state, o.nexus_http, o.nexus_error]), [['refused', 409, 'location_full']]);
  const ok = await bridge('floor', 'POST', '/putaway', { psku: P2.psku, location: 'P-03' }); assert.equal(ok.status, 200); assert.equal(await stock(), 200);
});

test('Nexus does not answer: nothing is stored; the same scan re-sends the same key and the pallet is placed exactly once', async () => {
  const p = await pallet(); net.mode = 'down';
  const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-04' }); assert.equal(r.status, 503); assert.equal(r.pending, true); assert.match(r.message, /Nothing is confirmed/);
  assert.equal((await row(p.id)).code, null); assert.equal(await stock(), 200); assert.equal((await at('P-04')).used, 0);
  const other = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-05' }); assert.equal(other.status, 409); assert.match(other.message, /already has a request for P-04/);
  assert.equal((await bridge('floor', 'GET', '/pending')).open.length, 1);
  // the request reaches Nexus and is applied, but the answer is lost on the way back
  net.mode = 'ok'; await new Promise((r2) => setTimeout(r2, 5)); net.mode = 'lost';
  const lost = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-04' }); assert.equal(lost.status, 503); assert.equal((await at('P-04')).used, 1, 'Nexus applied it'); assert.equal((await row(p.id)).code, null, 'ShipBay has not stored it yet');
  const done = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-04' }); assert.equal(done.status, 200); assert.equal(done.replayed, true); assert.equal((await row(p.id)).code, 'P-04'); assert.equal(await stock(), 300);
  const o = await ops(p.psku); assert.equal(o.length, 1, 'one request, one key'); assert.equal(o[0].state, 'done'); assert.equal((await at('P-04')).used, 1);
  assert.equal((await bridge('floor', 'GET', '/pending')).open.length, 0);
});

test('the bridge\'s own retry run finishes a request nobody re-scanned', async () => {
  const p = await pallet(); net.mode = 'lost';
  assert.equal((await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-05' })).status, 503);
  const r = await bridge('admin', 'POST', '/pending/retry'); assert.deepEqual(r.results.map((x) => [x.pallet, x.to, x.ok]), [[p.psku, 'P-05', true]]); assert.equal((await row(p.id)).code, 'P-05'); assert.equal(await stock(), 400);
});

test('held pallets never reach Nexus. Nexus says yes but ShipBay cannot record it: the position STAYS reserved, the problem is recorded, nothing is released', async () => {
  const q = await pallet(); await db.query(`update wms_pallets set held = true, hold_reason = 'crushed corner' where id = $1`, [q.id]);
  const before = net.calls.length; const r = await bridge('floor', 'POST', '/putaway', { psku: q.psku, location: 'P-06' }); assert.equal(r.status, 409); assert.match(r.message, /on HOLD/); assert.ok(!net.calls.slice(before).some((c) => c.startsWith('POST')));
  const p = await pallet();
  hooks.beforeCommit = () => db.query(`update wms_pallets set held = true, hold_reason = 'found damage' where id = $1`, [p.id]);
  const c0 = net.calls.length; const r2 = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-06' }); assert.equal(r2.status, 409); assert.equal(r2.error, 'out_of_sync'); assert.match(r2.message, /stays reserved in Nexus/);
  assert.ok(!net.calls.slice(c0).some((c) => /release/.test(c)), 'no release was sent'); assert.equal((await at('P-06')).used, 1, 'Nexus still holds P-06 for it'); assert.equal((await row(p.id)).code, null); assert.equal(await stock(), 400);
  let o = await ops(p.psku); assert.deepEqual(o.map((x) => x.state), ['out_of_sync']); const OP = o[0].id;
  const again = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-07' }); assert.equal(again.status, 409); assert.match(again.message, /needs an admin/);
  assert.equal((await bridge('admin', 'POST', '/pending/retry')).results.length, 0, 'the retry run does not touch it');
  const rec = await bridge('admin', 'GET', '/reconcile'); assert.equal(rec.in_sync, false); assert.deepEqual(rec.waiting.map((w) => [w.pallet, w.state, w.nexus_has_it_at]), [[p.psku, 'out_of_sync', 'P-06']]); assert.match(rec.waiting[0].problem, /HOLD|hold/i);
  // the corrective paths need an admin and a confirmation made at the position
  assert.equal((await bridge('admin', 'POST', '/reconcile/record', { op: OP })).status, 400);
  const notAdmin = await bridge('floor', 'POST', '/reconcile/record', { op: OP, confirmed: true }); assert.equal(notAdmin.status, 409); assert.match(notAdmin.message, /Only ShipBay admin or staff/);
  const stillHeld = await bridge('admin', 'POST', '/reconcile/record', { op: OP, confirmed: true }); assert.equal(stillHeld.status, 409); assert.equal((await ops(p.psku))[0].state, 'out_of_sync', 'ShipBay\'s own hold rule still applies');
  await run('authenticated', U.admin, 'wms_hold_disposition', { p_pallet: p.id, p_action: 'release', p_ref: 'SYN-OK-2' });
  const c1 = net.calls.length; const fixed = await bridge('admin', 'POST', '/reconcile/record', { op: OP, confirmed: true }); assert.equal(fixed.status, 200); assert.equal(fixed.location, 'P-06');
  assert.ok(!net.calls.slice(c1).some((c) => c.startsWith('POST')), 'recording sends nothing to Nexus'); assert.equal((await row(p.id)).code, 'P-06'); assert.equal(await stock(), 500); assert.equal((await at('P-06')).used, 1);
  o = await ops(p.psku); assert.deepEqual([o[0].state, o[0].resolved_by_name, o[0].confirmed_at_position], ['done', 'Test Admin', true]); assert.match(o[0].resolution, /confirmation at the position/);
});

test('out of sync and the pallet is NOT there: only an admin\'s confirmed correction releases the position, with its own key, and it survives a lost answer', async () => {
  const p = await pallet(); hooks.beforeCommit = () => db.query(`update wms_pallets set status = 'void', voided_at = now(), void_reason = 'synthetic' where id = $1`, [p.id]);
  const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-07' }); assert.equal(r.error, 'out_of_sync'); assert.equal((await at('P-07')).used, 1);
  const OP = (await ops(p.psku))[0].id;
  assert.equal((await bridge('admin', 'POST', '/reconcile/undo', { op: OP })).status, 400); assert.equal((await bridge('floor', 'POST', '/reconcile/undo', { op: OP, confirmed: true })).status, 409); assert.equal((await at('P-07')).used, 1);
  net.mode = 'down'; const down = await bridge('admin', 'POST', '/reconcile/undo', { op: OP, confirmed: true }); assert.equal(down.status, 503); assert.equal((await ops(p.psku))[0].state, 'out_of_sync', 'still out of sync until Nexus says yes');
  net.mode = 'lost'; const lost = await bridge('admin', 'POST', '/reconcile/undo', { op: OP, confirmed: true }); assert.equal(lost.status, 503); assert.equal((await at('P-07')).used, 0, 'Nexus applied the correction');
  const done = await bridge('admin', 'POST', '/reconcile/undo', { op: OP, confirmed: true }); assert.equal(done.status, 200); assert.equal(done.replayed, true);
  const o = await ops(p.psku); assert.deepEqual(o.map((x) => [x.kind, x.state, x.fixes === OP]), [['assign', 'undone', false], ['release', 'done', true]]); assert.match(o[0].resolution, /corrected in Nexus/); assert.equal(o[1].reason, 'correction'); assert.equal(o[1].confirmed_at_position, true);
  assert.notEqual(o[1].idem_key, o[0].idem_key); assert.equal((await at('P-07')).used, 0); assert.equal(await stock(), 500);
});

test('move: the position changes in both systems and the quantity does not; the stock record follows the pallet to its new position', async () => {
  const r0 = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-02' }); assert.equal(r0.status, 409); assert.equal(r0.error, 'location_full'); assert.equal((await row(P1.id)).code, 'P-01');
  const s = await stock(); const n = await moves(); const r = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-08' }); assert.equal(r.status, 200); assert.equal(r.location, 'P-08'); assert.equal(r.from, 'P-01');
  assert.equal((await row(P1.id)).code, 'P-08'); assert.equal(await stock(), s, 'on-hand quantity is unchanged'); assert.equal((await at('P-01')).used, 0); assert.equal((await at('P-08')).used, 1);
  const added = (await db.query(`select l.code, m.qty, m.reason from inventory_moves m join locations l on l.id = m.location_id where m.ref_id = $1 order by m.created_at desc, m.qty limit $2`, [P1.id, (await moves()) - n])).rows;
  assert.deepEqual(added.map((x) => [x.code, x.qty, x.reason]).sort(), [['P-01', -100, 'transfer'], ['P-08', 100, 'transfer']], 'the stock follows the pallet as one transfer pair that nets to zero');
  assert.equal((await db.query(`select count(*)::int n from inventory_moves where ref_id = $1 and reason = 'receive'`, [P1.id])).rows[0].n, 1, 'still exactly one receipt for this pallet: the move did not post it again');
  const same = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-08' }); assert.equal(same.status, 409); assert.match(same.message, /already at P-08/);
});

test('release is explicit: voiding a pallet frees nothing; a confirmed release frees the position, clears the position on the pallet and touches no stock', async () => {
  await run('authenticated', U.admin, 'wms_void_pallet', { p_id: P2.id, p_reason: 'synthetic void' }); assert.equal((await at('P-03')).used, 1, 'a voided pallet still holds its position in Nexus');
  assert.equal((await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-03', reason: 'shipped_out' })).status, 400);
  const noReason = await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-03', confirmed: true }); assert.equal(noReason.status, 409); assert.match(noReason.message, /Say why/);
  const wrong = await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-09', reason: 'shipped_out', confirmed: true }); assert.equal(wrong.status, 409); assert.match(wrong.message, /ShipBay has .* at P-03, not P-09/); assert.equal((await at('P-03')).used, 1);
  const before = { row: await row(P2.id), stock: await stock(), moves: await moves() };
  net.mode = 'lost'; assert.equal((await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-03', reason: 'shipped_out', confirmed: true })).status, 503);
  const r = await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-03', reason: 'shipped_out', confirmed: true }); assert.equal(r.status, 200); assert.equal(r.replayed, true); assert.equal((await at('P-03')).used, 0);
  assert.deepEqual({ stock: await stock(), moves: await moves() }, { stock: before.stock, moves: before.moves }, 'the stock total and the stock ledger are exactly as they were');
  assert.deepEqual([(await row(P2.id)).status, (await row(P2.id)).code], ['void', null], 'the voided pallet no longer shows P-03 as where it is');
  const o = (await ops(P2.psku)).filter((x) => x.kind === 'release'); assert.deepEqual(o.map((x) => [x.state, x.reason, x.confirmed_at_position]), [['done', 'shipped_out', true]]);
  const twice = await bridge('floor', 'POST', '/release', { psku: P2.psku, location: 'P-03', reason: 'shipped_out', confirmed: true }); assert.equal(twice.status, 409); assert.equal(twice.error, 'pallet_not_placed'); assert.equal((await at('P-03')).used, 0);
});

test('a departed pallet: no position on the pallet, no stock deducted by the release; off the floor keeps its stock; every move carries what is really left', async () => {
  const on = async (code) => Number((await db.query(`select coalesce(sum(m.qty),0) n from inventory_moves m join locations l on l.id = m.location_id where l.code = $1`, [code])).rows[0].n);
  const pick = async (pal, code, qty) => db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, note, location_id, pallet_id) select $1, $2, $3, 'pick', 'wave_task', gen_random_uuid(), 'synthetic pick', id, $4 from locations where code = $5`, [A, SKU, -qty, pal, code]);
  const rel = (psku, location, reason, who = 'floor') => bridge(who, 'POST', '/release', { psku, location, reason, confirmed: true });
  // emptied by picking, then removed: the release changes no stock
  const a = await pallet(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: a.psku, location: 'P-11' })).status, 200); await pick(a.id, 'P-11', 100); assert.equal(await on('P-11'), 0);
  let s = await stock(), n = await moves(); const ra = await rel(a.psku, 'P-11', 'emptied_and_removed'); assert.equal(ra.status, 200); assert.equal(ra.pallet_status, 'departed'); assert.equal(ra.note, null);
  assert.deepEqual([(await row(a.id)).status, (await row(a.id)).code, await stock(), await moves(), (await at('P-11')).used], ['departed', null, s, n, 0], 'no position shown, nothing deducted, nothing written to the ledger');
  const back = await bridge('floor', 'POST', '/putaway', { psku: a.psku, location: 'P-11' }); assert.equal(back.status, 409); assert.match(back.message, /left the building/);
  const again = await rel(a.psku, 'P-11', 'shipped_out'); assert.equal(again.status, 409); assert.match(again.message, /already left the shared floor/);
  const log = (await db.query(`select detail from wms_activity where kind = 'pallet_left_floor' and ref = $1`, [a.psku])).rows; assert.equal(log.length, 1); assert.equal(log[0].detail.from, 'P-11', 'where it stood is kept in the log');
  // part-picked pallet, moved: the old position ends at zero and the new one holds what is really left
  const b = await pallet(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: b.psku, location: 'P-12' })).status, 200); await pick(b.id, 'P-12', 40); s = await stock();
  assert.equal((await bridge('floor', 'POST', '/move', { psku: b.psku, location: 'P-13' })).status, 200); assert.deepEqual([await on('P-12'), await on('P-13'), await stock()], [0, 60, s]);
  // floor staff cannot force a correction
  const forced = await rel(b.psku, 'P-13', 'correction'); assert.equal(forced.status, 409); assert.match(forced.message, /needs a ShipBay admin or staff login/); assert.equal((await at('P-13')).used, 1);
  // off the shared floor, still in custody: stock is kept, at the holding location
  const off = await rel(b.psku, 'P-13', 'moved_off_shared_floor'); assert.equal(off.status, 200); assert.equal(off.pallet_status, 'off_floor');
  assert.deepEqual([(await row(b.id)).status, (await row(b.id)).code, await on('P-13'), await on('OFF-FLOOR'), await stock(), (await at('P-13')).used], ['off_floor', null, 0, 60, s, 0]);
  // and back: a transfer, not a second receipt
  assert.equal((await bridge('floor', 'POST', '/putaway', { psku: b.psku, location: 'P-14' })).status, 200);
  assert.deepEqual([(await row(b.id)).status, (await row(b.id)).code, await on('P-14'), await on('OFF-FLOOR'), await stock()], ['stored', 'P-14', 60, 0, s]);
  assert.equal((await db.query(`select count(*)::int n from inventory_moves where ref_id = $1 and reason in ('receive', 'adjust')`, [b.id])).rows[0].n, 1, 'one receipt, no adjustment, for the pallet\'s whole life');
  // shipped out with stock still on the books: released, NOT deducted, and said plainly
  n = await moves(); const out = await rel(b.psku, 'P-14', 'shipped_out'); assert.equal(out.status, 200); assert.equal(out.pallet_status, 'departed'); assert.match(out.note, /60 units are still on the books at P-14/);
  assert.deepEqual([await on('P-14'), await stock(), await moves(), (await at('P-14')).used], [60, s, n, 0]);
  // a later carton edit on a departed pallet does not touch the ledger either
  await db.query(`update wms_cartons set units_per_carton = 1 where pallet_id = $1`, [b.id]); assert.deepEqual([await stock(), await moves()], [s, n]);
  await pick(b.id, 'P-14', 60);   // the proper outbound transaction, here simulated, so the next test starts clean
  // an admin's forced correction on a stored pallet frees the position and keeps the stock
  const c = await pallet(); assert.equal((await bridge('floor', 'POST', '/putaway', { psku: c.psku, location: 'P-15' })).status, 200); s = await stock();
  const fc = await rel(c.psku, 'P-15', 'correction', 'admin'); assert.equal(fc.status, 200); assert.deepEqual([fc.pallet_status, await on('P-15'), await on('OFF-FLOOR'), await stock()], ['off_floor', 0, 100, s]);
  const priv = await bridge('floor', 'POST', '/putaway', { psku: c.psku, location: 'OFF-FLOOR' }); assert.equal(priv.status, 409); assert.match(priv.message, /not a shared pallet position/);
});

test('reconciliation compares ShipBay\'s journal with Nexus and reports drift in either direction; it changes nothing', async () => {
  const nf = await bridge('floor', 'GET', '/reconcile'); assert.equal(nf.status, 403); assert.equal(nf.error, 'not_admin', 'occupancy reconciliation is admin or staff work');
  const clean = await bridge('admin', 'GET', '/reconcile'); assert.equal(clean.in_sync, true, JSON.stringify(clean.differences)); assert.equal(clean.waiting.length, 0);
  const sb = async (p, body, idem) => { const r = await nexus(new Request(`http://nexus.local${p}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.shipbay}`, 'content-type': 'application/json', 'idempotency-key': idem }, body: JSON.stringify(body) })); return r.status; };
  assert.equal(await sb('/v1/pallets/release', { pallet: P1.psku }, 'drift-1'), 200); assert.equal(await sb('/v1/pallets/assign', { pallet: 'PSKU-GHOST', to: 'P-10' }, 'drift-2'), 200);   // drift made outside the bridge
  const n = net.calls.length; const d = await bridge('admin', 'GET', '/reconcile'); assert.equal(d.in_sync, false);
  assert.deepEqual(d.differences.map((x) => [x.pallet, x.kind, x.shipbay, x.nexus]).sort(), [['PSKU-GHOST', 'nexus_only', null, 'P-10'], [P1.psku, 'shipbay_only', 'P-08', null]].sort());
  assert.ok(net.calls.slice(n).every((c) => c.startsWith('GET')), 'reconciliation only reads'); assert.equal((await row(P1.id)).code, 'P-08');
  assert.equal(await sb('/v1/pallets/assign', { pallet: P1.psku, to: 'P-08' }, 'drift-3'), 200); assert.equal(await sb('/v1/pallets/release', { pallet: 'PSKU-GHOST' }, 'drift-4'), 200); assert.equal((await bridge('admin', 'GET', '/reconcile')).in_sync, true);
});

test('a floor that is not open for moves answers 423 in plain words; a key without the move scope answers 403; neither stores anything', async () => {
  const p = await pallet(); await ndb.query(`update nexus.warehouses set moves_enabled = false where code = 'HILLSBOROUGH-TEST'`);
  const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-01' }); await ndb.query(`update nexus.warehouses set moves_enabled = true where code = 'HILLSBOROUGH-TEST'`);
  assert.equal(r.status, 423); assert.equal(r.error, 'occupancy_not_initialized'); assert.match(r.message, /not open for put-away/); assert.equal((await row(p.id)).code, null);
  const ro = await bridgeWith({ ...ON, NEXUS_STAGING_API_KEY: KEYS.readOnly })('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-01' }); assert.equal(ro.status, 403); assert.equal(ro.error, 'forbidden'); assert.equal((await row(p.id)).code, null);
  assert.equal((await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-01' })).status, 200);
});

test('calendar: a confirmed time is published once under the shipment\'s own booking id; a date-only shipment is held, never sent; private detail stays in ShipBay', async () => {
  const timed = await shipment('SYN-PO-TIMED', '2026-12-10'), dateOnly = await shipment('SYN-PO-DATEONLY', '2026-12-11');
  await assert.rejects(run('authenticated', U.floor, 'wms_shipment_set_appointment', { p_id: timed, p_starts: '2026-12-10T12:00:00-05:00', p_ends: null }), /Only ShipBay admin or staff/);
  await assert.rejects(run('authenticated', U.admin, 'wms_shipment_set_appointment', { p_id: timed, p_starts: '2026-12-11T01:00:00-05:00', p_ends: null }), /not on the shipment's date/);
  await run('authenticated', U.admin, 'wms_shipment_set_appointment', { p_id: timed, p_starts: '2026-12-10T12:00:00-05:00', p_ends: '2026-12-10T14:00:00-05:00' });
  const ID = `SB-INB-${timed.toUpperCase()}`;
  // writes off: a report only
  const before = net.calls.length; const dry = await bridgeWith({ ...ON, NEXUS_CALENDAR_WRITES: '' })('admin', 'POST', '/calendar/sync'); assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.would_send.filter((a) => a.booking_id === ID).map((a) => [a.action, a.body]), [['put', { direction: 'inbound', starts_at: '2026-12-10T17:00:00Z', ends_at: '2026-12-10T19:00:00Z', pallets: 2, status: 'scheduled' }]]);
  assert.ok(!net.calls.slice(before).some((c) => /^(PUT|DELETE)/.test(c)));
  // writes on
  const r = await bridge('admin', 'POST', '/calendar/sync'); assert.equal(r.dry_run, false); assert.deepEqual(r.results.filter((x) => x.booking_id === ID).map((x) => [x.action, x.ok]), [['put', true]]);
  assert.ok(r.held.some((h) => h.shipment === dateOnly), 'the date-only shipment is reported as held'); assert.ok(!r.results.some((x) => x.shipment === dateOnly)); assert.ok(!net.calls.some((c) => c.includes(dateOnly.toUpperCase())), 'and was never sent');
  const sent = JSON.stringify((await ndb.query('select * from nexus.calendar_events')).rows); for (const secret of ['SYN-PO-TIMED', 'PRIVATE NOTE', 'Synthetic Records', 'Vendor']) assert.ok(!sent.includes(secret), `${secret} did not leave ShipBay`);
  const theirs = (await asSouled('GET', '/v1/calendar?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z')).events; assert.equal(theirs.length, 1);
  assert.deepEqual([theirs[0].company, theirs[0].direction, theirs[0].pallets, theirs[0].status, Date.parse(theirs[0].starts_at)], ['SHIPBAY', 'inbound', 2, 'scheduled', Date.parse('2026-12-10T17:00:00Z')]); assert.equal(theirs[0].id, undefined);
  // nothing to do the second time: no duplicate
  const c2 = net.calls.length; const r2 = await bridge('admin', 'POST', '/calendar/sync'); assert.equal(r2.results.length, 0); assert.ok(!net.calls.slice(c2).some((c) => /^(PUT|DELETE)/.test(c)));
  // a changed time updates the same booking
  await run('authenticated', U.admin, 'wms_shipment_set_appointment', { p_id: timed, p_starts: '2026-12-10T09:00:00-05:00', p_ends: null });
  assert.deepEqual((await bridge('admin', 'POST', '/calendar/sync')).results.map((x) => [x.booking_id, x.action, x.ok]), [[ID, 'put', true]]);
  assert.equal(Number((await ndb.query('select count(*) n from nexus.calendar_events')).rows[0].n), 1);
  // what the WMS screen gets
  await asSouled('PUT', '/v1/calendar/SOULED-EV-1', { direction: 'outbound', starts_at: '2026-12-11T10:00:00-05:00', pallets: 3, reference: 'SOULED PRIVATE', note: 'SOULED NOTE' });
  const cal = await bridge('floor', 'GET', '/calendar?from=2026-12-01&to=2026-12-31'); assert.equal(cal.nexus.ok, true);
  assert.deepEqual(cal.shipments.filter((s) => s.expected_at >= '2026-12-01').map((s) => [s.reference, s.appt_starts_at ? Date.parse(s.appt_starts_at) : null, s.publish_state]), [['SYN-PO-TIMED', Date.parse('2026-12-10T14:00:00Z'), 'published'], ['SYN-PO-DATEONLY', null, null]]);
  assert.deepEqual(cal.nexus.events.map((e) => [e.company, e.mine, e.id || null]).sort(), [['SHIPBAY', true, ID], ['SOULED', false, null]]); assert.ok(!JSON.stringify(cal).includes('SOULED PRIVATE') && !JSON.stringify(cal).includes('SOULED NOTE'));
  // the date moves: the confirmed time goes with the old date, so the shared booking is cancelled and the shipment is date-only again
  await db.query(`update inbound_shipments set expected_at = '2026-12-15' where id = $1`, [timed]);
  const moved = await bridge('admin', 'POST', '/calendar/sync'); assert.deepEqual(moved.results.map((x) => [x.booking_id, x.action, x.ok]), [[ID, 'cancel', true]]);
  const after = await bridge('admin', 'POST', '/calendar/sync'); assert.equal(after.results.length, 0); assert.ok(after.held.some((h) => h.shipment === timed), 'it is a date-only shipment again');
  assert.equal((await asSouled('GET', '/v1/calendar?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z')).events.find((e) => e.company === 'SHIPBAY').status, 'cancelled');
  // Nexus down: ShipBay's own shipments still load
  net.mode = 'down'; const offline = await bridge('floor', 'GET', '/calendar?from=2026-12-01&to=2026-12-31'); net.mode = 'ok'; assert.equal(offline.ok, true); assert.equal(offline.nexus.ok, false); assert.ok(offline.shipments.length >= 2);
});

test('the lost-answer test fault: only on the dev database with its own switch on, only for a signed-in staff request, one answer, once; everywhere else the request is not run', async () => {
  const F = { 'x-nexus-test-fault': 'lose-answer' }; const DEV = 'https://gdoaonsasbsperqjuurm.supabase.co'; const p = await pallet(); const posts = () => net.calls.filter((c) => c.startsWith('POST')).length;
  const tryIt = async (env, who = 'floor', extra = F, method = 'POST') => { const n = posts(); const r = await bridgeWith(env)(who, method, method === 'POST' ? '/putaway' : '/floor', method === 'POST' ? { psku: p.psku, location: 'P-20' } : undefined, extra); return [r.status, r.error, posts() - n, (await ops(p.psku)).length]; };
  assert.equal((await bridgeWith(ON)(null, 'GET', '/status')).test_faults, false);
  assert.deepEqual(await tryIt(ON), [403, 'test_faults_off', 0, 0], 'switch not set');
  assert.deepEqual(await tryIt({ ...ON, NEXUS_TEST_FAULTS: 'on' }), [403, 'test_faults_off', 0, 0], 'switch on, but not the dev database');
  assert.deepEqual(await tryIt({ ...ON, SUPABASE_URL: DEV }), [403, 'test_faults_off', 0, 0], 'the dev database, switch not set');
  assert.deepEqual(await tryIt({ ...ON, SUPABASE_URL: 'https://gdoaonsasbsperqjuurm.supabase.co.example.net', NEXUS_TEST_FAULTS: 'on' }), [403, 'test_faults_off', 0, 0], 'a look-alike address');
  assert.deepEqual(await tryIt({ ...ON, SUPABASE_URL: 'https://poxlczzkpztmoiixyrth.supabase.co', NEXUS_TEST_FAULTS: 'on' }), [503, 'wrong_database', 0, 0], 'production: the connection itself refuses');
  const DEVON = { ...ON, SUPABASE_URL: DEV, NEXUS_TEST_FAULTS: 'on' }; assert.equal((await bridgeWith(DEVON)(null, 'GET', '/status')).test_faults, true);
  assert.deepEqual(await tryIt(DEVON, null), [401, 'sign_in', 0, 0]); assert.deepEqual(await tryIt(DEVON, 'client'), [403, 'not_staff', 0, 0], 'sign-in and the staff check come first');
  assert.deepEqual(await tryIt(DEVON, 'floor', { 'x-nexus-test-fault': 'drop-database' }), [400, 'bad_request', 0, 0]); assert.deepEqual((await tryIt(DEVON, 'floor', F, 'GET')).slice(0, 3), [400, 'bad_request', 0]);
  const pre = await makeBridge({ env: { ...DEVON, BRIDGE_ALLOWED_ORIGINS: 'https://wms-dev.example.test' }, fetchImpl: nexusFetch, db: port, routes: palletRoutes })(new Request('https://x.test/functions/v1/nexus-bridge/putaway', { method: 'OPTIONS', headers: { origin: 'https://wms-dev.example.test' } }));
  assert.ok(!String(pre.headers.get('access-control-allow-headers')).includes('x-nexus-test-fault'), 'a browser on the WMS site is not allowed to send the header');
  const dev = bridgeWith(DEVON); const s0 = await stock();
  const lost = await dev('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-20' }, F); assert.deepEqual([lost.status, lost.error, lost.pending, lost.test_fault], [503, 'nexus_no_answer', true, 'answer_lost']);
  assert.equal((await at('P-20')).used, 1, 'Nexus applied it'); assert.deepEqual([(await row(p.id)).code, await stock()], [null, s0], 'ShipBay stored nothing');
  const done = await dev('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-20' }); assert.deepEqual([done.status, done.replayed, done.test_fault], [200, true, undefined]); assert.equal(await stock(), s0 + 100);
  assert.deepEqual((await ops(p.psku)).map((o) => [o.state, o.attempts]), [['done', 2]], 'one request, one key, sent twice');
  const plain = await dev('floor', 'POST', '/move', { psku: p.psku, location: 'P-21' }); assert.deepEqual([plain.status, plain.test_fault], [200, undefined], 'without the header nothing is dropped');
});

test('reconciliation carries the exceptions report for an admin', async () => {
  const rec = await bridge('admin', 'GET', '/reconcile'); assert.equal(rec.status, 200); assert.ok(rec.exceptions && Array.isArray(rec.exceptions.departed_with_stock) && Array.isArray(rec.exceptions.off_floor)); assert.equal(typeof rec.needs_action, 'number');
});
