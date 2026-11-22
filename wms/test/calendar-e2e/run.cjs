// WMS Calendar in a real browser with demonstration data, from a browser set far from New York. Any request off 127.0.0.1 is blocked and counted.
//   OUT=/tmp/cal-e2e VITE_NEXUS_CALENDAR=demo npx vite build --config test/calendar-e2e/vite.config.js && BUILD=/tmp/cal-e2e node test/calendar-e2e/run.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const BUILD = process.env.BUILD; let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const norm = (t) => t.replace(/\s+/g, ' ').trim();
(async () => {
  const server = http.createServer((req, res) => { const p = decodeURIComponent(req.url.split('?')[0]); const f = path.resolve(BUILD, '.' + p);
    const file = f.startsWith(BUILD + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(BUILD, 'calendar.html');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res); }).listen(4620, '127.0.0.1');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const outside = []; const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 1200 }, timezoneId: process.env.TZ_ID || 'Asia/Tokyo' });
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; if (h === '127.0.0.1') return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://127.0.0.1:4620/'); await p.waitForSelector('[data-testid=shared-cal]');
  ok(/Demonstration data/.test(await p.locator('[data-testid=demo-banner]').innerText()), 'the screen says its data is a demonstration');
  ok(/America\/New_York \(ET\)/.test(await p.locator('[data-testid=zone]').innerText()), 'and that its times are America/New_York');
  const day = async (n) => { const cells = p.locator('.calday.today ~ .calday'); const c = n === 0 ? p.locator('.calday.today') : cells.nth(n - 1); await c.click(); return norm(await p.locator('[data-testid=day-detail]').innerText()); };
  const d1 = await day(1);
  ok(/Souled · Inbound delivery .*10:00 AM to 12:00 PM ET 2 pallets · Scheduled/.test(d1) && /Synthetic Records SYN-PO-1001 .*12:00 PM to 2:00 PM ET 6 pallets · Booked · On the shared calendar/.test(d1), `both companies on one day, in time order, Eastern: ${d1.slice(0, 260)}`);
  ok(await p.locator('[data-testid=day-detail] .sc-row').count() === 2 && !/SB-INB/.test(d1), "ShipBay's shipment and its shared booking are one row, not two");
  ok(/Details are private to Souled/.test(d1) && !/SYN-PO|reference|note/i.test(norm(await p.locator('[data-testid=day-detail] .sc-row.other').innerText())), "the other company's row has no reference or detail");
  const d3 = await day(3);
  ok(/Synthetic Mailers · Expected arrival SYN-PO-1002 .*Time not confirmed 16 pallets · Booked · Not shared yet: Nexus needs a time/.test(d3) && await p.locator('[data-testid=day-detail] .sc-row.shipment').getAttribute('data-time-known') === 'false', `a date-only shipment shows its date and no invented time: ${d3.slice(0, 200)}`);
  ok(/Souled · Inbound delivery .*11:30 PM ET 1 pallet · Scheduled/.test(d3), 'an 11:30 PM Eastern appointment is on its Eastern day even from a Tokyo browser');
  const d8 = await day(8); ok(/Synthetic Records · Expected arrival SYN-PO-1004 .*Time not confirmed 4 pallets · On its way · Shared booking cancelled/.test(d8), `a cancelled shared booking leaves the shipment, without a time: ${d8.slice(0, 200)}`);
  const d5a = await day(5); ok(/Nothing scheduled/.test(d5a), 'cancelled appointments are hidden by default');
  await p.locator('.sc-check input').check(); const d5b = await day(5); ok(/Souled · Outbound pickup .*1:00 PM to 2:00 PM ET 5 pallets · Cancelled/.test(d5b) && await p.locator('[data-testid=day-detail] .sc-row.gone').count() === 1, 'and shown struck through when asked for');
  const d2 = await day(2); ok(/ShipBay · Outbound pickup ShipBay booking DEV-SYNTH01 · no shipment record in this WMS 3:00 PM to 4:00 PM ET 3 pallets · Scheduled/.test(d2), 'a ShipBay booking with no shipment record still shows');
  ok(/Synthetic Leather SYN-PO-1003 .*Date not set/.test(norm(await p.locator('[data-testid=undated]').innerText())), 'a shipment with no date is listed apart, not placed on a day');
  await p.locator('[data-testid=refresh]').click(); await p.waitForTimeout(300); ok(await p.locator('[data-testid=shared-cal] .calday.has').count() >= 4, 'refresh keeps the calendar');
  await day(1); await p.locator('[data-testid=day-detail] .sc-row.shipment button').click(); ok(await p.evaluate(() => document.body.dataset.went) === 'receive', "a ShipBay row links to Receiving");
  if (process.env.SHOT) { await p.locator('.sc-check input').uncheck(); await day(1); await p.screenshot({ path: process.env.SHOT, fullPage: true }); }
  ok(outside.length === 0, `requests to anywhere but this page: ${outside.length}`); ok(errors.length === 0, `page errors: ${errors.join(' | ') || 'none'}`);
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
