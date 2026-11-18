// The receiving screen in a real browser with no backend: every /rest and /auth request is answered here from synthetic
// rows, and any request to a host other than this machine or the stub is refused and counted.
// Build first with the stub address, then run:
//   VITE_SUPABASE_URL=https://stub.supabase.co VITE_SUPABASE_KEY=stub npx vite build && node test/receive-offline.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const DIST = path.join(__dirname, '..', 'dist'); const PORT = 4183; const STUB = 'stub.supabase.co';
const bundle = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('');
if (!bundle.includes(STUB) || /[a-z0-9]{20}\.supabase\.co/.test(bundle)) { console.error('REFUSED: dist is not a stub build (it names a real backend). Rebuild with the stub address.'); process.exit(2); }
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);

const UID = '00000000-0000-4000-8000-000000000001';
const orgs = [{ id: 'o1', name: 'Synthetic Records Co', status: 'active' }];
const products = ['Test Record Alpha', 'Test Record Bravo', 'Test Bulk Sleeves'].map((name, n) => ({ id: `s${n + 1}`, sku: `ITM-9${String(n + 1).padStart(5, '0')}`, name, asins: [], supplier: 'Synthetic', barcode: null, expected_qty: 100, expected_fba: 0, expected_fbm: 100 }));
const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'emp@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
let pass = 0; let fail = 0; const outside = [];
const ok = (cond, what) => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

async function scenario(browser, name, run) {
  console.log(`\n# ${name}`);
  const st = { seq: 900, pallets: [], cartons: [], holds: {}, receives: [], cartonReads: 0, f: {} };
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).host; if (h === `localhost:${PORT}` || h === STUB) return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  await ctx.route(new RegExp(`${STUB.replace(/\./g, '\\.')}/(?!rest/v1/|auth/v1/)`), (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
  await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, async (route) => {
    const req = route.request(); const u = new URL(req.url()); const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/); const single = (req.headers()['accept'] || '').includes('object'); const b = req.method() === 'POST' ? (req.postDataJSON() || {}) : {};
    const j = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (m[2]) {
      case 'profiles': return j(single ? { id: UID, full_name: 'Test Operator', email: 'emp@example.test', role: 'shipbay_admin', employee_no: 9001 } : []);
      case 'wms_brands': return j(orgs);
      case 'wms_products': return j(products);
      case 'locations': return j([{ id: 'l1', code: 'P-01', zone: 'bulk', kind: 'pallet', active: true }]);
      case 'wms_units': return j([]);
      case 'wms_mark_printed': return j(1);
      case 'wms_hold_pskus': { st.holds[b.p_key] = st.holds[b.p_key] || Array.from({ length: b.p_pallets }, () => String(++st.seq).padStart(6, '0')); return j(st.holds[b.p_key].map((n) => `PSKU-${n}`)); }
      case 'wms_pallets': { const k = u.searchParams.get('batch_key'); if (k) { if (st.f.lookupFail) return j({ message: 'lookup failed' }, 503); return j(st.pallets.filter((p) => `eq.${p.batch_key}` === k)); } return j([...st.pallets].reverse()); }
      case 'wms_cartons': {
        st.cartonReads += 1; if (st.f.cartonsFail) return j({ message: 'upstream timeout' }, 503); if (st.f.cartonsEmpty) return j([]);
        const q = u.searchParams.get('pallet_id') || ''; const ids = q.startsWith('in.') ? q.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')) : [q.replace('eq.', '')];
        let rows = st.cartons.filter((c) => ids.includes(c.pallet_id)); if (st.f.cartonsShort) rows = rows.slice(0, -1);
        const off = Number(u.searchParams.get('offset') || 0); const lim = Number(u.searchParams.get('limit') || 1000); return j(rows.slice(off, off + lim));
      }
      case 'wms_receive': {
        st.receives.push(b.p_key);
        if (st.f.reject) return j({ code: 'P0001', message: 'Units per carton is needed: it is what puts the stock on the shelf.' }, 400);
        if (st.f.delay) await new Promise((r) => setTimeout(r, st.f.delay));
        if (st.f.drop === 'committed') { doReceive(b); return route.abort('connectionreset'); }
        if (st.f.drop === 'lost') return route.abort('connectionreset');
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
  };
  try { await run(h); } catch (e) { fail++; console.log('FAIL scenario threw:', e.message.split('\n')[0]); }
  await ctx.close();
}
const codesIn = (doc) => [...(doc || '').matchAll(/<span>(C\d{8,10})<\/span>/g)].map((m) => m[1]);

(async () => {
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

  await scenario(browser, '5. Receive never arrived: the check says so and the same request can be sent again', async (h) => {
    h.st.f.drop = 'lost'; await h.brand(); await h.line(0, 'alpha', 5); await h.press();
    h.st.f.drop = null; await h.page.getByRole('button', { name: 'Check whether it was received' }).click(); await h.page.waitForTimeout(500);
    ok(/Nothing is on file/.test(await h.strips()), 'operator is told nothing is on file'); ok(h.st.pallets.length === 0, 'no pallet on file');
    await h.press(); ok(h.st.receives.length === 2 && h.st.receives[0] === h.st.receives[1], 'the second Receive carries the same key'); ok(h.st.pallets.length === 1 && await h.dialog() === 1, 'one pallet, print prompt opens');
  });

  await scenario(browser, '6. page reloaded while the answer was outstanding', async (h) => {
    h.st.f.drop = 'committed'; await h.brand(); await h.line(0, 'alpha', 5); await h.press();
    h.st.f.drop = null; await h.page.reload(); await h.page.waitForTimeout(800);
    ok(/Stop\./.test(await h.strips()), 'after the reload the stop notice is still there');
    await h.brand(); await h.line(0, 'alpha', 5); ok(await h.receiveBtn().isDisabled(), 'Receive stays held even with the form filled in again');
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

  await browser.close();
  ok(outside.length === 0, `no request left this machine (${outside.length} refused${outside.length ? ': ' + [...new Set(outside.map((u) => new URL(u).host))].join(', ') : ''})`);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
