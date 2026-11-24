// The store sync against orders the warehouse has started on (ShipBay MVP sprint, 2026-11-24). Runs the REAL shared sync code
// (supabase/functions/_shared/veeqo_orders.ts and shopify_orders.ts) under Deno, as the service login, through a LOCAL
// PostgREST in front of the local test database (wms/test/corrections-e2e/stack.mjs). Nothing here reaches Veeqo or Shopify:
// the order payloads are written below. Run with supabase/tests/deno/run-sync.sh.
import { createClient } from 'npm:@supabase/supabase-js@2';
import assert from 'node:assert/strict';
import { upsertVeeqoOrder } from '../../functions/_shared/veeqo_orders.ts';
import { upsertShopifyOrder } from '../../functions/_shared/shopify_orders.ts';

const session = JSON.parse(await Deno.readTextFile(Deno.env.get('SESSION')!));
const URL_ = 'http://127.0.0.1:54331';
const service = createClient(URL_, session.keys.service, { auth: { persistSession: false } });
const as = (who: string) => createClient(URL_, session.keys.anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${session.keys[who]}` } } });
const org = session.org as string;
const lines = async (id: string) => ((await service.from('order_lines').select('sku, qty, qty_verified').eq('order_id', id).order('sku')).data ?? []);
const order = async (id: string) => (await service.from('orders').select('status, customer_name, total_units, ship_to').eq('id', id).single()).data;

const veeqo = (over: any) => ({
  id: 990001, number: 'VQ-MVP-1', status: 'awaiting_fulfillment', created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-24T10:00:00Z',
  deliver_to: { first_name: 'Vee', last_name: 'Queue', address1: '1 Test St', city: 'Newark', state: 'NJ', zip: '07102', country: 'US' },
  customer: { email: 'vq@example.test' }, channel: { name: 'Test store', type_code: 'shopify' },
  line_items: [{ id: 1, quantity: 2, sellable: { sku_code: 'MVP-VQ', product_title: 'Veeqo test product' } }], ...over });

Deno.test('Veeqo: a retry changes nothing, a stale event is ignored, a newer event updates an order nobody has started on', async () => {
  const a = await upsertVeeqoOrder(service, org, veeqo({}));
  assert.equal(a.created, true);
  const b = await upsertVeeqoOrder(service, org, veeqo({}));                       // the same event again
  assert.equal(b.created, false); assert.equal(b.id, a.id); assert.equal(b.skipped, undefined);
  assert.deepEqual((await lines(a.id)).map((l) => [l.sku, l.qty]), [['MVP-VQ', 2]]);
  const c = await upsertVeeqoOrder(service, org, veeqo({ updated_at: '2026-11-24T09:00:00Z', line_items: [{ id: 1, quantity: 9, sellable: { sku_code: 'MVP-VQ' } }] }));
  assert.equal(c.skipped, 'stale');
  assert.deepEqual((await lines(a.id)).map((l) => [l.sku, l.qty]), [['MVP-VQ', 2]]);
  const d = await upsertVeeqoOrder(service, org, veeqo({ updated_at: '2026-11-24T11:00:00Z', line_items: [{ id: 1, quantity: 3, sellable: { sku_code: 'MVP-VQ' } }] }));
  assert.equal(d.skipped, undefined);
  assert.deepEqual((await lines(a.id)).map((l) => [l.sku, l.qty]), [['MVP-VQ', 3]]);
});

Deno.test('Veeqo: once the warehouse has verified the order, a cancel or edit from Veeqo changes nothing and is reported', async () => {
  const id = (await service.from('orders').select('id').eq('org_id', org).eq('veeqo_order_id', 990001).single()).data!.id;
  const admin = as('admin');
  for (let i = 0; i < 3; i++) { const r = await admin.rpc('scan_pack', { p_order_id: id, p_code: 'MVP-VQ', p_qty: 1 }); assert.equal(r.error, null, String(r.error?.message)); }
  const before = await order(id); assert.equal(before!.status, 'packed');
  const e = await upsertVeeqoOrder(service, org, veeqo({ status: 'cancelled', updated_at: '2026-11-24T12:00:00Z', deliver_to: { first_name: 'Some', last_name: 'One Else', country: 'US' }, line_items: [] }));
  assert.equal(e.skipped, 'in_warehouse'); assert.equal(e.order_number, 'VQ-MVP-1'); assert.equal(e.veeqo_status, 'cancelled');
  assert.deepEqual(await order(id), before);
  assert.deepEqual((await lines(id)).map((l) => [l.sku, l.qty, l.qty_verified]), [['MVP-VQ', 3, 3]]);
  // and the database refuses the same change even if a sync went around the check
  const raw = await service.from('orders').update({ status: 'cancelled' }).eq('id', id);
  assert.match(String(raw.error?.message), /store sync cannot change its status/);
  const del = await service.from('order_lines').delete().eq('order_id', id);
  assert.match(String(del.error?.message), /store sync cannot change its lines|line with pick, pack, wave or shipment history cannot be deleted/);
  assert.deepEqual(await order(id), before);
});

const shop = (over: any) => ({
  id: 880001, name: '#MVP1001', email: 'shop@example.test', created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-24T10:00:00Z', financial_status: 'paid', fulfillment_status: null,
  shipping_address: { name: 'Shop Buyer', address1: '2 Test St', city: 'Newark', province_code: 'NJ', zip: '07102', country_code: 'US' },
  line_items: [{ id: 77, sku: 'MVP-SH', title: 'Shopify test product', variant_title: null, quantity: 1, requires_shipping: true, variant_id: 5501, product_id: 4401 }], ...over });

Deno.test('Shopify: stale and in-warehouse events are skipped the same way', async () => {
  const a = await upsertShopifyOrder(service, org, shop({}));
  assert.equal(a.created, true);
  const s = await upsertShopifyOrder(service, org, shop({ updated_at: '2026-11-24T08:00:00Z', shipping_address: { name: 'Stale Name', country_code: 'US' } }));
  assert.equal(s.skipped, 'stale'); assert.equal((await order(a.id))!.customer_name, 'Shop Buyer');
  const r = await as('admin').rpc('scan_pack', { p_order_id: a.id, p_code: 'MVP-SH', p_qty: 1 }); assert.equal(r.error, null, String(r.error?.message));
  const before = await order(a.id); assert.equal(before!.status, 'packed');
  const c = await upsertShopifyOrder(service, org, shop({ updated_at: '2026-11-24T13:00:00Z', cancelled_at: '2026-11-24T13:00:00Z', line_items: [] }), 'orders/cancelled');
  assert.equal(c.skipped, 'in_warehouse');
  assert.deepEqual(await order(a.id), before);
});
