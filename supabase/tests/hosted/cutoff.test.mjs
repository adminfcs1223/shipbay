// The movement cutoff (NEXUS_MOVES_UNTIL / NEXUS_MOVES_POSITIONS / NEXUS_MOVES_PALLETS in core.js), proved on this machine
// only: ShipBay's database functions (local copy built like shipbay-nexus-dev), the bridge code in-process, the REAL Nexus code
// and database in a throwaway local database, and a clock the test moves. Nothing here reaches a hosted service.
// What it proves: no pallet write is sent to Nexus without an authorization in the function's own settings; none once it has
// expired, with the movement switches still ON; nothing a caller sends extends it; positions and pallets outside it are refused
// before ShipBay's journal is touched; the check is repeated immediately before each request to Nexus (expiry between the two,
// concurrent requests straddling the expiry); restarts and stale instances stop at the same absolute time; and what expiry
// cannot do: a request sent before the cutoff whose answer was lost or timed out stays waiting, and only a new authorization
// lets it be resent.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, nexusClient, readConfig, STAGING_HOST, MOVE_WINDOW_MAX_MS } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Pool({ connectionString: `${base}/staging`, max: 6 });
{ const g = (await db.query(`select current_setting('cluster_name') c, (select count(*)::int from orgs where name not like 'Synthetic %') n, (select count(*)::int from wms_pallets) p, (select count(*)::int from inventory_moves) m`)).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.n !== 0 || g.p !== 9 || g.m !== 0) { await db.end(); throw new Error('REFUSED: not a freshly built local synthetic database (run build-local.sh)'); } }
{ const c = new pg.Client(`${base}/staging`); await c.connect(); await c.query('drop database if exists nexus_cutoff_suite'); await c.query('create database nexus_cutoff_suite'); await c.end(); }
const ndb = new pg.Pool({ connectionString: `${base}/nexus_cutoff_suite` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql']) await ndb.query(fs.readFileSync(path.join(NX, f), 'utf8'));
const { makeHandler } = await import(pathToFileURL(path.join(NX, 'service/handler.mjs')));
const nexus = makeHandler(async (sql, p) => (await ndb.query(sql, p)).rows);
const n1 = async (sql, p) => Object.values((await ndb.query(sql, p)).rows[0])[0];
const SHIPBAY = await n1(`insert into nexus.companies (code, name) values ('SHIPBAY','ShipBay3PL') returning id`);
const NEXUS_KEY = await n1(`select nexus.integration_create('test', $1, 'shipbay-nexus-dev-bridge', 'HILLSBOROUGH-TEST', $2)`, [SHIPBAY, ['read', 'move']]);

// the clock every bridge here reads; the time of every request that reaches Nexus is recorded
const clock = { t: Date.parse('2026-11-24T16:00:00Z') }; const now = () => clock.t; const at = (min) => new Date(clock.t + min * 60000).toISOString();
const net = { posts: [], hang: false, onPost: null };
const nexusFetch = async (url, init = {}) => {
  const u = new URL(url); assert.equal(u.host, STAGING_HOST);
  const p = u.pathname.replace('/functions/v1/nexus', '');
  if (init.method === 'POST') {
    if (net.hang) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));   // Nexus never answers; the request never lands
    net.posts.push({ at: clock.t, what: `${p} ${init.body}` }); if (net.onPost) net.onPost();
  }
  return nexus(new Request(`http://nexus.local${p}${u.search}`, { method: init.method, headers: init.headers, body: init.body }));
};
const U = { floor: '5b000000-0000-4000-8000-000000000002', admin: '5b000000-0000-4000-8000-000000000001' };
const hook = { onBegin: null };
async function run(role, uid, fn, args) {
  const c = await db.connect(); const keys = Object.keys(args || {});
  try { await c.query('begin'); await c.query(`set local role ${role}`); await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const r = await c.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k])); await c.query('commit');
    if (/_begin$/.test(fn) && hook.onBegin) hook.onBegin();
    return r.rows[0].r;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const port = { user: (token) => ({ rpc: (fn, args) => run('authenticated', U[token], fn, args) }), service: { rpc: (fn, args) => run('service_role', null, fn, args) } };
