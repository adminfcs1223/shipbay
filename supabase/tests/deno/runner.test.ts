// The temporary movement runner (supabase/dev/runner/runner.js) under the real Deno runtime, on this machine only.
// Real here: Deno, the runner exactly as it would be deployed, the bridge's index.ts served over real HTTP, ShipBay's SQL in
// the local test database (build-local.sh), and the real Nexus service code with its own local database.
// Stand-ins: Supabase Auth and the REST layer (one small server: it issues a token per login and runs functions as that
// login, as the public key, or as the service login) and the network path to Nexus (in-process instead of the internet).
// Nothing here reaches the network: only 127.0.0.1.
// deno-lint-ignore-file no-explicit-any
import pg from 'npm:pg@8';
import assert from 'node:assert/strict';
import { makeRunner } from '../../dev/runner/runner.js';
import { STAGES, KEEP } from '../hosted/suite.js';

const NX = Deno.env.get('NEXUS_NEUTRAL'); if (!NX) throw new Error('Set NEXUS_NEUTRAL to the extracted neutral/ folder of the nexus-neutral branch.');
const base = 'postgres://postgres@127.0.0.1:54317';
const db = new pg.Pool({ connectionString: `${base}/staging`, max: 4 });
{ const g = (await db.query(`select current_setting('cluster_name') c, (select count(*)::int from orgs where name not like 'Synthetic %') n, (select count(*)::int from wms_pallets) p, (select count(*)::int from inventory_moves) m`)).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.n !== 0 || g.p !== 9 || g.m !== 0) { await db.end(); throw new Error('REFUSED: not a freshly built local synthetic database (run build-local.sh)'); } }
await db.query('drop database if exists nexus_runner_test'); await db.query('create database nexus_runner_test');
const ndb = new pg.Pool({ connectionString: `${base}/nexus_runner_test`, max: 4 });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await ndb.query(await Deno.readTextFile(`${NX}/${f}`));
const { makeHandler } = await import(`file://${NX}/service/handler.mjs`);
const nexus = makeHandler(async (sql: string, p: unknown[]) => (await ndb.query(sql, p)).rows);
const n1 = async (sql: string, p?: unknown[]) => Object.values((await ndb.query(sql, p)).rows[0])[0] as string;
const SHIPBAY = await n1(`insert into nexus.companies (code, name) values ('SHIPBAY','ShipBay3PL') returning id`);
const NEXUS_KEY = await n1(`select nexus.integration_create('test', $1, 'shipbay-nexus-dev-bridge', 'HILLSBOROUGH-TEST', $2)`, [SHIPBAY, ['read', 'move']]);
const SERVICE = 'local-service-key-0123456789', ANON = 'local-anon-key-0123456789';
const LOGINS: Record<string, string> = { 'test-admin@example.test': '5b000000-0000-4000-8000-000000000001', 'test-floor@example.test': '5b000000-0000-4000-8000-000000000002', 'test-client@example.test': '5b000000-0000-4000-8000-000000000004' };

// --- stand-in Supabase: Auth (issue, verify, who-am-I) and REST (functions as the caller) ---
const links = new Map<string, string>(), sessions = new Map<string, string>(); const seen = { asService: [] as string[], asUser: [] as string[], asPublic: [] as string[], issued: 0 };
const rnd = () => crypto.randomUUID().replaceAll('-', '');
async function rpc(fn: string, args: Record<string, unknown>, bearer: string) {
  const c = await db.connect();
  try {
    await c.query('begin');
    if (bearer === SERVICE) { seen.asService.push(fn); await c.query('set local role service_role'); }
    else if (bearer === ANON) { seen.asPublic.push(fn); await c.query('set local role anon'); }
    else { const email = sessions.get(bearer); if (!email) return { status: 401, body: { message: 'JWT invalid' } }; seen.asUser.push(`${email.split('@')[0]}:${fn}`);
      await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: LOGINS[email], role: 'authenticated' })]); }
    const keys = Object.keys(args); const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    let out: unknown = null;
    try { await c.query('savepoint s'); out = (await c.query(`select to_jsonb(x) r from ${call} x`, vals)).rows[0]?.r ?? null; }
    catch (e: any) { if (!/void/.test(String(e.message))) throw e; await c.query('rollback to savepoint s'); await c.query(`select ${call}`, vals); }
    await c.query('commit'); return { status: 200, body: out };
  } catch (e: any) { await c.query('rollback').catch(() => {}); return { status: 400, body: { message: String(e.message) } }; } finally { c.release(); }
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const supa = Deno.serve({ port: 54391, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
  const p = new URL(req.url).pathname; const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (p === '/auth/v1/admin/generate_link') { if (bearer !== SERVICE) return reply({}, 401); const { email, type } = await req.json(); if (type !== 'magiclink' || !LOGINS[email]) return reply({}, 400); const h = rnd(); links.set(h, email); return reply({ hashed_token: h }); }
  if (p === '/auth/v1/verify') { const { token_hash } = await req.json(); const email = links.get(token_hash); if (!email) return reply({}, 403); links.delete(token_hash); const t = `tok.${rnd()}${rnd()}`; sessions.set(t, email); seen.issued++; return reply({ access_token: t }); }
  if (p === '/auth/v1/user') { const email = sessions.get(bearer); return email ? reply({ id: LOGINS[email], email, role: 'authenticated' }) : reply({}, 401); }
  const fn = p.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]; if (!fn) return reply({}, 404);
  const r = await rpc(fn, await req.json(), bearer); return reply(r.body, r.status);
});

