// The MVP order path through the API exactly as the screens call it (ShipBay MVP sprint, 2026-11-24): real signed-in tokens
// against a LOCAL PostgREST (wms/test/corrections-e2e/stack.mjs) in front of the local test database with every candidate.
// Portal Pack & Ship: create_manual_order. WMS Orders: wms_wave_start / wms_wave_confirm / wms_wave_to_pack / wms_wave_pack.
// Portal "Mark shipped": the labels Edge Function's manual action, which calls ship_order with the user's own token, label
// source 'manual' and the chosen box name; replayed here call for call. Client portal: the brand's stock summary.
// Staging: stage-mvp-http.sql (20 units of MVP-H stored at P-50). Run with supabase/tests/deno/run-sync.sh.
import { createClient } from 'npm:@supabase/supabase-js@2';
import assert from 'node:assert/strict';

const session = JSON.parse(await Deno.readTextFile(Deno.env.get('SESSION')!));
const as = (who: string) => createClient('http://127.0.0.1:54331', session.keys.anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${session.keys[who]}` } } });
const admin = as('admin'), staff = as('staff'), floor = as('floor'), client = as('client'), anon = as('anon'), forged = as('forged');
const org = session.org as string, org2 = session.org2 as string;
const must = <T>(r: { data: T; error: any }, what: string): T => { assert.equal(r.error, null, `${what}: ${r.error?.message}`); return r.data; };
const summary = async (who: any, brand = org) => must(await who.rpc('wms_stock_summary', { p_org: brand }), 'summary') as any;
const product = (s: any) => s.products.find((p: any) => p.sku === 'MVP-H');

Deno.test('manual order -> wave pick -> pack -> Mark shipped -> reconcile, over the API', async () => {
  const sku = must(await admin.from('skus').select('id').eq('org_id', org).eq('sku', 'MVP-H').single(), 'sku') as any;
  assert.equal(product(await summary(admin)).available, 20);
  // portal Pack & Ship: two orders of 8 and one of 8 more than is free (24 asked, 20 on hand)
  const ids: string[] = [];
  for (const n of ['MVP-H1', 'MVP-H2', 'MVP-H3']) ids.push(must(await admin.rpc('create_manual_order', { p_org_id: org, p_order: { order_number: n, ship_to: { name: n, country_code: 'US' } }, p_lines: [{ sku_id: sku.id, qty: 8 }] }), n) as string);
  assert.match(String((await admin.rpc('create_manual_order', { p_org_id: org, p_order: { order_number: 'MVP-H1' }, p_lines: [{ sku_id: sku.id, qty: 1 }] })).error?.message), /already used/);
  assert.match(String((await client.rpc('create_manual_order', { p_org_id: org, p_order: {}, p_lines: [{ sku_id: sku.id, qty: 1 }] })).error?.message), /Only ShipBay admin or staff/);
  // WMS: the floor login's wave takes the orders the stock covers, one stop at P-50
  const w = must(await floor.rpc('wms_wave_start', { p_org: org }), 'wave start') as any;
  const wave = w.wave; assert.ok(wave, JSON.stringify(w));
  const mine = wave.orders.map((o: any) => o.order_number).filter((n: string) => n.startsWith('MVP-H')).sort();
  assert.deepEqual(mine, ['MVP-H1', 'MVP-H2']);
  assert.ok(w.short.some((s: any) => s.order_number === 'MVP-H3'));
  const stop = wave.tasks.find((t: any) => t.sku === 'MVP-H'); assert.equal(stop.location, 'P-50'); assert.equal(stop.qty_planned, 16);
  assert.match(String((await floor.rpc('wms_wave_confirm', { p_task: stop.id, p_qty: 16, p_scan: 'WRONG' })).error?.message), /barcode/);
  must(await floor.rpc('wms_wave_confirm', { p_task: stop.id, p_qty: 16, p_scan: 'MVP-H-BC' }), 'confirm');
  assert.match(String((await floor.rpc('wms_wave_confirm', { p_task: stop.id, p_qty: 16, p_scan: 'MVP-H-BC' })).error?.message), /already confirmed/);
  for (const t of wave.tasks.filter((t: any) => t.sku !== 'MVP-H')) must(await floor.rpc('wms_wave_confirm', { p_task: t.id, p_qty: t.qty_planned, p_scan: t.sku }), 'other stops');
  must(await floor.rpc('wms_wave_to_pack', { p_wave: wave.id }), 'to pack');
  for (const id of ids.slice(0, 2)) must(await floor.rpc('wms_wave_pack', { p_wave: wave.id, p_orders: [id], p_packages: [{ items: [{ key: 'MVP-H', qty: 8 }], weight_oz: 16, packaging: 'box' }] }), 'pack');
  let s = product(await summary(admin));
  assert.deepEqual([s.on_hand, s.picked_not_shipped, s.on_open_orders, s.available, s.reconciled], [4, 16, 8, 4 - 8, true]);
  // portal "Mark shipped" (labels manual action -> ship_order with the user's token)
  const mark = (who: any, id: string, tracking: string, box = 'Box 8×6×4') => who.rpc('ship_order', { p_order_id: id, p_carrier: 'USPS', p_service: 'Ground Advantage', p_tracking: tracking, p_label_source: 'manual', p_label_cost: 5.4, p_packaging: box, p_weight_oz: 16 });
  const s1 = must(await mark(admin, ids[0], '9400111111111111111111'), 'ship 1');
  assert.equal(must(await mark(admin, ids[0], '9400111111111111111111'), 'ship 1 again'), s1);      // a double click
  assert.match(String((await mark(staff, ids[1], '9400111111111111111111')).error?.message), /already on order MVP-H1/);
  must(await mark(staff, ids[1], '9400222222222222222222', 'Poly mailer'), 'ship 2');
  assert.match(String((await mark(admin, ids[2], '9400333333333333333333')).error?.message), /Pick it in the WMS first/);
  for (const who of [floor, client]) assert.match(String((await mark(who, ids[0], 'X')).error?.message), /Only ShipBay admin or staff/);
  for (const who of [anon, forged]) assert.ok((await mark(who, ids[0], 'X')).error, 'public key / forged token must be refused');
  const ships = must(await admin.from('shipments').select('order_id, tracking, label_source, packaging, postage_billed').in('order_id', ids), 'shipments') as any[];
  assert.deepEqual(ships.map((x) => [x.tracking, x.label_source, x.packaging, Number(x.postage_billed)]).sort(), [['9400111111111111111111', 'other', 'box_single', 5.4], ['9400222222222222222222', 'other', 'mailer', 5.4]]);
  // shipped orders cannot be rewritten from the portal
  assert.ok((await admin.from('orders').update({ ship_to: { name: 'Elsewhere' } }).eq('id', ids[0])).error);
  assert.ok((await admin.from('shipments').delete().eq('order_id', ids[0])).error);
  // reconcile: 20 received, 16 picked and shipped, 4 on hand; the third order still open and short
  s = product(await summary(admin));
  assert.deepEqual([s.received, s.picked_out, s.shipped, s.on_hand, s.picked_not_shipped, s.on_open_orders, s.reconciled], [20, -16, 16, 4, 0, 8, true]);
  // the client sees its own brand's figures, never the other brand's
  const mineAsClient = await client.rpc('wms_stock_summary', { p_org: org });
  const other = await client.rpc('wms_stock_summary', { p_org: org2 });
  const clientBrand = (must(await client.from('profiles').select('org_id').single(), 'profile') as any).org_id;
  assert.equal(clientBrand === org ? mineAsClient.error : other.error, null);
  assert.match(String((clientBrand === org ? other : mineAsClient).error?.message), /cannot see/);
  assert.ok((await anon.rpc('wms_stock_summary', { p_org: org })).error);
});