const BASE = { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: NEXUS_KEY, NEXUS_PALLET_MOVES: 'on', SUPABASE_URL: 'https://gdoaonsasbsperqjuurm.supabase.co' };
/** one bridge instance = one running function with these settings (a new instance = a restart) */
const bridgeWith = (env, opts = {}) => { const handle = makeBridge({ env, fetchImpl: nexusFetch, db: port, routes: palletRoutes, now, ...opts });
  return async (who, method, p, body, extra = {}) => { const r = await handle(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })); return { ...(await r.json()), status: r.status }; }; };
const ops = async () => (await db.query(`select psku, kind, state, attempts, coalesce(to_code, from_code) at from wms_nexus_ops order by created_at`)).rows;
const nexusAt = async (code) => (await ndb.query(`select p.external_id from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where l.code = $1`, [code])).rows.map((r) => r.external_id);
test.after(async () => { await ndb.end(); const c = new pg.Client(`${base}/staging`); await c.connect(); await c.query('drop database if exists nexus_cutoff_suite').catch(() => {}); await c.end(); await db.end(); });

test('fail closed: no authorization, an unreadable one, one reaching more than 60 minutes ahead, or no positions: nothing is begun or sent', async () => {
  const cases = [
    ['missing', {}, 'move_not_authorized'],
    ['a word', { NEXUS_MOVES_UNTIL: 'tomorrow' }, 'move_not_authorized'],
    ['no time zone', { NEXUS_MOVES_UNTIL: '2026-11-24T16:30:00' }, 'move_not_authorized'],
    ['a number', { NEXUS_MOVES_UNTIL: String(clock.t + 600000) }, 'move_not_authorized'],
    ['61 minutes ahead', { NEXUS_MOVES_UNTIL: at(61) }, 'move_not_authorized'],
    ['year 2099', { NEXUS_MOVES_UNTIL: '2099-01-01T00:00:00Z' }, 'move_not_authorized'],
    ['already past', { NEXUS_MOVES_UNTIL: at(-1) }, 'move_window_closed'],
    ['exactly now', { NEXUS_MOVES_UNTIL: at(0) }, 'move_window_closed'],
  ];
  for (const [name, w, err] of cases) {
    const b = bridgeWith({ ...BASE, NEXUS_MOVES_POSITIONS: 'P-50', ...w });
    const r = await b('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-50' }); assert.deepEqual([r.status, r.error], [503, err], name);
    const st = await b(null, 'GET', '/status'); assert.deepEqual([st.pallet_moves, st.move_window.open], [true, false], name);
  }
  for (const [name, w] of [['no positions', {}], ['a bad position', { NEXUS_MOVES_POSITIONS: 'P-5O' }], ['a repeated position', { NEXUS_MOVES_POSITIONS: 'P-50,P-50' }], ['a bad pallet list', { NEXUS_MOVES_POSITIONS: 'P-50', NEXUS_MOVES_PALLETS: 'pallet two' }]]) {
    const r = await bridgeWith({ ...BASE, NEXUS_MOVES_UNTIL: at(20), ...w })('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-50' }); assert.deepEqual([r.status, r.error], [503, 'move_not_authorized'], name);
  }
  // the switch still decides first: moves off with an open authorization answers as before
  assert.equal((await bridgeWith({ ...BASE, NEXUS_PALLET_MOVES: '', NEXUS_MOVES_UNTIL: at(20), NEXUS_MOVES_POSITIONS: 'P-50' })('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-50' })).error, 'pallet_moves_off');
  assert.deepEqual([net.posts.length, (await ops()).length], [0, 0], 'nothing reached Nexus and ShipBay\'s journal is untouched');
  assert.equal(MOVE_WINDOW_MAX_MS, 3600000);
});