// --- the only way out of this process: 127.0.0.1, or the fixed staging address answered by the real Nexus code ---
const out = { posts: [] as string[] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname !== 'ankoqruedjujyefhrmtw.supabase.co' || !url.pathname.startsWith('/functions/v1/nexus/')) throw new Error(`UNEXPECTED OUTBOUND CALL to ${url.hostname}`);
  const path = url.pathname.replace('/functions/v1/nexus', ''); if (init.method === 'POST') out.posts.push(`${path} ${init.body}`);
  return nexus(new Request(`http://nexus.local${path}${url.search}`, { method: init.method, headers: init.headers, body: init.body }));
}) as typeof fetch;

// --- the deployed bridge, exactly as deployed, and the runner in front of it ---
const ENV: Record<string, string> = { SUPABASE_URL: 'http://127.0.0.1:54391', SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: NEXUS_KEY, NEXUS_PALLET_MOVES: 'on', DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:54392' };
for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
await import('../../functions/nexus-bridge/index.ts');
const BRIDGE = 'http://127.0.0.1:54392/functions/v1/nexus-bridge';
const TOKEN = `one-time-${rnd()}`; const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const background: Promise<unknown>[] = [];
const runnerWith = (over: Record<string, unknown> = {}) => makeRunner({ env: ENV, fetchImpl: fetch, gate: { sha256: '', notAfter: Date.now() + 3600000 }, defer: (p: Promise<unknown>) => { background.push(p); }, devHost: '127.0.0.1:54391', bridgeBase: BRIDGE, ...over } as any);
const GATE = { sha256: await hex(TOKEN), notAfter: Date.now() + 3600000 };
const runner = runnerWith({ gate: GATE });
const get = async (h: (r: Request) => Promise<Response>, q: string, method = 'GET') => { const r = await h(new Request(`https://x.test/functions/v1/bridge-smoke${q}`, { method })); const text = await r.text(); return { status: r.status, text, ...(JSON.parse(text || '{}')) }; };
const opt = { sanitizeResources: false, sanitizeOps: false };
const secrets = () => [SERVICE, ANON, NEXUS_KEY, ...sessions.keys()];

Deno.test('the gate: closed as shipped, closed without the token, closed after its expiry, closed to anything but GET; refuses any database but the dev one', opt, async () => {
  const q = `?t=${TOKEN}&stage=preflight`;
  assert.deepEqual((await get(runnerWith({ gate: { sha256: 'CLOSED', notAfter: 0 } }), q)).status, 404, 'as shipped in the repository');
  assert.deepEqual((await get(runnerWith({ gate: { ...GATE, notAfter: Date.now() - 1 } }), q)).status, 404, 'expired');
  assert.deepEqual((await get(runner, '?stage=preflight')).status, 404); assert.deepEqual((await get(runner, '?t=wrong&stage=preflight')).status, 404); assert.deepEqual((await get(runner, q, 'POST')).status, 404);
  const prod = await get(runnerWith({ gate: GATE, env: { ...ENV, SUPABASE_URL: 'https://poxlczzkpztmoiixyrth.supabase.co' }, devHost: undefined }), q); assert.deepEqual([prod.status, prod.error], [503, 'not_the_dev_database']);
  const other = await get(runnerWith({ gate: GATE, devHost: undefined }), q); assert.deepEqual([other.status, other.error], [503, 'not_the_dev_database'], 'the real runner accepts only shipbay-nexus-dev');
  assert.deepEqual((await get(runner, `?t=${TOKEN}&stage=everything`)).status, 400);
  assert.deepEqual([seen.issued, seen.asService.length, out.posts.length], [0, 0, 0], 'none of that signed anyone in, touched the database or reached Nexus');
});

Deno.test('setup: the first hosted placement, repeated here (PSKU-000001 at P-01)', opt, async () => {
  sessions.set('setup-floor', 'test-floor@example.test');
  const r = await realFetch(`${BRIDGE}/putaway`, { method: 'POST', headers: { authorization: 'Bearer setup-floor', 'content-type': 'application/json' }, body: JSON.stringify({ psku: KEEP.psku, location: KEEP.at }) });
  assert.deepEqual([r.status, (await r.json()).location], [200, 'P-01']); sessions.delete('setup-floor'); out.posts.length = 0;
});

const totals: Record<string, unknown> = {};
for (const stage of STAGES) Deno.test(`stage ${stage}: started through the runner, run in the background, stored, read back`, opt, async () => {
  const s = await get(runner, `?t=${TOKEN}&stage=${stage}`); assert.deepEqual([s.status, s.started, s.stage], [200, true, stage]);
  const result: any = await background.pop(); const failed = (result.checks || []).filter((c: any) => !c.pass);
  assert.deepEqual(result.ok, true, `${result.stopped_at || result.message || ''}\n${failed.map((c: any) => `${c.name}\n  got  ${c.got}\n  want ${c.want}`).join('\n')}`);
  assert.deepEqual(Object.values(result.sessions).map((p: any) => [p.issued_by_auth, p.role, p.is_service_login]), [[true, 'authenticated', false], [true, 'authenticated', false], [true, 'authenticated', false]]);
  const stored = await get(runner, `?t=${TOKEN}&read=${stage}`); const last = stored.runs.at(-1); assert.deepEqual([last.ok, last.result.stage, last.result.passed, last.finished_at !== null], [true, stage, result.passed, true]);
  for (const text of [s.text, stored.text, JSON.stringify(result)]) for (const k of secrets()) assert.ok(!text.includes(k), 'no key or token in anything the runner returns or stores');
  totals[stage] = [result.passed, result.failed, result.writes_sent, result.calls];
  if (!['preflight', 'final'].includes(stage)) { const n = out.posts.length; const again = await get(runner, `?t=${TOKEN}&stage=${stage}`); assert.deepEqual([again.status, again.error], [409, 'not_started']); assert.match(again.message, /already started once/); assert.deepEqual(out.posts.length, n, 'a second start sends nothing'); }
});

Deno.test('who did what: floor rules as the signed-in login, recording as the bridge, the service login never used as a person; PSKU-000001 untouched in Nexus', opt, async () => {
  const sync = await get(runner, `?t=${TOKEN}&stage=final&wait=1`); assert.deepEqual([sync.status, sync.ok, sync.failed], [200, true, 0], 'wait=1 returns the result directly');
  assert.ok(seen.asUser.includes('test-floor:wms_move_begin') && seen.asUser.includes('test-floor:wms_release_begin') && seen.asUser.includes('test-admin:wms_nexus_resolve_record') && seen.asUser.includes('test-admin:wms_nexus_fix_begin'));
  const service = [...new Set(seen.asService)].sort(); assert.deepEqual(service, ['dev_fault_hold', 'dev_movement_snapshot', 'dev_runner_begin', 'dev_runner_finish', 'dev_runner_read', 'wms_nexus_op_commit', 'wms_nexus_op_note', 'wms_nexus_ops_pending'], 'the service login ran only the bridge\'s own three steps and the dev helpers');
  assert.ok(seen.asUser.every((x) => !x.startsWith('test-client:') || /is_wms_staff|wms_wave_start/.test(x)), 'the client login got no further than the staff check');
  assert.deepEqual(out.posts.some((p) => p.includes(KEEP.psku) || /"P-01"/.test(p)), false, 'no write to Nexus named PSKU-000001 or P-01');
  const k = (await ndb.query(`select (select count(*)::int from nexus.moves m join nexus.pallets p on p.id = m.pallet_id where p.external_id = $1) moves, (select l.code from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where p.external_id = $1) at`, [KEEP.psku])).rows[0];
  assert.deepEqual(k, { moves: 1, at: 'P-01' });
  console.log('per stage [passed, failed, writes sent, calls]:', JSON.stringify(totals));
});

Deno.test({ name: 'close', ...opt, fn: async () => { await supa.shutdown(); await ndb.end(); await db.query('drop database if exists nexus_runner_test').catch(() => {}); await db.end(); setTimeout(() => Deno.exit(0), 50); } });
