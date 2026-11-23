// Synthetic data only. The snapshot codes here are a stand-in: the real codes come from Nexus.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../db/package.json', import.meta.url))('pg'); const here = path.dirname(new URL(import.meta.url).pathname);
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
{ const g = (await db.query(`select current_setting('cluster_name') c, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0]; if (g.c !== 'shipbay-local-staging' || g.m !== 'shipbay-local-staging' || (await db.query('select count(*) n from orgs')).rows[0].n !== '0') { await db.end(); throw new Error('REFUSED'); } }
const A = 'd9000000-0000-4000-8000-00000000000a'; const pad = (n) => String(n).padStart(2, '0');
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-a','active')`, [A]);
await db.query(`insert into locations (code, zone, kind) select 'P-' || lpad(g::text, 2, '0'), 'bulk', 'pallet' from generate_series(1, 64) g`);
await db.query(`insert into locations (code, zone, kind) values ('STG-01','staging','floor'), ('RCV-DOCK','receiving','dock'), ('A-01','pick','shelf')`);
await db.query(fs.readFileSync(path.join(here, '../../candidates/20261128_nexus_registry_sync.sql'), 'utf8'));
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
const loc = async (c) => (await db.query('select * from locations where code = $1', [c])).rows[0];
for (const [psku, code] of [['PSKU-900001', 'P-03'], ['PSKU-900002', 'P-64']]) await db.query(`insert into wms_pallets (psku, org_id, status, location_id, sku_id, cartons) values ($1,$2,'stored',$3,$4,1)`, [psku, A, (await loc(code)).id, SKU]);
await db.query(`insert into inventory_moves (org_id, sku_id, qty, reason, location_id) values ($1,$2,7,'receive',$3)`, [A, SKU, (await loc('A-01')).id]);
const frozen = async () => JSON.stringify([(await db.query('select id, psku, status, location_id from wms_pallets order by psku')).rows, (await db.query('select sku_id, qty, location_id from inventory_moves order by created_at')).rows]);
const snap = (codes, version, extra = {}) => ({ version, locations: codes.map((c) => ({ id: c, code: c, kind: c.startsWith('STG') ? 'floor' : 'pallet', zone: c.startsWith('STG') ? 'staging' : 'bulk', capacity: 1, status: 'active', version, ...(extra[c] || {}) })) });
const layout66 = [...Array.from({ length: 66 }, (_, i) => 'P-' + pad(i + 1)), 'STG-01', 'STG-02'];
const apply = async (s, dry) => (await db.query('select nexus_registry_apply($1::jsonb, $2) r', [JSON.stringify(s), dry])).rows[0].r;

test('registry from Nexus: dry run first, new positions added, nothing of ShipBay moved or deleted, retired codes kept and reported', async () => {
  const before = await frozen(); const n0 = Number((await db.query('select count(*) n from locations')).rows[0].n);
  await assert.rejects(apply({ version: 1, locations: [] }, false), /no locations/);
  const dry = await apply(snap(layout66, 1), true);
  assert.deepEqual([dry.matched, dry.added, dry.retired], [65, 3, 0]); assert.deepEqual(dry.added_codes, ['P-65', 'P-66', 'STG-02']);
  assert.equal(Number((await db.query('select count(*) n from locations')).rows[0].n), n0, 'a dry run writes nothing'); assert.equal((await loc('P-01')).nexus_version, null);
  const real = await apply(snap(layout66, 1), false); assert.equal(real.added, 3);
  assert.equal(Number((await db.query(`select count(*) n from locations where shared and kind = 'pallet' and nexus_status = 'active'`)).rows[0].n), 66);
  assert.equal(Number((await db.query(`select count(*) n from locations where shared and kind = 'floor'`)).rows[0].n), 2);
  assert.equal((await loc('A-01')).shared, false, 'ShipBay shelves are not part of the shared registry'); assert.equal((await loc('RCV-DOCK')).nexus_status, null);
  assert.equal(await frozen(), before, 'pallets, their positions and stock are untouched');
  // Nexus blocks one position and drops two codes: one empty, one where ShipBay still records a pallet
  const next = await apply(snap(layout66.filter((c) => c !== 'P-64' && c !== 'P-63'), 2, { 'P-10': { status: 'blocked' } }), false);
  assert.deepEqual(next.retired_empty, ['P-63']); assert.deepEqual(next.retired_but_occupied, ['P-64']);
  assert.equal((await loc('P-10')).nexus_status, 'blocked');
  assert.deepEqual([(await loc('P-63')).active, (await loc('P-63')).nexus_status], [false, 'retired']);
  assert.deepEqual([(await loc('P-64')).active, (await loc('P-64')).nexus_status], [true, 'retired'], 'kept usable while a ShipBay pallet is recorded there');
  const d = (await db.query('select kind, location_code, shipbay_view from nexus_disagreements')).rows; assert.equal(d.length, 1); assert.deepEqual(d[0].shipbay_view.pallets, ['PSKU-900002']);
  assert.equal(Number((await db.query('select count(*) n from locations')).rows[0].n), n0 + 3, 'no location row is ever deleted');
  // an older snapshot arriving late changes nothing
  const old = await apply(snap(['P-10'], 1), true); assert.equal(old.ignored_older, 1);
  await apply(snap(layout66.filter((c) => c !== 'P-64' && c !== 'P-63'), 2, { 'P-10': { status: 'blocked' } }), false); assert.equal((await db.query('select count(*) n from nexus_disagreements')).rows[0].n, '1', 'the same snapshot twice reports once');
  assert.equal(await frozen(), before);
  await db.query('set role authenticated'); await assert.rejects(db.query(`select nexus_registry_apply('{}'::jsonb, true)`), /permission denied/); await db.query('reset role');
});
test.after(async () => { await db.end(); });
