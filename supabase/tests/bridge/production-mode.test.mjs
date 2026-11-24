// The bridge's connection modes: the real floor only from the production database with the production key; the test floor never from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, REAL_FLOOR, TEST_FLOOR } from '../../functions/nexus-bridge/core.js';
const PROD = 'https://poxlczzkpztmoiixyrth.supabase.co', DEV = 'https://gdoaonsasbsperqjuurm.supabase.co';
test('production mode: production database + production key → the real floor, moves still off unless switched', () => {
  const c = readConfig({ NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: PROD, NEXUS_PRODUCTION_API_KEY: 'p' });
  assert.equal(c.ok, true); assert.equal(c.floor, REAL_FLOOR); assert.equal(c.key, 'p'); assert.equal(c.palletMoves, false); assert.equal(c.testFaults, false);
});
test('production mode refuses: another database, missing production key, the staging key alone', () => {
  assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: DEV, NEXUS_PRODUCTION_API_KEY: 'p' }).error, 'not_production_database');
  assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: PROD }).error, 'not_configured');
  assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: PROD, NEXUS_STAGING_API_KEY: 's' }).error, 'not_configured');
});
test('staging mode unchanged: test floor, never on the production database, never the production key', () => {
  const c = readConfig({ NEXUS_BRIDGE_MODE: 'staging', SUPABASE_URL: DEV, NEXUS_STAGING_API_KEY: 's', NEXUS_PRODUCTION_API_KEY: 'p' });
  assert.equal(c.floor, TEST_FLOOR); assert.equal(c.key, 's');
  assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'staging', SUPABASE_URL: PROD, NEXUS_STAGING_API_KEY: 's' }).error, 'wrong_database');
  assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'live', SUPABASE_URL: PROD }).error, 'mode_not_available');
  assert.equal(readConfig({}).error, 'bridge_off');
});

test('real floor: a placement without the employee\'s "position is empty" is refused before ShipBay or Nexus is touched', async () => {
  const { makeBridge } = await import('../../functions/nexus-bridge/core.js'); const { palletRoutes } = await import('../../functions/nexus-bridge/pallets.js');
  const calls = []; const rpcs = [];
  const db = { user: () => ({ rpc: async (fn) => { rpcs.push(fn); return fn === 'is_wms_staff' ? true : null; } }), service: { rpc: async (fn) => { rpcs.push(fn); return null; } } };
  const fetchImpl = async (u) => { calls.push(u); return new Response('{"ok":true,"warehouse":"HILLSBOROUGH"}', { status: 200 }); };
  const run = (env, path, body) => makeBridge({ env, fetchImpl, db, routes: palletRoutes })(new Request(`https://x/functions/v1/nexus-bridge${path}`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) })).then((r) => r.json());
  const PRODENV = { NEXUS_BRIDGE_MODE: 'production', SUPABASE_URL: PROD, NEXUS_PRODUCTION_API_KEY: 'p' };
  for (const path of ['/putaway', '/move']) {
    const r = await run(PRODENV, path, { psku: 'PSKU-000500', location: 'P-10' });
    assert.equal(r.error, 'location_not_confirmed', path);
  }
  assert.equal(calls.length, 0, 'Nexus not called'); assert.deepEqual(rpcs, ['is_wms_staff', 'is_wms_staff'], 'no ShipBay journal function called');
  const off = await run(PRODENV, '/putaway', { psku: 'PSKU-000500', location: 'P-10', confirmed_clear: true });
  assert.equal(off.error, 'pallet_moves_off', 'confirmed, but placing is still switched off'); assert.equal(calls.length, 0);
});
