// Nexus v1 on the production schema rebuilt locally. Dedicated local cluster only; two synthetic brands, synthetic logins.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg');
const here = path.dirname(new URL(import.meta.url).pathname);
const cand = (f) => fs.readFileSync(path.join(here, '../../candidates', f), 'utf8');
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
  if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') { await db.end(); throw new Error('REFUSED: not the dedicated local staging cluster'); }
  if ((await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED: staging not freshly loaded'); } }
const fp = async () => (await db.query(`select md5(string_agg(x, '|' order by x)) h from (
  select pg_get_functiondef(p.oid) x from pg_proc p where p.pronamespace='public'::regnamespace
  union all select coalesce(array_to_string(proacl, ','), 'default')||proname from pg_proc where pronamespace='public'::regnamespace
  union all select table_name||column_name||data_type from information_schema.columns where table_schema='public'
  union all select tgrelid::regclass||tgname from pg_trigger where not tgisinternal
  union all select tablename||policyname from pg_policies where schemaname='public') t`)).rows[0].h;
const BEFORE = await fp();
await db.query(cand('20261124_nexus.sql'));
const U = { floor: 'c5000000-0000-4000-8000-000000000001', admin: 'c5000000-0000-4000-8000-000000000002', client: 'c5000000-0000-4000-8000-000000000003', gone: 'c5000000-0000-4000-8000-000000000004' };
const A = 'd5000000-0000-4000-8000-00000000000a', B = 'd5000000-0000-4000-8000-00000000000b';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active'), ($2,'Synthetic Sneakers','syn-b','active')`, [A, B]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin"}'),
  ($3,'c@example.test',jsonb_build_object('role','client_user','org_id',$5::text)), ($4,'gone@example.test','{"role":"wms_employee"}')`, [U.floor, U.admin, U.client, U.gone, A]);
await db.query(`update profiles set active=false where id=$1`, [U.gone]);
await db.query(`insert into locations (code, zone, kind) values ('N01','north','pallet'), ('N02','north','pallet'), ('N03','north','pallet'), ('S01','south','pallet'), ('S02','south','pallet')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
const SKU_B = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-SHOE','Synthetic shoe') returning id`, [B])).rows[0].id;
async function as(who, sql, p = []) {
  await db.query('begin');
  try { await db.query(`set local role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(who === 'anon' ? { role: 'anon' } : { sub: U[who], role: 'authenticated' })]);
    const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; }
}
const one = async (...a) => (await as(...a))[0];
// receive -> count -> put away through the live floor functions; returns the pallet
async function pallet(org, sku, cartons, key, store = true) {
  const p = (await as('floor', `select * from wms_receive($1,$2::jsonb,1,null,$3)`, [org, JSON.stringify([{ sku, cartons, units_per_carton: 10 }]), key]))[0];
  if (!store) return p;
  for (const c of (await db.query('select code from wms_cartons where pallet_id=$1', [p.id])).rows) await as('floor', 'select wms_scan_carton($1)', [c.code]);
  const k = await one('floor', 'select * from wms_complete_count($1)', [p.id]);
  await as('floor', 'select wms_putaway($1,$2,(select code from locations where id=$3))', [p.id, k.psku, k.location_id]);
  return (await db.query('select p.*, l.code loc, l.zone from wms_pallets p join locations l on l.id=p.location_id where p.id=$1', [p.id])).rows[0];
}
const P = {};
test('setup: three stored pallets and one waiting, through the live WMS functions', async () => {
  P.a1 = await pallet(A, SKU, 3, 'nx-a1'); await db.query(`update wms_pallets set received_at = now() - interval '9 days' where id=$1`, [P.a1.id]);
  P.a2 = await pallet(A, SKU, 2, 'nx-a2'); P.b1 = await pallet(B, SKU_B, 4, 'nx-b1'); P.aWait = await pallet(A, SKU, 1, 'nx-a3', false);
});
test('who: active floor staff only; clients, inactive and anonymous are refused; raw tables closed', async () => {
  for (const who of ['client', 'gone']) await assert.rejects(as(who, 'select nexus_overview()'), /cannot use Nexus/, who);
  await assert.rejects(as('anon', 'select nexus_overview()'), /permission denied/);
  for (const t of ['nexus_clients', 'nexus_counts', 'nexus_count_lines', 'v_nexus_pallets']) await assert.rejects(as('admin', `select * from ${t}`), /permission denied/);
});
test('overview and pallets: one pallet count, straight from the WMS records', async () => {
  const o = (await one('floor', 'select nexus_overview() r')).r; const a = o.brands.find((b) => b.org_id === A), b = o.brands.find((x) => x.org_id === B);
  assert.deepEqual([a.pallets_stored, a.pallets_waiting, a.units_on_hand, b.pallets_stored, b.units_on_hand], [2, 1, 50, 1, 40]);
  assert.deepEqual([o.locations.total, o.locations.used], [5, 3]);
  assert.equal((await as('floor', 'select * from nexus_pallets($1,null)', [A])).length, 3);
  assert.deepEqual((await as('floor', 'select psku from nexus_pallets(null,$1)', [P.b1.psku])).map((r) => r.psku), [P.b1.psku]);
});
test('FIFO: oldest received pallet first, with what is on hand at its position', async () => {
  const f = await as('floor', 'select * from nexus_fifo($1,$2)', [A, SKU]);
  assert.deepEqual(f.map((r) => r.psku), [P.a1.psku, P.a2.psku]); assert.deepEqual(f.map((r) => r.on_hand_here), [30, 20]); assert.equal(f[0].age_days, 9);
  assert.deepEqual((await as('floor', 'select sku, pallets from nexus_products($1)', [A])), [{ sku: 'SYN-LP', pallets: 2 }]);
});
test('cycle count: found, misplaced, unexpected, missing; nothing moves', async () => {
  const before = (await db.query(`select md5(string_agg(id::text||status||coalesce(location_id::text,''), ',' order by id)) h, (select coalesce(sum(qty),0) from inventory_moves) q from wms_pallets`)).rows[0];
  const zone = P.a1.zone; const inZone = [P.a1, P.a2, P.b1].filter((p) => p.zone === zone); const other = [P.a1, P.a2, P.b1].find((p) => p.zone !== zone);
  const id = (await one('floor', 'select nexus_count_start($1,null) id', [zone])).id;
  await assert.rejects(as('floor', 'select nexus_count_start($1,null)', [zone]), /already open/);
  assert.equal((await one('floor', 'select nexus_count_scan($1,$2,$3) r', [id, inZone[0].loc, inZone[0].psku])).r.result, 'found');
  await assert.rejects(as('floor', 'select nexus_count_scan($1,$2,$3)', [id, 'ZZ99', inZone[0].psku]), /not on file/);
  await assert.rejects(as('floor', 'select nexus_count_scan($1,$2,$3)', [id, inZone[0].loc, 'PSKU-NOPE']), /not on file/);
  if (inZone[1]) assert.equal((await one('floor', 'select nexus_count_scan($1,$2,$3) r', [id, inZone[0].loc, inZone[1].psku])).r.result, 'misplaced');
  assert.equal((await one('floor', 'select nexus_count_scan($1,$2,$3) r', [id, inZone[0].loc, P.aWait.psku])).r.result, 'unexpected');
  const t = (await one('floor', 'select nexus_count_close($1) r', [id])).r;
  assert.equal(t.found, 1); assert.equal(t.unexpected, 1); assert.equal((t.misplaced || 0) + (t.missing || 0), inZone.length - 1);
  await assert.rejects(as('floor', 'select nexus_count_scan($1,$2,$3)', [id, inZone[0].loc, inZone[0].psku]), /not open/);
  assert.equal((await as('floor', 'select * from nexus_count_lines_list($1)', [id])).length, inZone.length + 1);
  assert.deepEqual((await db.query(`select md5(string_agg(id::text||status||coalesce(location_id::text,''), ',' order by id)) h, (select coalesce(sum(qty),0) from inventory_moves) q from wms_pallets`)).rows[0], before);
  void other;
});
test('connections and API: admin-only keys, shown once, scoped to their brands; another WMS sees only its own counts', async () => {
  await assert.rejects(as('floor', `select nexus_client_create('x',$1)`, [[B]]), /Only a ShipBay admin/);
  const k = (await one('admin', `select nexus_client_create('Souled WMS (synthetic)',$1) r`, [[B]])).r;
  assert.match(k.key, /^nxs_[0-9a-f]{64}$/); assert.equal((await db.query('select count(*) n from nexus_clients where key_hash = $1', [k.key])).rows[0].n, '0', 'key is not stored');
  const c = (await one('anon', 'select nexus_api_counts($1) r', [k.key])).r;
  assert.deepEqual(c.brands.map((b) => [b.brand, b.pallets_stored, b.units_on_hand]), [['Synthetic Sneakers', 1, 40]]);
  const ps = (await one('anon', 'select nexus_api_pallets($1) r', [k.key])).r.pallets; assert.deepEqual(ps.map((p) => p.pallet), [P.b1.psku]);
  assert.equal((await one('anon', `select nexus_api_fifo($1,'syn-shoe') r`, [k.key])).r.pick_first[0].psku, P.b1.psku);
  await assert.rejects(as('anon', `select nexus_api_fifo($1,'SYN-LP')`, [k.key]), /not on file for this connection/);
  await assert.rejects(as('anon', `select nexus_api_counts('nxs_wrong')`), /Unknown or inactive/);
  // a new pallet in the ShipBay WMS shows in the other WMS's count at once
  await pallet(B, SKU_B, 1, 'nx-b2'); assert.equal((await one('anon', 'select nexus_api_counts($1) r', [k.key])).r.brands[0].pallets_stored, 2);
  await as('admin', 'select nexus_client_set_active($1,false)', [k.id]);
  await assert.rejects(as('anon', 'select nexus_api_counts($1)', [k.key]), /Unknown or inactive/);
  assert.equal((await as('admin', 'select * from nexus_clients_list()')).length, 1); assert.equal((await as('floor', 'select * from nexus_clients_list()')).length, 0);
});
test('rollback: refuses while counts exist; then removes only Nexus objects (schema exactly as before)', async () => {
  await assert.rejects(db.query(cand('20261124_nexus.rollback.sql')), /cycle count/); await db.query('rollback');
  await db.query('delete from nexus_count_lines; delete from nexus_counts'); await db.query(cand('20261124_nexus.rollback.sql'));
  assert.equal(await fp(), BEFORE);
});
test.after(async () => { await db.end(); });
