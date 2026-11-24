// The MVP rehearsal step (mvp.js), run on this machine only: ShipBay's database functions (local copy built like
// shipbay-nexus-dev: build-local.sh) + the bridge code in-process + the REAL Nexus service code and database in a throwaway
// local database. Nothing here reaches Supabase, Nexus staging or production.
// Covered: the whole sequence; repeated requests; answers lost on the way back and a Nexus that does not answer at all;
// a run stopped part-way (a failure inside packing) and run again; two runs at once; a finished run run again; refused
// positions (P-01, P-02, P-03, anything but P-50/P-49); an occupied destination; wrong switches; another company's pallet
// at P-02; and what a stopped run says about the switches (it cannot change them).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { runMvp, MVP, allowedPosition } from './mvp.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Pool({ connectionString: `${base}/staging`, max: 6 });
{ const g = (await db.query(`select current_setting('cluster_name') c, (select count(*)::int from orgs where name not like 'Synthetic %') n, (select count(*)::int from wms_pallets) p, (select count(*)::int from inventory_moves) m`)).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.n !== 0 || g.p !== 9 || g.m !== 0) { await db.end(); throw new Error('REFUSED: not a freshly built local synthetic database (run build-local.sh)'); } }

// ---- the real Nexus, local, with ShipBay's key and a second company (standing in for Souled at P-02) ----
const admin = new pg.Client(`${base}/staging`); await admin.connect();
await admin.query('drop database if exists nexus_mvp_suite'); await admin.query('create database nexus_mvp_suite'); await admin.end();
const ndb = new pg.Pool({ connectionString: `${base}/nexus_mvp_suite` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql']) await ndb.query(fs.readFileSync(path.join(NX, f), 'utf8'));
const { makeHandler } = await import(pathToFileURL(path.join(NX, 'service/handler.mjs')));
const nexus = makeHandler(async (sql, p) => (await ndb.query(sql, p)).rows);
const n1 = async (sql, p) => Object.values((await ndb.query(sql, p)).rows[0])[0];
const SHIPBAY = await n1(`insert into nexus.companies (code, name) values ('SHIPBAY','ShipBay3PL') returning id`);
const OTHER = await n1(`insert into nexus.companies (code, name) values ('SOULED','Souled (stand-in)') returning id`);
const NEXUS_KEY = await n1(`select nexus.integration_create('test', $1, 'shipbay-nexus-dev-bridge', 'HILLSBOROUGH-TEST', $2)`, [SHIPBAY, ['read', 'move']]);
const OTHER_KEY = await n1(`select nexus.integration_create('test', $1, 'souled-stand-in', 'HILLSBOROUGH-TEST', $2)`, [OTHER, ['read', 'move']]);
const otherPlace = (kind, pallet, to, from) => n1(`select nexus.api_place($1, $2, $3, $4, $5, $6)`, [OTHER_KEY, kind, pallet, to, from, `souled-${kind}-${pallet}-${to}-${Date.now()}`]);

const net = { posts: [], down: 0 };
const nexusFetch = async (url, init = {}) => {
  const u = new URL(url); assert.equal(u.host, STAGING_HOST, 'the bridge only ever calls the staging host');
  const p = u.pathname.replace('/functions/v1/nexus', '');
  if (init.method === 'POST' && net.down > 0) { net.down--; throw new TypeError('network: connection reset (simulated, request never reached Nexus)'); }
  if (init.method === 'POST') net.posts.push(`${p} ${init.body}`);
  return nexus(new Request(`http://nexus.local${p}${u.search}`, { method: init.method, headers: init.headers, body: init.body }));
};

// ---- ShipBay, local ----
const U = { admin: '5b000000-0000-4000-8000-000000000001', floor: '5b000000-0000-4000-8000-000000000002', staff: '5b000000-0000-4000-8000-000000000003', client: '5b000000-0000-4000-8000-000000000004' };
async function as(role, uid, fn) {
  const c = await db.connect(); await c.query('begin');
  try { await c.query(`set local role ${role}`); await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const out = await fn(c); await c.query('commit'); return out;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const fault = { failOn: null };   // an injected failure: the named function throws once, as a lost connection would
async function run(role, uid, fn, args) {
  if (fault.failOn === fn) { fault.failOn = null; throw new Error(`connection lost before ${fn} reached the database (simulated)`); }
  const keys = Object.keys(args || {});
  return as(role, uid, async (c) => (await c.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : Array.isArray(args[k]) && args[k].some((x) => typeof x === 'object') ? JSON.stringify(args[k]) : args[k])))).rows[0].r);
}
const port = { user: (token) => ({ rpc: (fn, args) => { if (!U[token]) throw new Error('bad token'); return run('authenticated', U[token], fn, args); } }), service: { rpc: (fn, args) => run('service_role', null, fn, args) } };
const ENV = { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: NEXUS_KEY, NEXUS_PALLET_MOVES: 'on', SUPABASE_URL: 'https://gdoaonsasbsperqjuurm.supabase.co' };
const bridgeWith = (env) => { const handle = makeBridge({ env, fetchImpl: nexusFetch, db: port, routes: palletRoutes });
  return async (who, method, p, body, extra = {}) => { const r = await handle(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })); return { ...(await r.json()), status: r.status }; }; };
