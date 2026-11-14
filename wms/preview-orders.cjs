// Today, Orders and the Picklist with stubbed data, at phone width and desktop. The stub mirrors the database rules
// (pairing with stock, pick / undo moving stock, order → Ready to pack) so the screens can be walked end to end; the
// rules themselves are tested against the database. node preview-orders.cjs [outdir]
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.argv[2] || 'shots-orders'; fs.mkdirSync(OUT, { recursive: true });
const DIST = path.join(__dirname, 'dist'); const PORT = 4181;
http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); }).listen(PORT);
const UID = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'; const WHO = 'Marcus Reyes';
const iso = (d) => d.toISOString().slice(0, 10); const T = iso(new Date()); const sh = (n) => { const d = new Date(`${T}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const orgs = [{ id: 'o1', name: 'Souled Worldwide', status: 'onboarding', client_code: 'SOULED' }, { id: 'o2', name: 'Steel Horse Leather', status: 'onboarding', client_code: null }];
let demo = null; const skus = []; const stock = []; const orders = []; const lines = []; const picks = []; let lid = 0;
const DEMO = [['DEMO-TEE-BLK-M', 'A-01', 40], ['DEMO-TEE-WHT-M', 'A-01', 25], ['DEMO-HOOD-GRY-L', 'A-02', 18], ['DEMO-CAP-NVY', 'A-03', 30], ['DEMO-SOCK-3PK', 'A-04', 60], ['DEMO-MUG-11', 'B-01', 24], ['DEMO-TOTE-NAT', 'B-02', 35], ['DEMO-STKR-PK', 'B-02', 200], ['DEMO-BTL-20', 'B-03', 2], ['DEMO-NOTE-A5', 'B-04', 45], ['DEMO-PIN-SET', 'B-04', 50], ['DEMO-POSTER-18', null, 0]];
const reset = () => { demo = { id: 'od', name: 'Demo Brand', status: 'active', client_code: 'DEMO' }; skus.length = stock.length = orders.length = lines.length = picks.length = 0;
  DEMO.forEach(([sku, loc, qty], i) => { skus.push({ id: `k${i}`, sku }); if (loc) stock.push({ sku_id: `k${i}`, location_id: loc, code: loc, zone: 'pick', on_hand: qty, first_in: '2026-11-10T10:00:00Z' }); });
  stock.push({ sku_id: 'k0', location_id: 'B-01', code: 'B-01', zone: 'pick', on_hand: 12, first_in: '2026-11-12T10:00:00Z' }); };
const post = (b) => { if (orders.some((o) => o.order_number === b.order_number)) return 200; const o = { id: `r${orders.length}`, order_number: b.order_number, ship_by: b.ship_by, notes: b.notes, status: 'new', units: b.lines.reduce((s, l) => s + l.quantity, 0) }; orders.push(o);
  b.lines.forEach((l) => lines.push({ id: `n${++lid}`, order_id: o.id, sku: l.sku, sku_id: skus.find((k) => k.sku === l.sku)?.id || null, name: l.name, image_url: l.image_url, qty: l.quantity, picked_at: null })); return 201; };
const inView = (o, day, all) => all || (day ? o.ship_by === day : !o.ship_by || o.ship_by <= T);
const locsOf = (sid) => stock.filter((s) => s.sku_id === sid && s.on_hand > 0).sort((a, b) => a.first_in.localeCompare(b.first_in) || a.code.localeCompare(b.code));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const sess = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'emp@wms.shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z' } };
  const run = async (name, viewport, scale) => { demo = null; orders.length = lines.length = picks.length = stock.length = skus.length = 0;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
    await ctx.route(/placehold\.co/, (r) => { const m = /400x400\/([0-9A-F]{6})\/FFFFFF\/png\?text=(.*)$/i.exec(r.request().url()); r.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#${m ? m[1] : '888888'}"/><text x="200" y="215" font-family="Arial" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${m ? decodeURIComponent(m[2]).replace(/\+/g, ' ') : ''}</text></svg>` }); });
    await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sess.user) }));
    await ctx.route(/\/api\/orders$/, (r) => { const st = post(JSON.parse(r.request().postData())); r.fulfill({ status: st, contentType: 'application/json', body: '{}' }); });
    await ctx.route(/\/rest\/v1\/(rpc\/)?([a-z_]+)/, (route) => {
      const req = route.request(); const fn = /\/rest\/v1\/(?:rpc\/)?([a-z_]+)/.exec(req.url())[1]; let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* get */ }
      const j = (x, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(x) });
      const single = (req.headers().accept || '').includes('vnd.pgrst.object');
      switch (fn) {
        case 'profiles': { const me = { id: UID, email: 'emp@wms.shipbay3pl.com', full_name: WHO, role: 'wms_employee', active: true, employee_no: 1002 }; return j(single ? me : [me]); }
        case 'wms_brands': return j(orgs.concat(demo ? [demo] : []));
        case 'wms_today': { const open = orders.filter((o) => !o.closed && ['new', 'picked'].includes(o.status)); const by = new Map(); open.forEach((o) => { const k = o.ship_by || ''; const r = by.get(k) || { org_id: 'od', brand: 'Demo Brand', ship_by: o.ship_by, orders: 0, ready: 0, units: 0, picked_units: 0 }; r.orders++; if (o.status === 'picked') r.ready++; lines.filter((l) => l.order_id === o.id).forEach((l) => { r.units += l.qty; if (l.picked_at) r.picked_units += l.qty; }); by.set(k, r); });
          return j({ today: T, inbound: [{ id: 'i1', brand: 'Souled Worldwide', reference: 'BOL 44812', carrier: 'Estes', expected_at: T, pallets: 2, cartons: null, status: 'in_transit' }, { id: 'i2', brand: 'Vinyl Moon', reference: 'December boxes', carrier: 'UPS Freight', expected_at: sh(2), pallets: 4, cartons: null, status: 'expected' }, { id: 'i3', brand: 'Steel Horse Leather', reference: 'PO 2291', carrier: null, expected_at: sh(4), pallets: 1, cartons: null, status: 'expected' }],
            pallets: { received_today: 3, to_scan: 1, to_put_away: 2, stored_today: 1 }, orders: [...by.values()], picked_today: picks.filter((k) => !k.undone).reduce((s, k) => s + k.qty, 0), closed_today: 0 }); }
        case 'wms_order_brands': return j(orgs.filter((o) => o.client_code).map((o) => ({ id: o.id, name: o.name, client_code: o.client_code, due_orders: 0, due_units: 0, open_orders: 0, ready: 0 })).concat(demo ? [{ id: 'od', name: 'Demo Brand', client_code: 'DEMO', due_orders: orders.filter((o) => o.status === 'new' && inView(o)).length, due_units: lines.filter((l) => !l.picked_at && inView(orders.find((o) => o.id === l.order_id))).reduce((s, l) => s + l.qty, 0), open_orders: orders.filter((o) => o.status === 'new').length, ready: orders.filter((o) => o.status === 'picked').length }] : []));
        case 'wms_demo_reset': reset(); return j({ org_id: 'od', client: 'DEMO', key: 'sbk_demo_x', today: T });
        case 'wms_picklist': return j({ day: b.p_day || T, today: T, stock: stock.filter((s) => s.on_hand !== 0), ready: orders.filter((o) => o.status === 'picked').map((o) => ({ order_number: o.order_number, ship_by: o.ship_by, units: o.units })),
          lines: lines.filter((l) => inView(orders.find((o) => o.id === l.order_id), b.p_day, b.p_all)).map((l) => { const o = orders.find((x) => x.id === l.order_id); return { ...l, order_number: o.order_number, ship_by: o.ship_by, notes: o.notes, picked_from: [...new Set(picks.filter((k) => k.line === l.id && !k.undone).map((k) => k.code))].join(', ') || null }; }).sort((a, b2) => String(a.ship_by).localeCompare(String(b2.ship_by)) || a.order_number.localeCompare(b2.order_number)) });
        case 'wms_pick': { let done = 0; const not = []; for (const id of b.p_lines) { const l = lines.find((x) => x.id === id); if (!l || l.picked_at) continue; const locs = l.sku_id ? locsOf(l.sku_id) : []; const avail = locs.reduce((s, x) => s + x.on_hand, 0); let need = l.qty; for (const s of locs) { if (!need) break; const t = Math.min(need, s.on_hand); s.on_hand -= t; need -= t; picks.push({ line: id, code: s.code, sku_id: l.sku_id, qty: t }); } l.picked_at = new Date().toISOString(); l.picked_by_name = WHO; l.problem = null; done++; const o = orders.find((x) => x.id === l.order_id); if (lines.filter((x) => x.order_id === o.id).every((x) => x.picked_at)) o.status = 'picked'; } return j({ picked: done, not_picked: not }); }
        case 'wms_report_problem': { for (const id of b.p_lines) { const l = lines.find((x) => x.id === id); if (l && !l.picked_at) l.problem = { kind: b.p_kind, found: b.p_found, note: b.p_note, location: b.p_location, by: WHO, at: new Date().toISOString() }; } return j({ reported: b.p_lines.length }); }
        case 'wms_resolve_problem': { for (const id of b.p_lines) { const l = lines.find((x) => x.id === id); if (l) l.problem = null; } return j({ cleared: b.p_lines.length }); }
        case 'wms_unpick': { for (const id of b.p_lines) { const l = lines.find((x) => x.id === id); if (!l?.picked_at) continue; picks.filter((k) => k.line === id && !k.undone).forEach((k) => { k.undone = true; stock.find((s) => s.sku_id === k.sku_id && s.code === k.code).on_hand += k.qty; }); l.picked_at = null; orders.find((x) => x.id === l.order_id).status = 'new'; } return j({ undone: b.p_lines.length }); }
        default: return j([]);
      }
    });
    const page = await ctx.newPage(); page.on('pageerror', (e) => console.log(name, 'PAGE ERROR', e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(name, 'console', m.text()); });
    const shot = async (n, full = true) => { await page.screenshot({ path: path.join(OUT, `${name}-${n}.png`), fullPage: full }); };
    await page.goto(`http://localhost:${PORT}/`); await page.evaluate((s) => localStorage.setItem('shipbay-wms-auth', JSON.stringify(s)), sess);
    await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(900); await shot('01-today-empty');
    await page.locator('.rail nav button', { hasText: 'Orders' }).click(); await page.waitForTimeout(400); await shot('02-brands');
    await page.locator('.brandlist .demo button').click(); await page.waitForTimeout(1500); await shot('03-picklist');
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const rows = await page.locator('.prows:not(.done):not(.probs) > li').count();
    const tee = page.locator('.prows > li', { hasText: 'Logo Tee, Black' });
    console.log(name, 'sideways px', sideways, '| rows', rows, '| first rows:', await page.locator('.prows > li').nth(0).locator('.pl b').innerText(), '/', await page.locator('.prows > li').nth(1).locator('.pl b').innerText(), '| any disabled check:', await page.locator('.prows .pcheck:disabled').count(), '| tee qty', await tee.locator('.pq b').innerText(), 'at', await tee.locator('.pl b').innerText(), '| target h', await tee.locator('.pcheck').evaluate((e) => e.getBoundingClientRect().height));
    await tee.locator('.pwhat').click(); await page.waitForTimeout(150); await tee.screenshot({ path: path.join(OUT, `${name}-04-row-expanded.png`) });
    await tee.locator('.pcheck').click(); await page.waitForTimeout(500);
    console.log(name, 'after pick: tee in A-01', stock.find((s) => s.sku_id === 'k0' && s.code === 'A-01').on_hand, '(was 40) | rows', await page.locator('.prows:not(.done):not(.probs) > li').count());
    for (const n of ['Dad Cap', 'Crew Socks', 'Ceramic Mug']) { await page.locator('.prows:not(.done):not(.probs) > li', { hasText: n }).locator('.pcheck').click(); await page.waitForTimeout(400); }
    await page.locator('.prows:not(.done):not(.probs) > li', { hasText: 'Steel Bottle' }).locator('.pcheck').click(); await page.waitForTimeout(400);
    await page.locator('.prows:not(.done):not(.probs) > li', { hasText: 'Pullover Hoodie' }).locator('.pprob').click(); await page.waitForTimeout(200); await page.locator('.kinds button', { hasText: 'Short' }).click(); await page.locator('.pf input').fill('0'); await page.locator('.pf textarea').fill('Bin is empty'); await page.waitForTimeout(150); await shot('04b-report', false); await page.locator('.dlgbtns .btn.big').click(); await page.waitForTimeout(500);
    await page.locator('.prows:not(.done):not(.probs) > li', { hasText: 'Poster' }).locator('.pprob').click(); await page.waitForTimeout(150); await page.locator('.kinds button', { hasText: 'Not at' }).click(); await page.locator('.dlgbtns .btn.big').click(); await page.waitForTimeout(500);
    console.log(name, 'problems:', await page.locator('.prows.probs > li').count(), '| to pick rows', await page.locator('.prows:not(.done):not(.probs) > li').count());
    await page.locator('.sect.toggle', { hasText: 'Picked' }).click(); await page.waitForTimeout(200); await shot('05-picked-and-ready');
    await page.locator('.prows.probs > li', { hasText: 'Poster' }).locator('.undo').click(); await page.waitForTimeout(400); console.log(name, 'after back to list: problems', await page.locator('.prows.probs > li').count());
    console.log(name, 'ready:', await page.locator('.ready li').allInnerTexts(), '| bottle picked with 2 on file:', lines.find((l) => l.sku === 'DEMO-BTL-20').picked_at ? 'yes' : 'no');
    await page.locator('.prows.done > li', { hasText: 'Logo Tee, Black' }).locator('.undo').click(); await page.waitForTimeout(500);
    console.log(name, 'after undo: tee in A-01', stock.find((s) => s.sku_id === 'k0' && s.code === 'A-01').on_hand, '| ready:', await page.locator('.ready li').allInnerTexts());
    await page.locator('.daybar button', { hasText: 'Tomorrow' }).click(); await page.waitForTimeout(400); await shot('06-tomorrow', false);
    await page.locator('.rail nav button', { hasText: 'Today' }).click(); await page.waitForTimeout(600); await shot('07-today');
    await ctx.close();
  };
  await run('phone', { width: 390, height: 844 }, 2);
  await run('desk', { width: 1440, height: 980 }, 1);
  await browser.close(); process.exit(0);
})();
