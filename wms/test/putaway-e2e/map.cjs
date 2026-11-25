// WMS Put-away in READ-ONLY mode (pallet moves off), with a stand-in bridge that answers in Nexus's own occupancy shape:
// the other company appears by name and count only, ShipBay's own pallet ids in your_pallets. Proves what the floor sees
// for the read-only staging comparison: map version, full checksum, shared-floor occupancy, no other company's pallet id,
// and that nothing is sent but reads.
//   OUT=/tmp/pa-e2e VITE_NEXUS_BRIDGE=on VITE_SUPABASE_URL=http://127.0.0.1:4631 VITE_SUPABASE_KEY=stub npx vite build --config test/putaway-e2e/vite.config.js && BUILD=/tmp/pa-e2e node test/putaway-e2e/readonly.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const BUILD = process.env.BUILD; let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const SUM = 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f';
const pos = (c, used, occ, mine) => ({ code: c, kind: c.startsWith('STG') ? 'staging' : 'pallet', status: 'open', capacity: 1, used, free: 1 - used, occupants: occ, your_pallets: mine });
const layout = { grid: { cols: 5, rows: 18 }, blocks: [{ key: 'outbound', x: [1, 2], y: [1, 18], label: 'Outbound' }, { key: 'walkway', x: [3, 3], y: [1, 18], label: 'Walkway' }, { key: 'inbound', x: [4, 5], y: [1, 15], label: 'Inbound' }, { key: 'staging', x: [4, 5], y: [16, 16], label: 'Staging' }] };
const landmarks = [{ key: 'exit', x: [1, 2], edge: 'top', label: 'Exit' }, { key: 'dock', x: [4, 5], edge: 'top', label: 'Dock' }, { key: 'entrance', x: [3, 3], edge: 'bottom', label: 'Entrance' }];
const positions = []; let n = 1;
for (let x = 4; x <= 5; x++) for (let y = 1; y <= 15; y++) if (n <= 30) positions.push({ code: `P-${String(n++).padStart(2, '0')}`, kind: 'pallet', status: 'open', capacity: 1, x, y });
for (let x = 1; x <= 2; x++) for (let y = 1; y <= 18; y++) if (n <= 66) positions.push({ code: `P-${String(n++).padStart(2, '0')}`, kind: 'pallet', status: 'open', capacity: 1, x, y });
positions.push({ code: 'STG-01', kind: 'staging', status: 'open', x: 4, y: 16 }, { code: 'STG-02', kind: 'staging', status: 'open', x: 5, y: 16 }, { code: 'RCV-DOCK', kind: 'dock', status: 'open', x: null, y: null });
let floor; floor = { ok: true, warehouse: 'HILLSBOROUGH', map_version: 4, checksum: SUM, occupancy_state: 'forward_only', moves_enabled: true, layout, landmarks, positions,
  locations: [pos('P-01', 1, [{ company: 'SHIPBAY', pallets: 1 }], ['PSKU-000001']), pos('P-02', 1, [{ company: 'SOULED', pallets: 1 }], []), pos('P-03', 0, [], []), pos('P-04', 0, [], []), pos('STG-01', 0, [], []),
    { code: 'RCV-DOCK', kind: 'dock', status: 'open', capacity: null, used: 0, free: null, occupants: [], your_pallets: [] }] };
const seen = [];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/functions/v1/nexus-bridge')) {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const r = p.replace('/functions/v1/nexus-bridge', ''); seen.push({ m: req.method, r });
      const [code, out] = r === '/status' ? [200, { ok: true, connection: 'staging', floor: 'HILLSBOROUGH-TEST', pallet_moves: false, registry_writes: false, calendar_writes: false, test_faults: false }]
        : r === '/floor' ? [200, floor] : r === '/pending' ? [200, { ok: true, open: [] }] : r === '/reconcile' ? [200, { ok: true, in_sync: true, differences: [], waiting: [], exceptions: null }]
        : req.method === 'POST' ? [503, { ok: false, error: 'pallet_moves_off', message: 'Placing and releasing pallets through Nexus is switched off here.' }] : [404, { ok: false }];
      res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    }); return;
  }
  if (p.startsWith('/rest/v1/')) { res.writeHead(404); res.end('{}'); return; }
  const f = path.resolve(BUILD, '.' + p); const file = f.startsWith(BUILD + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(BUILD, 'putaway.html');
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 4633), '127.0.0.1');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const outside = []; const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 1100 } });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; if (h === '127.0.0.1') return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${process.env.PORT || 4633}/`); await p.waitForSelector('[data-testid=pa-shared]');
  await p.waitForSelector('[data-testid=pa-map]');
  ok(await p.locator('[data-testid^=map-]').count() === 68, `68 drawn positions (${await p.locator('[data-testid^=map-]').count()})`);
  ok(await p.locator('[data-testid="map-P-01"]').getAttribute('data-tone') === 'mine', 'P-01: ShipBay');
  ok(await p.locator('[data-testid="map-P-02"]').getAttribute('data-tone') === 'other', 'P-02: another company');
  ok(await p.locator('[data-testid="map-P-03"]').getAttribute('data-tone') === 'free', 'P-03: empty in Nexus');
  ok(!/PAL-\d/.test(await p.content()), 'no other company pallet id');
  ok(seen.every((x) => x.m === 'GET'), 'only reads'); ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await p.screenshot({ path: '/tmp/pa-map.png', fullPage: true });
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