const bridges = { normal: bridgeWith(ENV), faults: bridgeWith({ ...ENV, NEXUS_TEST_FAULTS: 'on' }), off: bridgeWith({}), movesOff: bridgeWith({ ...ENV, NEXUS_PALLET_MOVES: '' }), calendar: bridgeWith({ ...ENV, NEXUS_CALENDAR_WRITES: 'on' }) };
const makeIo = (bridge) => ({
  call: bridge,
  lossy: async (who, method, p, body) => { const r = await bridge(who, method, p, body, { 'x-nexus-test-fault': 'lose-answer' }); return { ...r, lost: r.test_fault === 'answer_lost' }; },
  rpc: (who, fn, args) => run('authenticated', U[who], fn, args),
  snapshot: () => run('service_role', null, 'dev_movement_snapshot', {}),
  // what the runner does over the REST interface, here as that login with its own rights (row security applies)
  product: (who, row) => as('authenticated', U[who], async (c) => {
    const have = (await c.query('select id, sku, org_id from skus where org_id = $1 and sku = $2', [row.org_id, row.sku])).rows; if (have.length > 1) throw new Error('two products with that SKU');
    return have[0] || (await c.query('insert into skus (org_id, sku, name, barcode) values ($1, $2, $3, $4) returning id, sku, org_id', [row.org_id, row.sku, row.name, row.barcode])).rows[0]; }),
  cancelOrder: (who, id) => as('authenticated', U[who], async (c) => { const r = await c.query(`update orders set status = 'cancelled' where id = $1 returning status`, [id]); if (r.rowCount !== 1) throw new Error('The cancel did not change exactly one order.'); }),
});
const fast = { retryDelayMs: 0 };
const show = (r) => `${r.stopped_at || r.error || ''}\n${r.checks.filter((c) => !c.pass).map((c) => `${c.name}\n  got  ${c.got}\n  want ${c.want}`).join('\n')}\n${r.notes.join('\n')}`;
const q1 = async (sql, p) => (await db.query(sql, p)).rows;
const nexusAt = async (code) => (await ndb.query(`select p.external_id, c.code company from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.companies c on c.id = p.company_id join nexus.locations l on l.id = o.location_id where l.code = $1 order by 1`, [code])).rows;
let protectedBefore;
const protectedNow = async () => ({
  keep: await q1(`select to_jsonb(p) - 'updated_at' j from wms_pallets p where psku = 'PSKU-000001'`),
  keepLedger: await q1(`select to_jsonb(m) j from inventory_moves m where ref_id = (select id from wms_pallets where psku = 'PSKU-000001') order by id`),
  seeded: await q1(`select to_jsonb(p) - 'updated_at' j from wms_pallets p where coalesce(batch_key, '') not like 'mvp-rehearsal-%' order by psku`),
  otherOrders: await q1(`select order_number, status from orders where order_number not like 'MVP-RH-%' order by 1`),
  nexus: { p01: await nexusAt('P-01'), p02: await nexusAt('P-02'), p03: await nexusAt('P-03') },
  nexusMovesForKeep: await n1(`select count(*)::int from nexus.moves m join nexus.pallets p on p.id = m.pallet_id where p.external_id = 'PSKU-000001'`),
});
test.after(async () => { await ndb.end(); const c = new pg.Client(`${base}/staging`); await c.connect(); await c.query('drop database if exists nexus_mvp_suite').catch(() => {}); await c.end(); await db.end(); });

