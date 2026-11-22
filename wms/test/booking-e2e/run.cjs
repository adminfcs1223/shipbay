// WMS receiving graft, end to end in a real browser (Chromium): the real WMS Receive screen (this branch's source, built
// against the local stack only) with the synthetic floor login (JWT verified by PostgREST; RLS and the candidate enforced by
// Postgres). Not a GoTrue sign-in. Every request not to 127.0.0.1 is blocked and counted.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const pg = require(path.resolve(__dirname, '../../../supabase/tests/db/node_modules/pg'));
const S = JSON.parse(fs.readFileSync('/tmp/graft-e2e/session.json', 'utf8')); const BUILD = '/tmp/graft-e2e/builds/wms';
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const q = async (sql, p = []) => { const c = new pg.Client('postgres://postgres@127.0.0.1:54317/staging'); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } };
const serve = (dir, port) => http.createServer((req, res) => { const p = decodeURIComponent(String(req.url).split('?')[0]); const f = path.resolve(dir, '.' + p);
  const file = f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith('.html')));
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res); }).listen(port, '127.0.0.1');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
(async () => {
  const server = serve(BUILD, 4501);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
  const blocked = [], seen = [], lookups = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); seen.push(u); const h = u.startsWith('http') ? new URL(u).hostname : '127.0.0.1'; if (h === '127.0.0.1') return r.fallback(); blocked.push(u); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => ok(false, `page error: ${e.message}`));
  p.on('request', (r) => { if (/\/rest\/v1\/(rpc\/wms_receipt_lookup|wms_pallets\?.*batch_key)/.test(r.url())) lookups.push(new URL(r.url()).pathname); });
  // printing is mocked exactly as the existing station test does: print windows are counted, nothing reaches a printer
  await p.addInitScript(() => { window.__prints = 0; window.open = () => { window.__prints++; return { document: { write() {}, close() {} }, focus() {}, print() {}, close() {}, closed: false, addEventListener() {} }; }; window.print = () => { window.__prints++; }; });
  await p.goto('http://127.0.0.1:4501/'); await p.waitForTimeout(1500);
  const links = () => q('select batch_key, mode from wms_receipt_links order by created_at');
  const line = async (cartons) => { const l = p.locator('.line').first(); await l.locator('.scanbox input').fill('SYN-LP'); await p.waitForTimeout(200); await l.locator('.scanbox input').press('Enter'); await p.waitForTimeout(200);
    await l.getByLabel(/^Cartons/).fill(String(cartons)); await l.getByLabel(/^Units per carton/).fill('12'); };
  const press = async () => { await p.locator('form.entry .btn.big').click(); await p.waitForTimeout(1500); };
  const closePrompt = async () => { if (await p.locator('.overlay .btn.big').count()) { await p.locator('.overlay .btn.big').click(); await p.waitForTimeout(400); } };
  const pickBooking = async (re) => { const o = await p.locator('[data-testid=booking] select option').allInnerTexts(); await p.locator('[data-testid=booking] select').selectOption({ label: o.find((x) => re.test(x)) }); await p.waitForTimeout(300); };

  await p.locator('.brands button', { hasText: 'Synthetic Records' }).click(); await p.waitForTimeout(800);
  const opts = await p.locator('[data-testid=booking] select option').allInnerTexts();
  ok(opts.length === 3 && opts.some((o) => /SYN-REC-BOOK/.test(o)) && opts.some((o) => /SYN-REC-TWO/.test(o)) && !opts.some((o) => /SYN-REC-WAIT|SYN-SNK/.test(o)), `two approved same-brand bookings listed, nothing else: ${opts.join(' | ')}`);

  // 1. partial on booking one; the answer is lost; the lookup is first unavailable, then settles it
  await pickBooking(/SYN-REC-BOOK/); await line(10);
  let dropped = 0; await ctx.route('**/rest/v1/rpc/wms_receive_booking', async (r) => { if (dropped++ === 0) { await r.fetch(); return r.abort('connectionreset'); } return r.fallback(); });
  await press();
  ok((await links()).length === 1 && /Check whether it was received/.test(await p.locator('body').innerText()), 'lost answer: receipt on file, station stopped with the check');
  await ctx.route('**/rest/v1/rpc/wms_receipt_lookup', (r) => r.abort('connectionreset'));
  await p.getByRole('button', { name: 'Check whether it was received' }).click(); await p.waitForTimeout(1200);
  const un = await p.locator('body').innerText();
  ok(/could not be checked/.test(un) && !/Nothing found yet/.test(un) && /Check whether it was received/.test(un), 'lookup unavailable: "could not be checked", still stopped (not "not found")');
  await ctx.unroute('**/rest/v1/rpc/wms_receipt_lookup');
  await p.getByRole('button', { name: 'Check whether it was received' }).click(); await p.waitForTimeout(1500); await closePrompt();
  ok((await links()).length === 1, 'settled by the lookup: still exactly one receipt');
  ok(lookups.length >= 2 && lookups.every((u) => u === '/rest/v1/rpc/wms_receipt_lookup'), `booked check used only the dedicated lookup (${lookups.length})`);
  { const due = norm(await p.locator('[data-testid=due]').innerText()); ok(/SYN-REC-BOOK/.test(due) && /SYN-LP × 300/.test(due) && !/SYN-REC-WAIT/.test(due), `shipments to receive are listed with their items (unapproved one hidden): ${due.slice(0, 110)}`); }
  await pickBooking(/SYN-REC-BOOK/); const exp = norm(await p.locator('[data-testid=expected-items]').innerText()); ok(/SYN-LP · .* · 300 units/.test(exp), `shipment's expected items shown at receiving: ${exp.slice(0, 90)}`);
  const st1 = norm(await p.locator('[data-testid=booking-state]').innerText());
  ok(/^Partly received · 1 of 3 pallets · 10 of 30 cartons$/.test(st1), `floor progress from actual counts: ${st1}`);

  // 2. HOLD on the second booking of the same brand
  await pickBooking(/SYN-REC-TWO/); await p.getByLabel('On HOLD').check(); await line(5);
  ok(/Say why it is on HOLD/.test(await p.locator('form.entry .btn.big').innerText()), 'HOLD needs a reason before sending');
  await p.getByLabel('HOLD reason').fill('Two cartons crushed'); await press(); await closePrompt();
  const st2 = norm(await p.locator('[data-testid=booking-state]').innerText());
  ok(st2 === 'Partly received · on HOLD · 1 of 2 pallets · 5 of 20 cartons · 1 on HOLD: Two cartons crushed', `second booking on HOLD, first untouched: ${st2}`);
  const held = await q(`select held, inbound_id from wms_pallets where batch_key = (select batch_key from wms_receipt_links where mode='hold')`);
  ok(held.length === 1 && held[0].held && held[0].inbound_id === S.bookings.a2, 'held pallet linked to booking two and quarantined');

  // 3. shipments only: with no shipment chosen the form will not send
  await p.locator('[data-testid=booking] select').selectOption(''); await p.waitForTimeout(200);
  ok(/Pick the shipment/.test(await p.locator('form.entry .btn.big').innerText()) && await p.locator('form.entry .btn.big').isDisabled(), 'no shipment chosen: Receive is blocked');

  // 4. last of booking one: closes it on the floor; the booking row is not touched
  const before = (await q('select status, received_at, pallets, cartons from inbound_shipments where id = $1', [S.bookings.a]))[0];
  await pickBooking(/SYN-REC-BOOK/); await p.getByLabel('Last of this booking').check(); await line(4); await press(); await closePrompt(); await p.waitForTimeout(500);
  const after = (await q('select status, received_at, pallets, cartons from inbound_shipments where id = $1', [S.bookings.a]))[0];
  ok(JSON.stringify(after) === JSON.stringify(before) && after.status === 'expected' && after.received_at === null, `booking row untouched (status ${after.status}, planned ${after.pallets}/${after.cartons})`);
  ok(!(await p.locator('[data-testid=booking] select option').allInnerTexts()).some((o) => /SYN-REC-BOOK/.test(o)), 'closed booking left the floor list');
  ok(Number((await q(`select count(*) n from inbound_shipments where status in ('received','discrepancy')`))[0].n) === 0, 'nothing for the legacy invoice (no received/discrepancy booking)');

  // 5. stock
  ok(Number((await q('select coalesce(sum(qty),0) n from inventory_moves'))[0].n) === 0, 'no stock from any receipt (stock posts at put-away only)');
  // printing behaviour itself is covered by the existing station test (wms/test/receive-offline.cjs), run on both builds
  ok(blocked.length === 0, `requests outside 127.0.0.1: ${blocked.length}`);
  const glog = fs.readFileSync('/tmp/graft-e2e/gateway.log', 'utf8'); ok(!/-> 404/.test(glog), 'every request was a /rest/v1 call');
  fs.writeFileSync('/tmp/graft-e2e/browser-requests.log', seen.join('\n') + '\n');
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
