// Screenshots: a brand's inventory-list upload (parses a real file in the browser), ShipBay's review, and the
// Warehouse employees block. Stubbed data. node preview-invlist.cjs <outdir> <list.xlsx>
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.argv[2] || 'shots-invlist'; const FILE = process.argv[3]; fs.mkdirSync(OUT, { recursive: true });
const DIST = path.join(__dirname, 'dist'); const PORT = 4181;
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);
const ADMIN = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'; const CLIENT = '11111111-03f5-453b-99a0-5b7523ef5c8a'; const now = new Date().toISOString();
const org = { id: 'o1', name: 'Souled Worldwide', slug: 'souled-worldwide', status: 'onboarding', go_live_status: 'on_time', order_channels: { manual: true }, packing_slip: 'shipbay', sales_rep: 'Derek Harrison', ops_manager: 'Xavier Delmonte' };
const task = (key, label, kind, phase, sort) => ({ id: `t-${key}`, org_id: 'o1', key, label, kind, phase, sort, done: false, optional: false });
const tasks = [task('sku_catalog', 'Inventory list', 'catalog', 'inventory', 200), task('packaging_spec', 'Packaging spec', 'document', 'inventory', 210), task('inbound_scheduled', 'First inbound scheduled', 'schedule', 'inventory', 220)];
const items = (JSON.parse(fs.readFileSync(process.argv[4] || '/dev/null', 'utf8') || '[]')).map((i, n) => ({ id: `i${n}`, list_id: 'L1', org_id: 'o1', pos: n + 1, code: null, sku_id: null, ...i }));
const sum = (k) => items.reduce((s, i) => s + i[k], 0);
const list = { id: 'L1', org_id: 'o1', status: 'pending', file_name: 'Souled inventory.xlsx', storage_path: null, note: 'Starting inventory as of 11/1.', products: items.length, units: sum('qty'), units_fba: sum('qty_fba'), units_fbm: sum('qty_fbm'), submitted_by_name: 'Xavier Delmonte', submitted_at: now };
let lists = [];
const users = [
  { id: ADMIN, email: 'derekh@shipbay3pl.com', full_name: 'Derek Harrison', role: 'shipbay_admin', is_owner: true, is_sales: true, org_id: null, active: true, employee_no: 1001, last_seen_at: now },
  { id: 'u2', email: 'xavierd@shipbay3pl.com', full_name: 'Xavier Delmonte', role: 'shipbay_admin', is_sales: true, org_id: null, active: true, employee_no: null },
  { id: 'u3', email: 'emp-a@wms.shipbay3pl.com', full_name: 'Marcus Reyes', role: 'wms_employee', org_id: null, active: true, employee_no: 1002, last_seen_at: now },
  { id: 'u4', email: 'emp-b@wms.shipbay3pl.com', full_name: 'Tasha Greene', role: 'wms_employee', org_id: null, active: true, employee_no: 1003, last_seen_at: null },
  { id: 'u5', email: 'emp-c@wms.shipbay3pl.com', full_name: 'Luis Ortega', role: 'wms_employee', org_id: null, active: false, employee_no: 1004, last_seen_at: null },
];
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const mk = async (uid, email, profile) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
    const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    await ctx.addInitScript((s) => { localStorage.setItem('shipbay-auth', JSON.stringify(s)); sessionStorage.setItem('shipbay-owner-token', 'tok'); try { Object.keys(localStorage).filter((k) => /tour|tutorial/i.test(k)).forEach(() => {}); } catch { /* */ } }, sess);
    await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
    await ctx.route(/\/storage\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'k', path: 'p' }) }));
    await ctx.route(/\/functions\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, passphrase_set: true, unlocked: true }) }));
    await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, (route) => {
      const req = route.request(); const m = req.url().match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/); const single = (req.headers()['accept'] || '').includes('object'); const head = req.method() === 'HEAD';
      const T = { profiles: profile ? [profile] : users, orgs: [org], onboarding_tasks: tasks, v_onboarding_progress: [{ org_id: 'o1', name: org.name, status: 'onboarding', go_live_status: 'on_time', total: 3, done: 0, required_total: 3, required_done: 0, created_at: now }], documents: [], integrations: [], skus: [], inventory_lists: lists, inventory_list_items: items };
      if (m[2] === 'submit_inventory_list') { lists = [list]; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('L1') }); }
      if (req.method() === 'POST' && !m[1]) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(single ? { id: 'new' } : [{ id: 'new' }]) });
      let out = T[m[2]] || []; const u = new URL(req.url());
      for (const [k, v] of u.searchParams) { if (['select', 'order', 'limit', 'offset'].includes(k)) continue; const [op, ...rest] = v.split('.'); const val = rest.join('.'); if (op === 'eq') out = out.filter((r) => String(r[k]) === val); if (op === 'neq') out = out.filter((r) => String(r[k]) !== val); }
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `0-${out.length}/${out.length}` }, body: head ? '' : JSON.stringify(single ? out[0] || null : out) });
    });
    const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
    return page;
  };
  // 1 · the brand uploads its list
  let page = await mk(CLIENT, 'ops@souled.example', { id: CLIENT, email: 'ops@souled.example', full_name: 'Xavier Delmonte', role: 'client_admin', org_id: 'o1', active: true });
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(1200);
  const skip = page.getByRole('button', { name: /skip|close|got it|not now/i }).first(); if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('.phasetile', { hasText: /Inventory/ }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/10-client-onboarding.png`, fullPage: true });
  await page.getByRole('button', { name: 'Upload inventory list' }).click(); await page.waitForTimeout(200);
  if (FILE) { const t0 = Date.now(); await page.locator('.modal input[type=file]').setInputFiles(FILE); await page.waitForSelector('.liststats', { timeout: 30000 }); console.log('browser parse + roll-up ms', Date.now() - t0); console.log('stats', await page.locator('.liststats').innerText().then((t) => t.replace(/\n/g, ' '))); }
  await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/11-client-upload.png` });
  await page.locator('.modal .btn-sm.primary').click(); await page.waitForTimeout(700);
  await page.locator('.phasetile', { hasText: /Inventory/ }).click().catch(() => {}); await page.waitForTimeout(300);
  if (!(await page.locator('.task').first().isVisible().catch(() => false))) await page.locator('.phasetile', { hasText: /Inventory/ }).click();
  await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/12-client-sent.png`, fullPage: true });
  // 2 · ShipBay reviews it
  lists = [list];
  page = await mk(ADMIN, 'derekh@shipbay3pl.com', null);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(1200);
  await page.locator('.sidenav .navitem', { hasText: /^CRM$/ }).click(); await page.waitForTimeout(600);
  await page.locator('.ownertabs .tabs button', { hasText: /^Onboarding$/ }).click(); await page.waitForTimeout(800);
  await page.locator('.phasetile', { hasText: /Inventory/ }).click(); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/13-staff-onboarding.png`, fullPage: true });
  await page.getByRole('button', { name: 'Review inventory list' }).click(); await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/14-staff-review.png` });
  await page.keyboard.press('Escape'); await page.locator('.modal .btn-sm', { hasText: /^Close$/ }).click();
  // 3 · warehouse employees
  await page.locator('.sidenav .navitem', { hasText: /^Admin$/ }).click(); await page.waitForTimeout(700);
  await page.locator('.ownertabs .tabs button', { hasText: /^Admin settings$/ }).click(); await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/15-employees.png`, fullPage: true });
  await page.getByRole('button', { name: '+ Add employee' }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/16-add-employee.png` });
  await browser.close(); process.exit(0);
})().catch((e) => { console.log('FAILED', e.message.split('\n')[0]); process.exit(1); });
