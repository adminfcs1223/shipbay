// Corrections e2e stack. The dedicated local Postgres, ALREADY built the way shipbay-nexus-dev is (candidates through
// 20261205, the dev seed, PSKU-000001 stored at P-01) + PostgREST + a loopback gateway with Supabase's /rest/v1 path.
// Synthetic rows only. Nothing binds beyond 127.0.0.1 and nothing here can reach Supabase or Nexus.
// The four synthetic logins get tokens signed with a per-run random secret that never touches disk; PostgREST checks the
// signature on every request, exactly as it does on Supabase, and the database reads the login from the verified token.
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname); const repo = path.resolve(here, '../../..');
const { Client } = createRequire(path.join(repo, 'supabase/tests/db/package.json'))('pg');
const OUT = process.env.E2E_OUT || '/tmp/corrections-e2e'; fs.mkdirSync(OUT, { recursive: true });
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
const refuse = (m) => { console.error(`REFUSED: ${m}`); process.exit(3); };
const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') refuse('not the dedicated local staging cluster');
const O = '5a000000-0000-4000-8000-0000000000a1';
const U = { admin: '5b000000-0000-4000-8000-000000000001', floor: '5b000000-0000-4000-8000-000000000002', staff: '5b000000-0000-4000-8000-000000000003', client: '5b000000-0000-4000-8000-000000000004' };
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0] || { x: null })[0];
if (await one(`select count(*)::int from orgs where id::text not like '5a000000-%'`) !== 0 || await one('select count(*)::int from orgs') !== 2) refuse('not the synthetic development data set');
if (await one(`select count(*)::int from pg_proc where proname in ('wms_open_box_correct', 'wms_correct_units', 'wms_pick_correct', 'wms_manager_stops', 'wms_manager_stop_correct')`) !== 5) refuse('the correction functions are not installed');
if (await one(`select p.status || ' ' || l.code from wms_pallets p join locations l on l.id = p.location_id where p.psku = 'PSKU-000001'`) !== 'stored P-01') refuse('PSKU-000001 is not stored at P-01');
if (await one(`select count(*)::int from inbound_shipments where reference = 'CE-PO-1'`) !== 0) refuse('this database was already seeded for the corrections test: rebuild it');

// ---- seed: one booking, three more products, five pallets received and put away through the real functions ----
const as = async (who, sql, p) => { await db.query('begin'); try { await db.query(`set local role ${who === 'service' ? 'service_role' : 'authenticated'}`);
  await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(who === 'service' ? { role: 'service_role' } : { sub: U[who], role: 'authenticated' })]);
  const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } };
// SEED=manager seeds the manager-list test instead (run-manager.cjs): three pallets of brand A, one of brand B, and a second client login in brand B.
const SEED = process.env.SEED === 'manager' ? 'manager' : 'corrections'; const O2 = '5a000000-0000-4000-8000-0000000000a2';
const sku = (org, s) => one(`insert into skus (org_id, sku, name) values ($1, $2, $3) returning id`, [org, s, `Synthetic ${s}`]);
const booking = async (org, ref, skus) => { const id = await one(`insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values ($1,$2,'expected',5,50,current_date,now()) returning id`, [org, ref]);
  for (const k of skus) await db.query(`insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values ($1,$2,1000,0)`, [id, k]); return id; };
