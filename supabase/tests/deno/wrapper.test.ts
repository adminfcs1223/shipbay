// The Edge Function wrapper (supabase/functions/nexus-bridge/index.ts) under the real Deno runtime.
// What is real here: Deno, index.ts exactly as it would be deployed, Deno.serve, Deno.env, real HTTP into the function,
// and ShipBay's own SQL functions in the local test database (schema + every candidate + supabase/dev/seed.sql).
// What is a stand-in: Nexus (an in-memory floor at the fixed staging address) and the REST layer in front of the database
// (a small server that runs the same functions as the signed-in user or as the bridge; it does not verify tokens).
// Nothing here reaches the network: only 127.0.0.1.
// deno-lint-ignore-file no-explicit-any
import pg from 'npm:pg@8';
import assert from 'node:assert/strict';

const db = new pg.Pool({ host: '127.0.0.1', port: 54317, user: 'postgres', database: 'staging', max: 4 });
{ const g = (await db.query(`select current_setting('cluster_name') c, (select count(*)::int from orgs where name not like 'Synthetic %') n`)).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.n !== 0) { await db.end(); throw new Error('REFUSED: not the local synthetic database'); } }
const USERS: Record<string, string> = { admin: '5b000000-0000-4000-8000-000000000001', floor: '5b000000-0000-4000-8000-000000000002', client: '5b000000-0000-4000-8000-000000000004' };
const SERVICE = 'local-service-key', ANON = 'local-anon-key', NEXUS_KEY = 'local-nexus-key-never-real';

// --- stand-in REST layer: POST /rest/v1/rpc/<fn> ---
const restCalls: string[] = [];
async function rpc(fn: string, args: Record<string, unknown>, bearer: string) {
  const c = await db.connect();
  try {
    await c.query('begin');
    if (bearer === SERVICE) await c.query('set local role service_role');
    else { const uid = USERS[bearer]; if (!uid) return { status: 401, body: { message: 'JWT invalid' } };
      await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); }
    const keys = Object.keys(args); const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    let out: unknown = null;
    try { await c.query('savepoint s'); out = (await c.query(`select to_jsonb(x) r from ${call} x`, vals)).rows[0]?.r ?? null; }
    catch (e: any) { if (!/void/.test(String(e.message))) throw e; await c.query('rollback to savepoint s'); await c.query(`select ${call}`, vals); }
    await c.query('commit'); return { status: 200, body: out };
  } catch (e: any) { await c.query('rollback').catch(() => {}); return { status: 400, body: { message: String(e.message) } }; } finally { c.release(); }
}
const rest = Deno.serve({ port: 54391, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
  const fn = new URL(req.url).pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]; if (!fn) return new Response('{}', { status: 404 });
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, ''); restCalls.push(`${bearer === SERVICE ? 'bridge' : bearer}:${fn}`);
  const r = await rpc(fn, await req.json(), bearer); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});

