// The ShipBay bridge against the Nexus integration handoff (nexus commit a465b55, neutral/INTEGRATION-HANDOFF.md, the short
// form of MVP-CONTRACT.md at 663767e). Drives the REAL bridge code (supabase/functions/nexus-bridge/core.js + pallets.js)
// with a scripted Nexus and a recording stand-in for ShipBay's database, so every answer the contract lists can be given,
// including ones a live Nexus cannot easily be made to give. Nothing here reaches Nexus or any database.
// Run: node --test supabase/tests/bridge/contract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBridge } from '../../functions/nexus-bridge/core.js';
import { palletRoutes } from '../../functions/nexus-bridge/pallets.js';

const ENV = { NEXUS_BRIDGE_MODE: 'staging', NEXUS_PALLET_MOVES: 'on', NEXUS_MOVES_UNTIL: new Date(Date.now() + 50 * 60000).toISOString(), NEXUS_MOVES_POSITIONS: Array.from({ length: 66 }, (_, i) => 'P-' + String(i + 1).padStart(2, '0')).concat(['STG-01', 'STG-02']).join(), NEXUS_STAGING_API_KEY: 'test-key', SUPABASE_URL: 'https://gdoaonsasbsperqjuurm.supabase.co' };
const OPS = {
  wms_putaway_begin: { op: 'op-a', kind: 'assign', pallet: 'PSKU-000777', to: 'P-50', from: null, key: 'SB-ASSIGN-1' },
  wms_move_begin: { op: 'op-m', kind: 'move', pallet: 'PSKU-000777', to: 'P-51', from: 'P-50', key: 'SB-MOVE-1' },
  wms_release_begin: { op: 'op-r', kind: 'release', pallet: 'PSKU-000777', to: null, from: 'P-51', key: 'SB-RELEASE-1' },
};

