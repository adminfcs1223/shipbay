// Nexus end-to-end stack: dedicated local Postgres (guard-checked, freshly loaded) + the Nexus candidate + synthetic pallets +
// PostgREST + a loopback gateway with Supabase's /rest/v1 path. Synthetic data only. Nothing binds beyond 127.0.0.1.
// JWTs are signed with a per-run random secret that never touches disk; the keys file expires in 1 h.
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname); const repo = path.resolve(here, '../../..');
const { Client } = createRequire(path.join(repo, 'supabase/tests/db/package.json'))('pg');
const OUT = '/tmp/nexus-e2e'; fs.mkdirSync(OUT, { recursive: true });
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') { console.error('REFUSED: not the dedicated local staging cluster'); process.exit(3); }
if ((await db.query('select count(*) n from orgs')).rows[0].n !== '0') { console.error('REFUSED: staging not freshly loaded'); process.exit(3); }
await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates/20261123_wms_booking_receiving.sql'), 'utf8'));
await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates/20261124_nexus.sql'), 'utf8'));
await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates/20261124_nexus_map.sql'), 'utf8'));
for (const f of ['20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock']) await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates', f + '.sql'), 'utf8'));
const U = { floor: 'aa000000-0000-4000-8000-000000000001', admin: 'aa000000-0000-4000-8000-000000000002', userA: 'aa000000-0000-4000-8000-000000000003', userB: 'aa000000-0000-4000-8000-000000000004' };
const A = 'bb000000-0000-4000-8000-00000000000a', B = 'bb000000-0000-4000-8000-00000000000b';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-records','onboarding'), ($2,'Synthetic Sneakers','syn-sneakers','onboarding')`, [A, B]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin","full_name":"Test Admin"}'),
  ($3,'ua@example.test',jsonb_build_object('role','client_user','org_id',$5::text)), ($4,'ub@example.test',jsonb_build_object('role','client_user','org_id',$6::text))`, [U.floor, U.admin, U.userA, U.userB, A, B]);
await db.query(`insert into locations (code, zone, kind) select 'P-' || lpad(n::text, 2, '0'), 'bulk', 'pallet' from generate_series(1, 64) n`); await db.query(`insert into locations (code, zone, kind) values ('STG-01','staging','floor')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
const SKU2 = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-BOX','Synthetic box set') returning id`, [A])).rows[0].id;
const SHOE = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-SHOE','Synthetic shoe') returning id`, [B])).rows[0].id;
const fl = async (sql, p) => { await db.query('begin'); await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.floor, role: 'authenticated' })]); const r = await db.query(sql, p); await db.query('commit'); return r.rows; };
const pallets = [];
const mk = async (org, sku, cartons, key, days, store = true) => {
  const p = (await fl(`select * from wms_receive($1,$2::jsonb,1,null,$3)`, [org, JSON.stringify([{ sku, cartons, units_per_carton: 12 }]), key]))[0];
  if (store) { for (const c of (await db.query('select code from wms_cartons where pallet_id=$1', [p.id])).rows) await fl('select wms_scan_carton($1)', [c.code]);
    const k = (await fl('select * from wms_complete_count($1)', [p.id]))[0]; await fl('select wms_putaway($1,$2,(select code from locations where id=$3))', [p.id, k.psku, k.location_id]); }
  await db.query(`update wms_pallets set received_at = now() - ($2 || ' days')::interval where id=$1`, [p.id, days]);
  const r = (await db.query('select p.psku, l.code loc, l.zone from wms_pallets p left join locations l on l.id=p.location_id where p.id=$1', [p.id])).rows[0]; pallets.push({ ...r, org, key }); return r;
};
await mk(A, SKU, 10, 'e-a1', 21); await mk(A, SKU, 8, 'e-a2', 9); await mk(A, SKU2, 4, 'e-a3', 5); await mk(A, SKU, 6, 'e-a4', 2); await mk(A, SKU2, 3, 'e-a5', 0, false);
await mk(B, SHOE, 12, 'e-b1', 30); await mk(B, SHOE, 12, 'e-b2', 12); await mk(B, SHOE, 5, 'e-b3', 1, false);
await db.end();
const secret = crypto.randomBytes(32).toString('base64url'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'booking-e2e', exp: Math.floor(Date.now() / 1000) + 3600, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
const keys = Object.fromEntries(Object.entries(U).map(([k, id]) => [k, jwt({ role: 'authenticated', sub: id, email: `${k}@example.test` })]));
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ keys, users: U, orgs: { A, B }, pallets }, null, 1));
const pgrst = spawn(process.env.POSTGREST_BIN || '/tmp/postgrest', [], { env: { PATH: process.env.PATH, PGRST_DB_URI: 'postgres://authenticator@127.0.0.1:54317/staging', PGRST_DB_SCHEMAS: 'public',
  PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: '54332', PGRST_JWT_SECRET: secret }, stdio: ['ignore', fs.openSync(path.join(OUT, 'postgrest.log'), 'w'), fs.openSync(path.join(OUT, 'postgrest.log'), 'a')] });
const glog = fs.createWriteStream(path.join(OUT, 'gateway.log'));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile, range', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-expose-headers': 'content-range' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:54331'); glog.write(`${req.method} ${u.pathname}\n`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!u.pathname.startsWith('/rest/v1/')) { glog.write('  -> 404 (not part of the stack)\n'); res.writeHead(404, CORS); return res.end('{}'); }
  const up = http.request({ host: '127.0.0.1', port: 54332, path: u.pathname.slice(8) + u.search, method: req.method, headers: { ...req.headers, host: '127.0.0.1:54332' } }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...CORS }); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, CORS); res.end(JSON.stringify({ message: e.message })); }); req.pipe(up);
}).listen(54331, '127.0.0.1', () => console.log('READY'));
const stop = () => { pgrst.kill('SIGTERM'); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
