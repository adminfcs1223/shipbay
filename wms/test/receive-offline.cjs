// Build for this test with VITE_PALLET_SCREEN=1 VITE_ALLOW_UNBOOKED=1 (it exercises the retained pallet screen and label machinery).
// The receiving screen in a real browser with no backend: every /rest and /auth request is answered here from synthetic
// rows, and any request to a host other than this machine or the stub is refused and counted.
// Build first with the stub address, then run:
//   VITE_SUPABASE_URL=https://stub.supabase.co VITE_SUPABASE_KEY=stub npx vite build && node test/receive-offline.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const DIST = process.env.WMS_DIST || path.join(__dirname, '..', 'dist');   // WMS_DIST=<dir> to test another build
const DEV = process.env.WMS_EXPECT_DEV === '1';   // the build must be React's development runtime (StrictMode runs effects twice)
const PORT = 4183; const STUB = 'stub.supabase.co';
const bundle = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('');
if (DEV !== bundle.includes('Each child in a list')) { console.error(`REFUSED: expected a ${DEV ? 'development' : 'production'} build of React.`); process.exit(2); }
console.log(`build: ${DEV ? 'development (StrictMode double effects on)' : 'production'} · ${DIST}`);
if (!bundle.includes(STUB) || /[a-z0-9]{20}\.supabase\.co/.test(bundle)) { console.error('REFUSED: dist is not a stub build (it names a real backend). Rebuild with the stub address.'); process.exit(2); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' };
const ROOT = path.resolve(DIST);
const server = http.createServer((req, res) => {
  const deny = (code) => { res.statusCode = code; res.end(); };
  let p; try { p = decodeURIComponent(String(req.url || '/').split('?')[0]); } catch { return deny(400); }   // malformed %-encoding
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\\')) return deny(400);
  if (p === '/') p = '/index.html';
  const f = path.resolve(ROOT, '.' + p);
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) return deny(403);                                       // outside dist
  const file = fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(ROOT, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
});
const listening = new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const UID = '00000000-0000-4000-8000-000000000001';
const raw = (p) => new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', (e) => resolve({ status: 0, body: String(e) })); r.end(); });
const orgs = [{ id: 'o1', name: 'Synthetic Records Co', status: 'active' }];
const products = ['Test Record Alpha', 'Test Record Bravo', 'Test Bulk Sleeves'].map((name, n) => ({ id: `s${n + 1}`, sku: `ITM-9${String(n + 1).padStart(5, '0')}`, name, asins: [], supplier: 'Synthetic', barcode: null, expected_qty: 100, expected_fba: 0, expected_fbm: 100 }));
const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'emp@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
let pass = 0; let fail = 0; const outside = [];
const ok = (cond, what) => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

async function scenario(browser, name, run, { role = 'wms_employee' } = {}) {
  console.log(`\n# ${name}`);
  const st = { seq: 900, pallets: [], cartons: [], holds: {}, receives: [], bodies: [], marks: 0, cartonReads: 0, lookups: 0, pend: null, f: {} };
  // the stub's wms_receive: the same rules as the database function (same key = the same pallets; one marker row per NCC line)
  const doReceive = (b) => {
    const had = st.pallets.filter((p) => p.batch_key === b.p_key); if (had.length) return had;
    const lines = b.p_lines; const rowsN = lines.reduce((t, l) => t + (l.cle ? 1 : l.cartons), 0); const counted = lines.reduce((t, l) => t + (l.cle ? 0 : l.cartons), 0); const out = [];
    for (let i = 1; i <= b.p_pallets; i++) {
      const num = st.holds[b.p_key]?.[i - 1] || String(++st.seq).padStart(6, '0'); const id = `pal-${num}`; const mixed = lines.length > 1; const one = products.find((s) => s.id === lines[0].sku);
      const p = { id, psku: `PSKU-${num}`, org_id: b.p_org, status: counted ? 'open' : 'counted', mixed, fba: lines.every((l) => l.fba), cle: lines.every((l) => l.cle), cartons: counted || null, item_no: mixed ? null : one?.sku, item_name: mixed ? `Mixed pallet · ${lines.length} products` : one?.name || lines[0].name, units_per_carton: null, batch_key: b.p_key, batch_pos: i, batch_size: b.p_pallets, received_at: new Date().toISOString(), received_by_name: 'Test Operator', label_prints: 0, location_id: null };
      let seq = 0; for (const l of lines) { const s = products.find((x) => x.id === l.sku); for (let g = 0; g < (l.cle ? 1 : l.cartons); g++) { seq += 1; st.cartons.push({ id: `${id}-c${seq}`, pallet_id: id, org_id: b.p_org, seq, code: `C${num}${String(seq).padStart(Math.max(2, String(rowsN).length), '0')}`, sku_id: s?.id || null, item_no: s?.sku || null, item_name: st.f.renameOnReceive && seq === 2 ? 'A different product' : s?.name || l.name, units_per_carton: l.units_per_carton, fba: !!l.fba, cle: !!l.cle, scanned_at: l.cle ? p.received_at : null }); } }
      st.pallets.push(p); out.push(p);
    }
    return out;
  };
  st.commitPending = () => { if (st.pend) { doReceive(st.pend); st.pend = null; } };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  // print() never opens a real dialog here: it is counted, or made to fail, as window.__printMode says
  await ctx.addInitScript(() => {
    window.__printMode = 'ok'; window.__prints = 0;
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() {
      const w = d.get.call(this); if (!w) return w; if (window.__printMode === 'nowin') return null;
      try { w.print = () => { window.__prints += 1; if (window.__printMode === 'throw') throw new Error('printing is blocked'); }; } catch { /* cross-origin */ }
      return w;
    } });
  });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).host; if (h === `localhost:${PORT}` || h === STUB) return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  await ctx.route(new RegExp(`${STUB.replace(/\./g, '\\.')}/(?!rest/v1/|auth/v1/)`), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
  await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, async (route) => {
    const req = route.request(); const u = new URL(req.url()); const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/); const single = (req.headers()['accept'] || '').includes('object'); const b = req.method() === 'POST' ? (req.postDataJSON() || {}) : {};
    const j = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (m[2]) {
      case 'profiles': return j(single ? { id: UID, full_name: 'Test Operator', email: 'emp@example.test', role, employee_no: 9001 } : []);
      case 'wms_brands': return j(orgs);
      case 'wms_products': return j(products);
      case 'locations': return j([{ id: 'l1', code: 'P-01', zone: 'bulk', kind: 'pallet', active: true }]);
      case 'wms_units': return j([]);
      case 'wms_scan_carton': { const c = st.cartons.find((x) => x.code === b.p_code); if (!c) return j({ message: 'not on file' }, 400); const already = !!c.scanned_at; c.scanned_at = c.scanned_at || new Date().toISOString(); const p = st.pallets.find((x) => x.id === c.pallet_id); const mine = st.cartons.filter((x) => x.pallet_id === p.id && !x.cle); return j({ pallet_id: p.id, psku: p.psku, seq: c.seq, already, scanned: mine.filter((x) => x.scanned_at).length, total: mine.length }); }
      case 'wms_mark_printed': st.marks += 1; return j(1);
      case 'wms_hold_pskus': { st.holds[b.p_key] = st.holds[b.p_key] || Array.from({ length: b.p_pallets }, () => String(++st.seq).padStart(6, '0')); return j(st.holds[b.p_key].map((n) => `PSKU-${n}`)); }
      case 'wms_pallets': { const k = u.searchParams.get('batch_key'); if (k) { st.lookups += 1; if (st.f.lookupFail) return j({ message: 'lookup failed' }, 503); if (st.f.rlsHide) return j([]); return j(st.pallets.filter((p) => `eq.${p.batch_key}` === k)); } return j([...st.pallets].reverse()); }
      case 'wms_cartons': {
        st.cartonReads += 1; if (st.f.slowFor && (u.searchParams.get('pallet_id') || '').includes(st.f.slowFor)) await new Promise((r) => setTimeout(r, 2500));
        if (st.f.cartonsFail) return j({ message: 'upstream timeout' }, 503); if (st.f.cartonsEmpty) return j([]);
        const q = u.searchParams.get('pallet_id') || ''; const ids = q.startsWith('in.') ? q.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')) : [q.replace('eq.', '')];
        let rows = st.cartons.filter((c) => ids.includes(c.pallet_id)); if (st.f.cartonsShort) rows = rows.slice(0, -1);
        const off = Number(u.searchParams.get('offset') || 0); const lim = Number(u.searchParams.get('limit') || 1000); return j(rows.slice(off, off + lim));
      }
      case 'wms_receive': {
        st.receives.push(b.p_key); st.bodies.push(JSON.stringify(b));
        if (st.f.conflict) return j({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
        if (st.f.reject) return j({ code: 'P0001', message: 'Units per carton is needed: it is what puts the stock on the shelf.' }, 400);
        if (st.f.delay) await new Promise((r) => setTimeout(r, st.f.delay));
        if (st.f.drop === 'committed') { doReceive(b); return route.abort('connectionreset'); }
        if (st.f.drop === 'lost') return route.abort('connectionreset');
        if (st.f.drop === 'pending') { st.pend = b; return route.abort('connectionreset'); }   // the request is still in the database, not yet committed
        return j(doReceive(b));
      }
      default: return j([]);
    }
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { fail++; console.log('FAIL page error:', e.message); });
  await page.goto(`http://localhost:${PORT}/`); await page.evaluate((s) => localStorage.setItem('shipbay-wms-auth', JSON.stringify(s)), sess);
  await page.goto(`http://localhost:${PORT}/#receive`); await page.reload(); await page.waitForTimeout(700);
  const h = {
    page, st,
    brand: async () => { await page.locator('.brands button').first().click(); await page.waitForTimeout(300); },
    line: async (i, q, cartons, { ncc } = {}) => { if (i > 0) await page.locator('.addline').click(); const line = page.locator('.line').nth(i); await line.locator('.scanbox input').fill(q); await page.waitForTimeout(150); await line.locator('.scanbox input').press('Enter'); await page.waitForTimeout(120); if (ncc) await line.locator('.fbatoggle').nth(1).click(); else { await line.getByLabel(/^Cartons/).fill(String(cartons)); await line.getByLabel(/^Units per carton/).fill('12'); } },
    receiveBtn: () => page.locator('form.entry .btn.big'),
    press: async (wait = 700) => { await page.locator('form.entry .btn.big').click(); await page.waitForTimeout(wait); },
    dialog: () => page.locator('.overlay .dialog').count(),
    until: async (re, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test((await page.locator('.strip.bad').allInnerTexts()).join(' | '))) return Date.now() - t0; await page.waitForTimeout(150); } return -1; },
    strips: async () => (await page.locator('.strip.bad').allInnerTexts()).join(' | '),
    printDoc: () => page.evaluate(() => document.getElementById('wms-print')?.srcdoc || null),
    clearPrint: () => page.evaluate(() => document.getElementById('wms-print')?.remove()),
    printMode: (m) => page.evaluate((x) => { window.__printMode = x; }, m),
    prints: () => page.evaluate(() => window.__prints),
    flightKey: () => page.evaluate(() => JSON.parse(localStorage.getItem('wms-inflight') || 'null')?.key || null),
    holdKey: () => page.evaluate(() => JSON.parse(localStorage.getItem('wms-hold') || 'null')?.key || null),
    forceClick: (text) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes(t)); if (!b) return 'missing'; const d = b.matches(':disabled'); b.click(); return d ? 'disabled' : 'enabled'; }, text),
    formLocked: () => page.evaluate(() => document.querySelector('fieldset.lockset')?.disabled === true),
    denyStorage: (how) => page.evaluate((h) => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'wms-inflight') { if (h === 'quota') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); if (h === 'silent') return; throw new DOMException('Access is denied', 'SecurityError'); } return orig.call(this, k, v); }; }, how),
    checkBtn: () => page.getByRole('button', { name: 'Check whether it was received' }),
    resendBtn: () => page.getByRole('button', { name: /Admin: send the same Receive again/ }),
  };
  try { await run(h); } catch (e) { fail++; console.log('FAIL scenario threw:', e.message.split('\n')[0]); }
  await ctx.close();
}
const codesIn = (doc) => [...(doc || '').matchAll(/<span>(C\d{8,10})<\/span>/g)].map((m) => m[1]);

