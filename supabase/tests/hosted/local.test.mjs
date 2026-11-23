// The hosted movement suite (suite.js), run on this machine only, before anything is sent to a hosted service:
//   ShipBay's database functions (local copy of the schema, built like shipbay-nexus-dev: build-local.sh)
//   + the bridge code (supabase/functions/nexus-bridge/*.js) in-process
//   + the REAL Nexus service code and database (branch nexus-neutral, extracted to $NEXUS_NEUTRAL) in a throwaway local database.
// Nothing here reaches Supabase, Nexus staging or production. It proves the steps, the checks and the rules both sides run.
// It does not prove the deployed Edge Function, real sign-in tokens or the hosted Nexus staging service: that is what the
// hosted run is for.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { makeBridge, STAGING_HOST } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
import { runStage, STAGES, KEEP, namesProtected } from './suite.js';
const pg = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const NX = process.env.NEXUS_NEUTRAL; if (!NX || !fs.existsSync(path.join(NX, '001_core.sql'))) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Client(`${base}/staging`); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, (select count(*)::int from orgs where name not like 'Synthetic %') n, (select count(*)::int from wms_pallets) p, (select count(*)::int from inventory_moves) m`)).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.n !== 0 || g.p !== 9 || g.m !== 0) { await db.end(); throw new Error('REFUSED: not a freshly built local synthetic database (run build-local.sh)'); } }

// ---- the real Nexus, local ----
await db.query('drop database if exists nexus_hosted_suite'); await db.query('create database nexus_hosted_suite');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_hosted_suite` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await ndb.query(fs.readFileSync(path.join(NX, f), 'utf8'));
const { makeHandler } = await import(pathToFileURL(path.join(NX, 'service/handler.mjs')));
const nexus = makeHandler(async (sql, p) => (await ndb.query(sql, p)).rows);
const n1 = async (sql, p) => Object.values((await ndb.query(sql, p)).rows[0])[0];
const SHIPBAY = await n1(`insert into nexus.companies (code, name) values ('SHIPBAY','ShipBay3PL') returning id`);
// the same grant the hosted movement key has: SHIPBAY, the test floor, read + move, no calendar
const NEXUS_KEY = await n1(`select nexus.integration_create('test', $1, 'shipbay-nexus-dev-bridge', 'HILLSBOROUGH-TEST', $2)`, [SHIPBAY, ['read', 'move']]);
const net = { lose: false, lost: 0, posts: [] };
const nexusFetch = async (url, init = {}) => {
  const u = new URL(url); assert.equal(u.host, STAGING_HOST, 'the bridge only ever calls the staging host');
  const p = u.pathname.replace('/functions/v1/nexus', ''); if (init.method === 'POST') net.posts.push(`${p} ${init.body}`);
  const res = await nexus(new Request(`http://nexus.local${p}${u.search}`, { method: init.method, headers: init.headers, body: init.body }));
  if (net.lose && init.method === 'POST') { net.lose = false; net.lost++; throw new Error('answer lost'); }   // Nexus applied it; the answer never arrives
  return res;
};

