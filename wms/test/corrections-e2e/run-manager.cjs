// Manager access to pick corrections, in a real browser (Chromium), in the WHOLE WMS app, against the local stack: real
// database functions, real PostgREST checking every token, the synthetic logins (admin, staff, floor, a client in each brand).
// Then the two new endpoints over plain HTTP as every login that must be refused. Seeded by stack.mjs with SEED=manager.
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
  const netBlocked = []; const errors = []; const rpcs = []; const pages = [];
  // a signed-in browser: the app's own session store holds the login's token, as after a real sign-in
  const signIn = async (who, hash) => {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
    await ctx.route('**/*', (r) => { const u = r.request().url(); const h = u.startsWith('http') ? new URL(u).hostname : '127.0.0.1'; if (h === '127.0.0.1') return r.fallback(); netBlocked.push(u); return r.abort(); });
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
  const _unused = async (p, pal) => { if (await p.locator('button.back').count()) { await p.locator('button.back').click(); await p.waitForSelector('.toolbar .scanbox'); }
    const i = p.locator('.toolbar .scanbox input'); await i.fill(pal.psku); await i.press('Enter'); await p.waitForSelector('.unitsbox'); await p.waitForTimeout(500); };

  if (S.seed !== 'manager') throw new Error('start the stack with SEED=manager');
  const { F1, F2, K, X } = S.pallets; const A = S.org, B = S.org2; const ADMIN = S.users.admin, STAFF = S.users.staff; const keep0 = await keepRow();
  const WHO2 = { ...WHO }; let l0, n0, t0, rows, r;
  const task = (p) => q1('select id from wms_wave_tasks where pallet_id = $1 or id = (select ref_id from inventory_moves where pallet_id = $1 and ref_type = \'wave_task\' limit 1) limit 1', [p.id]);
  const order2 = async (org, no, sku, qty) => { const id = await q1(`insert into orders (org_id, order_number, source, status, customer_name, ship_to, total_units) values ($1,$2,'connector','new','Pat Example','{"name":"Pat Example","address1":"1 Test Way","city":"Testville","province_code":"NJ","zip":"08844","country_code":"US"}'::jsonb,$3) returning id`, [org, no, qty]);
    await q('insert into order_lines (order_id, sku_id, sku, name, qty) select $1, id, sku, name, $3 from skus where id = $2', [id, sku, qty]); return id; };
  const picked = async (who, org, picks) => { const w = (await as(who, 'select wms_wave_start($1) j', [org]))[0].j.wave; for (const [p, qty] of picks) { const t = w.tasks.find((x) => x.psku === p.psku); await as(who, 'select wms_wave_confirm($1,$2,$3)', [t.id, qty, p.cartons[0]]); p.task = t.id; } return w; };
  const mgrRows = async (p) => { const out = []; for (const row of await p.locator('[data-testid=mgr-stop]').all()) out.push(norm(await row.innerText())); return out; };
  const openBrand = async (p, name) => { if (await p.locator('.backlink').count()) { await p.locator('.backlink').click(); await p.waitForTimeout(300); } await p.locator('.brandlist button', { hasText: name }).click(); await p.waitForTimeout(900); };
  const strip = async (p) => ((await p.locator('.wv-start').locator('xpath=preceding-sibling::div[contains(@class,"strip")]').count()) ? norm(await p.locator('.wv-start').locator('xpath=preceding-sibling::div[contains(@class,"strip")]').first().innerText()) : null);

  // ================= staged at the database, as the logins themselves: three pickers' picks, then the pallets leave =================
  section('Staged: the floor login picks on two brands, staff picks and goes to the pack station, then all four pallets leave');
  await order2(A, 'MG-O1', F1.sku, 6); await order2(A, 'MG-O2', F2.sku, 6); const wA = await picked('floor', A, [[F1, 6], [F2, 4]]);
  await order2(B, 'MG-O3', X.sku, 7); const wB = await picked('floor', B, [[X, 7]]);
  await order2(A, 'MG-O4', K.sku, 6); const wS = await picked('staff', A, [[K, 6]]); await as('staff', 'select wms_wave_to_pack($1)', [wS.id]);
  for (const p of [F1, F2, X, K]) await depart(p);
  ok((await q('select status from wms_pallets where id = any($1)', [[F1.id, F2.id, X.id, K.id]])).every((x) => x.status === 'departed'), `four pallets departed; the floor login's wave ${wA.seq} (brand A) and ${wB.seq} (brand B) are still being picked, staff's wave ${wS.seq} is at the pack station`);
  ok(JSON.stringify([await books(F1.sku), await books(F2.sku), await books(X.sku), await books(K.sku)]) === JSON.stringify([{ 'P-60': 94 }, { 'P-61': 96 }, { 'P-63': 93 }, { 'P-62': 94 }]), 'the books: 6, 4 (short of 6), 7 and 6 picked; nothing deducted by the releases');

  // ================= the client login =================
  section('A client login');
  { const c = await signIn('client', '#orders'); const body = norm(await c.p.locator('body').innerText()); ok(/isn.t set up for the WMS/.test(body) && !/waiting for a manager/.test(body) && rpcs.filter((x) => x.who === 'client').length === 0, 'turned away by the app; nothing called'); await c.close(); }

  // ================= the floor login =================
  section('The floor login: told where the manager finds it, offered nothing more');
  const fl = await signIn('floor', '#orders'); let p = fl.p; await openBrand(p, 'Synthetic Records'); await p.waitForSelector('[data-testid=return-prompt]'); l0 = await ledger(); n0 = rpcs.length;
  await p.getByRole('button', { name: 'Go back to the last stop' }).click(); await p.waitForTimeout(700);
  const ask = (await p.locator('[data-testid=pick-correct-ask]').count()) ? norm(await p.locator('[data-testid=pick-correct-ask]').innerText()) : '';
  ok(new RegExp(`ask a manager\\. On their own login they open Orders, Synthetic Records, and return them to a shelf under .Picks waiting for a manager. \\(wave ${wA.seq}\\)`).test(ask), `the reopen is refused and the screen says where the manager finds it: ${ask}`);
  ok(await p.locator('[data-testid=pick-correct]').count() === 0 && await p.locator('[data-testid=mgr-stops]').count() === 0 && await p.locator('[data-testid=mgr-waiting]').count() === 0, 'no correction form, no manager list, no manager notice on the floor login\'s screens');
  ok(rpcs.filter((x) => x.who === 'floor' && /wms_manager_|wms_pick_correct/.test(x.fn)).length === 0 && (await ledger()).n === l0.n, 'the floor login\'s browser called neither manager function and nothing was posted');
  await shot(p, 'm01-floor-ask-manager');

  // ================= the admin login =================
  section('Admin: finds the floor picker\'s stops on the brand\'s Orders screen');
  const ad = await signIn('admin', '#orders'); p = ad.p; await openBrand(p, 'Synthetic Records'); await p.waitForSelector('[data-testid=mgr-stops]');
  let list = await mgrRows(p); console.log(`     ${list.join('\n     ')}`);
  ok(list.length === 3, `three picks wait for a manager on Synthetic Records (${list.length})`);
  const rowOf = (sku) => p.locator('[data-testid=mgr-stop]', { hasText: sku });
  ok(new RegExp(`Wave ${wA.seq} · Test Floor \\(synthetic\\) 6 × Synthetic MG-FULL MG-FULL Picked from P-60, pallet ${F1.psku}, which has left the building · order MG-O1 Return to a shelf`).test(norm(await rowOf('MG-FULL').innerText())), 'the floor picker\'s full pick: wave, picker, 6 units, item, position, pallet, order, and a button');
  ok(/ 4 of 6 × Synthetic MG-SHORT .*Picked from P-61/.test(norm(await rowOf('MG-SHORT').innerText())) && await rowOf('MG-SHORT').locator('[data-testid=mgr-open]').count() === 1, 'the short pick shows "4 of 6" and can be corrected');
  const blocked = norm(await rowOf('MG-PACK').innerText());
  ok(new RegExp(`Wave ${wS.seq} is at the pack station\\. A pick cannot be returned to a shelf from there; nothing was changed\\.`).test(blocked) && await rowOf('MG-PACK').locator('[data-testid=mgr-open]').count() === 0, `staff's pick at the pack station is listed with the reason it cannot be corrected, and no button: ${blocked.slice(blocked.lastIndexOf('Wave'))}`);
  ok(!list.join(' ').includes('MG-OTHER') && !list.join(' ').includes('MG-O3'), 'nothing of the other brand is on this brand\'s list');
  await shot(p, 'm02-admin-list');

  section('Admin: the form, its refusals, and the correction');
  l0 = await ledger(); n0 = rpcs.length; await rowOf('MG-FULL').locator('[data-testid=mgr-open]').click(); await p.waitForSelector('[data-testid=mgr-form]');
  ok(await p.locator('[data-testid=mgr-go]').isDisabled(), 'the button is locked with nothing entered');
  await p.locator('[data-testid=mgr-to]').fill('A-01'); await p.locator('[data-testid=mgr-why]').fill('abcd'); ok(await p.locator('[data-testid=mgr-go]').isDisabled(), 'a four-letter reason keeps it locked');
  await p.locator('[data-testid=mgr-to]').fill(''); await p.locator('[data-testid=mgr-why]').fill('Order changed after the pallet shipped'); ok(await p.locator('[data-testid=mgr-go]').isDisabled() && rpcs.length === n0, 'no shelf keeps it locked; nothing has been sent');
  await p.locator('[data-testid=mgr-to]').fill('P-65'); await p.locator('[data-testid=mgr-go]').click(); await p.waitForTimeout(700); let e = norm(await p.locator('.strip.bad').first().innerText());
  ok(/P-65 is a shared Nexus position\. Returned units go to a ShipBay shelf\./.test(e) && (await ledger()).n === l0.n && await p.locator('[data-testid=mgr-form]').count() === 1, `a shared position as the shelf is refused, the form stays, nothing posted: ${e}`);
  await p.locator('[data-testid=mgr-to]').fill('ZZ-99'); await p.locator('[data-testid=mgr-go]').click(); await p.waitForTimeout(700); e = norm(await p.locator('.strip.bad').first().innerText());
  ok(/Name the ShipBay shelf the units are going back to\./.test(e) && (await ledger()).n === l0.n, `a shelf that is not on file is refused: ${e}`);
  await shot(p, 'm03-admin-refused');
  t0 = await now(); await p.locator('[data-testid=mgr-to]').fill('A-01'); await p.locator('[data-testid=mgr-go]').click(); await p.waitForSelector('[data-testid=mgr-done]'); rows = await since(t0);
  const said = norm(await p.locator('[data-testid=mgr-done]').innerText());
  ok(new RegExp(`6 units returned to A-01\\. Test Floor \\(synthetic\\)'s wave ${wA.seq} now sends the picker to that shelf\\.`).test(said), `accepted, and the screen says what happened: ${said}`);
  let c1 = sent('wms_manager_stop_correct', n0).pop();
  ok(c1 && c1.as === 'admin' && c1.status === 200 && c1.args.p_org === A && c1.args.p_task === F1.task && c1.args.p_to_location === 'A-01', 'sent under the admin login\'s own token, naming the brand and the stop');
  ok(rows.length === 1 && rows[0].qty === 6 && rows[0].reason === 'pick' && rows[0].at === 'A-01' && rows[0].created_by === ADMIN && rows[0].ref_id === F1.task && rows[0].pallet_id === null && /stop corrected by Test Admin \(synthetic\): Order changed after the pallet shipped/.test(rows[0].note || ''), `ledger: ONE row, +6 on A-01, naming the admin, the stop and the reason: "${rows[0] && rows[0].note}"`);
  let act = await activity('pick_corrected', F1.psku); ok(act && act.actor === ADMIN && act.detail.returned_to === 'A-01' && act.detail.reason === 'Order changed after the pallet shipped' && Number(act.detail.wave) === wA.seq, `activity log: who, where, why, which wave: ${act && JSON.stringify(act.detail)}`);
  ok(JSON.stringify(await books(F1.sku)) === JSON.stringify({ 'A-01': 6, 'P-60': 94 }), 'the books: 6 on A-01, nothing put back at the position the pallet left');
  list = await mgrRows(p); ok(list.length === 2 && !list.join(' ').includes('MG-FULL') && await p.locator('[data-testid=mgr-form]').count() === 0, 'the corrected pick is off the list and the form has closed');
  await shot(p, 'm04-admin-corrected');

  section('Admin: the other brand has its own list');
  await openBrand(p, 'Synthetic Mailers'); await p.waitForSelector('[data-testid=mgr-stops]'); list = await mgrRows(p);
  ok(list.length === 1 && /MG-OTHER/.test(list[0]) && / 7 × .*Picked from P-63/.test(list[0]) && !/MG-SHORT|MG-PACK|MG-O2|MG-O4/.test(list[0]), `Synthetic Mailers lists only its own pick: ${list[0]}`);
  t0 = await now(); await p.locator('[data-testid=mgr-open]').click(); await p.locator('[data-testid=mgr-to]').fill('A-02'); await p.locator('[data-testid=mgr-why]').fill('Customer cancelled after the pallet left'); await p.locator('[data-testid=mgr-go]').click(); await p.waitForSelector('[data-testid=mgr-done]'); rows = await since(t0);
  ok(rows.length === 1 && rows[0].qty === 7 && rows[0].at === 'A-02' && rows[0].created_by === ADMIN && await q1('select org_id from inventory_moves where ref_id = $1 and qty > 0', [X.task]) === B, 'corrected under its own brand: one row, +7 on A-02, the row belongs to Synthetic Mailers');
  ok(await p.locator('[data-testid=mgr-stops]').count() === 0, 'with nothing left the section is gone'); await ad.close();

  // ================= the staff login, in the middle of their own wave =================
  section('Staff, in the middle of their own wave: still reaches the list, corrects the short pick');
  const st = await signIn('staff', '#orders'); p = st.p; await openBrand(p, 'Synthetic Records'); await p.waitForSelector('[data-testid=mgr-waiting]');
  const note = norm(await p.locator('[data-testid=mgr-waiting]').innerText()); ok(/^2 picks on this brand are waiting for a manager\./.test(note) && /Pack station|pack/i.test(norm(await p.locator('body').innerText())), `the staff login lands on their own wave, with a notice above it: ${note}`);
  await p.locator('[data-testid=mgr-waiting] button').click(); await p.waitForSelector('[data-testid=mgr-stops]'); list = await mgrRows(p);
  ok(list.length === 2 && /MG-SHORT/.test(list.join(' ')) && /MG-PACK/.test(list.join(' ')), 'and "Show" opens the list: the floor picker\'s short pick, and their own at the pack station (refused)');
  t0 = await now(); n0 = rpcs.length; await p.locator('[data-testid=mgr-stop]', { hasText: 'MG-SHORT' }).locator('[data-testid=mgr-open]').click(); await p.locator('[data-testid=mgr-to]').fill('A-03'); await p.locator('[data-testid=mgr-why]').fill('Short pick, pallet gone, back to stock'); await p.locator('[data-testid=mgr-go]').click(); await p.waitForSelector('[data-testid=mgr-done]'); rows = await since(t0);
  ok(/4 units returned to A-03/.test(norm(await p.locator('[data-testid=mgr-done]').innerText())) && rows.length === 1 && rows[0].qty === 4 && rows[0].at === 'A-03' && rows[0].created_by === STAFF && /corrected by Test Staff \(synthetic\): Short pick, pallet gone, back to stock/.test(rows[0].note || ''), `the short pick returns exactly the 4 that were picked, once, naming staff and the reason: "${rows[0] && rows[0].note}"`);
  ok(sent('wms_manager_stop_correct', n0).pop()?.as === 'staff', 'sent under the staff login\'s own token');
  const back = p.locator('[data-testid=start-wave]'); ok(norm(await back.innerText()) === 'Go back to your wave' && !(await back.isDisabled()), 'the staff login can go back to their own wave from here');
  await back.click(); await p.waitForTimeout(900); ok(/pack/i.test(norm(await p.locator('body').innerText())) && await p.locator('[data-testid=mgr-stops]').count() === 0, 'and does');
  await shot(p, 'm05-staff'); await st.close();

  // ================= the floor picker carries on =================
  section('The floor picker\'s own screen after the corrections');
  p = fl.p; await p.reload(); await p.waitForTimeout(900); await openBrand(p, 'Synthetic Records'); await p.waitForSelector('[data-testid=stop]');
  const stop = norm(await p.locator('[data-testid=stop]').innerText()); ok(/Go to A-0[13]/.test(stop), `the wave is open again and sends the picker to the shelf: ${stop.slice(0, 80)}`);
  ok(JSON.stringify((await q(`select l.code, t.qty_planned, t.confirmed_at is null open, t.pallet_id is null shelf from wms_wave_tasks t join locations l on l.id = t.location_id where t.wave_id = $1 order by l.code`, [wA.id])).map((x) => [x.code, x.qty_planned, x.open, x.shelf])) === JSON.stringify([['A-01', 6, true, true], ['A-03', 6, true, true]]), 'both stops are open at their shelves, still for the 6 each order needs');
  await fl.close();

  // ================= plain HTTP =================
  section('Authenticated HTTP requests to the two new endpoints');
  const snap = async () => JSON.stringify([await ledger(), await q1('select count(*)::int from wms_activity'), await q1(`select md5(string_agg(id::text || coalesce(qty_picked::text, '-') || location_id::text, ',' order by id)) from wms_wave_tasks`), await q1(`select md5(string_agg(id::text || role, ',' order by id)) from profiles`)]);
  const s0 = await snap(); const fixArgs = (org, t) => ({ p_org: org, p_task: t, p_to_location: 'A-01', p_reason: 'Tried over HTTP' });
  for (const who of ['floor', 'client', 'client2']) {
    r = await call(who, 'wms_manager_stops', { p_org: A }); ok(r.status === 400 && /Only ShipBay admin or staff can see picks waiting for a manager/.test(r.message || ''), `${who}: the list for brand A refused (${r.status} ${r.message})`);
    r = await call(who, 'wms_manager_stops', { p_org: B }); ok(r.status === 400 && /Only ShipBay admin or staff/.test(r.message || ''), `${who}: the list for brand B refused`);
    r = await call(who, 'wms_manager_stop_correct', fixArgs(A, K.task)); ok(r.status === 400 && /Only ShipBay admin or staff can correct a pick/.test(r.message || ''), `${who}: the correction refused (${r.status} ${r.message})`);
    r = await call(who, 'wms_pick_correct', { p_kind: 'wave_stop', p_id: K.task, p_to_location: 'A-01', p_reason: 'Tried over HTTP' }); ok(r.status === 400 && /Only ShipBay admin or staff/.test(r.message || ''), `${who}: the function underneath refused`);
    r = await call(who, '_wms_stop_correct_block', { p_task: K.task }); ok([401, 403, 404].includes(r.status), `${who}: the internal check cannot be called (${r.status})`);
  }
  // a floor login trying to make itself a manager
  r = await call('floor', null, { role: 'shipbay_staff' }, { table: 'profiles', method: 'PATCH', query: `?id=eq.${S.users.floor}` });
  ok((r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0)) && await q1('select role from profiles where id = $1', [S.users.floor]) === 'wms_employee', `floor: changing its own role is refused or touches nothing; it is still wms_employee (${r.status} ${r.message || ''})`);
  r = await call('floor', null, { id: '5b000000-0000-4000-8000-0000000000ff', role: 'shipbay_admin', email: 'x@example.test' }, { table: 'profiles' }); ok(r.status >= 400 && await q1(`select count(*)::int from profiles where role in ('shipbay_admin','shipbay_staff')`) === 2, `floor: creating a manager profile is refused (${r.status})`);
  r = await call('floor', 'wms_manager_stops', { p_org: A }); ok(r.status === 400, 'floor: and the list is still refused afterwards');
  for (const [who, label] of [[null, 'no token'], ['anon', 'the public key only'], ['forged', 'a token signed with the wrong secret']]) {
    const out = [(await call(who, 'wms_manager_stops', { p_org: A })).status, (await call(who, 'wms_manager_stop_correct', fixArgs(A, K.task))).status, (await call(who, '_wms_stop_correct_block', { p_task: K.task })).status];
    ok(out.every((x) => [401, 403, 404].includes(x)), `${label}: refused before anything runs (${out.join(', ')})`);
  }
  for (const who of ['admin', 'staff']) {
    r = await call(who, 'wms_manager_stop_correct', fixArgs(B, K.task)); ok(r.status === 400 && r.message === "That stop is not one of this brand's.", `${who}: brand A's stop under brand B's name is refused (${r.message})`);
    r = await call(who, 'wms_manager_stop_correct', fixArgs(A, '00000000-0000-4000-8000-00000000dead')); ok(r.status === 400 && r.message === "That stop is not one of this brand's.", `${who}: a stop that does not exist gets the same answer`);
    r = await call(who, 'wms_manager_stop_correct', { ...fixArgs(A, K.task), p_reason: 'no' }); ok(r.status === 400 && r.message === 'Say why this pick is being corrected.', `${who}: a reason is required (${r.message})`);
    r = await call(who, 'wms_manager_stop_correct', fixArgs(A, K.task)); ok(r.status === 400 && /is at the pack station/.test(r.message || ''), `${who}: the pick at the pack station is refused in words (${r.message})`);
    r = await call(who, '_wms_stop_correct_block', { p_task: K.task }); ok([401, 403, 404].includes(r.status), `${who}: the internal check cannot be called directly (${r.status})`);
    r = await call(who, 'wms_manager_stops', { p_org: B }); ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 0, `${who}: brand B's list is empty now, and never shows brand A's remaining pick`);
  }
  ok(await snap() === s0, 'after every request above: ledger, activity log, every wave stop and every login\'s role are exactly as before');

  // ================= the books =================
  section('Inventory integrity after the whole run');
  const neg = await q(`select s.sku, coalesce(l.code, '-') at, sum(m.qty)::int n from inventory_moves m join skus s on s.id = m.sku_id left join locations l on l.id = m.location_id group by 1, 2 having sum(m.qty) < 0`); ok(neg.length === 0, 'no position below zero');
  const rc = await q(`select p.psku, count(*)::int n, sum(m.qty)::int u from inventory_moves m join wms_pallets p on p.id = m.ref_id where m.reason = 'receive' and m.ref_type = 'wms_pallet' group by 1`); ok(rc.length === 5 && rc.every((x) => x.n === 1 && x.u === 100), 'five put-away pallets, one receipt of 100 each');
  const ret = await q(`select m.qty, l.code at, coalesce(l.shared, false) shared, m.note, m.created_by, m.pallet_id from inventory_moves m join locations l on l.id = m.location_id where m.reason = 'pick' and m.qty > 0 order by m.created_at`);
  ok(ret.map((x) => `${x.qty}@${x.at}`).join(' ') === '6@A-01 7@A-02 4@A-03' && ret.every((x) => !x.shared && [ADMIN, STAFF].includes(x.created_by) && /corrected by Test (Admin|Staff) \(synthetic\): \S.{8,}/.test(x.note || '') && x.pallet_id === null), 'three returns, each onto a private shelf, each naming the manager and the reason, none tied to a pallet that left');
  ok(await q1(`select count(*)::int from inventory_moves where reason not in ('receive', 'pick')`) === 0, 'no adjustment and no transfer was written');
  const tot = await ledger(); ok(tot.u === 500 - 6, `one ledger: 500 received, 6 picked net (staff's order at the pack station) = ${tot.u}`);
  ok(JSON.stringify([await books(F1.sku), await books(F2.sku), await books(X.sku), await books(K.sku)]) === JSON.stringify([{ 'A-01': 6, 'P-60': 94 }, { 'A-03': 4, 'P-61': 96 }, { 'A-02': 7, 'P-63': 93 }, { 'P-62': 94 }]), 'by place: each return sits on its shelf; the pick at the pack station was not touched');
  const over = await q(`select l.code, s.sku, sum(t.qty_planned)::int planned, (select coalesce(sum(m.qty), 0)::int from inventory_moves m where m.sku_id = t.sku_id and m.location_id = t.location_id) on_hand from wms_wave_tasks t join wms_waves w on w.id = t.wave_id join locations l on l.id = t.location_id join skus s on s.id = t.sku_id where w.status = 'picking' and t.confirmed_at is null group by l.code, s.sku, t.sku_id, t.location_id`);
  console.log(`     open stops against stock: ${over.map((x) => `${x.sku} at ${x.code}: ${x.planned} planned, ${x.on_hand} on hand`).join('; ')}`);
  ok(over.length === 3 && over.find((x) => x.sku === 'MG-FULL').on_hand === 6 && over.find((x) => x.sku === 'MG-OTHER').on_hand === 7 && over.find((x) => x.sku === 'MG-SHORT').on_hand === 4, 'reservations: the two full picks\' stops are covered (6 for 6, 7 for 7); the short pick\'s stop asks for the order\'s 6 with the 4 returned there, and the picker can confirm no more than 4');
  ok(await q1(`select count(*)::int from wms_nexus_ops where state in ('pending','out_of_sync')`) === 0, 'no Nexus request left open');
  ok(await keepRow() === keep0 && await q1(`select p.status || ' ' || l.code from wms_pallets p join locations l on l.id = p.location_id where p.psku = 'PSKU-000001'`) === 'stored P-01', 'PSKU-000001: row, receipt, journal entry and cartons byte-for-byte as before; still stored at P-01');

  section('The run itself');
  ok(netBlocked.length === 0, `no request left this machine (${netBlocked.length} blocked)`);
  ok(errors.length === 0, `no page error${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  const byWho = {}; rpcs.forEach((x) => { byWho[x.who] = byWho[x.who] || new Set(); byWho[x.who].add(x.as); });
  ok(Object.entries(byWho).every(([w, set]) => set.size === 1 && set.has(w)), `every function call from a browser carried the token of the login that browser was signed in as (${Object.entries(byWho).map(([w, s]) => `${w}: ${[...s].join('/')}`).join(', ')})`);
  await browser.close(); server.close(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); if (findings.length) console.log(`\nFINDINGS (${findings.length}):\n- ${findings.join('\n- ')}`);
  fs.writeFileSync(`${E}/result-manager.json`, JSON.stringify({ pass, fail, findings }, null, 1));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('STOPPED:', e.message.split('\n')[0]); await onStop(); try { await db.end(); } catch { /* closed */ } process.exit(2); });
