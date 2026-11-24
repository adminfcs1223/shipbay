// "View as client" guard: every request an admin's browser makes while viewing a brand must be limited to that brand.
// Run: node --test portal/test/view-guard.test.mjs   (no network)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewGuard, setViewAsOrg } from '../src/viewGuard.js';

const B = 'https://stub.supabase.co';
const MAILERS = '5a000000-0000-4000-8000-0000000000a2', RECORDS = '5a000000-0000-4000-8000-0000000000a1';
const calls = [];
const fake = (rows = []) => async (input, init) => { calls.push({ url: String(input), method: init?.method || 'GET' }); return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const go = (path, init = {}, rows) => { calls.length = 0; return viewGuard(B + path, init, fake(rows)); };
const sent = () => calls.length ? new URL(calls[0].url) : null;

test('off: requests pass untouched', async () => {
  setViewAsOrg(null);
  const r = await go('/rest/v1/v_orders_queue?select=*');
  assert.equal(r.status, 200); assert.equal(sent().searchParams.get('org_id'), null);
});

test('org-scoped views and tables are narrowed to the brand (rows and counts)', async () => {
  setViewAsOrg(MAILERS);
  for (const t of ['v_orders_queue', 'orders', 'shipments', 'skus', 'inventory_levels', 'inventory_moves', 'wms_pallets', 'v_open_queue', 'v_daily_ops', 'v_org_month']) {
    const r = await go(`/rest/v1/${t}?select=*`);
    assert.equal(r.status, 200, t); assert.deepEqual(sent().searchParams.getAll('org_id'), [`eq.${MAILERS}`], t);
  }
  const h = await go('/rest/v1/skus?select=id&active=eq.true', { method: 'HEAD' });
  assert.equal(h.status, 200); assert.deepEqual(sent().searchParams.getAll('org_id'), [`eq.${MAILERS}`]);
});

test('a read naming another brand is refused, not widened', async () => {
  setViewAsOrg(MAILERS);
  const r = await go(`/rest/v1/orders?select=*&org_id=eq.${RECORDS}`);
  assert.equal(r.status, 403); assert.equal(calls.length, 0);
  const r2 = await go(`/rest/v1/orders?select=*&org_id=in.(${MAILERS},${RECORDS})`);
  assert.equal(r2.status, 403); assert.equal(calls.length, 0);
  const ok = await go(`/rest/v1/orders?select=*&org_id=eq.${MAILERS}`);
  assert.equal(ok.status, 200); assert.deepEqual(sent().searchParams.getAll('org_id'), [`eq.${MAILERS}`]);
});

test('orgs: only the brand itself', async () => {
  setViewAsOrg(MAILERS);
  assert.equal((await go('/rest/v1/orgs?select=*')).status, 200); assert.deepEqual(sent().searchParams.getAll('id'), [`eq.${MAILERS}`]);
  assert.equal((await go(`/rest/v1/orgs?select=*&id=eq.${RECORDS}`)).status, 403);
});

test('order lines: only for an order this view was shown', async () => {
  setViewAsOrg(MAILERS);
  const mine = '11111111-1111-4111-8111-111111111111', theirs = '22222222-2222-4222-8222-222222222222';
  assert.equal((await go(`/rest/v1/order_lines?select=*&order_id=eq.${mine}`)).status, 403, 'not shown yet');
  await go('/rest/v1/v_orders_queue?select=*', {}, [{ id: mine, org_id: MAILERS }]);
  assert.equal((await go(`/rest/v1/order_lines?select=*&order_id=eq.${mine}`)).status, 200);
  assert.equal((await go(`/rest/v1/order_lines?select=*&order_id=eq.${theirs}`)).status, 403);
  assert.equal((await go('/rest/v1/order_lines?select=*')).status, 403, 'no order named');
  assert.equal((await go(`/rest/v1/order_lines?select=*&order_id=in.(${mine},${theirs})`)).status, 403);
  setViewAsOrg(RECORDS);
  assert.equal((await go(`/rest/v1/order_lines?select=*&order_id=eq.${mine}`)).status, 403, 'forgotten on brand switch');
});

test('unknown tables, writes, functions and other RPCs are refused', async () => {
  setViewAsOrg(MAILERS);
  for (const t of ['locations', 'wms_wave_tasks', 'nexus_clients', 'some_new_view']) assert.equal((await go(`/rest/v1/${t}?select=*`)).status, 403, t);
  assert.equal((await go('/rest/v1/orders', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await go('/rest/v1/orders?id=eq.x', { method: 'PATCH', body: '{}' })).status, 403);
  assert.equal((await go('/rest/v1/rpc/ship_order', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await go('/rest/v1/rpc/wms_stock_summary', { method: 'POST', body: JSON.stringify({ p_org: MAILERS }) })).status, 403);
  assert.equal((await go('/functions/v1/labels', { method: 'POST', body: '{}' })).status, 403);
  assert.equal(calls.length, 0);
});

test('read-only RPC only for the viewed brand', async () => {
  setViewAsOrg(MAILERS);
  assert.equal((await go('/rest/v1/rpc/wms_org_connector', { method: 'POST', body: JSON.stringify({ p_org: MAILERS }) })).status, 200);
  assert.equal((await go('/rest/v1/rpc/wms_org_connector', { method: 'POST', body: JSON.stringify({ p_org: RECORDS }) })).status, 403);
});

test('stored files only under the brand folder', async () => {
  setViewAsOrg(MAILERS);
  assert.equal((await go(`/storage/v1/object/sign/client-docs/${MAILERS}/w9/a.pdf`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await go(`/storage/v1/object/sign/client-docs/${RECORDS}/w9/a.pdf`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await go(`/storage/v1/object/sign/client-docs/${MAILERS}/../${RECORDS}/a.pdf`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await go(`/storage/v1/object/client-docs/${MAILERS}/x.pdf`, { method: 'POST', body: 'x' })).status, 403, 'upload');
});
