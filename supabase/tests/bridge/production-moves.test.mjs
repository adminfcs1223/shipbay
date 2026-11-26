// The real floor in daily use: reads with the read key, every pallet write with the read + move key only, no time window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, makeBridge, moveAuthorization } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';
const PROD = 'https://poxlczzkpztmoiixyrth.supabase.co';
const ENV = { NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: PROD, NEXUS_PRODUCTION_READ_KEY: 'read ', NEXUS_PRODUCTION_API_KEY: ' move', NEXUS_PALLET_MOVES: 'on' };

test('keys: reads use the read key, writes the move key; no move key means no placing', () => {
  const c = readConfig(ENV); assert.equal(c.key, 'read'); assert.equal(c.moveKey, 'move'); assert.equal(c.palletMoves, true);
  const r = readConfig({ ...ENV, NEXUS_PRODUCTION_API_KEY: undefined }); assert.equal(r.ok, true); assert.equal(r.moveKey, null); assert.equal(r.palletMoves, false);
});
test('no time window on the real floor; only shared floor positions may be named', () => {
  assert.equal(moveAuthorization(ENV, Date.now, { pallet: 'PSKU-000040', positions: ['P-66', 'STG-02'] }), null);
  assert.equal(moveAuthorization(ENV, Date.now, { pallet: 'PSKU-000040', positions: ['A-01'] }).error, 'move_out_of_scope');
  assert.equal(moveAuthorization({ ...ENV, NEXUS_BRIDGE_MODE: 'staging' }, Date.now, { positions: ['P-01'] }).error, 'move_not_authorized', 'staging keeps its window');
});
test('a confirmed placement: ShipBay rules, then Nexus with the move key, then recorded; a taken position comes back in words', async () => {
  const sent = []; const rpcs = []; let answer = { ok: true };
  const db = { user: () => ({ rpc: async (fn) => { rpcs.push(fn); return fn === 'is_wms_staff' ? true : { op: 'o1', kind: 'assign', pallet: 'PSKU-000040', to: 'P-12', key: 'k1', by: 'Derek Harrison' }; } }),
    service: { rpc: async (fn) => { rpcs.push(fn); return fn === 'wms_nexus_op_commit' ? { psku: 'PSKU-000040', location: 'P-12' } : null; } } };
  const fetchImpl = async (u, o) => { sent.push({ path: new URL(u).pathname, auth: o.headers.authorization, method: o.method, body: o.body ? JSON.parse(o.body) : null });
    if (o.method === 'GET') return new Response('{"ok":true,"warehouse":"HILLSBOROUGH"}', { status: 200 });
    return new Response(JSON.stringify(answer), { status: answer.ok ? 200 : 409 }); };
  const run = (body) => makeBridge({ env: ENV, fetchImpl, db, routes: palletRoutes })(new Request('https://x/functions/v1/nexus-bridge/putaway', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) })).then((r) => r.json());
  const ok = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.equal(ok.ok, true); assert.equal(ok.location, 'P-12');
  assert.deepEqual(sent.map((s) => [s.method, s.auth]), [['GET', 'Bearer read'], ['POST', 'Bearer move']]);
  assert.ok(rpcs.includes('wms_putaway_begin') && rpcs.includes('wms_nexus_op_commit'));
  // the real floor's contract: the employee's confirmation goes to Nexus as confirmed_empty + confirmed_by
  assert.deepEqual(sent[1].body, { pallet: 'PSKU-000040', to: 'P-12', confirmed_empty: true, confirmed_by: 'Derek Harrison' });
  answer = { ok: false, error: 'location_full' };
  const full = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.equal(full.error, 'location_full'); assert.match(full.message, /P-12 is taken in Nexus/);
  answer = { ok: false, error: 'location_not_confirmed' };
  const nc = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.equal(nc.error, 'location_not_confirmed'); assert.equal(nc.nexus_http, 409); assert.equal(nc.request, 'k1'); assert.match(nc.message, /confirmation that P-12 is physically empty/);
  answer = { ok: false, error: 'something_new' };
  const un = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.match(un.message, /something_new, HTTP 409\)\. Nothing was placed\. Request k1\./);
});

test('staging floor bodies are unchanged; a release never carries a placement confirmation', async () => {
  const { nexusBody } = await import('../../functions/nexus-bridge/pallets.js');
  assert.deepEqual(nexusBody({ kind: 'assign', pallet: 'P', to: 'P-01', by: 'X Y' }, { mode: 'staging' }), { pallet: 'P', to: 'P-01' });
  assert.deepEqual(nexusBody({ kind: 'release', pallet: 'P', from: 'P-01', by: 'X Y' }, { mode: 'production' }), { pallet: 'P', from: 'P-01' });
  assert.deepEqual(nexusBody({ kind: 'move', pallet: 'P', to: 'P-02', from: 'P-01', by: '' }, { mode: 'production' }), { pallet: 'P', to: 'P-02', from: 'P-01', confirmed_empty: true, confirmed_by: 'ShipBay floor staff' });
});
