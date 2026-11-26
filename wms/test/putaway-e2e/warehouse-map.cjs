// WMS → Warehouse Map against a stand-in bridge that keeps occupancy the way Nexus does (one pallet per position, Souled shown by
// company only) and refuses a taken position. Proves: the approved layout and colours, typed pallet IDs (no scanner), tapping a
// position, place / register / move / release each needing the employee's confirmation, Nexus's refusal of a Souled position,
// the map refreshed straight after each placement, position-label printing, and no other company's pallet id on screen.
//   OUT=/tmp/wm-e2e VITE_NEXUS_BRIDGE=on VITE_SUPABASE_URL=http://127.0.0.1:4641 VITE_SUPABASE_KEY=stub npx vite build --config test/putaway-e2e/vite.config.js && BUILD=/tmp/wm-e2e PORT=4641 node test/putaway-e2e/warehouse-map.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const BUILD = process.env.BUILD; const PORT = Number(process.env.PORT || 4641); let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const layout = { grid: { cols: 5, rows: 18 }, blocks: [{ key: 'outbound', x: [1, 2], y: [1, 18], label: 'Outbound' }, { key: 'walkway', x: [3, 3], y: [1, 18], label: 'Walkway' }, { key: 'inbound', x: [4, 5], y: [1, 15], label: 'Inbound' }, { key: 'staging', x: [4, 5], y: [16, 16], label: 'Staging' }] };
const landmarks = [{ key: 'exit', x: [1, 2], edge: 'top', label: 'Exit' }, { key: 'dock', x: [4, 5], edge: 'top', label: 'Dock' }, { key: 'entrance', x: [3, 3], edge: 'bottom', label: 'Entrance' }, { key: 'prep', x: [4, 5], edge: 'bottom', label: 'Prep area' }];
const positions = []; let n = 1;
for (let x = 4; x <= 5; x++) for (let y = 1; y <= 15; y++) positions.push({ code: `P-${String(n++).padStart(2, '0')}`, kind: 'pallet', block: 'inbound', status: 'open', capacity: 1, x, y });
for (let x = 1; x <= 2; x++) for (let y = 1; y <= 18; y++) positions.push({ code: `P-${String(n++).padStart(2, '0')}`, kind: 'pallet', block: 'outbound', status: 'open', capacity: 1, x, y });
positions.push({ code: 'STG-01', kind: 'staging', block: 'staging', status: 'open', x: 4, y: 16 }, { code: 'STG-02', kind: 'staging', block: 'staging', status: 'open', x: 5, y: 16 }, { code: 'RCV-DOCK', kind: 'dock', status: 'open', x: null, y: null });
positions.find((p) => p.code === 'P-66').status = 'blocked';
// occupancy kept like Nexus: who stands where
const at = new Map([['P-05', { company: 'SOULED', id: 'SOULED-PAL-9' }]]);
const occupancy = () => positions.filter((p) => p.kind !== 'dock').map((p) => { const o = at.get(p.code); return { code: p.code, kind: p.kind, status: p.status, capacity: 1, used: o ? 1 : 0, free: o ? 0 : 1, occupants: o ? [{ company: o.company, pallets: 1 }] : [], your_pallets: o && o.company === 'SHIPBAY' ? [o.id] : [] }; });
const where = (id) => [...at].find(([, o]) => o.id === id)?.[0] || null;
const seen = []; let floorReads = 0; const created = [];
const PALLETS = { 'PSKU-000040': { id: 'u40', psku: 'PSKU-000040', org_id: 'vm', status: 'counted', item_name: 'VM135 records', units_total: 300, held: false }, 'PSKU-000041': { id: 'u41', psku: 'PSKU-000041', org_id: 'vm', status: 'counted', item_name: 'VM135 mailers', units_total: 500, held: false } };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname); let raw = '';
  req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const send = (code, out) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    if (p === '/rest/v1/rpc/wms_brands') return send(200, [{ id: 'vm', name: 'Vinyl Moon' }, { id: 'demo', name: 'Demo Brand' }]);
    if (p === '/rest/v1/rpc/wms_mark_printed') return send(200, null);
    if (p === '/rest/v1/wms_pallets') {
      const bk = (u.searchParams.get('batch_key') || '').replace(/^eq\./, ''); if (bk) return send(200, Object.values(PALLETS).filter((x) => x.batch_key === bk));
      const ids = (u.searchParams.get('psku') || '').replace(/^in\.\(|\)$/g, '').split(','); return send(200, ids.map((i) => PALLETS[i]).filter(Boolean));
    }
    if (p === '/rest/v1/rpc/wms_products') return send(200, [{ id: 'sku1', sku: 'DEMO-TEE', name: 'Demo tee' }, { id: 'sku2', sku: 'DEMO-CAP', name: 'Demo cap' }]);
    if (p === '/rest/v1/rpc/wms_bookings') return send(200, []);
    if (p === '/rest/v1/rpc/wms_create_pallet') { const b = JSON.parse(raw); created.push(b);
      PALLETS['SB-PAL-000042'] = { id: 'u42', psku: 'SB-PAL-000042', org_id: b.p_org, status: 'open', item_name: 'Demo tee', units_total: null, held: false, batch_key: b.p_key, batch_pos: 1 }; return send(200, [PALLETS['SB-PAL-000042']]); }
    if (p === '/rest/v1/wms_cartons') return send(200, []);
    if (p.startsWith('/rest/v1/')) return send(404, {});
    if (p.startsWith('/functions/v1/nexus-bridge')) {
      const r = p.replace('/functions/v1/nexus-bridge', ''); const b = raw ? JSON.parse(raw) : {}; seen.push({ m: req.method, r, b });
      if (r === '/status') return send(200, { ok: true, connection: 'production', floor: 'HILLSBOROUGH', pallet_moves: true, move_key: true, move_window: null });
      if (r === '/floor') { floorReads++; return send(200, { ok: true, warehouse: 'HILLSBOROUGH', map_version: 4, checksum: 'be3c', occupancy_state: 'forward_only', moves_enabled: true, layout, landmarks, positions, locations: occupancy() }); }
      if (r === '/pending') return send(200, { ok: true, open: [] });
      if (r === '/reconcile') return send(403, { ok: false, error: 'not_admin' });
      if (b.confirmed_clear !== true && (r === '/putaway' || r === '/move')) return send(400, { ok: false, error: 'location_not_confirmed', message: 'Confirm first.' });
      if (r === '/putaway' || r === '/move') {
        if (at.has(b.location)) return send(409, { ok: false, error: 'location_full', message: `${b.location} is taken in Nexus. Pick another position.` });
        const from = where(b.psku); if (r === '/putaway' && from) return send(409, { ok: false, error: 'already_there', message: 'already placed' });
        if (r === '/move' && !from) return send(409, { ok: false, error: 'pallet_not_placed', message: 'not placed' });
        if (from) at.delete(from); at.set(b.location, { company: 'SHIPBAY', id: b.psku });
        return send(200, { ok: true, psku: b.psku, location: b.location, from, units_posted: PALLETS[b.psku]?.units_total || 0 });
      }
      if (r === '/release') { if (b.confirmed !== true || where(b.psku) !== b.location) return send(409, { ok: false, error: 'pallet_elsewhere', message: 'elsewhere' }); at.delete(b.location); return send(200, { ok: true, psku: b.psku, from: b.location, pallet_status: 'departed' }); }
      return send(404, { ok: false });
    }
    const f = path.resolve(BUILD, '.' + p); const file = f.startsWith(BUILD + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(BUILD, 'putaway.html');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1');
const tone = (p, c) => p.locator(`[data-testid="map-${c}"]`).getAttribute('data-tone');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const errors = []; const outside = [];
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; if (h === '127.0.0.1') return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { window.__printed = []; window.print = () => { window.__printed.push(document.title); }; });
  await p.goto(`http://127.0.0.1:${PORT}/?screen=map`); await p.waitForSelector('[data-testid=pa-map]');
  ok((await p.locator('h1').innerText()).startsWith('Warehouse Map'), 'title is Warehouse Map');
  ok(await p.locator('[data-testid^=map-]').count() === 68, '66 pallet positions + 2 staging drawn');
  const box = async (c) => p.locator(`[data-testid="map-${c}"]`).boundingBox();
  const [p31, p49, p01, p16, s1, s2, p15] = await Promise.all(['P-31', 'P-49', 'P-01', 'P-16', 'STG-01', 'STG-02', 'P-15'].map(box));
  ok(p31.x < p49.x && p49.x < p01.x && p01.x < p16.x, 'left two rows (P-31.., P-49..), walkway, right two rows (P-01.., P-16..)');
  ok(s1.y - (p15.y + p15.height) > 30 && Math.abs(s1.y - s2.y) < 1, 'staging set apart below the right rows, side by side');
  for (const k of ['exit', 'dock', 'entrance', 'prep']) ok(await p.locator(`[data-testid="mark-${k}"]`).count() === 1, `landmark ${k} on the wall`);
  ok(await tone(p, 'P-05') === 'souled' && await tone(p, 'P-01') === 'open' && await tone(p, 'P-66') === 'unknown', 'colours: Souled blue, open white, blocked grey');
  const bg = await p.locator('[data-testid="map-P-05"]').evaluate((e) => getComputedStyle(e).backgroundColor); ok(bg === 'rgb(37, 99, 201)', `Souled tile is blue (${bg})`);
  ok(!/SOULED-PAL/.test(await p.content()), 'no Souled pallet id anywhere');
  // place by typing (no scanner): pallet number alone, then tap the position
  await p.locator('[data-testid=wm-act] .scanbox input').first().fill('40'); await p.keyboard.press('Enter');
  await p.waitForSelector('[data-testid=pa-pallet-info]'); ok(/Vinyl Moon/.test(await p.locator('[data-testid=pa-pallet]').innerText()), 'typed "40" identifies PSKU-000040 (Vinyl Moon)');
  await p.locator('[data-testid="map-P-12"]').click(); await p.waitForSelector('[data-testid=pa-confirm]');
  ok(seen.filter((x) => x.m === 'POST').length === 0, 'nothing sent before the confirmation');
  let reads = floorReads; await p.locator('[data-testid=pa-confirm-yes]').click(); await p.waitForSelector('[data-testid=pa-result][data-tone=ok]');
  const put = seen.find((x) => x.r === '/putaway'); ok(put && put.b.psku === 'PSKU-000040' && put.b.location === 'P-12' && put.b.confirmed_clear === true, 'placement sent with the employee confirmation');
  await p.waitForFunction(() => document.querySelector('[data-testid="map-P-12"]')?.dataset.tone === 'shipbay'); ok(floorReads > reads, 'map re-read straight after the placement');
  const og = await p.locator('[data-testid="map-P-12"]').evaluate((e) => getComputedStyle(e).backgroundColor); ok(og === 'rgb(255, 107, 21)', `ShipBay tile is orange (${og})`);
  // Nexus refuses a Souled position
  await p.locator('[data-testid=mode-register]').click();
  await p.locator('[data-testid=wm-act] .scanbox input').first().fill('PSKU-000041'); await p.keyboard.press('Enter'); await p.waitForSelector('[data-testid=pa-pallet-info]');
  await p.locator('[data-testid=wm-act] .scanbox input').last().fill('p-05'); await p.waitForSelector('[data-testid=pa-confirm]');
  ok(/Souled holds it/.test(await p.locator('[data-testid=pa-target]').innerText()), 'typed position, Souled warning shown');
  await p.locator('[data-testid=pa-confirm-yes]').click(); await p.waitForSelector('[data-testid=pa-result][data-tone=bad]');
  ok(/P-05 is taken in Nexus/.test(await p.locator('[data-testid=pa-result]').innerText()) && await tone(p, 'P-05') === 'souled', 'Nexus refused: P-05 stays Souled');
  // register in place at an empty position (pallet kept after the refusal)
  await p.locator('[data-testid=wm-act] .scanbox input').last().fill('STG-02'); await p.locator('[data-testid=pa-confirm-yes]').click(); await p.waitForSelector('[data-testid=pa-result][data-tone=ok]');
  ok(/Registered where it stands/.test(await p.locator('[data-testid=pa-result]').innerText()) && seen.filter((x) => x.m === 'POST').at(-1).b.in_place === true, 'registered in place at STG-02');
  // move 40 from P-12 to P-40
  await p.locator('[data-testid=mode-move]').click(); await p.locator('[data-testid=wm-act] .scanbox input').first().fill('40'); await p.keyboard.press('Enter'); await p.waitForSelector('[data-testid=pa-pallet-info]');
  ok(/Nexus has it at P-12/.test(await p.locator('[data-testid=pa-pallet]').innerText()), 'pallet shows where Nexus has it');
  await p.locator('[data-testid="map-P-40"]').click(); await p.locator('[data-testid=pa-confirm-yes]').click(); await p.waitForSelector('[data-testid=pa-result][data-tone=ok]');
  await p.waitForFunction(() => document.querySelector('[data-testid="map-P-12"]')?.dataset.tone === 'open' && document.querySelector('[data-testid="map-P-40"]')?.dataset.tone === 'shipbay'); ok(true, 'moved: P-12 open, P-40 ShipBay');
  // release by tapping its position
  await p.locator('[data-testid=mode-release]').click(); await p.locator('[data-testid="map-P-40"]').click(); await p.waitForSelector('[data-testid=pa-reason]');
  ok(await p.locator('[data-testid=pa-release-yes]').isDisabled(), 'release needs a reason and the tick');
  await p.locator('[data-testid=pa-reason]').selectOption('shipped_out'); await p.locator('[data-testid=pa-sure]').check(); await p.locator('[data-testid=pa-release-yes]').click();
  await p.waitForSelector('[data-testid=pa-result][data-tone=ok]'); await p.waitForFunction(() => document.querySelector('[data-testid="map-P-40"]')?.dataset.tone === 'open'); ok(true, 'released: P-40 open');
  // position labels and the way to create a pallet
  await p.locator('[data-testid="map-P-07"]').click(); await p.locator('[data-testid=wm-print-one]').click(); await p.locator('[data-testid=wm-print-all]').click();
  ok(await p.locator('[data-testid=wm-print-all]').innerText() === 'Print all 68', 'position labels: one or all 68');
  // create a pallet without a shipment, then it is ready to place
  await p.locator('[data-testid=mode-place]').click();
  await p.locator('[data-testid=wm-create]').click(); await p.waitForSelector('[data-testid=cp-form]');
  await p.locator('[data-testid=cp-brand]').selectOption('demo'); await p.waitForSelector('[data-testid=cp-product]');
  await p.locator('[data-testid=cp-find]').fill('tee'); await p.locator('[data-testid=cp-product]').selectOption('sku1');
  await p.locator('[data-testid=cp-cartons]').fill('2'); await p.locator('[data-testid=cp-upc]').fill('12');
  ok(await p.locator('[data-testid=cp-create]').isDisabled(), 'create needs a source and a reason without a shipment');
  await p.locator('[data-testid=cp-source]').selectOption('found_on_floor'); await p.locator('[data-testid=cp-reason]').fill('Stage 1 live test pallet');
  await p.locator('[data-testid=cp-create]').click(); await p.waitForSelector('[data-testid=cp-made]');
  const c0 = created[0]; ok(c0 && c0.p_org === 'demo' && c0.p_source === 'found_on_floor' && c0.p_reason === 'Stage 1 live test pallet' && c0.p_lines[0].sku === 'sku1' && c0.p_lines[0].cartons === 2 && c0.p_lines[0].units_per_carton === 12, 'wms_create_pallet called with product, quantities, source and reason');
  ok(/SB-PAL-000042/.test(await p.locator('[data-testid=cp-id]').innerText()), 'new id is SB-PAL-000042');
  await p.locator('[data-testid=cp-place]').click(); await p.waitForSelector('[data-testid=pa-pallet-info]');
  ok(/SB-PAL-000042/.test(await p.locator('[data-testid=pa-pallet]').innerText()), 'the new pallet is ready to place');
  ok(outside.length === 0, 'nothing leaves 127.0.0.1'); ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await p.screenshot({ path: '/tmp/wm-map.png', fullPage: true });
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
