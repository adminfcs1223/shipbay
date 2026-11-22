// The bridge's database port and its settings, without a database or a network.
import test from 'node:test'; import assert from 'node:assert/strict';
import { postgrest } from '../../supabase/functions/nexus-bridge/postgrest.js';
import { readConfig, makeBridge, STAGING_HOST } from '../../supabase/functions/nexus-bridge/core.js';

test('database port: the user\'s own token for user calls, the service key only for bridge calls, database messages passed on, function names checked', async () => {
  const seen = []; const fetchImpl = async (url, init) => { seen.push({ url, h: init.headers, body: init.body }); return url.endsWith('/boom') ? new Response(JSON.stringify({ message: 'P-01 already holds a ShipBay pallet.' }), { status: 400 }) : new Response('{"op":"1"}', { status: 200 }); };
  const db = postgrest({ url: 'https://dev.example.test', anonKey: 'ANON', serviceKey: 'SERVICE', fetchImpl });
  assert.deepEqual(await db.user('USERTOKEN').rpc('wms_putaway_begin', { p_psku: 'A', p_location: 'P-01' }), { op: '1' }); await db.service.rpc('wms_nexus_op_commit', { p_op: '1' });
  assert.deepEqual(seen.map((s) => [s.url, s.h.apikey, s.h.authorization]), [['https://dev.example.test/rest/v1/rpc/wms_putaway_begin', 'ANON', 'Bearer USERTOKEN'], ['https://dev.example.test/rest/v1/rpc/wms_nexus_op_commit', 'SERVICE', 'Bearer SERVICE']]);
  await assert.rejects(db.user('T').rpc('boom', {}), /already holds a ShipBay pallet/); await assert.rejects(db.user('T').rpc('x; drop table y', {}), /bad function name/);
});
test('settings: off unless set to staging; the Nexus address is fixed and cannot be set from outside; both write switches default to off', () => {
  assert.equal(readConfig({}).error, 'bridge_off'); assert.equal(readConfig({ NEXUS_BRIDGE_MODE: 'production', NEXUS_STAGING_API_KEY: 'k' }).error, 'mode_not_available');
  const c = readConfig({ NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: 'k', NEXUS_BASE: 'https://evil.example', NEXUS_HOST: 'evil.example' });
  assert.equal(c.base, `https://${STAGING_HOST}/functions/v1/nexus`); assert.deepEqual([c.palletMoves, c.calendarWrites, c.floor], [false, false, 'HILLSBOROUGH-TEST']);
});
test('browser access: only listed origins get an answer they can read; an unknown path is 404 after sign-in', async () => {
  const db = { user: () => ({ rpc: async () => true }), service: { rpc: async () => null } };
  const h = makeBridge({ env: { NEXUS_BRIDGE_MODE: 'staging', NEXUS_STAGING_API_KEY: 'k', BRIDGE_ALLOWED_ORIGINS: 'https://wms-dev.example.test' }, fetchImpl: async () => { throw new Error('no network in this test'); }, db, routes: [] });
  const pre = (o) => h(new Request('https://x.test/functions/v1/nexus-bridge/putaway', { method: 'OPTIONS', headers: { origin: o } }));
  assert.equal((await pre('https://wms-dev.example.test')).headers.get('access-control-allow-origin'), 'https://wms-dev.example.test'); assert.equal((await pre('https://elsewhere.example')).headers.get('access-control-allow-origin'), null);
  const r = await h(new Request('https://x.test/functions/v1/nexus-bridge/anything', { headers: { authorization: 'Bearer t' } })); assert.equal(r.status, 404);
});
