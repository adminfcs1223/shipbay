// The function is the only thing that holds the key, so these tests are about what it will and will not do.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { makeHandler, NEXUS_HOST } from '../netlify/functions/nexus.mjs'; import { makeStub } from './stub-nexus.mjs';
const PASS = 'preview-passcode-123'; const here = path.dirname(new URL(import.meta.url).pathname);
const setup = (stubOpts, env) => { const stub = makeStub(stubOpts); const handle = makeHandler({ env: env ?? { NEXUS_STAGING_API_KEY: stub.key, PREVIEW_PASSCODE: PASS }, fetchImpl: stub.fetchImpl }); return { stub, handle }; };
const call = async (handle, method, p, { pass = PASS, body, headers } = {}) => { const res = await handle(new Request('https://dev.example.test/api/nexus' + p, { method, headers: { ...(pass ? { 'x-preview-passcode': pass } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })); return { status: res.status, data: await res.json(), text: JSON.stringify([...res.headers]) }; };
const T = '2026-11-24T15:00:00.000Z';

test('without its secrets the function does nothing and says so', async () => {
  const { stub, handle } = setup({}, {});
  assert.deepEqual((await call(handle, 'GET', '/status', { pass: null })).data, { ok: true, ready: false, target: 'nexus-staging', floor: 'HILLSBOROUGH-TEST', pallet_operations: 'disabled' });
  assert.equal((await call(handle, 'GET', '/map')).status, 503); assert.equal(stub.calls.length, 0);
});
test('no passcode, a wrong passcode, or a passcode in the address: refused before Nexus is called', async () => {
  const { stub, handle } = setup();
  assert.equal((await call(handle, 'GET', '/map', { pass: null })).status, 401); assert.equal((await call(handle, 'GET', '/map', { pass: 'wrong' })).status, 401);
  assert.equal((await call(handle, 'GET', '/map?passcode=' + PASS, { pass: null })).status, 400); assert.equal((await call(handle, 'GET', '/map?api_key=x')).status, 400);
  assert.equal(stub.calls.length, 0);
});
test('map, occupancy, feed and calendar reads go to the staging host with the key in the header, and the key never comes back', async () => {
  const { stub, handle } = setup();
  const map = await call(handle, 'GET', '/map'); assert.equal(map.status, 200);
  assert.equal(map.data.positions.filter((p) => p.kind === 'pallet').length, 66); assert.equal(map.data.positions.filter((p) => p.kind === 'staging').length, 2);
  assert.equal((await call(handle, 'GET', '/occupancy')).data.locations.length, 69);
  assert.equal((await call(handle, 'GET', '/changes?after=0&limit=50')).status, 200);
  assert.equal((await call(handle, 'GET', `/calendar?from=${encodeURIComponent(T)}&to=${encodeURIComponent('2026-12-24T15:00:00Z')}`)).status, 200);
  assert.equal((await call(handle, 'GET', '/health')).data.service, 'nexus');
  for (const c of stub.calls) { assert.equal(c.host, NEXUS_HOST); assert.ok(c.url.startsWith(`https://${NEXUS_HOST}/functions/v1/nexus/v1/`)); assert.ok(!c.url.includes(stub.key)); }
  assert.ok(stub.calls.filter((c) => c.path !== '/v1/health').every((c) => c.headers.authorization === `Bearer ${stub.key}`));
  assert.equal(stub.calls.find((c) => c.path === '/v1/health').headers.authorization, undefined);
  for (const r of [map, await call(handle, 'GET', '/occupancy')]) assert.ok(!JSON.stringify(r.data).includes(stub.key) && !r.text.includes(stub.key));
});
test('only whitelisted values reach Nexus', async () => {
  const { stub, handle } = setup();
  assert.equal((await call(handle, 'GET', '/changes?after=abc')).status, 400); assert.equal((await call(handle, 'GET', '/changes?limit=5000')).status, 400);
  assert.equal((await call(handle, 'GET', '/calendar?from=yesterday&to=' + T)).status, 400); assert.equal(stub.calls.length, 0);
  await call(handle, 'GET', '/changes?after=7&limit=20&extra=1&pallet=X'); const c = stub.calls.at(-1); assert.equal(c.search, '?after=7&limit=20');
});
test('pallet assign, move and release are refused here and never sent', async () => {
  const { stub, handle } = setup();
  for (const [m, p] of [['POST', '/pallets/assign'], ['POST', '/pallets/move'], ['POST', '/pallets/release'], ['GET', '/pallets/assign'], ['PUT', '/calendar/../pallets/assign'], ['POST', '/v1/pallets/assign'], ['GET', '/moves?pallet=X']]) {
    const r = await call(handle, m, p, { body: m === 'GET' ? undefined : { pallet: 'PSKU-1', to: 'P-01' } }); assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await call(handle, 'POST', '/calendar/DEV-1', { body: {} })).status, 405); assert.equal((await call(handle, 'PATCH', '/map')).status, 405);
  assert.equal((await call(handle, 'GET', '/anything-else')).status, 404); assert.equal(stub.calls.length, 0);
});
test('calendar writes: synthetic ids only, fixed fields only, reference and note set by the function', async () => {
  const { stub, handle } = setup();
  assert.equal((await call(handle, 'PUT', '/calendar/PO-111126', { body: { direction: 'inbound', starts_at: T } })).status, 400);
  assert.equal((await call(handle, 'DELETE', '/calendar/VERIFY-1')).status, 400);
  assert.equal((await call(handle, 'PUT', '/calendar/DEV-A1', { body: { direction: 'sideways', starts_at: T } })).status, 400);
  assert.equal((await call(handle, 'PUT', '/calendar/DEV-A1', { body: { direction: 'inbound', starts_at: T, pallets: 9999 } })).status, 400);
  assert.equal(stub.calls.length, 0);
  const put = await call(handle, 'PUT', '/calendar/DEV-A1', { body: { direction: 'inbound', starts_at: T, pallets: 6, status: 'scheduled', reference: 'VM135 real PO', note: 'customer name', company: 'SOULED', warehouse: 'HILLSBOROUGH' } });
  assert.equal(put.status, 200); const sent = stub.calls.at(-1);
  assert.deepEqual(sent.body, { direction: 'inbound', starts_at: T, pallets: 6, status: 'scheduled', reference: 'SYNTHETIC', note: 'ShipBay development preview' });
  assert.equal(sent.m, 'PUT'); assert.equal(sent.path, '/v1/calendar/DEV-A1'); assert.equal(stub.calls.at(-2).path, '/v1/map', 'the floor is confirmed before the first write');
  assert.equal((await call(handle, 'DELETE', '/calendar/DEV-A1')).status, 200); assert.equal(stub.events.get('DEV-A1').status, 'cancelled');
  assert.equal(stub.calls.filter((c) => c.path === '/v1/map').length, 1, 'the floor check is remembered for a few minutes');
});
test('a key that turns out to be bound to the live floor shows nothing and writes nothing', async () => {
  const { stub, handle } = setup({ test: false, warehouse: 'HILLSBOROUGH' });
  const map = await call(handle, 'GET', '/map'); assert.equal(map.status, 502); assert.equal(map.data.error, 'not_the_test_floor'); assert.equal(map.data.positions, undefined);
  assert.equal((await call(handle, 'GET', '/occupancy')).status, 502); assert.equal((await call(handle, 'GET', '/changes')).status, 502);
  assert.equal((await call(handle, 'PUT', '/calendar/DEV-B1', { body: { direction: 'inbound', starts_at: T } })).status, 502);
  assert.equal(stub.calls.filter((c) => c.m !== 'GET').length, 0);
});
test('Nexus down: a plain refusal, no cause passed on, no key in the answer', async () => {
  const handle = makeHandler({ env: { NEXUS_STAGING_API_KEY: 'stub-staging-key-0123456789', PREVIEW_PASSCODE: PASS }, fetchImpl: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1 Bearer stub-staging-key-0123456789'); } });
  const r = await call(handle, 'GET', '/map'); assert.equal(r.status, 502); assert.equal(r.data.error, 'nexus_unreachable'); assert.ok(!JSON.stringify(r.data).includes('stub-staging') && !JSON.stringify(r.data).includes('ECONN'));
});
test('nothing the browser loads names the key, the Nexus host or an Authorization header', () => {
  for (const f of fs.readdirSync(path.join(here, '../public'))) { const s = fs.readFileSync(path.join(here, '../public', f), 'utf8');
    for (const bad of ['NEXUS_STAGING_API_KEY', NEXUS_HOST, 'supabase', 'Bearer', 'authorization']) assert.ok(!s.toLowerCase().includes(bad.toLowerCase()), `${f} mentions ${bad}`); }
  const fn = fs.readFileSync(path.join(here, '../netlify/functions/nexus.mjs'), 'utf8'); assert.ok(!/console\.(log|info|warn|error|debug)/.test(fn), 'the function logs nothing');
});
