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
for (const f of ['20261123_wms_booking_receiving', '20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock', '20261129_wms_calendar_publish', '20261130_wms_nexus_putaway']) await db.query(fs.readFileSync(path.join(here, '../../candidates', f + '.sql'), 'utf8'));

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
await db.query(`insert into locations (code, zone, kind) select 'P-' || lpad(g::text, 2, '0'), 'bulk', 'pallet' from generate_series(1, 6) g`);
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
const ON = { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: KEYS.shipbay, NEXUS_PALLET_MOVES: 'on', NEXUS_CALENDAR_WRITES: 'on', SUPABASE_URL: 'https://dev-project.supabase.co' };
const bridgeWith = (env) => { const h = makeBridge({ env, fetchImpl: nexusFetch, db: port, routes: [...calendarRoutes, ...palletRoutes], timeoutMs: 2000 });
  return async (who, method, p, body) => { const r = await h(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })); return { status: r.status, ...(await r.json()) }; }; };
const bridge = bridgeWith(ON);

const shipment = async (ref, day) => run('authenticated', U.admin, 'nexus_shipment_create', { p_org: A, p_reference: ref, p_origin: 'Vendor', p_expected: day, p_pallets: 2, p_cartons: 20, p_notes: 'PRIVATE NOTE', p_lines: JSON.stringify([{ sku_id: SKU, qty: 500 }]) });
const today = (await db.query('select current_date::text d')).rows[0].d; const INB = await shipment('SYN-PO-RCV', today); let k = 0;
const pallet = async () => { await db.query('begin'); await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.floor, role: 'authenticated' })]);
  const r = await db.query(`select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,'partial',null)`, [INB, A, JSON.stringify([{ sku: SKU, cartons: 10, units_per_carton: 10 }]), `br-${++k}`]); await db.query('commit'); return r.rows[0]; };
const row = async (id) => (await db.query('select p.status, p.held, l.code from wms_pallets p left join locations l on l.id = p.location_id where p.id = $1', [id])).rows[0];
const stock = async () => Number((await db.query('select coalesce(sum(qty),0) n from inventory_moves')).rows[0].n);
const ops = async (psku) => (await db.query('select kind, state, nexus_http, nexus_error, attempts, idem_key from wms_nexus_ops where psku = $1 order by created_at', [psku])).rows;
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

let P1, P2;
test('put-away: ShipBay checks its rules, Nexus takes the position, then the pallet is stored and stock posts once', async () => {
  P1 = await pallet(); assert.equal(await stock(), 0);
  const bad = net.calls.length; const r0 = await bridge('floor', 'POST', '/putaway', { psku: P1.psku, location: 'A-01-1' }); assert.equal(r0.status, 409); assert.equal(r0.error, 'refused_by_shipbay'); assert.match(r0.message, /not a pallet position/);
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
  const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-04' }); assert.equal(r.status, 503); assert.equal(r.pending, true); assert.match(r.message, /NOT put away/);
  assert.equal((await row(p.id)).code, null); assert.equal(await stock(), 200); assert.equal((await at('P-04')).used, 0);
  const other = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-05' }); assert.equal(other.status, 409); assert.match(other.message, /already has a request to P-04/);
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

test('held pallets never reach Nexus; a pallet put on hold mid-request gets its Nexus position given back', async () => {
  const p = await pallet(); await db.query(`update wms_pallets set held = true, hold_reason = 'crushed corner' where id = $1`, [p.id]);
  const before = net.calls.length; const r = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-06' }); assert.equal(r.status, 409); assert.match(r.message, /on HOLD/); assert.ok(!net.calls.slice(before).some((c) => c.startsWith('POST')));
  await run('authenticated', U.admin, 'wms_hold_disposition', { p_pallet: p.id, p_action: 'release', p_ref: 'SYN-OK' });
  hooks.beforeCommit = () => db.query(`update wms_pallets set held = true, hold_reason = 'found damage' where id = $1`, [p.id]);
  const r2 = await bridge('floor', 'POST', '/putaway', { psku: p.psku, location: 'P-06' }); assert.equal(r2.status, 409); assert.equal(r2.error, 'not_recorded'); assert.match(r2.message, /given back in Nexus/);
  assert.equal((await at('P-06')).used, 0, 'Nexus no longer holds P-06 for it'); assert.equal((await row(p.id)).code, null); assert.equal(await stock(), 400);
  assert.deepEqual((await ops(p.psku)).map((o) => o.state), ['reverted']);
});

test('move: a stored pallet changes position in both systems; stock does not change; Souled\'s position stays refused', async () => {
  const r0 = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-02' }); assert.equal(r0.status, 409); assert.equal(r0.error, 'location_full'); assert.equal((await row(P1.id)).code, 'P-01');
  const s = await stock(); const r = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-06' }); assert.equal(r.status, 200); assert.equal(r.location, 'P-06'); assert.equal(r.from, 'P-01');
  assert.equal((await row(P1.id)).code, 'P-06'); assert.equal(await stock(), s); assert.equal((await at('P-01')).used, 0); assert.equal((await at('P-06')).used, 1);
  const same = await bridge('floor', 'POST', '/move', { psku: P1.psku, location: 'P-06' }); assert.equal(same.status, 409); assert.match(same.message, /already at P-06/);
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