(async () => {
  await listening;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());

  await scenario(browser, '1. mixed pallet with an NCC line: labels come from the database rows', async (h) => {
    await h.brand(); await h.line(0, 'sleeves', 0, { ncc: true }); await h.line(1, 'alpha', 3); await h.line(2, 'bravo', 2); await h.press();
    ok(await h.dialog() === 1, 'print prompt opens'); ok(h.st.receives.length === 1, 'one Receive sent');
    await h.page.locator('.printrow .twobtn .btn').first().click(); await h.page.waitForTimeout(500);
    const doc = await h.printDoc(); const want = h.st.cartons.filter((c) => !c.cle).map((c) => c.code);
    ok(JSON.stringify(codesIn(doc)) === JSON.stringify(want), `printed codes are the database's (${want.join(' ')})`);
    ok(!codesIn(doc).includes(h.st.cartons.find((c) => c.cle).code), 'the NCC marker row gets no label');
    ok((doc.match(/Test Record Alpha/g) || []).length === 3 && (doc.match(/Test Record Bravo/g) || []).length === 2, 'each label carries its own product');
    ok(/1 <i>of<\/i> 3/.test(doc) && /2 <i>of<\/i> 2/.test(doc), 'labels count within their own product');
  });

  await scenario(browser, '2. carton read fails after Receive: nothing printable, retry re-reads only', async (h) => {
    h.st.f.cartonsFail = true; await h.brand(); await h.line(0, 'alpha', 4); await h.line(1, 'bravo', 3); await h.press();
    ok(await h.dialog() === 0 && await h.printDoc() === null, 'while the read is being tried: no print prompt, nothing printed'); const took = await h.until(/could not be read/); console.log(`     (gave up after ${took} ms and ${h.st.cartonReads} read attempts)`);
    ok(await h.dialog() === 0, 'no print prompt'); ok(/could not be read/.test(await h.strips()), 'operator is told the cartons could not be read');
    ok(await h.printDoc() === null, 'nothing was sent to the printer'); ok(await h.receiveBtn().isDisabled(), 'Receive is held');
    h.st.f.cartonsFail = false; await h.page.getByRole('button', { name: 'Read the cartons again' }).click(); await h.page.waitForTimeout(500);
    ok(await h.dialog() === 1, 'after the re-read the print prompt opens'); ok(h.st.receives.length === 1, 'still one Receive sent'); ok(h.st.pallets.length === 1, 'one pallet on file');
  });

  await scenario(browser, '3. carton read answers 200 with an empty list: treated as wrong, not as "no cartons"', async (h) => {
    h.st.f.cartonsEmpty = true; await h.brand(); await h.line(0, 'alpha', 4); await h.press();
    ok(await h.dialog() === 0, 'no print prompt'); ok(/do not add up/.test(await h.strips()), 'operator is told the cartons do not add up'); ok(await h.printDoc() === null, 'nothing printed');
    await h.page.getByRole('button', { name: 'Leave it for an admin' }).click(); await h.page.waitForTimeout(200);
    ok(!(await h.receiveBtn().innerText()).includes('Receiving'), 'the station is not locked: the next pallet can be entered');
  });

  await scenario(browser, '4. Receive committed but the answer was lost: look it up, never send it twice', async (h) => {
    h.st.f.drop = 'committed'; await h.brand(); await h.line(0, 'alpha', 5); await h.press();
    ok(/Stop\./.test(await h.strips()) && /Do not enter it again/.test(await h.strips()), 'operator is told to stop'); ok(await h.receiveBtn().isDisabled(), 'Receive is held'); ok(await h.dialog() === 0, 'no print prompt yet');
    h.st.f.drop = null; await h.page.getByRole('button', { name: 'Check whether it was received' }).click(); await h.page.waitForTimeout(600);
    ok(await h.dialog() === 1, 'the receipt is found and its print prompt opens'); ok(h.st.receives.length === 1, 'one Receive sent'); ok(h.st.pallets.length === 1, 'one pallet on file');
  });

  await scenario(browser, '5. Receive never arrived: an empty lookup does NOT release the station or change the receipt', async (h) => {
    h.st.f.drop = 'lost'; await h.brand(); await h.line(0, 'alpha', 5); await h.press(); const k0 = await h.flightKey();
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/);
    ok(/does not prove it was not received/.test(await h.strips()), 'operator is told an empty lookup proves nothing');
    ok(await h.receiveBtn().isDisabled(), 'Receive stays held'); ok(await h.flightKey() === k0, 'the receipt key is unchanged');
    ok(await h.resendBtn().count() === 0, 'a floor login is not offered a re-send'); ok(/an admin must resolve it/.test(await h.strips()), 'floor login is sent to an admin');
    await h.checkBtn().click(); await h.until(/looked 2 times/); ok(await h.flightKey() === k0 && h.st.receives.length === 1, 'a second empty lookup changes nothing; nothing re-sent');
  });

  await scenario(browser, '6. page reloaded while the answer was outstanding', async (h) => {
    h.st.f.drop = 'committed'; await h.brand(); await h.line(0, 'alpha', 5); await h.press();
    h.st.f.drop = null; await h.page.reload(); await h.page.waitForTimeout(800);
    ok(/Stop\./.test(await h.strips()), 'after the reload the stop notice is still there');
    ok(await h.receiveBtn().isDisabled() && await h.formLocked(), 'Receive and the form stay locked');
    ok(await h.page.locator('.line').first().getByLabel(/^Cartons/).inputValue() === '5', 'the form shows what was sent');
    await h.page.getByRole('button', { name: 'Check whether it was received' }).click(); await h.page.waitForTimeout(600);
    ok(await h.dialog() === 1 && h.st.receives.length === 1 && h.st.pallets.length === 1, 'receipt found; still one Receive and one pallet');
  });

  await scenario(browser, '7. the lookup itself fails: still held', async (h) => {
    h.st.f.drop = 'committed'; await h.brand(); await h.line(0, 'alpha', 2); await h.press(); h.st.f.lookupFail = true;
    await h.page.getByRole('button', { name: 'Check whether it was received' }).click(); await h.until(/could not be checked/);
    ok(/could not be checked/.test(await h.strips()) && await h.receiveBtn().isDisabled(), 'operator is told; Receive stays held'); ok(h.st.receives.length === 1, 'one Receive sent');
  });

  await scenario(browser, '8. double click on a slow connection', async (h) => {
    h.st.f.delay = 900; await h.brand(); await h.line(0, 'alpha', 3);
    await h.receiveBtn().dblclick(); await h.page.keyboard.press('Enter'); await h.page.waitForTimeout(1600);
    ok(h.st.receives.length === 1, 'one Receive sent'); ok(h.st.pallets.length === 1, 'one pallet on file');
  });

  await scenario(browser, '9. the database refuses the form (400): a plain error, not a stop', async (h) => {
    h.st.f.reject = true; await h.brand(); await h.line(0, 'alpha', 3); await h.press();
    const s = await h.strips(); ok(/Not received/.test(s) && !/Stop\./.test(s), 'shown as not received'); ok(!(await h.receiveBtn().isDisabled()), 'the form can be fixed and sent');
    ok(await h.page.evaluate(() => localStorage.getItem('wms-inflight')) === null, 'no outstanding-receive marker left behind');
  });

  await scenario(browser, '10. labels printed before Receive that match are counted as printed', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.line(1, 'bravo', 2);
    await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600); const early = codesIn(await h.printDoc());
    await h.press(); const want = h.st.cartons.map((c) => c.code);
    ok(JSON.stringify(early) === JSON.stringify(want), 'the early labels carry the codes the database then made'); ok(/printed before receiving/.test(await h.page.locator('.printrow').nth(1).innerText()), 'counted as printed');
  });

  await scenario(browser, '11. labels printed before Receive that do NOT match are called out', async (h) => {
    h.st.f.renameOnReceive = true; await h.brand(); await h.line(0, 'alpha', 3); await h.line(1, 'bravo', 2);
    await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600); await h.press();
    ok(/are not what was received/.test(await h.strips()), 'operator is told to take them off and reprint'); ok(!/printed before receiving/.test(await h.page.locator('.printrow').nth(1).innerText()), 'not counted as printed');
  });

  await scenario(browser, '12. Pallets screen: a failed carton read cannot produce labels', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.line(1, 'bravo', 2); await h.press(); h.st.f.cartonsFail = true; await h.clearPrint();
    await h.page.locator('.dialog .btn.big').click(); await h.until(/could not be read/);
    ok(/could not be read/.test(await h.strips()), 'operator is told the cartons could not be read'); ok(await h.page.getByRole('button', { name: /carton label/ }).count() === 0, 'no carton reprint is offered'); ok(await h.printDoc() === null, 'nothing printed');
  });

  await scenario(browser, '13. Pallets screen: a short carton list cannot be reprinted', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.line(1, 'bravo', 2); await h.press(); h.st.f.cartonsShort = true; await h.clearPrint();
    await h.page.locator('.dialog .btn.big').click(); await h.page.waitForTimeout(600);
    ok(/do not add up/.test(await h.strips()), 'operator is told the cartons do not add up');
    await h.page.getByRole('button', { name: /^Reprint \d+ carton labels/ }).click(); await h.page.waitForTimeout(400);
    ok(/No carton labels were printed/.test(await h.strips()), 'the reprint is refused and says so'); ok(await h.printDoc() === null, 'nothing printed');
  });

  await scenario(browser, '14. Pallets screen: a good read still reprints from the rows', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.press(); await h.clearPrint();
    await h.page.locator('.dialog .btn.big').click(); await h.page.waitForTimeout(600);
    await h.page.getByRole('button', { name: /^Reprint \d+ carton labels/ }).click(); await h.page.waitForTimeout(500);
    ok(JSON.stringify(codesIn(await h.printDoc())) === JSON.stringify(h.st.cartons.map((c) => c.code)), 'reprint carries the database codes');
  });

  await scenario(browser, '15. labels printed first -> answer lost (committed) -> discard-hold -> check: same receipt', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.line(1, 'bravo', 2);
    await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600); const holdKey = await h.holdKey();
    h.st.f.drop = 'committed'; await h.press();
    ok(await h.flightKey() === holdKey, 'the receipt is the key the labels were held under');
    ok(await h.forceClick('Throw those labels away') === 'disabled', 'discard-hold is disabled'); await h.page.waitForTimeout(200);
    ok(await h.flightKey() === holdKey && await h.holdKey() === holdKey, 'clicking it changed neither key');
    ok(await h.page.locator('.early .btn').first().isDisabled(), 'print-first is disabled');
    h.st.f.drop = null; await h.checkBtn().click(); await h.page.waitForTimeout(700);
    ok(await h.dialog() === 1 && h.st.pallets.length === 1 && h.st.lookups === 1, 'found under that key; one pallet');
    ok(/printed before receiving/.test(await h.page.locator('.printrow').nth(1).innerText()), 'the early labels are still matched to it');
  });

  await scenario(browser, '16. labels printed first -> answer lost (never arrived) -> discard-hold -> check: still held, same key', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3);
    await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600); const holdKey = await h.holdKey();
    h.st.f.drop = 'lost'; await h.press(); await h.forceClick('Throw those labels away');
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/);
    ok(await h.flightKey() === holdKey && await h.receiveBtn().isDisabled(), 'still held under the same key');
  });

  await scenario(browser, '17. form edits while the answer is delayed are blocked; the request sent is the one recorded', async (h) => {
    h.st.f.delay = 1500; await h.brand(); await h.line(0, 'alpha', 4);
    await h.page.locator('form.entry .btn.big').click(); await h.page.waitForTimeout(200);
    ok(await h.formLocked(), 'the form is locked while waiting');
    ok(await h.page.locator('.line').first().getByLabel(/^Cartons/).isDisabled(), 'carton count cannot be changed');
    ok(await h.page.locator('.brands button').first().isDisabled(), 'brand cannot be changed');
    ok(await h.forceClick('+ Another product') === 'disabled' && await h.page.locator('.line').count() === 1, 'no product can be added');
    const sentBody = h.st.bodies[0]; await h.page.waitForTimeout(1800);
    ok(h.st.receives.length === 1 && h.st.pallets.length === 1 && h.st.pallets[0].cartons === 4, 'one pallet, 4 cartons as sent');
    ok(JSON.parse(sentBody).p_lines[0].cartons === 4, 'the request carried the form as it was when Receive was pressed');
  });

  await scenario(browser, '18. original commits AFTER an empty lookup: the next check finds it, nothing re-sent', async (h) => {
    h.st.f.drop = 'pending'; await h.brand(); await h.line(0, 'alpha', 2); await h.press(); const k0 = await h.flightKey();
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/); ok(h.st.pallets.length === 0, 'nothing on file yet');
    h.st.commitPending(); await h.checkBtn().click(); await h.page.waitForTimeout(700);
    ok(await h.dialog() === 1 && h.st.pallets.length === 1 && h.st.pallets[0].batch_key === k0, 'found under the original key');
    ok(h.st.receives.length === 1, 'one Receive ever sent');
  });

  await scenario(browser, '19. pallets on file but hidden from this login (RLS-style empty answer): stays held', async (h) => {
    h.st.f.drop = 'committed'; h.st.f.rlsHide = true; await h.brand(); await h.line(0, 'alpha', 2); await h.press(); const k0 = await h.flightKey();
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/); await h.checkBtn().click(); await h.until(/looked 2 times/);
    ok(h.st.pallets.length === 1, '(the pallet really is on file)'); ok(await h.receiveBtn().isDisabled() && await h.flightKey() === k0, 'still held, same key');
    ok(await h.resendBtn().count() === 0 && h.st.receives.length === 1, 'no re-send offered or made');
  });

  await scenario(browser, '20. admin re-sends the same pinned request after an empty lookup: same key, no second pallet', async (h) => {
    h.st.f.drop = 'committed'; h.st.f.rlsHide = true; await h.brand(); await h.line(0, 'alpha', 2); await h.press(); const k0 = await h.flightKey();
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/);
    ok(await h.resendBtn().count() === 1, 'admin is offered the re-send'); await h.resendBtn().click(); await h.page.waitForTimeout(800);
    ok(h.st.receives.length === 2 && h.st.receives[1] === k0 && h.st.bodies[0] === h.st.bodies[1], 'the re-send is byte-for-byte the original request');
    ok(h.st.pallets.length === 1 && await h.dialog() === 1, 'one pallet; its print prompt opens');
  }, { role: 'shipbay_admin' });

  await scenario(browser, '21. admin re-send answered 409 (key already taken): stays held, not treated as refused', async (h) => {
    h.st.f.drop = 'lost'; await h.brand(); await h.line(0, 'alpha', 2); await h.press(); const k0 = await h.flightKey();
    h.st.f.drop = null; await h.checkBtn().click(); await h.until(/Nothing found yet/);
    h.st.f.conflict = true; await h.resendBtn().click(); await h.page.waitForTimeout(500);
    ok(/Stop\./.test(await h.strips()) && !/Not received/.test(await h.strips()), 'still the stop notice'); ok(await h.flightKey() === k0, 'same key kept');
  }, { role: 'shipbay_admin' });

  await scenario(browser, '22. reload with no labels held: the pinned form and key survive; an empty lookup makes no new key', async (h) => {
    h.st.f.drop = 'lost'; await h.brand(); await h.line(0, 'bravo', 6); await h.press(); const k0 = await h.flightKey();
    ok(await h.holdKey() === null, '(no labels were held)');
    h.st.f.drop = null; await h.page.reload(); await h.page.waitForTimeout(800);
    await h.checkBtn().click(); await h.until(/Nothing found yet/);
    ok(await h.flightKey() === k0 && await h.receiveBtn().isDisabled(), 'same key; still held');
  });

  await scenario(browser, '23. print window refused (throws) for the pallet label: not marked printed; retry works', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 2); await h.press(); await h.printMode('throw');
    await h.page.locator('.printrow').first().locator('.btn').click(); await h.page.waitForTimeout(500);
    ok(/did not open for the pallet label/.test(await h.page.locator('.dialog').innerText()), 'operator is told it did not print');
    ok(h.st.marks === 0, 'not recorded as printed'); ok(!(await h.page.locator('.printrow').first().getAttribute('class')).includes('done'), 'row not ticked');
    await h.printMode('ok'); await h.page.locator('.printrow').first().locator('.btn').click(); await h.page.waitForTimeout(500);
    ok(h.st.marks === 1 && (await h.page.locator('.printrow').first().getAttribute('class')).includes('done'), 'retry sent and recorded once');
  });

  await scenario(browser, '24. no print window (frame has no window) for carton labels: not ticked; retry works', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 2); await h.press(); await h.printMode('nowin');
    await h.page.locator('.printrow .twobtn .btn').first().click(); await h.page.waitForTimeout(500);
    ok(/did not open for the carton labels/.test(await h.page.locator('.dialog').innerText()), 'operator is told');
    ok(!(await h.page.locator('.printrow').nth(1).getAttribute('class')).includes('done'), 'carton row not ticked');
    await h.printMode('ok'); await h.page.locator('.printrow .twobtn .btn').first().click(); await h.page.waitForTimeout(500);
    ok((await h.page.locator('.printrow').nth(1).getAttribute('class')).includes('done') && await h.prints() >= 1, 'retry ticks it');
  });

  await scenario(browser, '25. print-first refused: the number stays held but the labels are not counted as printed', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 2); await h.printMode('throw');
    await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600);
    ok(/print window did not open/.test(await h.strips()), 'operator is told'); ok(/Not every carton label is printed/.test(await h.page.locator('.early').innerText()), 'hold kept, not counted as printed');
    await h.printMode('ok'); await h.page.locator('.early .btn').first().click(); await h.page.waitForTimeout(600);
    ok(/Carton labels printed for/.test(await h.page.locator('.early').innerText()), 'retry counts');
    await h.press(); ok(/printed before receiving/.test(await h.page.locator('.printrow').nth(1).innerText()), 'and is matched after Receive');
  });

  await scenario(browser, '26. Pallets screen: a slow read for pallet A cannot overwrite pallet B after switching', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.page.locator('form.entry input[aria-label="Pallets"]').fill('2'); await h.page.locator('form.entry input[aria-label="Pallets"]').blur(); await h.press();
    const [A, B] = h.st.pallets; await h.page.locator('.dialog .btn.big').click(); await h.page.waitForTimeout(600);
    await h.page.locator('button.back').click(); await h.page.waitForTimeout(300);
    h.st.f.slowFor = A.id; await h.page.locator('tr', { hasText: A.psku }).click(); await h.page.waitForTimeout(150);
    await h.page.locator('button.back').click(); await h.page.locator('tr', { hasText: B.psku }).click(); h.st.f.slowFor = null; await h.page.waitForTimeout(3200);
    const titles = await h.page.locator('.ctiles span').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    const bnum = B.psku.replace(/\D/g, '');
    ok(titles.length === 3 && titles.every((t) => t.startsWith(`C${bnum}`)), `B shows only its own cartons (${titles.join(' ')})`);
    ok(!/could not be read|do not add up/.test(await h.strips()), 'no stale error from A');
  });

  for (const [n, how] of [['27', 'denied'], ['28', 'quota'], ['29', 'silent']]) {
    await scenario(browser, `${n}. the Receive record cannot be saved (${how}): nothing is sent, the operator is told`, async (h) => {
      await h.brand(); await h.line(0, 'alpha', 2); await h.denyStorage(how); await h.press(400);
      ok(h.st.receives.length === 0 && h.st.pallets.length === 0, 'no Receive sent'); ok(/Nothing was sent.*could not save/.test(await h.strips()), 'operator is told why and what to do');
      ok(!(await h.formLocked()) && !(await h.receiveBtn().isDisabled()), 'the station is not stuck: the form stays editable');
    });
  }
  for (const [n, bad] of [['30', '{not json'], ['31', JSON.stringify({ key: 'k1', payload: { p_key: 'other' } })]]) {
    await scenario(browser, `${n}. an unreadable saved Receive record (${bad.slice(0, 18)}…) holds a floor login`, async (h) => {
      await h.page.evaluate((v) => localStorage.setItem('wms-inflight', v), bad); await h.page.reload(); await h.page.waitForTimeout(800);
      ok(/cannot read/.test(await h.strips()) && /An admin must clear this/.test(await h.strips()), 'held, admin needed');
      ok(await h.receiveBtn().isDisabled() && await h.formLocked() && await h.page.locator('.brands button').first().isDisabled(), 'Receive, brand and the form are locked'); ok(await h.page.getByRole('button', { name: /Admin: receipts checked/ }).count() === 0, 'no clear button for a floor login');
    });
  }
  await scenario(browser, '32. admin clears an unreadable record after checking receipts; receiving works again', async (h) => {
    await h.page.evaluate(() => localStorage.setItem('wms-inflight', '{not json')); await h.page.reload(); await h.page.waitForTimeout(800);
    await h.page.getByRole('button', { name: /Admin: receipts checked/ }).click(); await h.page.waitForTimeout(200);
    ok(await h.page.evaluate(() => localStorage.getItem('wms-inflight')) === null && !(await h.formLocked()), 'cleared');
    await h.brand(); await h.line(0, 'alpha', 2); await h.press(); ok(h.st.pallets.length === 1 && await h.dialog() === 1, 'a Receive goes through');
  }, { role: 'shipbay_admin' });

  await scenario(browser, '33. Pallets screen: cartons load and a scan refreshes them (catches the StrictMode stale-read bug in a development build)', async (h) => {
    await h.brand(); await h.line(0, 'alpha', 3); await h.press(); await h.page.locator('.dialog .btn.big').click(); await h.page.waitForTimeout(800);
    ok(await h.page.locator('.ctiles span').count() === 3, 'the 3 cartons are shown (not stuck on "Loading cartons…")');
    h.st.f.scanOk = true; const code = h.st.cartons[0].code;
    await h.page.locator('.scanbox input').first().fill(code); await h.page.keyboard.press('Enter'); await h.page.waitForTimeout(800);
    ok(await h.page.locator('.ctiles span.in').count() === 1, 'a scan marks the carton scanned');
  });

  // 4) the test server: local only, nothing outside dist
  ok(server.address().address === '127.0.0.1', 'test server listens on 127.0.0.1 only');
  for (const [p, want] of [['/../package.json', 403], ['/%2e%2e/%2e%2e/package.json', 403], ['/assets/..%2f..%2fpackage.json', 403], ['/%E0%A4%A', 400], ['/..%5c..%5cpackage.json', 400]]) {
    const r = await raw(p); ok(r.status === want && !r.body.includes('shipbay-wms'), `server refuses ${p} (${r.status})`);
  }
  ok((await raw('/index.html')).status === 200, 'server still serves dist');

  await browser.close();
  ok(outside.length === 0, `no request left this machine (${outside.length} refused${outside.length ? ': ' + [...new Set(outside.map((u) => new URL(u).host))].join(', ') : ''})`);
  console.log(`\n${pass} passed, ${fail} failed`); server.close(); process.exit(fail ? 1 : 0);
})();
