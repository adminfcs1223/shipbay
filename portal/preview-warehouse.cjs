// The client Warehouse page, opened through the admin's "View as client" switch. Stubbed data.
// node preview-warehouse.cjs [outdir]
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.argv[2] || 'shots-warehouse'; fs.mkdirSync(OUT, { recursive: true });
const DIST = path.join(__dirname, 'dist'); const PORT = 4183;
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);
const UID = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'; const now = Date.now(); const ago = (h) => new Date(now - h * 3600e3).toISOString(); const T = new Date().toISOString().slice(0, 10);
const orgs = [{ id: 'od', name: 'Demo Brand', slug: 'demo-brand', status: 'active' }, { id: 'o1', name: 'Souled Worldwide', slug: 'souled-worldwide', status: 'onboarding' }];
const L = (id, sku, name, qty, picked) => ({ id, sku, name, qty, picked_at: picked ? ago(1) : null });
const data = {
  orders: [
    { id: 'r1', org_id: 'od', order_number: 'DEMO-1001', ship_by: T, status: 'picked', closed_at: null, received_at: ago(5), total_units: 3, order_lines: [L('a', 'DEMO-TEE-BLK-M', 'Logo Tee, Black, M', 2, 1), L('b', 'DEMO-CAP-NVY', 'Dad Cap, Navy', 1, 1)] },
    { id: 'r2', org_id: 'od', order_number: 'DEMO-1002', ship_by: T, status: 'new', closed_at: null, received_at: ago(5), total_units: 3, order_lines: [L('c', 'DEMO-TEE-BLK-M', 'Logo Tee, Black, M', 1, 1), L('d', 'DEMO-MUG-11', 'Ceramic Mug, 11 oz', 2, 0)] },
    { id: 'r5', org_id: 'od', order_number: 'DEMO-1005', ship_by: T, status: 'new', closed_at: null, received_at: ago(4), total_units: 5, order_lines: [L('e', 'DEMO-BTL-20', 'Steel Bottle, 20 oz', 4, 0), L('f', 'DEMO-TOTE-NAT', 'Canvas Tote, Natural', 1, 0)] },
    { id: 'r0', org_id: 'od', order_number: 'DEMO-0998', ship_by: T, status: 'new', closed_at: ago(20), received_at: ago(30), total_units: 2, order_lines: [L('g', 'DEMO-PIN-SET', 'Enamel Pin Set', 2, 0)] },
    { id: 'x1', org_id: 'o1', order_number: 'SOULED-77', ship_by: T, status: 'new', closed_at: null, received_at: ago(2), total_units: 1, order_lines: [L('z', 'ITM-000169', 'Should never show', 1, 0)] },
  ],
  inventory_levels: [['DEMO-TEE-BLK-M', 'Logo Tee, Black, M', 49, 1], ['DEMO-CAP-NVY', 'Dad Cap, Navy', 29, 0], ['DEMO-MUG-11', 'Ceramic Mug, 11 oz', 24, 2], ['DEMO-BTL-20', 'Steel Bottle, 20 oz', 2, 4], ['DEMO-POSTER-18', 'Poster, 18 × 24', 0, 0]].map(([sku, name, on_hand, reserved], i) => ({ sku_id: `k${i}`, org_id: 'od', sku, name, on_hand, reserved, active: true })),
  wms_pallets: [
    { id: 'p1', org_id: 'od', psku: 'PSKU-000041', status: 'stored', item_no: 'DEMO-TEE-BLK-M', item_name: 'Logo Tee, Black, M', cartons: 4, units_per_carton: 12, units_total: null, mixed: false, fba: false, cle: false, received_at: ago(50), stored_at: ago(49) },
    { id: 'p2', org_id: 'od', psku: 'PSKU-000042', status: 'open', item_no: null, item_name: 'Mixed pallet · 3 products', cartons: 20, units_per_carton: null, units_total: null, mixed: true, fba: true, cle: false, received_at: ago(3), stored_at: null },
    { id: 'p3', org_id: 'od', psku: 'PSKU-000043', status: 'counted', item_no: 'DEMO-STKR-PK', item_name: 'Sticker Pack', cartons: null, units_per_carton: null, units_total: 200, mixed: false, fba: false, cle: true, received_at: ago(2), stored_at: null },
  ],
  wms_pick_problems: [
    { id: 'b1', org_id: 'od', line_id: 'e', order_id: 'r5', kind: 'short', found: 2, note: 'Shelf only has two', reported_at: ago(1), resolved_at: null, resolved_how: null, order_lines: { sku: 'DEMO-BTL-20', name: 'Steel Bottle, 20 oz', qty: 4 } },
    { id: 'b2', org_id: 'od', line_id: 'd', order_id: 'r2', kind: 'missing', found: null, note: null, reported_at: ago(6), resolved_at: ago(5), resolved_how: 'picked', order_lines: { sku: 'DEMO-MUG-11', name: 'Ceramic Mug, 11 oz', qty: 2 } },
  ],
  inbound_shipments: [
    { id: 'i1', org_id: 'od', reference: 'PO 5512', status: 'expected', carrier: 'Estes', tracking: '0412-889', expected_at: T, received_at: null, pallets: 2, cartons: null, notes: 'Holiday restock', created_at: ago(40), approved_at: ago(30) },
    { id: 'i2', org_id: 'o1', reference: 'Container 7', status: 'expected', carrier: 'XPO', tracking: null, expected_at: new Date(now + 3 * 864e5).toISOString().slice(0, 10), received_at: null, pallets: 6, cartons: null, notes: null, created_at: ago(5), approved_at: null },
    { id: 'i3', org_id: 'od', reference: 'Delivery', status: 'expected', carrier: 'UPS Freight', tracking: null, expected_at: new Date(now + 9 * 864e5).toISOString().slice(0, 10), received_at: null, pallets: 3, cartons: null, notes: 'Winter drop', created_at: ago(2), approved_at: null },
  ],
};
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'admin@shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z' } };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const seen = []; let writes = 0;
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
  await ctx.route(/\/functions\/v1\//, (r) => { writes++; r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, (route) => {
    const req = route.request(); const u = new URL(req.url()); const m = /\/rest\/v1\/(rpc\/)?([a-z_]+)/.exec(u.pathname); const fn = m[2];
    const j = (x) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    const single = (req.headers().accept || '').includes('vnd.pgrst.object'); const org = (u.searchParams.get('org_id') || '').replace('eq.', '');
    if (req.method() !== 'GET' && !m[1]) { writes++; if (req.method() === 'PATCH' && data[fn]) { const id = (u.searchParams.get('id') || '').replace('eq.', ''); const row = data[fn].find((r) => r.id === id); if (row) Object.assign(row, JSON.parse(req.postData() || '{}')); return j([]); } }
    if (m[1]) return j(fn === 'wms_org_connector' ? { client_code: 'DEMO', keys: [{ id: 'k1', label: 'Veeqo program', hint: '9f2c', created_at: ago(90), last_used_at: ago(1), revoked_at: null }, { id: 'k0', label: 'First try', hint: '11ab', created_at: ago(200), last_used_at: null, revoked_at: ago(90) }] } : []);
    if (fn === 'profiles') { const me = { id: UID, email: 'admin@shipbay3pl.com', full_name: 'Derek Harrison', role: 'shipbay_admin', active: true, is_owner: true, org_id: null }; return j(single ? me : [me]); }
    if (fn === 'orgs') return j(single ? orgs[0] : orgs);
    if (data[fn]) { seen.push(`${fn}${org ? ` org=${org}` : ' NO ORG FILTER'}`); return j(data[fn].filter((r) => !org || r.org_id === org)); }
    return j(single ? null : []);
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`http://localhost:${PORT}/`); await page.evaluate((s) => localStorage.setItem('shipbay-auth', JSON.stringify(s)), sess);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '00-hub.png'), fullPage: true });
  console.log('staff menu:', await page.locator('.sidenav .navitem').allInnerTexts(), '| to approve:', await page.locator('.glance > div').first().innerText());
  await page.locator('table .btn-sm.primary', { hasText: 'Approve' }).first().click(); await page.waitForTimeout(700);
  console.log('after approving one, to approve:', (await page.locator('.glance > div').first().innerText()).replace(/\n/g, ' '));
  await page.locator('.hubtabs button', { hasText: 'Demo Brand' }).click(); await page.waitForTimeout(900);
  await page.locator('.card .tabs button', { hasText: 'Deliveries' }).click(); await page.waitForTimeout(300); await page.screenshot({ path: path.join(OUT, '01-hub-brand-deliveries.png'), fullPage: true });
  await page.locator('.hubtabs button', { hasText: 'All brands' }).click(); await page.waitForTimeout(400);
  await page.locator('select.viewas').selectOption('od'); await page.waitForTimeout(1200);
  console.log('nav as client:', await page.locator('.sidenav .navitem').allInnerTexts(), '| bar:', await page.locator('.viewasbar span').innerText());
  await page.locator('.navitem', { hasText: 'Warehouse' }).click(); await page.waitForTimeout(900);
  for (const t of ['Orders', 'Stock', 'Pallets', 'Problems', 'Deliveries', 'Connection']) { await page.locator('.tabs button', { hasText: t }).first().click(); await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, `wh-${t.toLowerCase()}.png`), fullPage: true }); }
  console.log('other brand visible:', await page.getByText('SOULED-77').count(), '| reads:', [...new Set(seen)].join(', '));
  const before = writes; const res = await page.evaluate(async () => { const m = await import(document.querySelector('script[type=module]').src); return 'n/a'; }).catch(() => 'n/a');
  console.log('writes sent while viewing:', writes - before, '| book button disabled:', await (async () => { await page.locator('.tabs button', { hasText: 'Deliveries' }).click(); return page.locator('form .btn-sm.primary').isDisabled(); })());
  await page.locator('.viewasbar button').click(); await page.waitForTimeout(800); console.log('back to admin nav items:', await page.locator('.sidenav .navitem').count());
  await browser.close(); process.exit(0);
})();