test('setup: PSKU-000001 at P-01 (as on dev), and another company\'s pallet at P-02 (as Souled\'s PAL-9801 on dev)', async () => {
  const r = await bridges.normal('floor', 'POST', '/putaway', { psku: 'PSKU-000001', location: 'P-01' }); assert.deepEqual([r.status, r.location, Number(r.units_posted)], [200, 'P-01', 100]);
  const s = (await otherPlace('assign', 'PAL-9801', 'P-02', null)); assert.equal(s.ok, true, JSON.stringify(s));
  net.posts.length = 0; protectedBefore = await protectedNow();
});

test('positions: P-01, P-02, P-03 and any position but P-50 / P-49 are refused before anything is sent', async () => {
  for (const p of ['P-01', 'p-02', ' P-03 ', 'loc-p-01', 'P-30', 'P-51', '', null]) {
    assert.equal(allowedPosition(p).ok, false, String(p));
    const r = await runMvp(makeIo(bridges.normal), { ...fast, position: p });
    assert.deepEqual([r.ok, r.error, r.writes_sent], [false, 'position_refused', 0], String(p));
  }
  assert.deepEqual([allowedPosition('P-50').ok, allowedPosition(' p-49').code], [true, 'P-49']);
  assert.equal(net.posts.length, 0);
});

test('switches: off, moves off, a write switch the run does not need, or test faults it did not ask for: stops before anything', async () => {
  for (const [name, b, opts] of [['bridge off', bridges.off, {}], ['moves off', bridges.movesOff, {}], ['calendar writes on', bridges.calendar, {}], ['test faults on, not asked for', bridges.faults, {}], ['test faults asked for, off', bridges.normal, { faults: true }]]) {
    const r = await runMvp(makeIo(b), { ...fast, ...opts });
    assert.equal(r.ok, false, name); assert.match(r.stopped_at, /^switches set by hand/, name); assert.equal(r.writes_sent, 0, name);
    assert.match(r.notes.at(-1), /STOPPED\. Switches now: .*The runner cannot turn them off/, name);
  }
  assert.equal(net.posts.length, 0);
  assert.equal((await q1(`select count(*)::int n from skus where sku = $1`, [MVP.sku]))[0].n, 0, 'nothing was created');
});

test('an occupied destination is refused before anything is created (another company\'s pallet at P-49)', async () => {
  assert.equal((await otherPlace('assign', 'PAL-TEMP', 'P-49', null)).ok, true);
  const r = await runMvp(makeIo(bridges.normal), { ...fast, position: 'P-49' });
  assert.equal(r.ok, false); assert.match(r.stopped_at, /P-49 is vacant/); assert.equal(r.writes_sent, 0);
  assert.equal((await q1(`select count(*)::int n from skus where sku = $1`, [MVP.sku]))[0].n, 0);
  assert.equal((await otherPlace('release', 'PAL-TEMP', null, 'P-49')).ok, true);
});

test('a run stopped after receiving, run again: the same pallet, nothing doubled', async () => {
  const a = await runMvp(makeIo(bridges.normal), { ...fast, stopAfter: 'receive' }); assert.equal(a.ok, true, show(a));
  const b = await runMvp(makeIo(bridges.normal), { ...fast, stopAfter: 'receive' }); assert.equal(b.ok, true, show(b));
  assert.equal(a.pallet, b.pallet);
  const p = await q1(`select psku, status, (select count(*)::int from wms_cartons c where c.pallet_id = p.id) cartons from wms_pallets p where batch_key = $1`, [MVP.key]);
  assert.deepEqual(p, [{ psku: a.pallet, status: 'open', cartons: 2 }]);
  assert.equal(net.posts.length, 0, 'nothing went to Nexus yet');
});