function rig(answer, { commitFails = false, pending = [] } = {}) {
  const sent = [], service = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace(/^.*\/functions\/v1\/nexus/, '');
    if (init.method === 'GET' && path === '/v1/map') return new Response(JSON.stringify({ ok: true, warehouse: 'HILLSBOROUGH-TEST' }), { status: 200 });
    sent.push({ path, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const a = typeof answer === 'function' ? answer(sent.length) : answer;
    if (a === 'timeout') throw new Error('aborted');
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  const db = {
    user: () => ({ rpc: async (fn) => (fn === 'is_wms_staff' ? true : OPS[fn]) }),
    service: { rpc: async (fn, args) => { service.push({ fn, args }); if (fn === 'wms_nexus_op_commit' && commitFails) throw new Error('pallet on hold'); if (fn === 'wms_nexus_ops_pending') return pending; return { pallet: 'PSKU-000777', location: 'P-50' }; } },
  };
  const bridge = makeBridge({ env: ENV, fetchImpl, db, routes: palletRoutes });
  const call = async (path, body) => { const r = await bridge(new Request(`https://x/functions/v1/nexus-bridge${path}`, { method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  return { sent, service, call };
}
const putaway = (r) => r.call('/putaway', { psku: 'PSKU-000777', location: 'P-50' });
const move = (r) => r.call('/move', { psku: 'PSKU-000777', location: 'P-51' });
const release = (r) => r.call('/release', { psku: 'PSKU-000777', location: 'P-51', confirmed: true, reason: 'shipped out' });
const ok = (extra = {}) => ({ status: 200, body: { ok: true, pallet: 'PSKU-000777', location: 'P-50', free: 0, seq: 9, ...extra } });

test('requests: assign {pallet,to}; move {pallet,to,from}; release {pallet,from}; key and Idempotency-Key on every POST', async () => {
  for (const [go, path, body, key] of [[putaway, '/v1/pallets/assign', { pallet: 'PSKU-000777', to: 'P-50' }, 'SB-ASSIGN-1'],
    [move, '/v1/pallets/move', { pallet: 'PSKU-000777', to: 'P-51', from: 'P-50' }, 'SB-MOVE-1'],
    [release, '/v1/pallets/release', { pallet: 'PSKU-000777', from: 'P-51' }, 'SB-RELEASE-1']]) {
    const r = rig(ok()); await go(r);
    assert.equal(r.sent.length, 1); assert.equal(r.sent[0].path, path); assert.deepEqual(r.sent[0].body, body);
    assert.equal(r.sent[0].headers['idempotency-key'], key); assert.equal(r.sent[0].headers.authorization, 'Bearer test-key');
  }
});

test('200: recorded in ShipBay once, only after Nexus says yes; a replayed 200 is recorded idempotently and reported as replayed', async () => {
  let r = rig(ok()); let a = await putaway(r);
  assert.equal(a.status, 200); assert.equal(a.body.ok, true); assert.equal(a.body.replayed, false);
  assert.deepEqual(r.service.map((s) => s.fn), ['wms_nexus_op_commit']);
  r = rig(ok({ replayed: true })); a = await putaway(r);
  assert.equal(a.body.replayed, true); assert.deepEqual(r.service.map((s) => s.fn), ['wms_nexus_op_commit']);
});

const REFUSALS = [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'location_not_found'], [404, 'pallet_not_found'],
  [409, 'location_full'], [409, 'location_not_a_destination'], [409, 'location_blocked'], [409, 'location_unavailable'], [409, 'pallet_elsewhere'],
  [409, 'pallet_not_placed'], [409, 'already_there'], [409, 'idempotency_key_reused'], [423, 'occupancy_not_initialized'], [409, 'a_code_nobody_has_seen']];
test('every refusal in the handoff table (and an unknown code): nothing recorded as placed; journal row refused with the code; floor gets the code', async () => {
  for (const [status, error] of REFUSALS) {
    const r = rig({ status, body: { ok: false, error, message: 'Nexus words, not passed on' } }); const a = await move(r);
    assert.equal(a.status, status, error); assert.equal(a.body.ok, false); assert.equal(a.body.error, error);
    assert.ok(!r.service.some((s) => s.fn === 'wms_nexus_op_commit'), `${error}: committed`);
    assert.deepEqual(r.service.find((s) => s.fn === 'wms_nexus_op_note').args, { p_op: 'op-m', p_state: 'refused', p_http: status, p_error: error });
    assert.ok(!/Nexus words/.test(a.body.message), `${error}: Nexus's message passed to the floor`);
  }
});

test('no answer (timeout, 503 unavailable, 500, 429): nothing recorded; journal stays pending with the same key; a retry resends the identical request with the same key', async () => {
  for (const ans of ['timeout', { status: 503, body: { ok: false, error: 'unavailable' } }, { status: 500, body: { ok: false } }, { status: 429, body: { ok: false } }]) {
    const r = rig(ans); const a = await move(r);
    assert.equal(a.status, 503); assert.equal(a.body.error, 'nexus_no_answer'); assert.equal(a.body.pending, true);
    assert.ok(!r.service.some((s) => s.fn === 'wms_nexus_op_commit'));
    assert.equal(r.service.find((s) => s.fn === 'wms_nexus_op_note').args.p_state, 'pending');
  }
  // the retry run (POST /pending/retry) takes the pending rows from the journal and sends each again, unchanged, with its own key
  const r = rig((n) => (n === 1 ? 'timeout' : ok({ replayed: true })), { pending: [OPS.wms_move_begin] });
  await move(r); const again = await r.call('/pending/retry', {});
  assert.equal(r.sent.length, 2); assert.deepEqual(r.sent[1].body, r.sent[0].body); assert.equal(r.sent[1].headers['idempotency-key'], r.sent[0].headers['idempotency-key']);
  assert.equal(again.body.ok, true); assert.ok(r.service.some((s) => s.fn === 'wms_nexus_op_commit'));
});

test('Nexus says yes but ShipBay cannot record it: the position stays reserved in Nexus, the row is out of sync, nothing is released automatically', async () => {
  const r = rig(ok(), { commitFails: true }); const a = await putaway(r);
  assert.equal(a.status, 409); assert.equal(a.body.error, 'out_of_sync');
  assert.equal(r.service.find((s) => s.fn === 'wms_nexus_op_note').args.p_state, 'out_of_sync');
  assert.equal(r.sent.length, 1);   // no release or compensating call was sent
});
