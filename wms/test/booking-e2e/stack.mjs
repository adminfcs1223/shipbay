// WMS receiving graft end-to-end stack: dedicated local Postgres (guard-checked, freshly loaded) + the one graft candidate +
// PostgREST + a loopback gateway with Supabase's /rest/v1 path. Synthetic data only. Nothing binds beyond 127.0.0.1.
// JWTs are signed with a per-run random secret that never touches disk; the keys file expires in 1 h.
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname); const repo = path.resolve(here, '../../..');
const { Client } = createRequire(path.join(repo, 'supabase/tests/db/package.json'))('pg');
const OUT = '/tmp/graft-e2e'; fs.mkdirSync(OUT, { recursive: true });
const db = new Client('postgres://postgres@127.0.0.1:54317/staging'); await db.connect();
const g = (await db.query(`select current_setting('cluster_name') c, host(inet_server_addr()) h, split_part(pg_read_file('SHIPBAY_LOCAL_STAGING'),' ',1) m`).catch(() => ({ rows: [{}] }))).rows[0];
if (g.c !== 'shipbay-local-staging' || g.h !== '127.0.0.1' || g.m !== 'shipbay-local-staging') { console.error('REFUSED: not the dedicated local staging cluster'); process.exit(3); }
if ((await db.query('select count(*) n from orgs')).rows[0].n !== '0') { console.error('REFUSED: staging not freshly loaded'); process.exit(3); }
await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates/20261123_wms_booking_receiving.sql'), 'utf8'));
for (const f of ['20261124_nexus', '20261124_nexus_map', '20261124_nexus_shared_controls', '20261125_wms_activity', '20261126_nexus_dock']) await db.query(fs.readFileSync(path.join(repo, 'supabase/candidates', f + '.sql'), 'utf8'));
const U = { floor: 'aa000000-0000-4000-8000-000000000001', admin: 'aa000000-0000-4000-8000-000000000002', userA: 'aa000000-0000-4000-8000-000000000003', userB: 'aa000000-0000-4000-8000-000000000004' };
const A = 'bb000000-0000-4000-8000-00000000000a', B = 'bb000000-0000-4000-8000-00000000000b';
await db.query(`insert into orgs (id, name, slug, status) values ($1,'Synthetic Records','syn-records','onboarding'), ($2,'Synthetic Sneakers','syn-sneakers','onboarding')`, [A, B]);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'floor@example.test','{"role":"wms_employee","full_name":"Test Floor"}'), ($2,'admin@example.test','{"role":"shipbay_admin","full_name":"Test Admin"}'),
  ($3,'ua@example.test',jsonb_build_object('role','client_user','org_id',$5::text)), ($4,'ub@example.test',jsonb_build_object('role','client_user','org_id',$6::text))`, [U.floor, U.admin, U.userA, U.userB, A, B]);
await db.query(`insert into locations (code, zone, kind) values ('E01','e','pallet'), ('E02','e','pallet')`);
const SKU = (await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-LP','Synthetic LP') returning id`, [A])).rows[0].id;
await db.query(`insert into skus (org_id, sku, name) values ($1,'SYN-SHOE','Synthetic Shoe')`, [B]);
const bk = async (org, ref, p, c, approved = true) => (await db.query(`insert into inbound_shipments (org_id, reference, status, pallets, cartons, expected_at, approved_at) values ($1,$2,'expected',$3,$4,current_date,$5) returning id`, [org, ref, p, c, approved ? new Date() : null])).rows[0].id;
const bookings = { a: await bk(A, 'SYN-REC-BOOK', 3, 30), a2: await bk(A, 'SYN-REC-TWO', 2, 20), aWait: await bk(A, 'SYN-REC-WAIT', 1, 5, false), b: await bk(B, 'SYN-SNK-BOOK', 2, 10) };
await db.query(`insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values ($1,$2,300,0)`, [bookings.a, SKU]);
await db.end();
const secret = crypto.randomBytes(32).toString('base64url'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'booking-e2e', exp: Math.floor(Date.now() / 1000) + 3600, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
const keys = Object.fromEntries(Object.entries(U).map(([k, id]) => [k, jwt({ role: 'authenticated', sub: id, email: `${k}@example.test` })]));
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ keys, users: U, orgs: { A, B }, bookings, sku: SKU }, null, 1));
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