test('put-away with the answer lost on the way back: recovered only through /pending/retry with the same key', async () => {
  const r = await runMvp(makeIo(bridges.faults), { ...fast, faults: true, stopAfter: 'putaway' }); assert.equal(r.ok, true, show(r));
  assert.ok(r.notes.some((n) => /Nexus did not answer.*pending\/retry/.test(n)), r.notes.join('\n'));
  console.log(`put-away run: ${r.passed} checks passed\n${r.checks.map((c) => '  ok  ' + c.name).join('\n')}\n${r.notes.map((n) => '  note ' + n).join('\n')}`);
  const assigns = net.posts.filter((x) => x.includes(r.pallet)); assert.equal(assigns.length, 2, 'the lost request and its one resend');
  const keys = assigns.map((x) => JSON.parse(x.slice(x.indexOf(' ') + 1))); assert.equal(keys[0].to, 'P-50'); assert.deepEqual(keys[0], keys[1], 'the resend is the same request');
  assert.deepEqual(await nexusAt('P-50'), [{ external_id: r.pallet, company: 'SHIPBAY' }]);
  assert.deepEqual((await q1(`select kind, state, attempts from wms_nexus_ops where psku = $1`, [r.pallet])), [{ kind: 'assign', state: 'done', attempts: 2 }]);
});

test('a failure part-way through packing: the run stops, reports the switches, and a second run finishes without doubling anything', async () => {
  fault.failOn = 'wms_wave_pack';
  const a = await runMvp(makeIo(bridges.normal), fast);
  assert.equal(a.ok, false); assert.match(a.error, /connection lost before wms_wave_pack/);
  assert.match(a.notes.at(-1), /STOPPED\. Switches now: connection staging, pallet moves true.*Derek deletes NEXUS_BRIDGE_MODE and NEXUS_PALLET_MOVES now/);
  assert.equal(a.switches_at_end.pallet_moves, true, 'a stopped run leaves the switches exactly as they were set: it cannot change them');
  const mid = await q1(`select order_number, status from orders where order_number like 'MVP-RH-%' order by 1`);
  assert.deepEqual(mid.map((o) => o.status), ['picked', 'picked', 'new'], 'stopped after the pick, before packing');
  // the release happens during the second run with Nexus unreachable for one request: the retry with the same key settles it
  net.down = 1;
  const b = await runMvp(makeIo(bridges.normal), fast); assert.equal(b.ok, true, show(b));
  assert.equal(net.down, 0);
  assert.ok(b.notes.some((n) => /\/release: Nexus did not answer/.test(n)), b.notes.join('\n'));
  assert.equal(b.pallet, a.pallet);
  console.log(`full run after the stop: ${b.passed} checks passed, ${b.failed} failed, ${b.writes_sent} writes sent\n${b.checks.map((c) => '  ok  ' + c.name).join('\n')}\n${b.notes.map((n) => '  note ' + n).join('\n')}`);
});

test('the result: 12 received, 12 picked, 12 shipped, 0 left; the pallet gone from P-50; two shipments; the third order cancelled', async () => {
  const s = (await q1(`select e j from jsonb_array_elements((select dev_movement_snapshot())->'pallets') e where e->>'batch' = $1`, [MVP.key]))[0].j;
  assert.deepEqual([s.status, s.location, Number(s.received_units), Number(s.on_books)], ['departed', null, 12, 0]);
  assert.deepEqual(await q1(`select o.order_number, o.status, (select count(*)::int from shipments x where x.order_id = o.id) shipments, (select string_agg(x.tracking, ',') from shipments x where x.order_id = o.id) tracking, (select string_agg(x.label_source, ',') from shipments x where x.order_id = o.id) label from orders o where order_number like 'MVP-RH-%' order by 1`),
    [{ order_number: 'MVP-RH-1', status: 'shipped', shipments: 1, tracking: 'TEST-MVP-RH-0001', label: 'other' }, { order_number: 'MVP-RH-2', status: 'shipped', shipments: 1, tracking: 'TEST-MVP-RH-0002', label: 'other' }, { order_number: 'MVP-RH-3', status: 'cancelled', shipments: 0, tracking: null, label: null }]);
  assert.deepEqual(await q1(`select reason, sum(qty)::int units, count(*)::int rows from inventory_moves where sku_id = (select id from skus where sku = $1) group by 1 order by 1`, [MVP.sku]), [{ reason: 'pick', units: -12, rows: 1 }, { reason: 'receive', units: 12, rows: 1 }]);
  assert.deepEqual(await nexusAt('P-50'), []);
  assert.deepEqual((await ndb.query(`select m.kind, m.result, count(*)::int n from nexus.moves m join nexus.pallets p on p.id = m.pallet_id where p.external_id = $1 group by 1, 2 order by 1, 2`, [s.psku])).rows, [{ kind: 'assign', result: 'ok', n: 1 }, { kind: 'release', result: 'ok', n: 1 }]);
});