test('scope: a position or pallet outside the authorization is refused before the journal is touched', async () => {
  const b = bridgeWith({ ...BASE, NEXUS_MOVES_UNTIL: at(20), NEXUS_MOVES_POSITIONS: 'P-50', NEXUS_MOVES_PALLETS: 'PSKU-000004' });
  for (const [body, why] of [[{ psku: 'PSKU-000004', location: 'P-49' }, 'P-49'], [{ psku: 'PSKU-000004', location: 'loc-p-01' }, 'P-01'], [{ psku: 'PSKU-000002', location: 'P-50' }, 'PSKU-000002'], [{ psku: 'PSKU-000001', location: 'P-50' }, 'PSKU-000001']]) {
    const r = await b('floor', 'POST', '/putaway', body); assert.deepEqual([r.status, r.error], [503, 'move_out_of_scope'], JSON.stringify(body)); assert.match(r.message, new RegExp(why));
  }
  assert.deepEqual([net.posts.length, (await ops()).length], [0, 0]);
  const ok = await b('floor', 'POST', '/putaway', { psku: 'psku-000004 ', location: ' p-50' }); assert.deepEqual([ok.status, ok.location], [200, 'P-50'], JSON.stringify(ok));
  const rel = await b('floor', 'POST', '/release', { psku: 'PSKU-000004', location: 'P-50', confirmed: true, reason: 'emptied_and_removed' }); assert.equal(rel.status, 200, JSON.stringify(rel));
  assert.equal(net.posts.length, 2); net.posts.length = 0;
});

test('expiry with the switches still ON: every write route refuses, nothing reaches Nexus, nothing a caller sends extends it', async () => {
  const env = { ...BASE, NEXUS_MOVES_UNTIL: at(10), NEXUS_MOVES_POSITIONS: 'P-50,P-49,P-46', NEXUS_TEST_FAULTS: 'on' };
  const b = bridgeWith(env);
  assert.equal((await b('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-50' })).status, 200);
  net.posts.length = 0; const journal = await ops();
  clock.t += 10 * 60000;   // the authorization's own time: from this instant on, nothing new may be sent
  const st = await b(null, 'GET', '/status');
  assert.deepEqual([st.connection, st.pallet_moves, st.test_faults, st.move_window.open, st.move_window.seconds_left], ['staging', true, true, false, 0], 'the switches are still ON; only the authorization has closed');
  const tries = [
    ['/putaway', { psku: 'PSKU-000009', location: 'P-49' }],
    ['/move', { psku: 'PSKU-000002', location: 'P-49' }],
    ['/release', { psku: 'PSKU-000002', location: 'P-50', confirmed: true, reason: 'emptied_and_removed' }],
    ['/reconcile/undo', { op: '00000000-0000-4000-8000-000000000000', confirmed: true }],
    ['/putaway', { psku: 'PSKU-000009', location: 'P-49', until: at(30), NEXUS_MOVES_UNTIL: at(30) }],
  ];
  for (const [p, body] of tries) { const r = await b('floor', 'POST', p, body); assert.deepEqual([r.status, r.error], [503, 'move_window_closed'], p); }
  for (const extra of [{ 'x-nexus-moves-until': at(30) }, { 'nexus-moves-until': at(30) }]) assert.equal((await b('floor', 'POST', '/putaway', { psku: 'PSKU-000009', location: 'P-49' }, extra)).error, 'move_window_closed');
  assert.equal((await b('floor', 'POST', '/putaway?until=2026-11-24T17:00:00Z', { psku: 'PSKU-000009', location: 'P-49' })).error, 'move_window_closed');
  const lost = await b('floor', 'POST', '/putaway', { psku: 'PSKU-000009', location: 'P-49' }, { 'x-nexus-test-fault': 'lose-answer' }); assert.equal(lost.error, 'move_window_closed');
  const retry = await b('floor', 'POST', '/pending/retry', {}); assert.deepEqual([retry.status, retry.error], [503, 'move_window_closed']);
  assert.deepEqual([net.posts.length, await ops()], [0, journal], 'no request reached Nexus after the cutoff and ShipBay\'s journal did not change');
  // reading still works: reconciliation is not a write
  const rec = await b('admin', 'GET', '/reconcile'); assert.deepEqual([rec.status, rec.in_sync], [200, true]);
  // a restart with the same settings, and an instance started before the cutoff, both stop at the same absolute time
  assert.equal((await bridgeWith(env)('floor', 'POST', '/putaway', { psku: 'PSKU-000009', location: 'P-49' })).error, 'move_window_closed', 'restarted');
  assert.equal(net.posts.length, 0);
});

