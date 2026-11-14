// The WMS end to end with stubbed data: sign-in, receive a product (1 pallet, 27 cartons), print prompt, carton scan,
// put-away on the map, received; plus the labels exactly as they print (PDFs). node preview-wms.cjs [outdir] [items.json]
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.argv[2] || 'shots'; fs.mkdirSync(OUT, { recursive: true });
const DIST = path.join(__dirname, 'dist'); const PORT = 4179;
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);
const UID = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'; const WHO = 'Marcus Reyes';
const orgs = [{ id: 'o1', name: 'Souled Worldwide', status: 'onboarding' }, { id: 'o2', name: 'Steel Horse Leather', status: 'onboarding' }, { id: 'o3', name: 'Vinyl Moon', status: 'onboarding' }];
const src = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [{ name: 'Generation Mini Blocks (20 gm.) 16 lb. Pail', asins: ['B095SXKKLW'], supplier: 'Summit Chemical (Lipha Tech)', qty: 7, qty_fba: 0, qty_fbm: 7 }];
const products = src.map((i, n) => ({ id: `s${n + 1}`, sku: `ITM-${String(n + 1).padStart(6, '0')}`, name: i.name, asins: i.asins, supplier: i.supplier, barcode: null, expected_qty: i.qty, expected_fba: i.qty_fba, expected_fbm: i.qty_fbm })).sort((a, b) => a.name.localeCompare(b.name));
const locations = [['P-01', 'Bulk'], ['P-02', 'Bulk'], ['P-03', 'Bulk'], ['P-04', 'Bulk'], ['L1-01', 'Lane 1'], ['L1-02', 'Lane 1'], ['L1-03', 'Lane 1'], ['L1-04', 'Lane 1'], ['L1-05', 'Lane 1'], ['L1-06', 'Lane 1']].map(([code, zone], i) => ({ id: `l${i}`, code, zone, kind: 'pallet', active: true })).concat([{ id: 'lob', code: 'OB-01', zone: 'open box', kind: 'shelf', active: true }, { id: 'lf', code: 'STG-01', zone: 'Staging', kind: 'floor', active: true }, { id: 'ls', code: 'A-01', zone: 'pick', kind: 'shelf', active: true }]);
let seq = 0; let useq = 0; const pallets = []; const cartons = []; const units = [];
const mkLines = (org, lines, n, extra = {}) => { const key = `k${seq}`; const out = []; const total = lines.reduce((t, l) => t + (l.cle ? 0 : l.cartons || 0), 0); const rows = total + lines.filter((l) => l.cle).length; const mixed = lines.length > 1; for (let i = 1; i <= n; i++) { const num = String(++seq).padStart(6, '0'); const one = lines[0]; const p = { id: `p${seq}`, psku: `PSKU-${num}`, org_id: org, status: total ? 'open' : 'counted', mixed, fba: lines.every((l) => l.fba), cle: lines.every((l) => l.cle), sku_id: mixed ? null : one.sku?.id || null, item_no: mixed ? null : one.sku?.sku || null, item_name: mixed ? `Mixed pallet · ${lines.length} products` : one.sku?.name || one.name || null, cartons: total || null, units_per_carton: mixed ? null : one.upc || null, location_id: null, reference: null, carrier: null, notes: null, batch_key: key, batch_pos: i, batch_size: n, received_at: new Date().toISOString(), received_by_name: WHO, label_prints: 0, ...extra }; pallets.push(p); const w = Math.max(2, String(rows).length); let g = 0; for (const l of lines) for (let x = 0; x < (l.cle ? 1 : l.cartons || 0); x++) { g++; cartons.push({ id: `c${p.id}-${g}`, pallet_id: p.id, org_id: org, seq: g, code: `C${num}${String(g).padStart(w, '0')}`, scanned_at: l.cle ? new Date().toISOString() : null, cle: !!l.cle, sku_id: l.sku?.id || null, item_no: l.sku?.sku || null, item_name: l.sku?.name || l.name, units_per_carton: l.upc || null, fba: !!l.fba, open_box_at: null, open_units: null }); } out.push(p); } return out; };
const mk = (org, sku, n, c, extra = {}) => mkLines(org, [{ sku, cartons: c }], n, extra);
const taken = (lid) => pallets.some((p) => p.location_id === lid && ['counted', 'stored'].includes(p.status));
const pickLoc = (p) => { const l = locations.find((x) => x.kind === 'pallet' && !taken(x.id)); p.location_id = l?.id || null; };
// two pallets already on the floor
{ const [a] = mk('o2', { id: 'x1', sku: 'SH-WALLET-BRN', name: 'Bifold Wallet — Brown' }, 1, 0, { status: 'stored', location_id: 'l1', stored_at: new Date().toISOString(), stored_by_name: 'Derek Harrison' }); const [b] = mk('o3', { id: 'x2', sku: 'VM-NOV', name: 'November record box' }, 1, 0, { status: 'stored', location_id: 'l4', stored_at: new Date().toISOString(), stored_by_name: 'Derek Harrison' }); void a; void b; }
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'emp@wms.shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
  await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, (route) => {
    const req = route.request(); const m = req.url().match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/); const single = (req.headers()['accept'] || '').includes('object'); const b = req.method() === 'POST' ? (req.postDataJSON() || {}) : {};
    const j = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); const fail = (message) => j({ message }, 400);
    switch (m[2]) {
      case 'profiles': return j(single ? { id: UID, full_name: WHO, email: 'emp@wms.shipbay3pl.com', role: 'shipbay_admin', employee_no: 1002 } : []);
      case 'wms_brands': return j(orgs);
      case 'wms_products': return j(b.p_org === 'o1' ? products : []);
      case 'locations': return j(locations);
      case 'wms_pallets': return j([...pallets].reverse());
      case 'wms_cartons': { const q = new URL(req.url()).searchParams.get('pallet_id') || ''; const ids = q.startsWith('in.') ? q.slice(4, -1).split(',') : [q.replace('eq.', '')]; return j(cartons.filter((c) => ids.includes(c.pallet_id))); }
      case 'wms_units': { const u = new URL(req.url()).searchParams; const pid = u.get('pallet_id')?.replace('eq.', ''); const cid = u.get('carton_id')?.replace('eq.', ''); return j(units.filter((x) => (pid ? x.pallet_id === pid : x.carton_id === cid))); }
      case 'wms_open_box': { const c = cartons.find((x) => x.code === b.p_carton_code); const p = pallets.find((x) => x.id === c.pallet_id); c.open_box_at = new Date().toISOString(); c.open_units = b.p_units; c.scanned_at = c.scanned_at || c.open_box_at; c.open_by_name = WHO; for (let i = 0; i < b.p_units; i++) units.push({ id: `u${++useq}`, code: `U${String(useq).padStart(7, '0')}`, org_id: c.org_id, carton_id: c.id, pallet_id: p.id, item_no: c.item_no, item_name: c.item_name, fba: c.fba, location_id: 'lob', status: 'shelved' }); return j({ pallet_id: p.id, psku: p.psku, seq: c.seq, units: b.p_units, location: 'OB-01' }); }
      case 'wms_receive': { const out = mkLines(b.p_org, b.p_lines.map((l) => ({ sku: products.find((s) => s.id === l.sku), name: l.name, cartons: l.cartons, upc: l.units_per_carton, fba: l.fba, cle: l.cle })), b.p_pallets); out.filter((p) => p.status === 'counted').forEach(pickLoc); return j(out); }
      case 'wms_hold_pskus': return j(Array.from({ length: b.p_pallets }, (_, i) => `PSKU-${String(seq + 1 + i).padStart(6, '0')}`));
      case 'wms_mark_printed': return j(1);
      case 'wms_scan_carton': { const c = cartons.find((x) => x.code === b.p_code); if (!c) return fail(`${b.p_code} is not a carton label on file.`); const already = !!c.scanned_at; c.scanned_at = c.scanned_at || new Date().toISOString(); const all = cartons.filter((x) => x.pallet_id === c.pallet_id); return j({ pallet_id: c.pallet_id, psku: pallets.find((p) => p.id === c.pallet_id).psku, seq: c.seq, already, scanned: all.filter((x) => x.scanned_at).length, total: all.length }); }
      case 'wms_complete_count': { const p = pallets.find((x) => x.id === b.p_pallet); p.status = 'counted'; p.counted_at = new Date().toISOString(); p.counted_by_name = WHO; pickLoc(p); return j(p); }
      case 'wms_assign_location': { const p = pallets.find((x) => x.id === b.p_pallet); p.location_id = b.p_location; return j(p); }
      case 'wms_putaway': { const p = pallets.find((x) => x.id === b.p_pallet); p.status = 'stored'; p.stored_at = new Date().toISOString(); p.stored_by_name = WHO; return j(p); }
      default: return j([]);
    }
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); page.on('console', (m) => m.type() === 'error' && !/400/.test(m.text()) && console.log('CONSOLE', m.text()));
  const shot = (n, full = true) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });
  const frameDoc = () => page.evaluate(() => { const f = document.getElementById('wms-print'); return f ? { doc: f.srcdoc, size: f.dataset.size } : null; });
  const pdf = async (name) => { const f = await frameDoc(); const [w, h] = f.size.split(' '); if (!/size:/.test(f.doc.match(/@page \{[^}]*\}/)[0])) console.log(name, 'page size left to the printer paper'); const lp = await ctx.newPage(); await lp.goto(`http://localhost:${PORT}/version.json`); await lp.setContent(f.doc.replace(/<head>/, `<head><base href="http://localhost:${PORT}/">`), { waitUntil: 'networkidle' }); await lp.evaluate(() => document.fonts.ready); await lp.pdf({ path: `${OUT}/${name}.pdf`, width: w, height: h, printBackground: true, preferCSSPageSize: true }); await lp.close(); };
  const scan = async (code) => { await page.locator('.scanbox input').first().fill(code); await page.keyboard.press('Enter'); await page.waitForTimeout(60); };

  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(600);
  await page.evaluate((s) => localStorage.setItem('shipbay-wms-auth', JSON.stringify(s)), sess);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(900);
  await page.locator('.brands button', { hasText: 'Souled Worldwide' }).click(); await page.waitForTimeout(400);
  const pickProduct = async (i, q, cartons, fba) => { const line = page.locator('.line').nth(i); await line.locator('.scanbox input').fill(q); await page.waitForTimeout(200); await line.locator('.scanbox input').press('Enter'); await page.waitForTimeout(150); await line.getByLabel(/^Cartons/).fill(String(cartons)); if (fba) await line.locator('.fbatoggle').first().click(); };
  // a mixed pallet: three products, one FBA
  await pickProduct(0, 'mini blocks', 6, true);
  await page.locator('.addline').click(); await pickProduct(1, 'sabrett onions 16 oz', 9, false);
  await page.locator('.addline').click(); await pickProduct(2, 'tenax ager pen', 5, false);
  await page.waitForTimeout(250); await shot('01-mixed-pallet');
  // print the carton labels before Receive, reload the station, and the form with its held number is still there
  await page.locator('.early .sizepick').nth(0).selectOption('2x1'); await page.locator('.early .sizepick').nth(1).selectOption('0');
  await page.locator('.early .btn').first().click(); await page.waitForTimeout(700); await pdf('carton-labels-before-receive');
  await page.reload(); await page.waitForTimeout(900); await shot('01b-printed-before-receive');
  console.log('held', await page.locator('.early .strip').innerText());
  await page.locator('.line').nth(1).getByLabel(/^Cartons/).fill('8'); await page.waitForTimeout(150); console.log('changed', await page.locator('.early .strip').innerText());
  await page.locator('.line').nth(1).getByLabel(/^Cartons/).fill('9'); await page.waitForTimeout(150);
  await page.locator('form .btn.big').click(); await page.waitForTimeout(700);
  console.log('after receive', await page.locator('.printrow').nth(1).innerText(), '| hold kept:', await page.evaluate(() => localStorage.getItem('wms-hold')));
  await page.locator('.printrow .btn').nth(0).click(); await page.waitForTimeout(500); await pdf('pallet-label-mixed');
  await page.locator('.printrow .sizepick').nth(0).selectOption('2x1'); await page.locator('.printrow .sizepick').nth(1).selectOption('0'); await page.waitForTimeout(150);
  await page.locator('.printrow .twobtn .btn').nth(0).click(); await page.waitForTimeout(700); await pdf('carton-labels-mixed');
  await shot('02-print-prompt', false);
  await page.locator('.dialog .btn.big').click(); await page.waitForTimeout(600);
  const mine = pallets[pallets.length - 1]; const codes = cartons.filter((c) => c.pallet_id === mine.id).map((c) => c.code);
  for (const c of codes.slice(0, 8)) await scan(c);
  await page.waitForTimeout(200); await shot('03-mixed-scanning');
  // an open box: carton 12 has 7 loose units
  await page.getByRole('button', { name: 'Found an open box' }).click(); await page.waitForTimeout(200);
  await page.getByLabel('Carton', { exact: true }).fill('12'); await page.getByLabel('Units in it').fill('7'); await page.waitForTimeout(100); await shot('04-open-box-form', false);
  await page.locator('.dialog .btn.go').click(); await page.waitForTimeout(700); await shot('05-open-box-labels', false);
  await page.locator('.dialog .printrow .btn.go').click(); await page.waitForTimeout(600); await pdf('unit-labels');
  await page.locator('.dialog .btn.big').click(); await page.waitForTimeout(300);
  for (const c of codes.slice(8)) await scan(c);
  await page.waitForTimeout(250); await shot('06-all-cartons-in');
  await page.locator('.pmain .btn.big').click(); await page.waitForTimeout(500); await shot('07-put-away-map');
  const target = locations.find((l) => l.id === mine.location_id).code;
  await scan('LOC-' + target); await scan(mine.psku); await page.waitForTimeout(500); await shot('08-received');
  await page.locator('.rail nav button', { hasText: 'Locations' }).click(); await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.locator('.inlinepick .sizepick').selectOption('2x1'); await page.waitForTimeout(150); await shot('10-locations');
  await page.getByRole('button', { name: /Print 4 Bulk labels/ }).click(); await page.waitForTimeout(500); await pdf('position-labels-2x1');
  // NCC (no carton count): one product, no count -> no carton labels, straight to put-away, NCC on the 4x6
  await page.locator('.rail nav button', { hasText: 'Receiving' }).click(); await page.waitForTimeout(400);
  { const line = page.locator('.line').nth(0); await line.locator('.scanbox input').fill('mini blocks'); await page.waitForTimeout(200); await line.locator('.scanbox input').press('Enter'); await page.waitForTimeout(150); } await page.locator('.line .fbatoggle').nth(1).click(); await page.waitForTimeout(200); await shot('12-cle-form');
  await page.locator('form .btn.big').click(); await page.waitForTimeout(700); await shot('13-cle-prompt', false);
  await page.locator('.printrow .btn').nth(0).click(); await page.waitForTimeout(500); await pdf('pallet-label-cle');
  await page.locator('.dialog .btn.big').click(); await page.waitForTimeout(600); await shot('14-cle-pallet');
  // mixed pallet with one NCC product and one counted product
  await page.locator('.rail nav button', { hasText: 'Receiving' }).click(); await page.waitForTimeout(400);
  { const line = page.locator('.line').nth(0); await line.locator('.scanbox input').fill('tenax ager pen'); await page.waitForTimeout(200); await line.locator('.scanbox input').press('Enter'); await page.waitForTimeout(150); } await page.locator('.line .fbatoggle').nth(1).click();
  await page.locator('.addline').click(); await pickProduct(1, 'sabrett onions 16 oz', 4, false); await page.waitForTimeout(200); await shot('15-ncc-mixed-form');
  await page.locator('form .btn.big').click(); await page.waitForTimeout(700); await shot('16-ncc-mixed-prompt', false);
  await page.locator('.printrow .btn').nth(0).click(); await page.waitForTimeout(500); await pdf('pallet-label-ncc-mixed');
  await page.locator('.printrow .twobtn .btn').nth(0).click(); await page.waitForTimeout(700); await pdf('carton-labels-ncc-mixed');
  await page.locator('.dialog .btn.big').click(); await page.waitForTimeout(600); await shot('17-ncc-mixed-pallet');
  await page.locator('.rail nav button', { hasText: 'Pallets' }).click(); await page.waitForTimeout(300); await page.locator('.seg button', { hasText: 'All' }).click(); await page.waitForTimeout(200); await shot('11-register');
  await browser.close(); process.exit(0);
})().catch((e) => { console.log('FAILED', e.message.split('\n').slice(0, 3).join(' | ')); process.exit(1); });
