// The three correction forms in a real browser (Chromium), in the WHOLE WMS app, against the local stack: real database
// functions, real PostgREST checking every token, the four synthetic logins. Then the same endpoints over plain HTTP as the
// logins that must be refused, and the ledger checked row by row after everything.
// Every request not to 127.0.0.1 is blocked and counted. Nothing here can reach Supabase, Nexus or production.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const pg = require(path.resolve(__dirname, '../../../supabase/tests/db/node_modules/pg'));
const E = process.env.E2E_OUT || '/tmp/corrections-e2e'; const S = JSON.parse(fs.readFileSync(`${E}/session.json`, 'utf8')); const BUILD = `${E}/build`; const SHOTS = `${E}/shots`; fs.mkdirSync(SHOTS, { recursive: true });
const API = 'http://127.0.0.1:54331'; const WEB = 'http://127.0.0.1:4503';
let pass = 0, fail = 0; let onStop = async () => {}; const findings = []; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); return !!c; };
const section = (t) => console.log(`\n## ${t}`);
const db = new pg.Client('postgres://postgres@127.0.0.1:54317/staging');
const q = async (sql, p = []) => (await db.query(sql, p)).rows; const q1 = async (sql, p = []) => Object.values((await q(sql, p))[0] || { x: null })[0];
const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
const sub = (auth) => { try { return JSON.parse(Buffer.from(String(auth).split('.')[1], 'base64url').toString()).sub || null; } catch { return null; } };
const WHO = Object.fromEntries(Object.entries(S.users).map(([k, v]) => [v, k]));

// ---- the books ----
const books = async (sku) => Object.fromEntries((await q(`select coalesce(l.code, '-') c, sum(m.qty)::int n from inventory_moves m left join locations l on l.id = m.location_id where m.sku_id = $1 group by 1 having sum(m.qty) <> 0`, [sku])).map((r) => [r.c, r.n]));
const ledger = async () => (await q('select count(*)::int n, coalesce(sum(qty), 0)::int u from inventory_moves'))[0];
const since = async (t) => q(`select m.qty, m.reason, coalesce(l.code, '-') at, m.note, m.created_by, m.ref_type, m.ref_id, m.pallet_id from inventory_moves m left join locations l on l.id = m.location_id where m.created_at > $1 order by m.created_at, m.qty`, [t]);
const now = () => q1('select clock_timestamp()');
const activity = async (kind, ref) => (await q('select kind, qty, ref, actor, actor_name, detail from wms_activity where kind = $1 and ref = $2 order by at desc limit 1', [kind, ref]))[0] || null;
const keepRow = () => q1(`select md5(concat_ws('|', (select to_jsonb(p)::text from wms_pallets p where psku = 'PSKU-000001'), (select jsonb_agg(to_jsonb(m) order by m.id)::text from inventory_moves m where m.ref_id = (select id from wms_pallets where psku = 'PSKU-000001')),
  (select jsonb_agg(to_jsonb(o) order by o.id)::text from wms_nexus_ops o where o.psku = 'PSKU-000001'), (select jsonb_agg(to_jsonb(c) order by c.code)::text from wms_cartons c where c.pallet_id = (select id from wms_pallets where psku = 'PSKU-000001'))))`);
// act as a login at the database, only to stage a situation the test needs (a release Nexus accepted, a request still waiting)
const as = async (who, sql, p) => { await db.query('begin'); try { await db.query(`set local role ${who === 'service' ? 'service_role' : 'authenticated'}`);
  await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(who === 'service' ? { role: 'service_role' } : { sub: S.users[who], role: 'authenticated' })]);
  const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } };
const depart = async (p) => { const op = (await as('floor', 'select wms_release_begin($1,$2,$3,true) j', [p.psku, p.at, 'shipped_out']))[0].j.op; await as('service', 'select wms_nexus_op_commit($1)', [op]); };
const order = async (no, sku, qty) => { const id = await q1(`insert into orders (org_id, order_number, source, status, customer_name, ship_to, total_units) values ($1,$2,'connector','new','Pat Example','{"name":"Pat Example","address1":"1 Test Way","city":"Testville","province_code":"NJ","zip":"08844","country_code":"US"}'::jsonb,$3) returning id`, [S.org, no, qty]);
  const name = await q1('select name from skus where id = $1', [sku]); const s = await q1('select sku from skus where id = $1', [sku]);
  await q('insert into order_lines (order_id, sku_id, sku, name, qty) values ($1,$2,$3,$4,$5)', [id, sku, s, name, qty]); return id; };