test('expiry between ShipBay\'s journal and the request to Nexus: the second check stops it; it stays waiting, unsent, until a new authorization', async () => {
  const env = { ...BASE, NEXUS_MOVES_UNTIL: at(5), NEXUS_MOVES_POSITIONS: 'P-48' };
  hook.onBegin = () => { clock.t += 5 * 60000; hook.onBegin = null; };   // the cutoff passes while the journal entry is being written
  const r = await bridgeWith(env)('floor', 'POST', '/putaway', { psku: 'PSKU-000006', location: 'P-48' });
  assert.deepEqual([r.status, r.error, r.waiting], [503, 'move_window_closed', true]);
  assert.equal(net.posts.length, 0, 'nothing was sent');
  assert.deepEqual((await ops()).filter((o) => o.psku === 'PSKU-000006'), [{ psku: 'PSKU-000006', kind: 'assign', state: 'pending', attempts: 0, at: 'P-48' }], 'the journal entry is left exactly as it was: waiting');
  assert.deepEqual(await nexusAt('P-48'), []);
  // a new authorization (Derek sets a new time; the function restarts with it): the retry sends it once
  const again = await bridgeWith({ ...env, NEXUS_MOVES_UNTIL: at(5) })('floor', 'POST', '/pending/retry', {});
  assert.deepEqual(again.results.map((x) => [x.pallet, x.ok]), [['PSKU-000006', true]]);
  assert.deepEqual(await nexusAt('P-48'), ['PSKU-000006']); net.posts.length = 0;
});

