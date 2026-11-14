// Screenshots of the WMS with stubbed data + the 4x6 label as it prints. node preview-wms.cjs [outdir]
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.argv[2] || 'shots'; fs.mkdirSync(OUT, { recursive: true });
const DIST = path.join(__dirname, 'dist'); const PORT = 4179;
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);
const UID = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a';
const orgs = [{ id: 'o1', name: 'Souled Worldwide', status: 'onboarding' }, { id: 'o2', name: 'Steel Horse Leather', status: 'onboarding' }, { id: 'o3', name: 'Vinyl Moon', status: 'onboarding' }];
let seq = 0; const pallets = [];
const add = (org, n, extra = {}, agoMin = 0) => { const key = `k${seq}`; const out = []; for (let i = 1; i <= n; i++) { const r = { id: `p${++seq}`, psku: `PSKU-${String(seq).padStart(6, '0')}`, org_id: org, status: 'received', reference: null, carrier: null, cartons: null, notes: null, batch_key: key, batch_pos: i, batch_size: n, received_at: new Date(Date.now() - agoMin * 60000).toISOString(), received_by: UID, received_by_name: 'Derek Harrison', label_prints: 1, last_printed_at: new Date(Date.now() - agoMin * 60000).toISOString(), void_reason: null, ...extra }; pallets.push(r); out.push(r); } return out; };
add('o1', 3, { reference: 'SW-PO-1182', carrier: 'Estes', cartons: 24 }, 60 * 26);
add('o2', 4, { reference: 'SH-INBOUND-001', carrier: 'Client drop-off', cartons: 22 }, 190);
add('o3', 2, { reference: 'VM-NOV-A', carrier: 'XPO', cartons: 40, notes: 'Records stored vertical. Do not double stack.' }, 95);
pallets[pallets.length - 1].status = 'void'; pallets[pallets.length - 1].void_reason = 'Entered twice';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'derekh@shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
  await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, (route) => {
    const req = route.request(); const m = req.url().match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/); const single = (req.headers()['accept'] || '').includes('object');
    const j = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m[2] === 'profiles') return j(single ? { id: UID, full_name: 'Derek Harrison', email: 'derekh@shipbay3pl.com', role: 'shipbay_admin' } : []);
    if (m[2] === 'orgs') return j(orgs);
    if (m[2] === 'wms_pallets') return j([...pallets].reverse());
    if (m[2] === 'wms_receive_pallets') { const b = req.postDataJSON(); return j(add(b.p_org, b.p_count, { reference: b.p_reference, carrier: b.p_carrier, cartons: b.p_cartons, notes: b.p_notes, label_prints: 0, last_printed_at: null })); }
    if (m[2] === 'wms_mark_printed') return j(1);
    if (m[2] === 'wms_void_pallet') { const b = req.postDataJSON(); const p = pallets.find((x) => x.id === b.p_id); Object.assign(p, { status: 'void', void_reason: b.p_reason }); return j(p); }
    j([]);
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
  const shot = (n, full = true) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(700); await shot('00-signin', false);
  await page.evaluate((s) => localStorage.setItem('shipbay-wms-auth', JSON.stringify(s)), sess);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(900); await shot('01-receiving-empty');
  await page.locator('.brands button', { hasText: 'Souled Worldwide' }).click();
  await page.locator('.quick button', { hasText: /^4$/ }).click();
  await page.getByLabel('Reference').fill('SW-PO-1190'); await page.getByLabel('Carrier').fill('Old Dominion'); await page.getByLabel('Cartons per pallet').fill('30');
  await page.waitForTimeout(200); await shot('02-receiving-filled');
  await page.locator('.btn.big').click(); await page.waitForTimeout(900); await shot('03-received');
  // the print frame's document = what the printer gets
  const doc = await page.evaluate(() => document.getElementById('wms-print')?.srcdoc || '');
  console.log('print frame bytes', doc.length, 'labels', (doc.match(/class="plabel"/g) || []).length);
  await page.locator('.rail nav button', { hasText: 'Pallets' }).click(); await page.waitForTimeout(400);
  await page.locator('.scanbox input').fill('12'); await page.keyboard.press('Enter'); await page.waitForTimeout(400); await shot('04-pallets-scan');
  await page.locator('.seg button', { hasText: 'All' }).click(); await page.locator('.scanbox .x').click(); await page.waitForTimeout(300); await shot('05-pallets-all');
  const mob = await ctx.newPage(); await mob.setViewportSize({ width: 820, height: 1180 }); await mob.goto(`http://localhost:${PORT}/`); await mob.waitForTimeout(900); await mob.screenshot({ path: `${OUT}/06-tablet.png`, fullPage: true });
  const lp = await ctx.newPage(); await lp.goto(`http://localhost:${PORT}/version.json`); await lp.setContent(doc.replace(/<head>/, `<head><base href="http://localhost:${PORT}/">`), { waitUntil: 'networkidle' }); await lp.evaluate(() => document.fonts.ready);
  await lp.pdf({ path: `${OUT}/labels.pdf`, width: '4in', height: '6in', printBackground: true, preferCSSPageSize: true });
  await browser.close(); process.exit(0);
})();