test('a finished run run again sends nothing to Nexus and changes nothing', async () => {
  const before = net.posts.length; const fp = await q1(`select md5(string_agg(to_jsonb(m)::text, '|' order by id)) h from inventory_moves m`);
  const r = await runMvp(makeIo(bridges.normal), fast); assert.equal(r.ok, true, show(r));
  assert.equal(net.posts.length, before); assert.equal(r.writes_sent, 0);
  assert.deepEqual(await q1(`select md5(string_agg(to_jsonb(m)::text, '|' order by id)) h from inventory_moves m`), fp);
});

test('the protected records: PSKU-000001, the seeded pallets, other orders, and Nexus at P-01, P-02, P-03 are as before', async () => {
  assert.deepEqual(await protectedNow(), protectedBefore);
  assert.equal(net.posts.some((p) => /PSKU-000001|"P-0[123]"/.test(p)), false, 'no write to Nexus named PSKU-000001, P-01, P-02 or P-03');
});

test('two runs at once (a doubled start) on a fresh set: one result, nothing doubled', async () => {
  // a second, separate rehearsal set: same steps, its own identifiers, P-49
  const saved = { ...MVP, orders: MVP.orders.map((o) => [...o]), tracking: [...MVP.tracking] };
  Object.assign(MVP, { sku: 'MVP-RH-1124B', barcode: 'MVP-RH-1124B-BC', key: 'mvp-rehearsal-1124b', orders: [['MVP-RH-B1', 6], ['MVP-RH-B2', 6], ['MVP-RH-B3', 6]], tracking: ['TEST-MVP-RH-B001', 'TEST-MVP-RH-B002'] });
  try {
    const [a, b] = await Promise.all([runMvp(makeIo(bridges.normal), { ...fast, position: 'P-49' }), runMvp(makeIo(bridges.normal), { ...fast, position: 'P-49' })]);
    const done = [a, b].filter((r) => r.ok);
    // whichever stopped did so at a check (a refusal from the database or the bridge), never by doubling anything
    for (const r of [a, b]) if (!r.ok) assert.ok(r.stopped_at || r.error, show(r));
    const c = await runMvp(makeIo(bridges.normal), { ...fast, position: 'P-49' }); assert.equal(c.ok, true, show(c));
    assert.deepEqual(await q1(`select count(*)::int pallets from wms_pallets where batch_key = $1`, [MVP.key]), [{ pallets: 1 }]);
    assert.deepEqual(await q1(`select reason, sum(qty)::int units, count(*)::int rows from inventory_moves where sku_id = (select id from skus where sku = $1) group by 1 order by 1`, [MVP.sku]), [{ reason: 'pick', units: -12, rows: 1 }, { reason: 'receive', units: 12, rows: 1 }]);
    assert.deepEqual(await q1(`select count(*)::int n from shipments where order_id in (select id from orders where order_number like 'MVP-RH-B%')`), [{ n: 2 }]);
    assert.deepEqual(await nexusAt('P-49'), []);
    assert.deepEqual(await protectedNow(), protectedBefore);
    console.log('doubled start:', JSON.stringify([a, b].map((r) => ({ ok: r.ok, stopped_at: r.stopped_at || null, error: r.error || null, writes: r.writes_sent }))));
  } finally { Object.assign(MVP, saved); }
});