// ---- plain HTTP, the way any client with a token would call ----
const call = async (who, fn, args, { method = 'POST', table = null, query = '' } = {}) => {
  const headers = { 'content-type': 'application/json', apikey: S.keys.anon }; if (who) headers.authorization = `Bearer ${S.keys[who]}`;
  const r = await fetch(table ? `${API}/rest/v1/${table}${query}` : `${API}/rest/v1/rpc/${fn}`, { method, headers: { ...headers, prefer: 'return=representation' }, body: JSON.stringify(args) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, message: j?.message || null, code: j?.code || null, body: j };
};

(async () => {
  await db.connect();
  const server = http.createServer((req, res) => { const p = decodeURIComponent(String(req.url).split('?')[0]);
    if (p === '/version.json') { res.setHeader('Content-Type', 'application/json'); return res.end('{"build":"corrections-e2e"}'); }
    const f = path.resolve(BUILD, '.' + p); const file = f.startsWith(BUILD + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(BUILD, 'app.html');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res); }).listen(4503, '127.0.0.1');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
  const blocked = []; const errors = []; const rpcs = []; const pages = [];
  // a signed-in browser: the app's own session store holds the login's token, as after a real sign-in
  const signIn = async (who, hash) => {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
    await ctx.route('**/*', (r) => { const u = r.request().url(); const h = u.startsWith('http') ? new URL(u).hostname : '127.0.0.1'; if (h === '127.0.0.1') return r.fallback(); blocked.push(u); return r.abort(); });
    await ctx.addInitScript((s) => { localStorage.setItem('shipbay-wms-auth', JSON.stringify(s)); window.print = () => {}; },
      { access_token: S.keys[who], refresh_token: 'none', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3500, user: { id: S.users[who], email: `test-${who}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z' } });
    const p = await ctx.newPage(); pages.push(p); p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    p.on('response', (r) => { const m = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(r.url()); if (!m || r.request().method() !== 'POST') return; let args = {}; try { args = JSON.parse(r.request().postData() || '{}'); } catch { /* none */ }
      rpcs.push({ who, fn: m[1], status: r.status(), args, as: WHO[sub(r.request().headers().authorization)] || 'unknown' }); });
    await p.goto(`${WEB}/${hash}`); await p.waitForTimeout(900);
    return { p, ctx, close: () => ctx.close() };
  };
  onStop = async () => { for (const [i, x] of pages.entries()) if (!x.isClosed()) { await x.screenshot({ path: `${SHOTS}/stopped-${i}.png`, fullPage: true }).catch(() => {}); console.error(`   page ${i}: ${norm(await x.locator('body').innerText().catch(() => '')).slice(0, 400)}`); } };
  const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  const sent = (fn, from = 0) => rpcs.slice(from).filter((r) => r.fn === fn);
  const openPallet = async (p, pal) => { if (await p.locator('button.back').count()) { await p.locator('button.back').click(); await p.waitForSelector('.toolbar .scanbox'); }
    const i = p.locator('.toolbar .scanbox input'); await i.fill(pal.psku); await i.press('Enter'); await p.waitForSelector('.unitsbox'); await p.waitForTimeout(500); };
  // the open-box dialog
  const obOpen = async (p) => { await p.getByRole('button', { name: 'Found an open box' }).click(); await p.waitForSelector('[aria-label="Found an open box"]'); };
  const obFill = async (p, carton, units, why) => { const d = p.locator('[aria-label="Found an open box"]'); const ins = d.locator('input'); await ins.nth(0).fill(String(carton)); await ins.nth(1).fill(String(units)); if (why !== undefined) await ins.nth(2).fill(why); };
  const obSubmit = async (p) => { await p.locator('[aria-label="Found an open box"] .btn.go').click(); await p.waitForTimeout(700); };
  const obError = async (p) => ((await p.locator('[aria-label="Found an open box"] .strip.bad').count()) ? norm(await p.locator('[aria-label="Found an open box"] .strip.bad').innerText()) : null);
  const obMade = async (p) => ((await p.locator('[aria-label="Open box labels"]').count()) ? norm(await p.locator('[aria-label="Open box labels"] .lead').innerText()) : null);
  const obCancel = async (p) => { await p.locator('[aria-label="Found an open box"]').getByRole('button', { name: 'Cancel' }).click(); await p.waitForTimeout(150); };
  const obDone = async (p) => { await p.locator('[aria-label="Open box labels"]').getByRole('button', { name: 'Done' }).click(); await p.waitForTimeout(200); };
  // the Units box
  const unitsSave = async (p, units, why) => { const b = p.locator('.unitsbox'); if (why !== undefined) await b.locator('.unitwhy input').fill(why); await b.locator('.unitrows li input').first().fill(String(units)); await b.locator('.unitrows li button').first().click(); await p.waitForTimeout(800); };
  const unitsMsg = async (p) => { const s = p.locator('.unitsbox .strip'); return (await s.count()) ? { kind: (await s.getAttribute('class')).includes('bad') ? 'bad' : 'ok', text: norm(await s.innerText()) } : null; };
  const unitsRow = async (p) => norm(await p.locator('.unitsbox .unitrows li').first().locator('div span').innerText());
  const unitsBtn = async (p) => { const b = p.locator('.unitsbox .unitrows li button').first(); return { text: norm(await b.innerText()), disabled: await b.isDisabled() }; };

  const { A, B, F, M, S: St } = S.pallets; const LP = A.sku; const keep0 = await keepRow();
  const ADMIN = S.users.admin, STAFF = S.users.staff;

  // ================= the client login =================
  section('A client login in the WMS');
  { const c = await signIn('client', '#pallets'); const body = norm(await c.p.locator('body').innerText());
    ok(/isn.t set up for the WMS/.test(body) && !/Found an open box|Units per carton/.test(body), 'a client login is turned away by the app: no Pallets screen, no forms');
    ok(rpcs.filter((r) => r.who === 'client').length === 0, 'and the app called no function for it'); await c.close(); }

  // ================= the floor login: the forms refuse, the ordinary opening works =================
  section('Open box and count correction as the floor login');
  const fl = await signIn('floor', '#pallets'); let p = fl.p;
  await openPallet(p, A); let l0 = await ledger(); let n0 = rpcs.length;
  await obOpen(p); ok(await p.locator('[aria-label="Found an open box"] input').count() === 3, 'on a put-away pallet the open-box dialog has a reason field');
  await obFill(p, 1, 8); await obSubmit(p); let e = await obError(p);
  ok(/Carton 1 holds 10 on file\. Say why it holds 8; an admin or staff login is needed\./.test(e || ''), `a count that differs with no reason is stopped on the screen: ${e}`);
  ok(rpcs.length === n0 && (await ledger()).n === l0.n, 'nothing was sent and nothing was posted');
  ok(!(await p.locator('[aria-label="Found an open box"] .btn.go').isDisabled()), 'the dialog stays usable after that message');
  await shot(p, '01-floor-openbox-needs-reason');
  await obFill(p, 1, 8, 'Two units missing'); await obSubmit(p); e = await obError(p);
  let c1 = sent('wms_open_box_correct', n0)[0];
  ok(/Only ShipBay admin or staff can open a box with a count that differs from the carton.s\./.test(e || ''), `with a reason, the floor login is refused by the database and the screen says why: ${e}`);
  ok(c1 && c1.as === 'floor' && c1.status === 400 && c1.args.p_carton_code === A.cartons[0] && c1.args.p_units === 8 && c1.args.p_reason === 'Two units missing', 'that request went out under the floor login\'s own token, to the correction function, with the carton, count and reason');
  ok((await ledger()).n === l0.n && await q1('select open_box_at is null from wms_cartons where code = $1', [A.cartons[0]]), 'the refusal changed nothing: no ledger row, the carton is not opened');
  await shot(p, '02-floor-openbox-refused');
  let t0 = await now(); n0 = rpcs.length;
  await obFill(p, 1, 10, ''); await obSubmit(p); let made = await obMade(p);
  ok(/^10 loose units · Synthetic LP, Black · shelf OB-01$/.test(made || ''), `the carton's own count opens for the floor login: ${made}`);
  let rows = await since(t0);
  ok(sent('wms_open_box', n0).length === 1 && sent('wms_open_box_correct', n0).length === 0, 'through the ordinary open-box function, not the correction');
  ok(rows.length === 2 && rows.every((r) => r.reason === 'transfer') && rows.map((r) => `${r.qty}@${r.at}`).sort().join(' ') === '-10@P-60 10@OB-01', `the ledger got one transfer pair, 10 off P-60 and 10 onto OB-01, and no adjustment: ${rows.map((r) => `${r.reason} ${r.qty} ${r.at}`).join(', ')}`);
  ok(rows.every((r) => r.ref_type === 'wms_pallet' && r.ref_id === A.id && r.created_by === S.users.floor), 'both rows name the pallet and the floor login');
  await shot(p, '03-floor-openbox-exact'); await obDone(p);

  l0 = await ledger(); n0 = rpcs.length;
  await unitsSave(p, 9); let m = await unitsMsg(p);
  ok(m && m.kind === 'bad' && m.text === 'Say why the count is being corrected.' && rpcs.length === n0, `a count change on a put-away pallet with no reason is stopped on the screen: ${m && m.text}`);
  let btn = await unitsBtn(p); const stuck = btn.disabled || /Saving/.test(btn.text);
  ok(!stuck, `after that message the Save button is usable again (shows "${btn.text}", ${btn.disabled ? 'locked' : 'enabled'})`);
  if (stuck) { findings.push('Units box: after "Say why the count is being corrected." the Save button stays on "Saving…" and locked until the page is reloaded.'); await p.reload(); await p.waitForTimeout(900); await openPallet(p, A); }
  await shot(p, '04-floor-units-needs-reason');
  await unitsSave(p, 9, 'Recounted at the position'); m = await unitsMsg(p); c1 = sent('wms_correct_units', n0)[0];
  ok(m && m.kind === 'bad' && /Only ShipBay admin or staff can correct the count of a pallet that is put away\./.test(m.text), `with a reason, the floor login is refused by the database: ${m && m.text}`);
  ok(c1 && c1.as === 'floor' && c1.status === 400 && c1.args.p_pallet === A.id && c1.args.p_units === 9, 'under the floor login\'s own token');
  ok((await ledger()).n === l0.n && (await ledger()).u === l0.u && /10 cartons × 10 = 100 units/.test(await unitsRow(p)), 'nothing posted; the count on file is still 10 per carton');
  await shot(p, '05-floor-units-refused');

  // ================= the admin login =================
  section('Open box with a corrected count, as admin');
  const ad = await signIn('admin', '#pallets'); p = ad.p; await openPallet(p, A);
  l0 = await ledger(); n0 = rpcs.length; await obOpen(p);
  await obFill(p, 2, 8, 'ab'); await obSubmit(p); e = await obError(p);
  ok(/Carton 2 holds 10 on file\. Say why it holds 8/.test(e || '') && rpcs.length === n0, `a reason of two letters is not a reason: stopped on the screen, nothing sent: ${e}`);
  t0 = await now(); await obFill(p, 2, 8, 'Two units missing at the position'); await obSubmit(p); made = await obMade(p); rows = await since(t0);
  ok(/^8 loose units · Synthetic LP, Black · shelf OB-01$/.test(made || ''), `the admin's corrected count is accepted and the screen offers the 8 unit labels: ${made}`);
  c1 = sent('wms_open_box_correct', n0)[0]; ok(c1 && c1.as === 'admin' && c1.status === 200, 'sent under the admin login\'s own token');
  const tr = rows.filter((r) => r.reason === 'transfer'), aj = rows.filter((r) => r.reason === 'adjust');
  ok(rows.length === 3 && tr.length === 2 && tr.reduce((s, r) => s + r.qty, 0) === 0 && aj.length === 1 && aj[0].qty === -2 && aj[0].at === 'P-60', `ledger: one transfer pair netting to zero and ONE adjustment of -2 at P-60: ${rows.map((r) => `${r.reason} ${r.qty} ${r.at}`).join(', ')}`);
  ok(aj[0].created_by === ADMIN && /Two units missing at the position/.test(aj[0].note || '') && aj[0].ref_id === A.id, `the adjustment names the admin, the pallet and the reason: "${aj[0].note}"`);
  let act = await activity('open_box_corrected', A.psku);
  ok(act && act.actor === ADMIN && act.detail.reason === 'Two units missing at the position' && Number(act.detail.on_file) === 10 && Number(act.detail.found) === 8, `the activity log has who, on file, found and why: ${act && JSON.stringify(act.detail)}`);
  ok(JSON.stringify(await books(LP)) === JSON.stringify(await books(LP)) && (await books(LP))['P-60'] === 80 && (await ledger()).u === l0.u - 2, 'the books: P-60 holds 80, and the total is down by exactly the 2 missing units');
  await shot(p, '06-admin-openbox-corrected'); await obDone(p);
  ok(/Carton 2.*8 units.*shelf OB-01.*Test Admin/.test(norm(await p.locator('.obox').innerText())), 'the pallet page lists the opened carton with its 8 units and who opened it');

  t0 = await now(); await obOpen(p); await obFill(p, 3, 12, 'Supplier packed twelve in this carton'); await obSubmit(p); made = await obMade(p); rows = await since(t0);
  ok(/^12 loose units/.test(made || '') && rows.length === 3 && rows.filter((r) => r.reason === 'adjust').map((r) => `${r.qty}@${r.at}`).join() === '2@OB-01', `a carton holding more than its count: the carton's 10 leave the position, and ONE adjustment of +2 lands on the shelf with the units: ${rows.map((r) => `${r.reason} ${r.qty} ${r.at}`).join(', ')}`);
  await obDone(p); l0 = await ledger();
  await obOpen(p); await obFill(p, 2, 10, ''); await obSubmit(p); e = await obError(p);
  ok(/Carton 2 of PSKU-\d+ is already an open box with 8 units\./.test(e || '') && (await ledger()).n === l0.n, `opening the same carton twice is refused in plain words, nothing posted: ${e}`);
  await obCancel(p);

  section('Pallet count correction, as admin');
  await openPallet(p, B); l0 = await ledger(); n0 = rpcs.length;
  await unitsSave(p, 9, 'abc'); m = await unitsMsg(p);
  ok(m && m.text === 'Say why the count is being corrected.' && rpcs.length === n0, 'a reason of three letters is stopped on the screen, nothing sent');
  if (/Saving/.test((await unitsBtn(p)).text)) { await p.reload(); await p.waitForTimeout(900); await openPallet(p, B); }
  t0 = await now(); await unitsSave(p, 9, 'Recounted at the position'); m = await unitsMsg(p); rows = await since(t0);
  ok(m && m.kind === 'ok' && m.text === 'Saved. Stock updated at this position.', `the admin's correction is saved and the screen says so: ${m && m.text}`);
  ok(/10 cartons × 9 = 90 units/.test(await unitsRow(p)), `the pallet page shows the new count: ${await unitsRow(p)}`);
  ok(rows.length === 1 && rows[0].reason === 'adjust' && rows[0].qty === -10 && rows[0].at === 'P-61' && rows[0].created_by === ADMIN && /Recounted at the position/.test(rows[0].note || '') && rows[0].ref_id === B.id, `ledger: ONE adjustment of -10 at P-61 naming the admin, the pallet and the reason: "${rows[0] && rows[0].note}"`);
  act = await activity('pallet_units_corrected', B.psku);
  ok(act && act.actor === ADMIN && act.detail.reason === 'Recounted at the position', `the activity log has the correction: ${act && JSON.stringify(act.detail)}`);
  l0 = await ledger(); await unitsSave(p, 9, 'Recounted at the position'); m = await unitsMsg(p);
  ok((await ledger()).n === l0.n, `entering the same count again posts nothing (screen: ${m && m.text})`);
  await shot(p, '07-admin-units-corrected');

  section('Refusal handling: a Nexus request still waiting on the pallet');
  const wait = (await as('floor', 'select wms_move_begin($1,$2) j', [B.psku, 'P-65']))[0].j.op;   // what the bridge writes before it asks Nexus; nothing is sent
  l0 = await ledger();
  await unitsSave(p, 8, 'Recounted again'); m = await unitsMsg(p);
  ok(m && m.kind === 'bad' && /cannot be corrected yet: it has a request for P-65 that Nexus has not answered/.test(m.text), `count correction under a waiting move is refused and explained: ${m && m.text}`);
  await obOpen(p); await obFill(p, 1, 9, ''); await obSubmit(p); e = await obError(p);
  ok(/No box of PSKU-\d+ can be opened yet: it has a request for P-65 that Nexus has not answered/.test(e || ''), `opening a box under a waiting move is refused and explained: ${e}`);
  await obCancel(p); ok((await ledger()).n === l0.n, 'neither refusal posted anything');
  await shot(p, '08-admin-refused-while-waiting');
  await as('service', `select wms_nexus_op_note($1,'refused',409,'location_full')`, [wait]);   // Nexus says no: the request is settled, the pallet stays
  await ad.close();

  // ================= the staff login =================
  section('Both corrections as shipbay_staff');
  const st = await signIn('staff', '#pallets'); p = st.p; await openPallet(p, B); n0 = rpcs.length;
  t0 = await now(); await obOpen(p); await obFill(p, 1, 7, 'Two short in carton one'); await obSubmit(p); made = await obMade(p); rows = await since(t0);
  ok(/^7 loose units/.test(made || '') && sent('wms_open_box_correct', n0)[0]?.as === 'staff', `staff can open a box with a corrected count (9 on file, 7 found): ${made}`);
  ok(rows.length === 3 && rows.filter((r) => r.reason === 'adjust').length === 1 && rows.find((r) => r.reason === 'adjust').qty === -2 && rows.find((r) => r.reason === 'adjust').created_by === STAFF, 'ledger: the transfer pair and one adjustment of -2 naming the staff login');
  act = await activity('open_box_corrected', B.psku); ok(act && act.actor === STAFF && /Test Staff/.test(act.actor_name || ''), `the activity log names the staff login: ${act && act.actor_name}`);
  await obDone(p);
  t0 = await now(); const b0 = await books(LP); await unitsSave(p, 10, 'Recount found ten per carton'); m = await unitsMsg(p); rows = await since(t0); const b1 = await books(LP);
  ok(m && m.kind === 'ok' && rows.length === 1 && rows[0].reason === 'adjust' && rows[0].created_by === STAFF && /Recount found ten per carton/.test(rows[0].note || ''), `staff can correct a pallet's count; one adjustment naming staff and the reason: ${m && m.text}`);
  ok(rows[0] && rows[0].qty === 9 && b1['P-61'] - b0['P-61'] === 9 && b1['OB-01'] === b0['OB-01'], `the nine unopened cartons go from 9 to 10 each (+9 at P-61); the opened carton's loose units are not touched: ${rows[0] && rows[0].qty}`);
  await shot(p, '09-staff-corrections'); await st.close();

  // ================= pick correction =================
  section('Pick correction: the floor login');
  await order('CE-ORD-F', F.sku, 6);
  p = fl.p; await p.goto(`${WEB}/#orders`); await p.reload(); await p.waitForTimeout(900);
  await p.locator('.brandlist button', { hasText: 'Synthetic Records' }).click(); await p.waitForTimeout(700);
  await p.locator('[data-testid=start-wave]').click(); await p.waitForSelector('[data-testid=stop]');
  let stop = norm(await p.locator('[data-testid=stop]').innerText()); ok(new RegExp(`Go to P-62 Pallet ${F.psku}`).test(stop) && /Pick 6/.test(stop), `the floor login's wave: ${stop.slice(0, 90)}`);
  await p.locator('.scanbox input').fill(F.cartons[0]); await p.locator('.scanbox input').press('Enter'); await p.waitForSelector('[data-testid=return-prompt]');
  ok((await books(F.sku))['P-62'] === 94, 'the stop is picked: 94 left at P-62');
  await depart(F); ok(await q1('select status from wms_pallets where id = $1', [F.id]) === 'departed' && (await books(F.sku))['P-62'] === 94, 'the pallet then leaves the building (release accepted by Nexus, staged at the database): departed, nothing deducted');
  l0 = await ledger(); n0 = rpcs.length;
  await p.getByRole('button', { name: 'Go back to the last stop' }).click(); await p.waitForTimeout(700);
  const pr = norm(await p.locator('[data-testid=return-prompt]').innerText());
  ok(/has left the shared floor\. A manager returns these units/.test(pr), `the normal reopen is refused and the screen says a manager is needed: ${pr.slice(pr.indexOf('PSKU'), pr.indexOf('PSKU') + 120)}`);
  ok(await p.locator('[data-testid=pick-correct-ask]').count() === 1 && await p.locator('[data-testid=pick-correct]').count() === 0 && await p.locator('[data-testid=fix-go]').count() === 0, 'the floor login is told to ask a manager and is NOT offered the correction form');
  ok(sent('wms_pick_correct', n0).length === 0 && (await ledger()).n === l0.n, 'no correction was sent, nothing posted');
  const fTask = await q1('select t.id from wms_wave_tasks t where t.pallet_id = $1', [F.id]);
  await shot(p, '10-floor-pick-ask-manager');

  section('Pick correction: can a manager reach the floor login\'s stop from their own screen?');
  const ad2 = await signIn('admin', '#orders'); p = ad2.p; await p.locator('.brandlist button', { hasText: 'Synthetic Records' }).click(); await p.waitForTimeout(900);
  const mgr = norm(await p.locator('body').innerText());
  const reach = await p.locator('[data-testid=pick-correct]').count() > 0 || /Return the units to the shelf/.test(mgr);
  console.log(`     the admin's Orders screen for the brand: ${mgr.slice(mgr.indexOf('Synthetic Records.'), mgr.indexOf('Synthetic Records.') + 260)}`);
  if (!reach) findings.push('Pick correction: the form appears only on the wave of the login that picked it. A floor picker is told to "ask a manager: they return them to a shelf from this screen", but a manager who signs in sees only their own wave; the floor picker\'s stop cannot be opened from the manager\'s screen. The correction itself works for that stop when called directly (checked below over HTTP).');
  ok(true, `recorded, not a pass or fail: the manager ${reach ? 'CAN' : 'CANNOT'} reach the floor picker's stop from their own Orders screen`);
  await shot(p, '11-admin-sees-other-wave');

  section('Pick correction as admin, on the admin\'s own wave');
  await order('CE-ORD-A', M.sku, 6); await p.reload(); await p.waitForTimeout(900); await p.locator('.brandlist button', { hasText: 'Synthetic Records' }).click(); await p.waitForTimeout(700);
  await p.locator('[data-testid=start-wave]').click(); await p.waitForSelector('[data-testid=stop]');
  stop = norm(await p.locator('[data-testid=stop]').innerText()); ok(new RegExp(`Go to P-63 Pallet ${M.psku}`).test(stop), `the admin's wave: ${stop.slice(0, 90)}`);
  await p.locator('.scanbox input').fill(M.cartons[0]); await p.locator('.scanbox input').press('Enter'); await p.waitForSelector('[data-testid=return-prompt]');
  await depart(M); l0 = await ledger(); n0 = rpcs.length;
  await p.getByRole('button', { name: 'Go back to the last stop' }).click(); await p.waitForSelector('[data-testid=pick-correct]');
  ok(await p.locator('[data-testid=fix-go]').isDisabled(), 'the manager is offered the correction form; its button is locked with nothing entered');
  await p.locator('[data-testid=fix-to]').fill('A-01'); await p.locator('[data-testid=fix-why]').fill('abcd'); ok(await p.locator('[data-testid=fix-go]').isDisabled(), 'a four-letter reason keeps it locked');
  await p.locator('[data-testid=fix-to]').fill(''); await p.locator('[data-testid=fix-why]').fill('Order changed after the pallet shipped'); ok(await p.locator('[data-testid=fix-go]').isDisabled(), 'no shelf keeps it locked');
  await p.locator('[data-testid=fix-to]').fill('P-65'); await p.locator('[data-testid=fix-go]').click(); await p.waitForTimeout(700);
  let perr = norm(await p.locator('[data-testid=return-prompt] .strip.bad').first().innerText());
  ok(/P-65 is a shared Nexus position\. Returned units go to a ShipBay shelf\./.test(perr) && (await ledger()).n === l0.n && await p.locator('[data-testid=pick-correct]').count() === 1, `a shared position as the shelf is refused, the form stays, nothing posted: ${perr}`);
  await p.locator('[data-testid=fix-to]').fill('ZZ-99'); await p.locator('[data-testid=fix-go]').click(); await p.waitForTimeout(700); perr = norm(await p.locator('[data-testid=return-prompt] .strip.bad').first().innerText());
  ok(/Name the ShipBay shelf the units are going back to\./.test(perr) && (await ledger()).n === l0.n, `a shelf that is not on file is refused: ${perr}`);
  await shot(p, '12-admin-pick-correct-refused');
  t0 = await now(); await p.locator('[data-testid=fix-to]').fill('A-01'); await p.locator('[data-testid=fix-go]').click(); await p.waitForSelector('[data-testid=stop]'); rows = await since(t0);
  stop = norm(await p.locator('[data-testid=stop]').innerText());
  ok(/Go to A-01/.test(stop) && /Pick 6/.test(stop) && await p.locator('[data-testid=pick-correct]').count() === 0, `the correction is accepted: the stop is open again, at the shelf: ${stop.slice(0, 80)}`);
  c1 = sent('wms_pick_correct', n0).pop(); ok(c1 && c1.as === 'admin' && c1.status === 200 && c1.args.p_kind === 'wave_stop' && c1.args.p_to_location === 'A-01', 'sent under the admin login\'s own token');
  ok(rows.length === 1 && rows[0].qty === 6 && rows[0].at === 'A-01' && rows[0].created_by === ADMIN && /Order changed after the pallet shipped/.test(rows[0].note || ''), `ledger: ONE row, +6 at A-01, naming the admin and the reason (${rows.map((r) => `${r.reason} ${r.qty} ${r.at} "${r.note}"`).join(', ')})`);
  ok(JSON.stringify(await books(M.sku)) === JSON.stringify({ 'A-01': 6, 'P-63': 94 }), `the books: the 6 are on A-01, and nothing went back to the position the pallet left: ${JSON.stringify(await books(M.sku))}`);
  act = await activity('pick_corrected', M.psku); ok(act && act.actor === ADMIN && act.detail.returned_to === 'A-01' && /Order changed/.test(JSON.stringify(act.detail)), `the activity log has who, where and why: ${act && JSON.stringify(act.detail)}`);
  await shot(p, '13-admin-pick-corrected');
  await p.locator('[data-testid=confirm-stop]').click(); await p.waitForTimeout(700);
  ok(/Scan the barcode/.test(await p.locator('[data-testid=pick-err]').innerText()) && (await books(M.sku))['A-01'] === 6, 'picking it again from the shelf still asks for the barcode; nothing moved without it');
  await p.locator('.scanbox input').fill(M.cartons[0]); await p.locator('.scanbox input').press('Enter'); await p.waitForSelector('[data-testid=return-prompt]');
  ok(JSON.stringify(await books(M.sku)) === JSON.stringify({ 'P-63': 94 }), 'and with the scan the stop is picked again from the shelf: A-01 back to nothing');
  await ad2.close();

  section('Pick correction as shipbay_staff, on the staff login\'s own wave');
  await order('CE-ORD-S', St.sku, 6); const st2 = await signIn('staff', '#orders'); p = st2.p; await p.locator('.brandlist button', { hasText: 'Synthetic Records' }).click(); await p.waitForTimeout(700);
  await p.locator('[data-testid=start-wave]').click(); await p.waitForSelector('[data-testid=stop]');
  await p.locator('.scanbox input').fill(St.cartons[0]); await p.locator('.scanbox input').press('Enter'); await p.waitForSelector('[data-testid=return-prompt]'); await depart(St);
  await p.getByRole('button', { name: 'Go back to the last stop' }).click(); await p.waitForSelector('[data-testid=pick-correct]');
  t0 = await now(); await p.locator('[data-testid=fix-to]').fill('A-02'); await p.locator('[data-testid=fix-why]').fill('Customer cancelled after the pallet left'); await p.locator('[data-testid=fix-go]').click(); await p.waitForSelector('[data-testid=stop]'); rows = await since(t0);
  ok(rows.length === 1 && rows[0].qty === 6 && rows[0].at === 'A-02' && rows[0].created_by === STAFF && /Customer cancelled/.test(rows[0].note || ''), `staff is offered the form and the correction posts once, naming staff and the reason: ${rows.map((r) => `${r.reason} ${r.qty} ${r.at}`).join(', ')}`);
  act = await activity('pick_corrected', St.psku); ok(act && act.actor === STAFF, 'the activity log names the staff login'); await shot(p, '14-staff-pick-corrected'); await st2.close();

  // ================= plain HTTP: the logins that must be refused =================
  section('Authenticated HTTP requests to the correction endpoints');
  const snap = async () => JSON.stringify([await ledger(), await q1('select count(*)::int from wms_units'), await q1('select count(*)::int from wms_activity'), await q1(`select md5(string_agg(code || ':' || coalesce(units_per_carton::text, '') || ':' || (open_box_at is not null)::text, ',' order by code)) from wms_cartons`)]);
  const s0 = await snap(); const free = A.cartons[4];
  const wantStaff = /Only ShipBay admin or staff/;
  for (const who of ['floor', 'client']) {
    let r = await call(who, 'wms_correct_units', { p_pallet: B.id, p_item: null, p_units: 5, p_reason: 'Recounted at the position' });
    ok(r.status === 400 && wantStaff.test(r.message || ''), `${who}: count correction refused (${r.status} ${r.message})`);
    r = await call(who, 'wms_open_box_correct', { p_carton_code: free, p_units: 3, p_location: null, p_reason: 'Seven missing' });
    ok(r.status === 400 && (who === 'floor' ? wantStaff : /cannot open a box/).test(r.message || ''), `${who}: open box with a corrected count refused (${r.status} ${r.message})`);
    r = await call(who, 'wms_pick_correct', { p_kind: 'wave_stop', p_id: fTask, p_to_location: 'A-03', p_reason: 'Returned by the picker' });
    ok(r.status === 400 && wantStaff.test(r.message || ''), `${who}: pick correction refused (${r.status} ${r.message})`);
    r = await call(who, '_wms_open_box_do', { p_carton_code: free, p_units: 3, p_location: null, p_reason: 'Seven missing' });
    ok([401, 403, 404].includes(r.status), `${who}: the internal open-box function cannot be called (${r.status} ${r.message})`);
    r = await call(who, null, { org_id: S.org, sku_id: LP, qty: -5, reason: 'adjust', note: 'direct write' }, { table: 'inventory_moves' });
    ok([401, 403].includes(r.status), `${who}: writing a ledger row directly is refused (${r.status} ${r.message})`);
    r = await call(who, null, { units_per_carton: 3 }, { table: 'wms_cartons', method: 'PATCH', query: `?code=eq.${free}` });
    ok((r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0)) && await q1('select units_per_carton from wms_cartons where code = $1', [free]) === 10, `${who}: changing a carton's count directly changes nothing (${r.status}, ${Array.isArray(r.body) ? `${r.body.length} rows` : r.message})`);
    r = await call(who, null, { status: 'void' }, { table: 'wms_pallets', method: 'PATCH', query: `?id=eq.${B.id}` });
    ok((r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0)) && await q1('select status from wms_pallets where id = $1', [B.id]) === 'stored', `${who}: changing a pallet row directly changes nothing (${r.status})`);
  }
  let r = await call('floor', 'wms_open_box', { p_carton_code: free, p_units: 3 }); ok(r.status === 400 && /holds 10 on file, not 3/.test(r.message || ''), `floor: the ordinary open-box function refuses a different count on a put-away carton (${r.message})`);
  r = await call('floor', 'wms_set_units', { p_pallet: B.id, p_item: null, p_units: 5 }); ok(r.status === 400 && /is put away, so changing its count changes stock/.test(r.message || ''), `floor: the ordinary count entry refuses a put-away, counted pallet (${r.message})`);
  r = await call('client', 'wms_set_units', { p_pallet: B.id, p_item: null, p_units: 5 }); ok(r.status === 400 && /cannot change a pallet/.test(r.message || ''), `client: count entry refused (${r.message})`);
  for (const [who, label] of [[null, 'no token'], ['anon', 'the public key only'], ['forged', 'a token signed with the wrong secret']]) {
    const out = [];
    for (const [fn, args] of [['wms_correct_units', { p_pallet: B.id, p_item: null, p_units: 5, p_reason: 'Recounted at the position' }], ['wms_open_box_correct', { p_carton_code: free, p_units: 3, p_location: null, p_reason: 'Seven missing' }], ['wms_pick_correct', { p_kind: 'wave_stop', p_id: fTask, p_to_location: 'A-03', p_reason: 'Returned by the picker' }], ['wms_open_box', { p_carton_code: free, p_units: 10 }], ['wms_set_units', { p_pallet: B.id, p_item: null, p_units: 5 }]]) out.push((await call(who, fn, args)).status);
    ok(out.every((s) => [401, 403, 404].includes(s)), `${label}: all five functions refused before they run (${out.join(', ')})`);
  }
  for (const who of ['admin', 'staff']) {
    r = await call(who, 'wms_correct_units', { p_pallet: B.id, p_item: null, p_units: 5, p_reason: '' }); ok(r.status === 400 && r.message === 'Say why the count is being corrected.', `${who}: passes the role check and is then asked for the reason (${r.message})`);
    r = await call(who, 'wms_open_box_correct', { p_carton_code: free, p_units: 3, p_location: null, p_reason: 'x' }); ok(r.status === 400 && r.message === 'Say why the count differs.', `${who}: open-box correction needs a reason of substance (${r.message})`);
    r = await call(who, 'wms_pick_correct', { p_kind: 'wave_stop', p_id: fTask, p_to_location: 'A-03', p_reason: 'no' }); ok(r.status === 400 && r.message === 'Say why this pick is being corrected.', `${who}: pick correction needs a reason (${r.message})`);
    r = await call(who, '_wms_open_box_do', { p_carton_code: free, p_units: 3, p_location: null, p_reason: 'Seven missing' }); ok([401, 403, 404].includes(r.status), `${who}: even ${who} cannot call the internal function directly (${r.status})`);
  }
  ok(await snap() === s0, 'after every request above: ledger, unit labels, activity log and carton counts are exactly as before');
  // the floor picker's stranded stop: the correction works for it when an admin calls it (there is no screen path to it)
  t0 = await now(); r = await call('admin', 'wms_pick_correct', { p_kind: 'wave_stop', p_id: fTask, p_to_location: 'A-03', p_reason: 'Floor picker asked a manager' }); rows = await since(t0);
  ok(r.status === 200 && rows.length === 1 && rows[0].qty === 6 && rows[0].at === 'A-03' && rows[0].created_by === ADMIN, `admin over HTTP: the floor picker's stop is corrected, +6 at A-03 once (${r.status} ${r.message || ''})`);
  p = fl.p; await p.reload(); await p.waitForTimeout(900); await p.locator('.brandlist button', { hasText: 'Synthetic Records' }).click(); await p.waitForSelector('[data-testid=stop]');
  stop = norm(await p.locator('[data-testid=stop]').innerText()); ok(/Go to A-03/.test(stop) && /Pick 6/.test(stop), `and the floor login's screen then sends the picker to the shelf: ${stop.slice(0, 70)}`);
  await fl.close();

  // ================= the books after everything =================
  section('Inventory integrity after the whole run');
  const neg = await q(`select s.sku, coalesce(l.code, '-') at, sum(m.qty)::int n from inventory_moves m join skus s on s.id = m.sku_id left join locations l on l.id = m.location_id group by 1, 2 having sum(m.qty) < 0`);
  ok(neg.length === 0, `no position below zero${neg.length ? `: ${JSON.stringify(neg)}` : ''}`);
  const dup = await q(`select ref_id, sku_id, location_id, count(*) from inventory_moves where reason = 'receive' and ref_type = 'wms_pallet' group by 1, 2, 3 having count(*) > 1`);
  ok(dup.length === 0, 'no pallet received twice at one place');
  const rc = await q(`select p.psku, count(*)::int n, sum(m.qty)::int u from inventory_moves m join wms_pallets p on p.id = m.ref_id where m.reason = 'receive' and m.ref_type = 'wms_pallet' group by 1 order by 1`);
  ok(rc.length === 6 && rc.every((x) => x.n === 1 && x.u === 100), `each of the six put-away pallets has exactly one receipt of 100: ${rc.map((x) => `${x.psku} ${x.n}:${x.u}`).join(', ')}`);
  const trn = await q(`select ref_id, sum(qty)::int n, count(*)::int c from inventory_moves where reason = 'transfer' group by 1`);
  ok(trn.length === 2 && trn.every((x) => x.n === 0) && trn.reduce((s, x) => s + x.c, 0) === 8, 'transfers: four opened cartons, four pairs, every pair nets to zero');
  const adj = await q(`select m.qty, coalesce(l.code, '-') at, m.note, m.created_by, m.ref_id from inventory_moves m left join locations l on l.id = m.location_id where m.reason not in ('receive', 'transfer', 'pick') order by m.created_at`);
  ok(adj.length === 5 && adj.every((x) => [ADMIN, STAFF].includes(x.created_by) && /: \S.{8,}/.test(x.note || '') && [A.id, B.id].includes(x.ref_id)), `every adjustment is explained: ${adj.length} rows, each by admin or staff, each with its reason and its pallet (${adj.map((x) => `${x.qty}@${x.at}`).join(' ')})`);
  ok(adj.reduce((s, x) => s + x.qty, 0) === -2 + 2 - 10 - 2 + 9, 'and they add up to exactly what was corrected on the screens: -2, +2, -10, -2, +9');
  const ret = await q(`select m.qty, coalesce(l.code, '-') at, m.note, m.created_by, m.ref_type, m.pallet_id, coalesce(l.shared, false) shared from inventory_moves m left join locations l on l.id = m.location_id where m.reason = 'pick' and m.qty > 0 order by m.created_at`);
  ok(ret.length === 3 && ret.every((x) => x.qty === 6 && !x.shared && [ADMIN, STAFF].includes(x.created_by) && /stop corrected by Test (Admin|Staff).*: \S.{8,}/.test(x.note || '') && x.ref_type === 'wave_task' && x.pallet_id === null), `the three returned picks: +6 each onto a private shelf (${ret.map((x) => x.at).join(', ')}), each naming the manager, the stop and the reason, none tied to the pallet that left`);
  const out = await q(`select m.qty, coalesce(l.code, '-') at, m.pallet_id from inventory_moves m left join locations l on l.id = m.location_id where m.reason = 'pick' and m.qty < 0 order by m.created_at`);
  ok(out.length === 4 && out.filter((x) => x.pallet_id).map((x) => x.at).join() === 'P-62,P-63,P-64' && out.filter((x) => !x.pallet_id).map((x) => x.at).join() === 'A-01', 'picks: the three from pallets name their pallet and its position; the re-pick from the shelf is a shelf pick');
  const picks = await q1(`select coalesce(sum(qty), 0)::int from inventory_moves where reason = 'pick'`);
  const tot = await ledger(); ok(picks === -6 && tot.u === 600 - 3 - 6, `one ledger: 600 received, -3 corrected, ${picks} picked net = ${tot.u} on the books`);
  const anon = await q(`select reason, count(*)::int n from inventory_moves where created_by is null group by 1`);
  if (anon.length) findings.push(`Ledger rows with no person on them: ${anon.map((x) => `${x.n} ${x.reason}`).join(', ')}. These are the put-away receipts this test staged the way the bridge commits them (service login, after Nexus accepts). Who scanned is on the Nexus journal row and on the pallet, not on the ledger row.`);
  ok(await q1(`select count(*)::int from inventory_moves where created_by is null and reason <> 'receive'`) === 0, `every correction, transfer and pick row names the login that made it (rows with no person: ${anon.map((x) => `${x.n} ${x.reason}`).join(', ') || 'none'})`);
  const view = await q1(`select coalesce(sum(on_hand), 0)::int from inventory_levels`).catch(() => null);
  ok(view === null || view === tot.u, `the stock view agrees with the ledger (${view})`);
  const att = await q(`select m.reason, count(*)::int n from inventory_moves m where m.ref_type = 'wms_pallet' and not exists (select 1 from wms_pallets p where p.id = m.ref_id) group by 1`);
  ok(att.length === 0 && await q1(`select count(*)::int from inventory_moves where location_id is null`) === 0, 'every row names a position, and every pallet row names a pallet on file');
  ok(JSON.stringify(await books(LP)) === JSON.stringify({ 'OB-01': 37, 'P-01': 100, 'P-60': 70, 'P-61': 90 }), `the LP product by place: ${JSON.stringify(await books(LP))} (P-01 is PSKU-000001's 100; OB-01 holds the 10 + 8 + 12 + 7 loose units)`);
  ok(await q1('select count(*)::int from wms_units') === 37 && await q1(`select count(*)::int from wms_nexus_ops where state in ('pending','out_of_sync')`) === 0, '37 unit labels for 37 loose units; no request left open');
  ok(await keepRow() === keep0 && await q1(`select p.status || ' ' || l.code from wms_pallets p join locations l on l.id = p.location_id where p.psku = 'PSKU-000001'`) === 'stored P-01', 'PSKU-000001: its row, its one receipt of 100, its journal entry and its cartons are byte-for-byte as before; still stored at P-01');

  section('The run itself');
  ok(blocked.length === 0, `no request left this machine (${blocked.length} blocked)`);
  ok(errors.length === 0, `no page error${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  const byWho = {}; rpcs.forEach((x) => { byWho[x.who] = byWho[x.who] || new Set(); byWho[x.who].add(x.as); });
  ok(Object.entries(byWho).every(([w, set]) => set.size === 1 && set.has(w)), `every function call from a browser carried the token of the login that browser was signed in as (${Object.entries(byWho).map(([w, s]) => `${w}: ${[...s].join('/')}`).join(', ')})`);
  await browser.close(); server.close(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); if (findings.length) console.log(`\nFINDINGS (${findings.length}):\n- ${findings.join('\n- ')}`);
  fs.writeFileSync(`${E}/result.json`, JSON.stringify({ pass, fail, findings }, null, 1));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('STOPPED:', e.message.split('\n')[0]); await onStop(); try { await db.end(); } catch { /* closed */ } process.exit(2); });