test('in flight at the cutoff: an answer lost, or a request that timed out, before expiry stays waiting; expiry stops the resend', async () => {
  // (a) Nexus applied it and the answer was lost
  const env = { ...BASE, NEXUS_MOVES_UNTIL: at(5), NEXUS_MOVES_POSITIONS: 'P-47,P-46', NEXUS_TEST_FAULTS: 'on' };
  const b = bridgeWith(env);
  const lost = await b('floor', 'POST', '/putaway', { psku: 'PSKU-000005', location: 'P-47' }, { 'x-nexus-test-fault': 'lose-answer' });
  assert.deepEqual([lost.status, lost.pending, lost.test_fault], [503, true, 'answer_lost']);
  // (b) the move of PSKU-000002 (stored at P-50) to P-46 times out: Nexus never answers
  net.hang = true; const timed = await bridgeWith({ ...BASE, NEXUS_MOVES_UNTIL: at(5), NEXUS_MOVES_POSITIONS: 'P-50,P-46' }, { timeoutMs: 150 })('floor', 'POST', '/move', { psku: 'PSKU-000002', location: 'P-46' }); net.hang = false;
  assert.deepEqual([timed.status, timed.pending], [503, true]);
  clock.t += 5 * 60000; const posts = net.posts.length;
  const r = await b('floor', 'POST', '/pending/retry', {}); assert.deepEqual([r.status, r.error], [503, 'move_window_closed']);
  assert.equal(net.posts.length, posts, 'nothing was resent');
  assert.deepEqual(await nexusAt('P-47'), ['PSKU-000005'], 'what expiry cannot undo: Nexus already holds the pallet whose answer was lost');
  const rec = await b('admin', 'GET', '/reconcile');
  assert.deepEqual(rec.waiting.map((w) => [w.pallet, w.kind, w.state, w.nexus_has_it_at]).sort(), [['PSKU-000002', 'move', 'pending', 'P-50'], ['PSKU-000005', 'assign', 'pending', 'P-47']], 'both are reported waiting, with where Nexus has each pallet');
  // only a new authorization covering them lets the same keys be resent
  const partial = await bridgeWith({ ...BASE, NEXUS_MOVES_UNTIL: at(5), NEXUS_MOVES_POSITIONS: 'P-47' })('floor', 'POST', '/pending/retry', {});
  assert.deepEqual(partial.results.map((x) => [x.pallet, x.ok, x.error]).sort(), [['PSKU-000002', false, 'move_out_of_scope'], ['PSKU-000005', true, null]], 'an authorization that does not cover the move leaves it waiting');
  const full = await bridgeWith({ ...BASE, NEXUS_MOVES_UNTIL: at(5), NEXUS_MOVES_POSITIONS: 'P-50,P-46' })('floor', 'POST', '/pending/retry', {});
  assert.deepEqual(full.results.map((x) => [x.pallet, x.ok]), [['PSKU-000002', true]]);
  assert.deepEqual([await nexusAt('P-46'), await nexusAt('P-50')], [['PSKU-000002'], []]);
  assert.deepEqual((await ops()).filter((o) => ['PSKU-000002', 'PSKU-000005'].includes(o.psku)).map((o) => [o.psku, o.kind, o.state]), [['PSKU-000002', 'assign', 'done'], ['PSKU-000005', 'assign', 'done'], ['PSKU-000002', 'move', 'done']]);
  net.posts.length = 0;
});

test('concurrent requests straddling the cutoff: no request reaches Nexus at or after it', async () => {
  const env = { ...BASE, NEXUS_MOVES_UNTIL: at(1.5), NEXUS_MOVES_POSITIONS: 'P-40,P-41,P-42' }; const until = clock.t + 90000;
  const b = bridgeWith(env);
  net.onPost = () => { clock.t += 60000; };   // each request that reaches Nexus moves the clock a minute on
  const rs = await Promise.all([['PSKU-000007', 'P-40'], ['PSKU-000008', 'P-41'], ['PSKU-000009', 'P-42']].map(([psku, location]) => b('floor', 'POST', '/putaway', { psku, location })));
  net.onPost = null;
  assert.ok(net.posts.every((p) => p.at < until), JSON.stringify(net.posts.map((p) => p.at - until)));
  const sent = rs.filter((r) => r.status === 200).length, stopped = rs.filter((r) => r.error === 'move_window_closed').length;
  assert.deepEqual([sent + stopped, sent >= 1, stopped >= 1, net.posts.length], [3, true, true, sent], JSON.stringify(rs.map((r) => [r.status, r.error])));
  console.log(`straddling the cutoff: ${sent} sent before it, ${stopped} stopped at the last check, 0 after it`);
});

test('the last line of defence: the Nexus client itself refuses a pallet write the authorization does not cover', async () => {
  const cfg = readConfig({ ...BASE }); let fetched = 0;
  const nx = nexusClient(cfg, async () => { fetched++; return new Response('{}'); }, { now, guardWrite: () => ({ error: 'move_window_closed' }) });
  await assert.rejects(nx.call('POST', '/v1/pallets/assign', { body: { pallet: 'PSKU-000009', to: 'P-49' }, idem: 'x' }), /pallet write blocked here: move_window_closed/);
  await assert.rejects(nexusClient(cfg, async () => { fetched++; return new Response('{}'); })/* no guard given: refuses */.call('POST', '/v1/pallets/release', { body: {} }), /blocked/);
  assert.equal((await nx.call('GET', '/v1/map')).status, 200, 'reads are not affected');
  assert.equal(fetched, 1, 'only the read was fetched');
});
