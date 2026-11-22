// Nexus end to end in a real browser (Chromium) against the local stack: the real screens, synthetic signed logins, RLS and
// the candidate enforced by Postgres. Not a GoTrue sign-in. Every request not to 127.0.0.1 is blocked and counted.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const S = JSON.parse(fs.readFileSync('/tmp/nexus-e2e/session.json', 'utf8')); const E = '/tmp/nexus-e2e';
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const serve = (dir, port) => http.createServer((req, res) => { const p = decodeURIComponent(String(req.url).split('?')[0]); const f = path.resolve(dir, '.' + p);
  const file = f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(dir, 'index.html');
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res); }).listen(port, '127.0.0.1');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const api = (fn, body) => fetch(`http://127.0.0.1:54331/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  const server = serve(`${E}/builds/admin`, 4601); const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
  const blocked = []; const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); const h = u.startsWith('http') ? new URL(u).hostname : '127.0.0.1'; if (h === '127.0.0.1') return r.fallback(); blocked.push(u); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => ok(false, `page error: ${e.message}`));
  await p.goto('http://127.0.0.1:4601/'); await p.waitForTimeout(1500);
  const shot = (n) => p.screenshot({ path: `${E}/shots/${n}.png` }); fs.mkdirSync(`${E}/shots`, { recursive: true });
  const tab = async (n) => { await p.locator('.top nav button', { hasText: n }).click(); await p.waitForTimeout(900); };

  const g = norm(await p.locator('[data-testid=glance]').innerText());
  ok(/^6 Pallets stored 2 Waiting for put-away 0 On hold 6 \/ 64 Positions used$/.test(g), `overview counts: ${g}`);
  const bt = norm(await p.locator('[data-testid=brand-table] tbody').innerText());
  ok(/Synthetic Records 4 1 0 336/.test(bt) && /Synthetic Sneakers 2 1 0 288/.test(bt), `per-brand counts and units: ${bt.slice(0, 90)}`);
  await shot('1-overview');

  await tab('Locations'); await p.waitForTimeout(600);
  const full = await p.locator('[data-testid=floor-map] .cell.full').count(); const none = await p.locator('[data-testid=floor-map] .cell.none').count();
  ok(full === 6 && none === 9, `floor map: 6 occupied squares, 9 not set up (P-65..72 and STG-02): ${full}/${none}`);
  const first = S.pallets[0]; await p.locator(`[data-testid="cell-${first.loc}"]`).click(); await p.waitForTimeout(300);
  ok((await p.locator('[data-testid=cell-detail]').innerText()).includes(first.psku), 'click a square: shows the pallet standing there');
  ok(/no position yet · 2/i.test(await p.locator('[data-testid=unplaced]').innerText()), 'received pallets with no position are listed'); await shot('6-map');
  await tab('Pallets'); ok((await p.locator('[data-testid=pallet-table] tbody tr').count()) === 8, 'pallets: all 8 listed');
  await p.getByLabel('Brand').selectOption({ label: 'Synthetic Sneakers' }); await p.getByLabel('Status').selectOption('stored'); await p.waitForTimeout(800);
  ok((await p.locator('[data-testid=pallet-table] tbody tr').count()) === 2, 'pallets: brand + status filter'); await shot('2-pallets');

  await tab('FIFO'); await p.getByLabel('Brand').selectOption({ label: 'Synthetic Records' }); await p.waitForTimeout(600);
  await p.getByLabel('Product').selectOption({ index: 2 }); await p.waitForTimeout(800);   // SYN-LP (after SYN-BOX)
  const rows = await p.locator('[data-testid=fifo-table] tbody tr').allInnerTexts(); const lp = S.pallets.filter((x) => ['e-a1', 'e-a2', 'e-a4'].includes(x.key));
  ok(rows.length === 3 && rows[0].includes('First') && rows[0].includes(lp[0].psku) && rows[1].includes(lp[1].psku) && rows[2].includes(lp[2].psku), 'FIFO: oldest pallet first, then by age');
  ok(/21d/.test(rows[0]) && /120/.test(rows[0]), `FIFO shows age and on-hand at the position: ${norm(rows[0])}`); await shot('3-fifo');

  await tab('Cycle counts'); const z = lp[0].zone; const inZone = S.pallets.filter((x) => x.zone === z);
  await p.getByLabel('Zone').selectOption({ index: 1 }); await p.getByRole('button', { name: 'Start a count' }).click(); await p.waitForTimeout(1200);
  ok((await p.locator('[data-testid=line-table] tbody tr').count()) === inZone.length, `count started with the ${inZone.length} stored pallets of zone ${z}`);
  const scan = async (loc, psku) => { await p.getByLabel('Position').fill(loc); await p.getByLabel('Pallet').fill(psku); await p.getByRole('button', { name: 'Record' }).click(); await p.waitForTimeout(900); return norm(await p.locator('[data-testid=count-last]').innerText()); };
  ok(/: Found$/.test(await scan(inZone[0].loc, inZone[0].psku)), 'scan in the right position: found');
  ok(/Wrong position \(belongs in/.test(await scan(inZone[0].loc, inZone[1].psku)), 'scan in another position: wrong position, with where it belongs');
  ok(/not on file/.test(await scan('ZZ99', inZone[0].psku)), 'unknown position refused');
  await shot('4-count'); await p.getByRole('button', { name: 'Finish count' }).click(); await p.waitForTimeout(1000);
  const lt = norm(await p.locator('[data-testid=line-table]').innerText());
  ok(/Count closed\. Nothing was moved/.test(await p.locator('body').innerText()) && (inZone.length < 3 || /Missing/i.test(lt)), 'finish: uncounted pallets become Missing; nothing moved');

  await tab('Connections'); await p.getByLabel('WMS name').fill('Souled Sneakers WMS (synthetic)'); await p.getByLabel('Synthetic Sneakers').check();
  await p.getByRole('button', { name: 'Create key' }).click(); await p.waitForTimeout(1000);
  const key = (await p.locator('[data-testid=new-key] code').innerText()).trim(); ok(/^nxs_[0-9a-f]{64}$/.test(key), 'connection key shown once'); 
  await p.locator('[data-testid=new-key] code').evaluate((n) => { n.textContent = 'nxs_••••••••••••••••••••••••'; }); await shot('5-connections');
  const c = await (await api('nexus_api_counts', { p_key: key })).json();
  ok(c.brands.length === 1 && c.brands[0].brand === 'Synthetic Sneakers' && c.brands[0].pallets_stored === 2 && c.brands[0].pallets_waiting === 1, `the other WMS reads its own pallet count over the API: ${JSON.stringify(c.brands[0]).slice(0, 110)}`);
  const pl = await (await api('nexus_api_pallets', { p_key: key })).json(); ok(pl.pallets.length === 3 && pl.pallets.every((x) => x.brand === 'Synthetic Sneakers'), 'API pallets: only that connection\'s brand');
  ok((await api('nexus_api_fifo', { p_key: key, p_sku: 'SYN-LP' })).status >= 400, 'API: another brand\'s product refused');
  ok((await api('nexus_api_counts', { p_key: 'nxs_wrong' })).status >= 400, 'API: wrong key refused');

  // dock: book a shipment on the calendar, then put a waiting pallet away by two scans
  await tab('Calendar'); await p.locator('[data-testid=new-shipment]').click(); const f = p.locator('[data-testid=shipment-form]');
  await f.locator('select').first().selectOption({ label: 'Synthetic Records' }); await p.waitForTimeout(500);
  await f.getByLabel('Reference (PO, BOL or shipment no.)').fill('SYN-CAL-1'); await f.getByLabel('Pallets', { exact: true }).fill('2');
  await f.getByLabel('Item').selectOption({ label: 'SYN-LP · Synthetic LP' }); await f.getByLabel('Units expected').fill('240'); await f.getByText('Book it').click(); await p.waitForTimeout(900);
  const cal = norm(await p.locator('[data-testid=calendar] .day.today').innerText()); ok(/Synthetic Records 0\/2 pallets/.test(cal), `booked shipment appears on today's calendar square: ${cal}`);
  await p.locator('[data-testid=calendar] .day.today .ship').click(); const det = norm(await p.locator('[data-testid=shipment-detail]').innerText()); ok(/SYN-CAL-1/.test(det) && /SYN-LP Synthetic LP 240/i.test(det), `its items are on file: ${det.slice(0, 120)}`);
  await shot('7-calendar');
  await tab('Put-away'); const w5 = S.pallets.find((x) => x.key === 'e-a5');
  ok(await p.locator('[data-testid=putaway-table] tbody tr').count() === 2, 'two received pallets are waiting for a position');
  await p.locator('[data-testid=scan-pallet]').fill(w5.psku); await p.locator('[data-testid=scan-pallet]').press('Enter'); await p.waitForTimeout(300);
  await p.locator('[data-testid=scan-position]').fill('LOC-' + S.pallets[0].loc); await p.locator('[data-testid=scan-position]').press('Enter'); await p.waitForTimeout(700);
  ok(/already holds a pallet/i.test(await p.locator('[data-testid=putaway-msg]').innerText()), 'an occupied position is refused');
  await p.locator('[data-testid=scan-position]').fill('LOC-P-40'); await p.locator('[data-testid=scan-position]').press('Enter'); await p.waitForTimeout(900);
  const pm = norm(await p.locator('[data-testid=putaway-msg]').innerText()); ok(new RegExp(`${w5.psku} is in P-40\\. 36 units are now in stock`, 'i').test(pm), `two scans put the pallet away and post its stock: ${pm}`);
  ok(await p.locator('[data-testid=putaway-table] tbody tr').count() === 1, 'it left the waiting list'); await shot('8-putaway');
  ok(blocked.length === 0, `requests outside 127.0.0.1: ${blocked.length}`);
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
