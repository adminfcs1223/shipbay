// WMS Put-away in a real browser against a stand-in bridge on 127.0.0.1 (scripted answers in the bridge's own format). This proves the
// screen: what it sends, what it shows, what it keeps. The bridge's rules are proven in supabase/tests/staging/bridge.test.mjs.
//   OUT=/tmp/pa-e2e VITE_NEXUS_BRIDGE=on VITE_SUPABASE_URL=http://127.0.0.1:4630 VITE_SUPABASE_KEY=stub npx vite build --config test/putaway-e2e/vite.config.js && BUILD=/tmp/pa-e2e node test/putaway-e2e/run.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const BUILD = process.env.BUILD; let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const norm = (t) => t.replace(/\s+/g, ' ').trim();
(async () => {
  const st = { status: { ok: true, connection: 'staging', floor: 'HILLSBOROUGH-TEST', pallet_moves: true, calendar_writes: false }, at: { 'P-02': 'SOULED' }, mine: {}, open: [], p04: 0, seen: [], exc: null, rpc: [] };
  const none = () => ({ departed_with_stock: [], off_floor: [], held_in_shipbay_only: [], stops_without_pallet: [], picks_without_pallet: [], needs_action: 0 });
  const floor = () => ({ ok: true, warehouse: 'HILLSBOROUGH-TEST', map_version: 4, moves_enabled: true, locations: ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06', 'STG-01'].map((c) => ({ code: c, kind: c.startsWith('STG') ? 'staging' : 'pallet', status: 'open', capacity: 1, used: st.at[c] ? 1 : 0, free: st.at[c] ? 0 : 1, your_pallets: st.at[c] === 'SHIPBAY' ? [st.mine[c]] : [] })).concat([{ code: 'RCV-DOCK', kind: 'dock', status: 'open', capacity: null, used: 0, free: null, your_pallets: [] }]) });
  const place = (b, move) => {
    if (st.at[b.location]) return [409, { ok: false, error: 'location_full', message: `${b.location} is taken in Nexus. Pick another position.` }];
    if (b.location === 'P-04' && st.p04++ === 0) { st.open = [{ op: 'o1', pallet: b.psku, to: 'P-04', state: 'pending', attempts: 1, by: 'Test Floor' }]; return [503, { ok: false, error: 'nexus_no_answer', pending: true, message: `Nexus did not answer. ${b.psku} is NOT put away yet. Scan it and P-04 again to retry.` }]; }
    let from = null; if (move) { from = Object.keys(st.mine).find((c) => st.mine[c] === b.psku); delete st.at[from]; delete st.mine[from]; }
    st.at[b.location] = 'SHIPBAY'; st.mine[b.location] = b.psku; st.open = [];
    return [200, { ok: true, psku: b.psku, location: b.location, from, units_posted: 100 }];
  };
  const release = (b) => { if (b.confirmed !== true || !b.reason) return [400, { ok: false, error: 'not_confirmed', message: 'Confirm at the position.' }]; if (st.mine[b.location] !== b.psku) return [409, { ok: false, error: 'pallet_not_placed', message: 'Nexus does not have it there.' }];
    delete st.at[b.location]; delete st.mine[b.location]; return [200, { ok: true, kind: 'release', psku: b.psku, from: b.location, location: null }]; };
  const fix = (b, how) => { const o = st.open.find((x) => x.op === b.op); if (!o || b.confirmed !== true) return [400, { ok: false, error: 'not_confirmed', message: 'Confirm at the position.' }]; st.open = st.open.filter((x) => x !== o);
    if (how === 'undo') { delete st.at[o.to]; delete st.mine[o.to]; } return [200, { ok: true, psku: o.pallet, location: how === 'record' ? o.to : null, from: o.to }]; };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/functions/v1/nexus-bridge')) {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const r = p.replace('/functions/v1/nexus-bridge', ''); const body = raw ? JSON.parse(raw) : null; st.seen.push({ m: req.method, r, body, auth: req.headers.authorization });
        const [code, out] = r === '/status' ? [200, st.status] : r === '/floor' ? [200, floor()] : r === '/pending' ? [200, { ok: true, open: st.open }] : r === '/putaway' ? place(body, false) : r === '/move' ? place(body, true) : r === '/release' ? release(body) : r === '/reconcile' ? [200, { ok: true, in_sync: true, differences: [], waiting: [], exceptions: st.exc || none() }] : r === '/reconcile/record' ? fix(body, 'record') : r === '/reconcile/undo' ? fix(body, 'undo') : [404, { ok: false }];
        res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      }); return;
    }
    if (p === '/rest/v1/rpc/wms_departed_stock_close') { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const b = JSON.parse(raw); st.rpc.push({ b, auth: req.headers.authorization });
      const x = st.exc.departed_with_stock[0]; st.exc = none(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pallet: x.pallet, units_closed: x.units, reference: b.p_ref })); }); return; }
    const f = path.resolve(BUILD, '.' + p); const file = f.startsWith(BUILD + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(BUILD, 'putaway.html');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  }).listen(4630, '127.0.0.1');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const outside = []; const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 1100 } });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; if (h === '127.0.0.1') return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  const scan = async (text) => { const i = p.locator('.scanbox input'); await i.fill(text); await i.press('Enter'); };
  const result = async (tone) => { await p.waitForSelector(`[data-testid=pa-result]${tone ? `[data-tone=${tone}]` : ''}`); return { tone: await p.locator('[data-testid=pa-result]').getAttribute('data-tone'), text: norm(await p.locator('[data-testid=pa-result]').innerText()) }; };
  await p.goto('http://127.0.0.1:4630/'); await p.waitForSelector('[data-testid=pa-floor]');
  ok(/HILLSBOROUGH-TEST · map version 4/.test(await p.locator('[data-testid=pa-floor]').innerText()), 'the screen names the Nexus floor and map version it is working on');
  ok(norm(await p.locator('[data-testid=pa-free]').innerText()) === 'P-01 · P-03 · P-04 · P-05 · P-06 · STG-01', 'free positions come from Nexus: the other company\'s position is not offered, the dock is not a position');
  await scan('123'); ok(/PSKU-000123 · now scan the position/.test(norm(await p.locator('[data-testid=pa-pallet]').innerText())), 'scanning the pallet label asks for the position');
  await scan('LOC-P-01'); let r = await result(); ok(r.tone === 'ok' && /PSKU-000123 is at P-01\. 100 units/.test(r.text), `a put-away Nexus accepts is confirmed with the position and the units posted: ${r.text}`);
  const sent = st.seen.find((s) => s.r === '/putaway'); ok(sent.m === 'POST' && sent.body.psku === 'PSKU-000123' && sent.body.location === 'P-01' && sent.auth === 'Bearer TEST-USER-TOKEN' && Object.keys(sent.body).length === 2, 'it sent the label and the position, under the user\'s own sign-in, and nothing else');
  ok(await p.locator('[data-testid=pa-pallet]').count() === 0, 'and is ready for the next pallet');
  await scan('124'); await scan('P-02'); r = await result(); ok(r.tone === 'bad' && /P-02 is taken in Nexus/.test(r.text), `a position the other company holds is refused in plain words: ${r.text}`);
  ok(/PSKU-000124/.test(await p.locator('[data-testid=pa-pallet]').innerText()), 'the pallet stays selected so another position can be scanned');
  await scan('P-03'); r = await result('ok'); ok(r.tone === 'ok' && /PSKU-000124 is at P-03/.test(r.text), 'and the next position works');
  await scan('125'); await scan('P-04'); r = await result(); ok(r.tone === 'wait' && /NOT put away yet|Nothing is confirmed/.test(r.text), `no answer from Nexus is shown as not confirmed, never as stored: ${r.text}`);
  await p.waitForSelector('[data-testid=pa-open]'); const openText = norm(await p.locator('[data-testid=pa-open]').innerText()); ok(/PSKU-000125 to P-04 ?Not confirmed yet/.test(openText), `the unconfirmed request is listed: ${openText}`);
  await p.locator('[data-testid=pa-result] button').click(); await p.waitForSelector('[data-testid=pa-result][data-tone=ok]'); r = await result(); ok(/PSKU-000125 is at P-04/.test(r.text), 'Send again repeats the same request and confirms it');
  ok(st.seen.filter((s) => s.r === '/putaway' && s.body.psku === 'PSKU-000125').every((s) => s.body.location === 'P-04'), 'both attempts named the same pallet and position');
  await p.getByRole('button', { name: 'Move a stored pallet' }).click(); await scan('PSKU-000123'); await scan('P-06'); await p.waitForSelector('[data-testid=pa-result][data-tone=ok]'); r = await result();
  ok(/PSKU-000123 is at P-06\. Moved from P-01\. Quantity unchanged/.test(r.text) && st.seen.some((s) => s.r === '/move'), `a move goes to the move route and says where it came from: ${r.text}`);
  // release: only at the position, with a reason and a stated confirmation
  await p.getByRole('button', { name: 'Pallet left the floor' }).click(); await scan('LOC-P-03'); await p.waitForSelector('[data-testid=pa-release]');
  ok(/P-03 · Nexus has these ShipBay pallets here/.test(norm(await p.locator('[data-testid=pa-release]').innerText())) && /PSKU-000124/.test(await p.locator('[data-testid=pa-release]').innerText()), 'release starts from the position scan and lists what Nexus has there for ShipBay');
  const relBtn = p.getByRole('button', { name: 'Release P-03' }); ok(await relBtn.isDisabled(), 'the release button is locked until a reason and the confirmation are given');
  await p.locator('[data-testid=pa-reason]').selectOption('shipped_out'); ok(await relBtn.isDisabled(), 'a reason alone is not enough'); await p.locator('[data-testid=pa-sure]').check(); const nBefore = st.seen.filter((s) => s.r === '/release').length;
  await relBtn.click(); r = await result('ok'); const relSent = st.seen.filter((s) => s.r === '/release'); ok(/P-03 is free\. PSKU-000124 left the floor\. Its stock was not changed/.test(r.text) && nBefore === 0 && relSent.length === 1 && relSent[0].body.confirmed === true && relSent[0].body.reason === 'shipped_out' && relSent[0].body.location === 'P-03', `a confirmed release frees the position and says stock was not changed: ${r.text}`);
  // out of sync: shown apart, never auto-released, resolved only by a ticked admin action
  st.at['P-05'] = 'SHIPBAY'; st.mine['P-05'] = 'PSKU-000130'; st.open = [{ op: 'x1', kind: 'assign', pallet: 'PSKU-000130', to: 'P-05', state: 'out_of_sync', attempts: 1, by: 'Test Floor', problem: 'PSKU-000130 is on HOLD (found damage).' }];
  await p.reload(); await p.waitForSelector('[data-testid=pa-broken]'); const bt = norm(await p.locator('[data-testid=pa-broken]').innerText());
  ok(/positions stay reserved/.test(bt) && /PSKU-000130 at P-05/.test(bt) && /on HOLD/.test(bt), `an out-of-sync placement is listed with its reason and says the position stays reserved: ${bt.slice(0, 160)}`);
  const recBtn = p.getByRole('button', { name: 'The pallet is there: record it' }); const undoBtn = p.getByRole('button', { name: 'It is not there: free the position' });
  ok(await recBtn.isDisabled() && await undoBtn.isDisabled() && !st.seen.some((s) => s.r.startsWith('/reconcile/')), 'neither correction can be sent before the admin ticks that they went and checked');
  await p.locator('[data-testid=pa-broken] input[type=checkbox]').check(); await undoBtn.click(); r = await result('ok');
  ok(/P-05 is free/.test(r.text) && st.seen.filter((s) => s.r === '/reconcile/undo').length === 1 && st.seen.find((s) => s.r === '/reconcile/undo').body.confirmed === true, `the confirmed correction frees the position: ${r.text}`);
  // ShipBay's own records to settle: a departed pallet with units still on the books is listed, and closing it out needs a reference
  st.exc = { ...none(), needs_action: 1, departed_with_stock: [{ pallet: 'PSKU-000077', pallet_id: '7f000000-0000-4000-8000-000000000077', brand: 'Synthetic Records', left_from: 'P-06', reason: 'shipped_out', units: 94, lines: [{ sku: 'SYN-LP-001', position: 'P-06', units: 94 }] }],
    off_floor: [{ pallet: 'PSKU-000078', pallet_id: '7f000000-0000-4000-8000-000000000078', brand: 'Synthetic Records', left_from: 'P-05', units: 70, lines: [], action: 'Still in ShipBay custody and not pickable.' }] };
  await p.reload(); await p.waitForSelector('[data-testid=pa-exceptions]'); const ex = norm(await p.locator('[data-testid=pa-exceptions]').innerText());
  ok(/1 need action/.test(ex) && /PSKU-000077 left P-06 with 94 units still on the books/.test(ex) && /94 × SYN-LP-001 at P-06/.test(ex) && /The release did not deduct them/.test(ex), 'the departed pallet is listed with what is still on the books and where');
  ok(/PSKU-000078 is off the shared floor with 70 units/.test(ex), 'a pallet off the floor is listed too');
  const closeBtn = p.locator('[data-testid=exc-departed] button'); ok(await closeBtn.isDisabled() && st.rpc.length === 0, 'it cannot be closed out without a reference');
  await p.locator('[data-testid=exc-departed] input').fill('BOL SYN-778'); await closeBtn.click(); await p.waitForFunction(() => /is closed out/.test(document.querySelector('[data-testid=pa-result]')?.innerText || ''));
  ok(st.rpc.length === 1 && st.rpc[0].b.p_pallet === '7f000000-0000-4000-8000-000000000077' && st.rpc[0].b.p_ref === 'BOL SYN-778', 'the close-out was sent once, for that pallet, with the reference typed');
  const said = norm(await p.locator('[data-testid=pa-result]').innerText()); await p.waitForFunction(() => !document.querySelector('[data-testid=pa-exceptions]'), null, { timeout: 5000 }).catch(() => {});
  ok(/94 units taken off the books against BOL SYN-778/.test(said) && await p.locator('[data-testid=pa-exceptions]').count() === 0, 'the screen says what was closed and the list is empty again');
  st.status = { ok: true, connection: 'off', pallet_moves: false, calendar_writes: false }; await p.reload(); await p.waitForSelector('[data-testid=pa-closed]');
  ok(/Put-away through Nexus is off/.test(await p.locator('[data-testid=pa-closed]').innerText()), 'when the bridge is off the screen says nothing here will store a pallet');
  const js = fs.readdirSync(path.join(BUILD, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(BUILD, 'assets', f), 'utf8')).join('\n');
  ok(!/nxk_|NEXUS_STAGING_API_KEY|ankoqruedjujyefhrmtw|functions\/v1\/nexus\/v1/.test(js), 'the browser code holds no Nexus key, key name or Nexus address');
  ok(st.seen.every((s) => s.auth === 'Bearer TEST-USER-TOKEN'), 'every call carried the user\'s own sign-in'); ok(outside.length === 0, `nothing was requested outside 127.0.0.1 (${outside.length})`); ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await p.screenshot({ path: process.env.SHOT || '/tmp/putaway.png', fullPage: true });
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
