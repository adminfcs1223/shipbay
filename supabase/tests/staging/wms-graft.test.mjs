// Receiving-only graft for the deployed WMS (dc024b2): the one candidate on the production schema rebuilt locally.
// Dedicated local cluster only (guard below); two synthetic brands, synthetic logins (active and inactive), synthetic stock.
//   EXTRACT=<extract> supabase/tests/staging/load.sh && node --test supabase/tests/staging/wms-graft.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const URL_ = 'postgres://postgres@127.0.0.1:54317/staging';
const here = path.dirname(new URL(import.meta.url).pathname);
const cand = (f) => fs.readFileSync(path.join(here, '../../candidates', f), 'utf8');
const db = new Client(URL_); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') { await db.end(); throw new Error('REFUSED: not the dedicated local staging cluster'); }
  if ((await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED: staging not freshly loaded'); } }
const fp = async () => (await db.query(`select md5(string_agg(x, '|' order by x)) h from (
  select pg_get_functiondef(p.oid) x from pg_proc p where p.pronamespace='public'::regnamespace
  union all select coalesce(array_to_string(proacl, ','), 'default')||proname from pg_proc where pronamespace='public'::regnamespace
  union all select conrelid::regclass||conname||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
  union all select table_name||column_name||data_type from information_schema.columns where table_schema='public'
  union all select tgrelid::regclass||tgname from pg_trigger where not tgisinternal
  union all select tablename||policyname from pg_policies where schemaname='public'
  union all select table_name||grantee||privilege_type from information_schema.role_table_grants where table_schema='public') t`)).rows[0].h;
const fnDef = async (n) => (await db.query(`select string_agg(pg_get_functiondef(oid), '|') d from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [n])).rows[0].d;
const BEFORE = await fp(); const LEGACY = await fnDef('wms_receive'); const INVOICE = await fnDef('generate_invoice');
await db.query(cand('20261123_wms_booking_receiving.sql'));

const U = { floor: 'c4000000-0000-4000-8000-000000000001', admin: 'c4000000-0000-4000-8000-000000000002', staff: 'c4000000-0000-4000-8000-000000000003',
  userA: 'c4000000-0000-4000-8000-000000000004', goneFloor: 'c4000000-0000-4000-8000-000000000005', goneAdmin: 'c4000000-0000-4000-8000-000000000006',
  sales: 'c4000000-0000-4000-8000-000000000007' };
const A = 'd4000000-0000-4000-8000-00000000000a', B = 'd4000000-0000-4000-8000-00000000000b';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','onboarding'), ($2,'Synthetic Sneakers','syn-b','onboarding')`, [A, B]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values
  ($1,'floor@example.test','{"role":"wms_employee"}'), ($2,'admin@example.test','{"role":"shipbay_admin"}'), ($3,'staff@example.test','{"role":"shipbay_staff"}'),
  ($4,'ua@example.test',jsonb_build_object('role','client_user','org_id',$8::text)), ($5,'gonefloor@example.test','{"role":"wms_employee"}'),
  ($6,'goneadmin@example.test','{"role":"shipbay_admin"}'), ($7,'sales@example.test','{"role":"shipbay_sales"}')`, [U.floor, U.admin, U.staff, U.userA, U.goneFloor, U.goneAdmin, U.sales, A]);
await db.query(`update profiles set active = false where id in ($1, $2)`, [U.goneFloor, U.goneAdmin]);
await db.query(`insert into locations (code, zone, kind) values ('G01','g','pallet'), ('G02','g','pallet'), ('G03','g','pallet'), ('G04','g','pallet')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-G-LP','Synthetic record') returning id`, [A])).rows[0].id;
const SKU_B = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-G-SH','Synthetic shoe') returning id`, [B])).rows[0].id;
const bk = async (org, ref, p, c, approved = true) => (await db.query(`insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values ($1,$2,'expected',$3,$4,current_date,$5) returning id`, [org, ref, p, c, approved ? new Date() : null])).rows[0].id;
const BK = { a1: await bk(A, 'SYN-A-ONE', 3, 30), a2: await bk(A, 'SYN-A-TWO', 2, 20), aWait: await bk(A, 'SYN-A-WAIT', 1, 5, false), b1: await bk(B, 'SYN-B-ONE', 1, 10) };

async function as(who, sql, p = [], c = db) {
  await c.query('begin');
  try {
    const role = who === 'anon' ? 'anon' : who === 'service' ? 'service_role' : 'authenticated';
    const claims = who === 'anon' ? { role: 'anon' } : who === 'service' ? { role: 'service_role' } : { sub: U[who], role: 'authenticated' };
    await c.query(`set local role ${role}`); await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(claims)]);
    const r = await c.query(sql, p); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; }
}
const one = async (...a) => (await as(...a))[0];
const L = (n, sku = SKU, upc = 10) => JSON.stringify([{ sku, cartons: n, units_per_carton: upc }]);
const recv = (inb, org, lines, key, mode = 'partial', hold = null, who = 'floor', c) => as(who, `select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,$5,$6)`, [inb, org, lines, key, mode, hold], c);
const look = (who, org, inb, key, lines, o = {}) => one(who, `select wms_receipt_lookup($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) r`, [org, inb, key, o.version ?? 1, lines, o.pallets ?? 1, null, o.mode ?? 'partial', o.hold ?? null]).then((x) => x.r);
const stock = async () => Number((await db.query('select coalesce(sum(qty),0) n from inventory_moves where sku_id=$1', [SKU])).rows[0].n);
const bookRow = async (id) => (await db.query('select status, received_at, pallets, cartons from inbound_shipments where id=$1', [id])).rows[0];
const legacyInvoiceRows = async () => Number((await db.query(`select count(*) n from inbound_shipments where status in ('received','discrepancy')`)).rows[0].n);
async function count(pid) {
  for (const c of (await db.query('select code from wms_cartons where pallet_id=$1 order by seq', [pid])).rows) await as('floor', 'select wms_scan_carton($1)', [c.code]);
  const k = await one('floor', 'select * from wms_complete_count($1)', [pid]);
  return { psku: k.psku, loc: (await db.query('select code from locations where id=$1', [k.location_id])).rows[0].code };
}
const putaway = (pid, x) => as('floor', 'select wms_putaway($1,$2,$3)', [pid, x.psku, x.loc]);
const P = {};

test('scope: legacy wms_receive and generate_invoice are byte-identical to production', async () => {
  assert.equal(await fnDef('wms_receive'), LEGACY); assert.equal(await fnDef('generate_invoice'), INVOICE);
});

test('booking list: approved, open, same-brand bookings only; active WMS staff only', async () => {
  assert.deepEqual((await as('floor', 'select reference from wms_bookings($1)', [A])).map((r) => r.reference).sort(), ['SYN-A-ONE', 'SYN-A-TWO']);
  assert.deepEqual((await as('floor', 'select reference from wms_bookings($1)', [B])).map((r) => r.reference), ['SYN-B-ONE']);
  for (const who of ['userA', 'goneFloor', 'sales']) assert.equal((await as(who, 'select * from wms_bookings($1)', [A])).length, 0, who);
  await assert.rejects(as('anon', 'select * from wms_bookings($1)', [A]), /permission denied/);
});

test('refusals write nothing: inactive/client/sales/anon, wrong brand, unapproved, no key, HOLD without reason', async () => {
  const n0 = (await db.query('select (select count(*) from wms_pallets) p, (select count(*) from wms_receipt_links) l')).rows[0];
  for (const who of ['goneFloor', 'userA', 'sales']) await assert.rejects(recv(BK.a1, A, L(1), 'gk-' + who, 'partial', null, who), /cannot receive/, who);
  await assert.rejects(recv(BK.a1, A, L(1), 'gk-anon', 'partial', null, 'anon'), /permission denied/);
  await assert.rejects(recv(BK.a1, B, L(1, SKU_B), 'gk-wrongbrand'), /another brand/);
  await assert.rejects(recv(BK.aWait, A, L(1), 'gk-wait'), /not been approved/);
  await assert.rejects(recv(BK.a1, A, L(1), ''), /request key/);
  await assert.rejects(recv(BK.a1, A, L(1), 'gk-hold', 'hold', ' '), /why it is on HOLD/);
  assert.deepEqual((await db.query('select (select count(*) from wms_pallets) p, (select count(*) from wms_receipt_links) l')).rows[0], n0);
});

test('two same-brand bookings: actual quantities linked to the right booking; no stock at receipt', async () => {
  P.a1 = (await recv(BK.a1, A, L(10), 'gk-a1-p1'))[0]; P.a2 = (await recv(BK.a2, A, L(7), 'gk-a2-p1'))[0];
  assert.equal(P.a1.inbound_id, BK.a1); assert.equal(P.a2.inbound_id, BK.a2);
  const list = Object.fromEntries((await as('floor', 'select * from wms_bookings($1)', [A])).map((r) => [r.reference, r]));
  assert.deepEqual([list['SYN-A-ONE'].received_pallets, list['SYN-A-ONE'].received_cartons, list['SYN-A-TWO'].received_pallets, list['SYN-A-TWO'].received_cartons], [1, 10, 1, 7]);
  assert.equal(list['SYN-A-ONE'].receiving_state, 'partial');
  assert.equal(await stock(), 0);
});

test('lost answer: exact retry from another connection returns the same pallets; lookup is bound to booking, key and content', async () => {
  const c = new Client(URL_); await c.connect();
  assert.deepEqual((await recv(BK.a1, A, L(10), 'gk-a1-p1', 'partial', null, 'floor', c)).map((p) => p.id), [P.a1.id]); await c.end();
  await assert.rejects(recv(BK.a1, A, L(11), 'gk-a1-p1'), /already used for a different receipt/);
  await assert.rejects(recv(BK.a2, A, L(10), 'gk-a1-p1'), /already used for a different receipt/);
  const r = await look('floor', A, BK.a1, 'gk-a1-p1', L(10)); assert.equal(r.state, 'received'); assert.deepEqual(r.pallets.map((p) => p.id), [P.a1.id]);
  assert.equal((await look('staff', A, BK.a1, 'gk-a1-p1', L(10))).state, 'received');
  assert.equal((await look('floor', A, BK.a1, 'gk-a1-p1', L(9))).state, 'different_request');
  assert.equal((await look('floor', A, BK.a2, 'gk-a1-p1', L(10))).state, 'key_used_elsewhere', 'same brand, other booking');
  assert.equal((await look('floor', A, BK.a1, 'gk-not-sent', L(10))).state, 'not_found');
  await as('floor', `select * from wms_receive($1,$2::jsonb,1,null,'gk-legacy-1')`, [A, L(2)]);
  assert.equal((await look('floor', A, BK.a1, 'gk-legacy-1', L(2))).state, 'key_used_elsewhere', 'never answered from an unbooked batch');
  await assert.rejects(recv(BK.a1, A, L(2), 'gk-legacy-1'), /unbooked receipt/);
  await assert.rejects(look('floor', B, BK.a1, 'gk-a1-p1', L(10)), /not on file for this brand/);
  await assert.rejects(look('floor', A, BK.a1, 'gk-a1-p1', L(10), { version: 2 }), /Unsupported/);
  for (const who of ['goneFloor', 'userA', 'sales']) await assert.rejects(look(who, A, BK.a1, 'gk-a1-p1', L(10)), /cannot look up/, who);
  for (const who of ['floor', 'admin', 'userA', 'service', 'anon']) await assert.rejects(as(who, 'select * from wms_receipt_links'), /permission denied/, who);
});

test('HOLD/quarantine: counted but never stocked; only an active admin releases (then put-away) or voids', async () => {
  P.held = (await recv(BK.a1, A, L(5), 'gk-a1-hold', 'hold', 'Crushed cartons; brand to confirm'))[0];
  assert.equal(P.held.held, true);
  P.clearAt = await count(P.a1.id); P.heldAt = await count(P.held.id);
  await putaway(P.a1.id, P.clearAt); assert.equal(await stock(), 100, 'clear pallet stocked at put-away only');
  await assert.rejects(putaway(P.held.id, P.heldAt), /on HOLD/);
  await assert.rejects(db.query(`update wms_pallets set status='stored' where id=$1`, [P.held.id]), /on HOLD/);
  await assert.rejects(db.query(`update wms_pallets set held=false where id=$1`, [P.held.id]), /recorded release/);
  for (const who of ['floor', 'staff', 'goneAdmin', 'userA']) await assert.rejects(as(who, `select wms_hold_disposition($1,'release','SYN-REF')`, [P.held.id]), /Only a ShipBay admin/, who);
  const wl = (await as('floor', 'select * from wms_bookings($1)', [A])).find((r) => r.id === BK.a1);
  assert.equal(wl.receiving_state, 'partial_on_hold'); assert.equal(wl.held_pallets, 1);
  await as('admin', `select wms_hold_disposition($1,'release','SYN-BRAND-OK-1')`, [P.held.id]);
  await putaway(P.held.id, P.heldAt); assert.equal(await stock(), 150);
  P.void = (await recv(BK.a2, A, L(3), 'gk-a2-hold', 'hold', 'Wrong brand on pallet'))[0];
  await as('admin', `select wms_hold_disposition($1,'void','SYN-RETURNED-1')`, [P.void.id]);
  assert.equal((await db.query('select status from wms_pallets where id=$1', [P.void.id])).rows[0].status, 'void'); assert.equal(await stock(), 150);
});

test('last of a booking: closes it on the floor; booking row, planned counts and status untouched; nothing for the legacy invoice', async () => {
  const before = await bookRow(BK.a1);
  await recv(BK.a1, A, L(4), 'gk-a1-last', 'final');
  assert.deepEqual(await bookRow(BK.a1), before); assert.equal(before.status, 'expected'); assert.equal(before.received_at, null);
  assert.equal(await legacyInvoiceRows(), 0);
  assert.ok(!(await as('floor', 'select id from wms_bookings($1)', [A])).some((r) => r.id === BK.a1), 'closed booking leaves the floor list');
  await assert.rejects(recv(BK.a1, A, L(1), 'gk-a1-late'), /closed by its last receipt/);
  assert.equal((await recv(BK.a1, A, L(4), 'gk-a1-last', 'final')).length, 1, 'replay of the last receipt still answers');
  assert.equal(await stock(), 150, 'no stock from receipts');
});

test('legacy unbooked receive and retry unchanged', async () => {
  const a = await as('floor', `select * from wms_receive($1,$2::jsonb,2,null,'gk-legacy-2')`, [B, L(3, SKU_B)]);
  const b = await as('floor', `select * from wms_receive($1,$2::jsonb,2,null,'gk-legacy-2')`, [B, L(3, SKU_B)]);
  assert.deepEqual(b.map((p) => p.id), a.map((p) => p.id)); assert.ok(a.every((p) => p.inbound_id === null && !p.held));
});

test('fix-forward: disable turns the booked route off and keeps every record; HOLD gate stays; enable restores', async () => {
  const keep = (await db.query('select (select count(*) from wms_receipt_links) l, (select count(*) from wms_pallets where inbound_id is not null) p')).rows[0];
  await db.query(cand('20261123_wms_booking_receiving.disable.sql'));
  await assert.rejects(as('floor', 'select * from wms_bookings($1)', [A]), /permission denied/);
  await assert.rejects(recv(BK.a2, A, L(1), 'gk-after-off'), /permission denied/);
  assert.equal((await look('floor', A, BK.a2, 'gk-a2-p1', L(7))).state, 'received', 'stations can still settle an earlier receipt');
  assert.equal((await as('floor', `select * from wms_receive($1,$2::jsonb,1,null,'gk-legacy-3')`, [A, L(1)])).length, 1, 'unbooked receiving works');
  assert.deepEqual((await db.query('select (select count(*) from wms_receipt_links) l, (select count(*) from wms_pallets where inbound_id is not null) p')).rows[0], keep);
  const h = (await recv(BK.a2, A, L(2), 'gk-would-hold', 'hold', 'x', 'floor').catch(() => null)); assert.equal(h, null);
  await db.query(cand('20261123_wms_booking_receiving.enable.sql'));
  assert.equal((await as('floor', 'select * from wms_bookings($1)', [A])).length, 1);
});

test('full rollback refuses (changing nothing) while records exist; on a never-used database it restores production exactly', async () => {
  const roll = cand('20261123_wms_booking_receiving.rollback.sql');
  await assert.rejects(db.query(roll), /Rollback stopped: \d+ booked receipt/); await db.query('rollback');
  assert.ok(Number((await db.query('select count(*) n from wms_receipt_links')).rows[0].n) > 0, 'receipts preserved');
  // synthetic only: clear the test records, then roll back
  await db.query(`delete from wms_receipt_links; alter table wms_pallets disable trigger wms_pallets_hold_gate;
    update wms_pallets set held=false, hold_disposition=null, hold_reason=null, inbound_id=null; alter table wms_pallets enable trigger wms_pallets_hold_gate`);
  await db.query(roll);
  assert.equal(await fp(), BEFORE);
});
test.after(async () => { await db.end(); });