const LP = await one(`select id from skus where sku = 'SYN-LP-001'`); let K, bk, plan;
if (SEED === 'corrections') {
  K = { f: await sku(O, 'CE-FLOOR'), a: await sku(O, 'CE-ADMIN'), s: await sku(O, 'CE-STAFF') }; bk = await booking(O, 'CE-PO-1', [LP, K.f, K.a, K.s]);
  plan = [['A', LP, 'P-60', O, bk], ['B', LP, 'P-61', O, bk], ['F', K.f, 'P-62', O, bk], ['M', K.a, 'P-63', O, bk], ['S', K.s, 'P-64', O, bk]];
} else {
  K = { f1: await sku(O, 'MG-FULL'), f2: await sku(O, 'MG-SHORT'), k: await sku(O, 'MG-PACK'), x: await sku(O2, 'MG-OTHER') }; bk = await booking(O, 'CE-PO-1', [K.f1, K.f2, K.k]); const bk2 = await booking(O2, 'CE-PO-2', [K.x]);
  plan = [['F1', K.f1, 'P-60', O, bk], ['F2', K.f2, 'P-61', O, bk], ['K', K.k, 'P-62', O, bk], ['X', K.x, 'P-63', O2, bk2]];
  U.client2 = '5b000000-0000-4000-8000-000000000005';
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'test-client2@example.test','{"role":"client_admin","full_name":"Test Client B (synthetic)"}')`, [U.client2]); await db.query('update profiles set org_id = $2 where id = $1', [U.client2, O2]);
}
const pallets = {};
for (const [name, k, at, org, b] of plan) {
  const p = (await as('floor', `select * from wms_receive_booking($1,$2,$3::jsonb,1,null,$4,'partial',null)`, [b, org, JSON.stringify([{ sku: k, cartons: 10, units_per_carton: 10 }]), `ce-${name}`]))[0];
  const op = (await as('floor', `select wms_putaway_begin($1,$2) j`, [p.psku, at]))[0].j.op; await as('service', 'select wms_nexus_op_commit($1)', [op]);   // what the bridge does once Nexus accepts
  const cartons = (await db.query('select code from wms_cartons where pallet_id = $1 order by seq', [p.id])).rows.map((r) => r.code);
  pallets[name] = { id: p.id, psku: p.psku, at, sku: k, org, cartons };
}
await db.end();

const secret = crypto.randomBytes(32).toString('base64url'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'corrections-e2e', exp: Math.floor(Date.now() / 1000) + 3600, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
const keys = Object.fromEntries(Object.entries(U).map(([k, id]) => [k, jwt({ role: 'authenticated', sub: id, email: `test-${k}@example.test` })]));
keys.anon = jwt({ role: 'anon' });
// a token for the admin's id signed with a DIFFERENT secret: PostgREST must refuse it
keys.forged = (() => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'corrections-e2e', exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', sub: U.admin }); return `${h}.${p}.${crypto.createHmac('sha256', crypto.randomBytes(32)).update(`${h}.${p}`).digest('base64url')}`; })();
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ seed: SEED, keys, users: U, org: O, org2: O2, booking: bk, skus: K, pallets }, null, 1), { mode: 0o600 });
const log = fs.openSync(path.join(OUT, 'postgrest.log'), 'w');
const pgrst = spawn(process.env.POSTGREST_BIN || '/tmp/postgrest', [], { env: { PATH: process.env.PATH, PGRST_DB_URI: 'postgres://authenticator@127.0.0.1:54317/staging', PGRST_DB_SCHEMAS: 'public',
  PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: '54332', PGRST_JWT_SECRET: secret }, stdio: ['ignore', log, log] });
const glog = fs.createWriteStream(path.join(OUT, 'gateway.log'));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile, range, x-supabase-api-version', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-expose-headers': 'content-range' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:54331'); glog.write(`${req.method} ${u.pathname}\n`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!u.pathname.startsWith('/rest/v1/')) { glog.write('  -> 404 (not part of the stack)\n'); res.writeHead(404, CORS); return res.end('{}'); }
  const up = http.request({ host: '127.0.0.1', port: 54332, path: u.pathname.slice(8) + u.search, method: req.method, headers: { ...req.headers, host: '127.0.0.1:54332' } }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...CORS }); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, CORS); res.end(JSON.stringify({ message: e.message })); }); req.pipe(up);
}).listen(54331, '127.0.0.1', () => console.log('READY'));
const stop = () => { pgrst.kill('SIGTERM'); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