// --- stand-in Nexus at the fixed staging address ---
const nexus = { mode: 'up' as 'up' | 'down' | 'lost', at: new Map<string, string>(), seen: new Map<string, any>(), calls: [] as string[], keys: [] as string[], warehouse: 'HILLSBOROUGH-TEST' };
function nexusAnswer(method: string, path: string, body: any, idem: string | null, auth: string | null): { status: number; body: any } {
  if (auth !== `Bearer ${NEXUS_KEY}`) return { status: 401, body: { ok: false, error: 'unauthorized' } };
  if (method === 'GET' && path === '/v1/map') return { status: 200, body: { ok: true, warehouse: nexus.warehouse, map_version: 4, checksum: 'x', positions: [] } };
  if (method === 'GET' && path === '/v1/occupancy') { const by = new Map<string, string[]>(); for (const [p, l] of nexus.at) by.set(l, [...(by.get(l) || []), p]);
    return { status: 200, body: { ok: true, warehouse: nexus.warehouse, locations: [...by].map(([code, your_pallets]) => ({ code, your_pallets, used: your_pallets.length })) } }; }
  const kind = path.match(/^\/v1\/pallets\/(assign|move|release)$/)?.[1]; if (method !== 'POST' || !kind || !idem) return { status: 400, body: { ok: false, error: 'bad_request' } };
  nexus.keys.push(idem); if (nexus.seen.has(idem)) return { status: 200, body: { ...nexus.seen.get(idem), replayed: true } };
  const here = nexus.at.get(body.pallet); let err: string | null = null;
  if (kind === 'assign') { if (here) err = 'pallet_elsewhere'; else if ([...nexus.at.values()].includes(body.to)) err = 'location_full'; else nexus.at.set(body.pallet, body.to); }
  else if (kind === 'move') { if (!here) err = 'pallet_not_placed'; else if ([...nexus.at.values()].includes(body.to)) err = 'location_full'; else nexus.at.set(body.pallet, body.to); }
  else { if (!here) err = 'pallet_not_placed'; else nexus.at.delete(body.pallet); }
  if (err) return { status: 409, body: { ok: false, error: err } };
  const ok = { ok: true }; nexus.seen.set(idem, ok); return { status: 200, body: ok };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname !== 'ankoqruedjujyefhrmtw.supabase.co' || !url.pathname.startsWith('/functions/v1/nexus/')) throw new Error(`UNEXPECTED OUTBOUND CALL to ${url.hostname}`);
  const path = url.pathname.replace('/functions/v1/nexus', ''); nexus.calls.push(`${init.method || 'GET'} ${path}`);
  if (nexus.mode === 'down') throw new TypeError('network down');
  const h = new Headers(init.headers); const r = nexusAnswer(init.method || 'GET', path, init.body ? JSON.parse(init.body) : null, h.get('idempotency-key'), h.get('authorization'));
  if (nexus.mode === 'lost') { nexus.mode = 'up'; throw new TypeError('answer lost'); }   // Nexus applied it; the answer never arrived
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// --- the function itself, exactly as deployed ---
for (const [k, v] of Object.entries({ SUPABASE_URL: 'http://127.0.0.1:54391', SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: NEXUS_KEY,
  NEXUS_PALLET_MOVES: 'on', NEXUS_MOVES_UNTIL: new Date(Date.now() + 50 * 60000).toISOString(), NEXUS_MOVES_POSITIONS: Array.from({ length: 66 }, (_, i) => 'P-' + String(i + 1).padStart(2, '0')).concat(['STG-01', 'STG-02']).join(), BRIDGE_ALLOWED_ORIGINS: 'https://wms-dev.example.test', DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:54392' })) Deno.env.set(k, v);
await import('../../functions/nexus-bridge/index.ts');
const BASE = 'http://127.0.0.1:54392/functions/v1/nexus-bridge';
async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = BASE) {
  const r = await realFetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const text = await r.text(); return { status: r.status, headers: r.headers, ...(text ? JSON.parse(text) : {}) };
}
const pallet = async (psku: string) => (await db.query(`select p.status, l.code from wms_pallets p left join locations l on l.id = p.location_id where p.psku = $1`, [psku])).rows[0];
const total = async () => Number((await db.query('select coalesce(sum(qty), 0) n from inventory_moves')).rows[0].n);
const opt = { sanitizeResources: false, sanitizeOps: false };

Deno.test('status, CORS, sign-in: answered by the wrapper under Deno; the Nexus key never appears', opt, async () => {
  const s = await call(null, 'GET', '/status'); assert.deepEqual([s.status, s.connection, s.floor, s.pallet_moves, s.calendar_writes, s.registry_writes], [200, 'staging', 'HILLSBOROUGH-TEST', true, false, false]);
  assert.ok(!JSON.stringify(s).includes(NEXUS_KEY));
  const pre = await realFetch(BASE + '/putaway', { method: 'OPTIONS', headers: { origin: 'https://wms-dev.example.test' } }); await pre.body?.cancel(); assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [204, 'https://wms-dev.example.test']);
  const other = await realFetch(BASE + '/putaway', { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example' } }); await other.body?.cancel(); assert.deepEqual(other.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await call(null, 'POST', '/putaway', {})).status, 401); assert.deepEqual((await call('nobody', 'POST', '/putaway', {})).status, 401);
  assert.deepEqual((await call('client', 'POST', '/putaway', { psku: 'PSKU-000001', location: 'P-01' })).status, 403);
  assert.deepEqual((await call('floor', 'POST', '/putaway', 'x'.repeat(5000))).status, 400); assert.deepEqual((await call('floor', 'POST', '/putaway', '{not json')).status, 400);
  assert.deepEqual((await call('floor', 'GET', '/nope')).status, 404); assert.deepEqual(nexus.calls.filter((c) => c.startsWith('POST')).length, 0, 'none of that reached Nexus');
});

Deno.test('put-away, a lost answer, move and release run end to end through the wrapper into the real SQL', opt, async () => {
  const r = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000001', location: 'LOC-P-01' }); assert.deepEqual([r.status, r.ok, r.location, r.units_posted], [200, true, 'P-01', 100]);
  assert.deepEqual(await pallet('PSKU-000001'), { status: 'stored', code: 'P-01' }); assert.deepEqual(nexus.at.get('PSKU-000001'), 'P-01'); assert.deepEqual(await total(), 100);
  assert.ok(restCalls.includes('floor:wms_putaway_begin') && restCalls.includes('bridge:wms_nexus_op_commit'), 'rules as the user, recording as the bridge');
  const again = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000001', location: 'P-01' }); assert.deepEqual(again.status, 409); assert.match(again.message, /already put away/);
  // the path Supabase gives the function has no /functions/v1 prefix
  const held = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000003', location: 'P-09' }, {}, 'http://127.0.0.1:54392/nexus-bridge'); assert.deepEqual(held.status, 409); assert.match(held.message, /on HOLD/);
  // Nexus down: nothing stored. Answer lost after Nexus applied it: still nothing stored, and the same key finishes it.
  nexus.mode = 'down'; const down = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-02' }); assert.deepEqual([down.status, down.pending], [503, true]); assert.deepEqual((await pallet('PSKU-000002')).status, 'open');
  nexus.mode = 'lost'; const lost = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-02' }); assert.deepEqual(lost.status, 503); assert.deepEqual(nexus.at.get('PSKU-000002'), 'P-02'); assert.deepEqual((await pallet('PSKU-000002')).status, 'open');
  const k = nexus.keys.length; const done = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000002', location: 'P-02' }); assert.deepEqual([done.status, done.replayed], [200, true]);
  assert.deepEqual(new Set(nexus.keys.slice(k - 1)).size, 1, 'the retry re-sent the same Idempotency-Key'); assert.deepEqual(await pallet('PSKU-000002'), { status: 'stored', code: 'P-02' }); assert.deepEqual(await total(), 200);
  const full = await call('floor', 'POST', '/move', { psku: 'PSKU-000002', location: 'P-01' }); assert.deepEqual([full.status, full.error], [409, 'location_full']); assert.deepEqual((await pallet('PSKU-000002')).code, 'P-02');
  const mv = await call('floor', 'POST', '/move', { psku: 'PSKU-000002', location: 'P-30' }); assert.deepEqual([mv.status, mv.from, mv.location], [200, 'P-02', 'P-30']); assert.deepEqual(await total(), 200);
  assert.deepEqual((await call('floor', 'POST', '/release', { psku: 'PSKU-000002', location: 'P-30', reason: 'moved_off_shared_floor' })).status, 400);
  const forced = await call('floor', 'POST', '/release', { psku: 'PSKU-000002', location: 'P-30', reason: 'correction', confirmed: true }); assert.deepEqual(forced.status, 409); assert.match(forced.message, /admin or staff/);
  const rel = await call('floor', 'POST', '/release', { psku: 'PSKU-000002', location: 'P-30', reason: 'moved_off_shared_floor', confirmed: true }); assert.deepEqual([rel.status, rel.pallet_status], [200, 'off_floor']);
  assert.deepEqual(await pallet('PSKU-000002'), { status: 'off_floor', code: null }); assert.deepEqual(nexus.at.has('PSKU-000002'), false); assert.deepEqual(await total(), 200, 'the release deducted nothing');
});

Deno.test('reconciliation is admin work; pallet movement can be switched off without redeploying code', opt, async () => {
  const nf = await call('floor', 'GET', '/reconcile'); assert.deepEqual([nf.status, nf.error], [403, 'not_admin']);
  const rec = await call('admin', 'GET', '/reconcile'); assert.deepEqual([rec.status, rec.in_sync, rec.placed_in_nexus], [200, true, 1]);
  nexus.at.set('PSKU-GHOST', 'P-44'); const drift = await call('admin', 'GET', '/reconcile'); assert.deepEqual(drift.in_sync, false); assert.deepEqual(drift.differences.map((d: any) => [d.pallet, d.kind, d.nexus]), [['PSKU-GHOST', 'nexus_only', 'P-44']]); nexus.at.delete('PSKU-GHOST');
  // each case below is a fresh, separate Deno process running index.ts with different settings
  const env = { ...Deno.env.toObject(), DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:54393' };
  const run = async (extra: Record<string, string>, drop: string[] = []) => { const e: Record<string, string> = { ...env, ...extra }; for (const d of drop) delete e[d];
    const p = new Deno.Command(Deno.execPath(), { args: ['run', '--allow-env', '--allow-net=127.0.0.1', new URL('../../functions/nexus-bridge/index.ts', import.meta.url).pathname], env: e, clearEnv: true, stdout: 'null', stderr: 'null' }).spawn();
    for (let i = 0; i < 80; i++) { try { const s = await realFetch('http://127.0.0.1:54393/nexus-bridge/status'); const j = await s.json(); const r = await call('floor', 'POST', '/putaway', { psku: 'PSKU-000001', location: 'P-50' }, {}, 'http://127.0.0.1:54393/nexus-bridge'); p.kill(); await p.status; return { status: j, put: r }; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    p.kill(); await p.status; throw new Error('the function did not start'); };
  const before = nexus.calls.length;
  const off = await run({}, ['NEXUS_BRIDGE_MODE']); assert.deepEqual([off.status.connection, off.put.status, off.put.error], ['off', 503, 'bridge_off']);
  const prod = await run({ SUPABASE_URL: 'https://poxlczzkpztmoiixyrth.supabase.co' }); assert.deepEqual([prod.status.connection, prod.put.error], ['off', 'wrong_database']);
  const noMoves = await run({}, ['NEXUS_PALLET_MOVES']); assert.deepEqual([noMoves.status.connection, noMoves.status.pallet_moves, noMoves.put.status, noMoves.put.error], ['staging', false, 503, 'pallet_moves_off']);
  // a separate real process with no stand-in: it is only allowed to reach 127.0.0.1, so Nexus cannot answer, and nothing is stored
  const cut = await run({}); assert.deepEqual([cut.put.status, cut.put.error], [503, 'nexus_no_answer']);
  assert.deepEqual(nexus.calls.length, before, 'none of the separate processes reached the stand-in'); assert.deepEqual(await pallet('PSKU-000001'), { status: 'stored', code: 'P-01' });
});

Deno.test({ name: 'close', ...opt, fn: async () => { await rest.shutdown(); await db.end(); setTimeout(() => Deno.exit(0), 50); } });
