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
  const db = { user: () => ({ rpc: async (fn) => { rpcs.push(fn); return fn === 'is_wms_staff' ? true : { op: 'o1', kind: 'assign', pallet: 'PSKU-000040', to: 'P-12', key: 'k1' }; } }),
    service: { rpc: async (fn) => { rpcs.push(fn); return fn === 'wms_nexus_op_commit' ? { psku: 'PSKU-000040', location: 'P-12' } : null; } } };
  const fetchImpl = async (u, o) => { sent.push({ path: new URL(u).pathname, auth: o.headers.authorization, method: o.method });
    if (o.method === 'GET') return new Response('{"ok":true,"warehouse":"HILLSBOROUGH"}', { status: 200 });
    return new Response(JSON.stringify(answer), { status: answer.ok ? 200 : 409 }); };
  const run = (body) => makeBridge({ env: ENV, fetchImpl, db, routes: palletRoutes })(new Request('https://x/functions/v1/nexus-bridge/putaway', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) })).then((r) => r.json());
  const ok = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.equal(ok.ok, true); assert.equal(ok.location, 'P-12');
  assert.deepEqual(sent.map((s) => [s.method, s.auth]), [['GET', 'Bearer read'], ['POST', 'Bearer move']]);
  assert.ok(rpcs.includes('wms_putaway_begin') && rpcs.includes('wms_nexus_op_commit'));
  answer = { ok: false, error: 'location_full' };
  const full = await run({ psku: 'PSKU-000040', location: 'P-12', confirmed_clear: true });
  assert.equal(full.error, 'location_full'); assert.match(full.message, /P-12 is taken in Nexus/);
});