// ---- ShipBay, local: the four synthetic logins from seed.sql ----
const U = { admin: '5b000000-0000-4000-8000-000000000001', floor: '5b000000-0000-4000-8000-000000000002', staff: '5b000000-0000-4000-8000-000000000003', client: '5b000000-0000-4000-8000-000000000004' };
async function run(role, uid, fn, args) {
  const keys = Object.keys(args || {}); await db.query('begin');
  try { await db.query(`set local role ${role}`); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const r = await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map((k) => args[k])); await db.query('commit'); return r.rows[0].r;
  } catch (e) { await db.query('rollback'); throw e; }
}
const port = { user: (token) => ({ rpc: (fn, args) => { if (token === 'public') return run('anon', null, fn, args); if (!U[token]) throw new Error('bad token'); return run('authenticated', U[token], fn, args); } }), service: { rpc: (fn, args) => run('service_role', null, fn, args) } };
const handle = makeBridge({ env: { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: NEXUS_KEY, NEXUS_PALLET_MOVES: 'on', SUPABASE_URL: 'https://gdoaonsasbsperqjuurm.supabase.co' }, fetchImpl: nexusFetch, db: port, routes: palletRoutes, timeoutMs: 2000 });
const bridge = async (who, method, p, body) => { const r = await handle(new Request(`https://x.test/functions/v1/nexus-bridge${p}`, { method, headers: who ? { authorization: `Bearer ${who}`, 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })); return { ...(await r.json()), status: r.status }; };
const io = {
  call: bridge,
  lossy: async (who, method, p, body) => { const before = net.lost; net.lose = true; const r = await bridge(who, method, p, body); net.lose = false; return { ...r, lost: net.lost === before + 1 }; },
  rpc: (who, fn, args) => run('authenticated', U[who], fn, args),
  snapshot: () => run('service_role', null, 'dev_movement_snapshot', {}),
  faultHold: (psku, reason) => run('service_role', null, 'dev_fault_hold', { p_psku: psku, p_reason: reason }),
};
test.after(async () => { await ndb.end(); await db.query('drop database if exists nexus_hosted_suite').catch(() => {}); await db.end(); });
const show = (r) => r.checks.filter((c) => !c.pass).map((c) => `${c.name}\n      got  ${c.got}\n      want ${c.want}`).join('\n') || r.stopped_at || '';

test('setup: the first hosted placement, repeated here (PSKU-000001 at P-01, one receipt of 100)', async () => {
  const r = await bridge('floor', 'POST', '/putaway', { psku: KEEP.psku, location: KEEP.at }); assert.deepEqual([r.status, r.location, Number(r.units_posted)], [200, 'P-01', 100]); net.posts.length = 0;
});

const totals = {};
for (const stage of STAGES) test(`stage ${stage}`, async () => { const r = await runStage(io, stage); totals[stage] = [r.passed, r.failed, r.writes_sent]; assert.equal(r.ok, true, `\n${show(r)}`); });

test('the suite protects itself', async () => {
  assert.equal(net.posts.some((p) => p.includes(KEEP.psku) || /"P-01"/.test(p)), false, 'no write to Nexus named PSKU-000001 or P-01');
  const k = (await ndb.query(`select (select count(*)::int from nexus.moves m join nexus.pallets p on p.id = m.pallet_id where p.external_id = $1) moves, (select l.code from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where p.external_id = $1) at`, [KEEP.psku])).rows[0];
  assert.deepEqual(k, { moves: 1, at: 'P-01' }, 'Nexus has one move for PSKU-000001, the first placement, and it stands at P-01');
  const n = (await ndb.query(`select m.kind, m.result, count(*)::int n from nexus.moves m join nexus.pallets p on p.id = m.pallet_id join nexus.companies c on c.id = p.company_id where c.code = 'SHIPBAY' group by 1, 2 order by 1, 2`)).rows;
  assert.deepEqual(n.map((r) => [r.kind, r.result, r.n]), [['assign', 'ok', 9], ['move', 'location_full', 1], ['move', 'ok', 3], ['release', 'ok', 3]], 'what the whole suite changes in Nexus: 8 put-aways (plus the first placement), 3 moves, 3 releases, and one refused move on record');
  // a stage refuses to run twice: its pallets are no longer in the state it expects, and it stops before sending a write
  for (const stage of ['move', 'release', 'lost', 'partial', 'picks']) { const before = net.posts.length; const r = await runStage(io, stage); assert.equal(r.ok, false, stage); assert.match(r.stopped_at, /^start:/, stage); assert.equal(net.posts.length, before, `${stage} sent nothing`); }
  // a request naming the protected pallet or position never leaves the suite
  for (const b of [{ psku: 'PSKU-000001', location: 'P-30' }, { psku: 'psku-000001 ', location: 'P-30' }, { psku: 'PSKU-000009', location: 'P-01' }, { psku: 'PSKU-000009', location: 'loc-p-01' }, { psku: 'PSKU-000009', location: ' P-01 ' }]) assert.equal(namesProtected(b), true, JSON.stringify(b));
  for (const b of [{ psku: 'PSKU-000010', location: 'P-10' }, { psku: 'PSKU-000002', location: 'P-11' }, { op: 'x', confirmed: true }, undefined]) assert.equal(namesProtected(b), false, JSON.stringify(b));
  assert.equal((await runStage(io, 'nope')).error, 'unknown_stage');
  console.log('checks per stage [passed, failed, writes sent]:', JSON.stringify(totals));
});
