// Browser check of the preview against the stand-in Nexus. Needs Playwright (not a dependency of this site):
//   PLAYWRIGHT=/path/to/node_modules/playwright CHROME=/path/to/chrome node test/preview.e2e.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright'); const { spawn } = require('child_process'); const path = require('path');
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
(async () => {
  const srv = spawn('node', [path.join(__dirname, 'serve.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise((r) => srv.stdout.on('data', (d) => /READY/.test(d) && r()));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const outside = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 }, timezoneId: process.env.TZ_ID || 'Asia/Tokyo' });   // a browser far from New York, on purpose
  await ctx.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; if (h === '127.0.0.1') return r.fallback(); outside.push(r.request().url()); return r.abort(); });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));   // the wrong-passcode step answers 401 on purpose
  await p.goto('http://127.0.0.1:4610/'); await p.waitForSelector('#gate:not([hidden])');
  ok(await p.locator('#app').isHidden(), 'nothing is shown before the passcode');
  await p.fill('#pass', 'wrong-passcode-000'); await p.click('#gate .btn'); await p.waitForTimeout(500);
  ok(/not accepted/.test(await p.locator('#msg').innerText()) && await p.locator('#app').isHidden(), 'a wrong passcode is refused');
  await p.fill('#pass', 'preview-passcode-123'); await p.click('#gate .btn'); await p.waitForSelector('#app:not([hidden])');
  ok(!(await p.locator('#gate').isVisible()) && await p.locator('#floor').isVisible(), 'the passcode form goes away once the preview is open');
  ok(await p.locator('.pos[data-kind=pallet]').count() === 66, 'the floor draws 66 pallet positions');
  ok(await p.locator('.pos[data-kind=staging]').count() === 2, 'and 2 staging spots');
  // Every code in its approved square. The expectation below is written from the approved layout, independently of the page.
  const want = {}; for (let n = 1; n <= 66; n++) { const code = 'P-' + String(n).padStart(2, '0');
    want[code] = n <= 15 ? [4, n] : n <= 30 ? [5, n - 15] : n <= 48 ? [1, n - 30] : [2, n - 48]; } want['STG-01'] = [4, 16]; want['STG-02'] = [5, 16];
  const got = await p.$$eval('.pos', (els) => Object.fromEntries(els.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.code, { x: Number(e.dataset.x), y: Number(e.dataset.y), left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), text: e.querySelector('b').textContent }]; })));
  const wrong = Object.keys(want).filter((c) => !got[c] || got[c].x !== want[c][0] || got[c].y !== want[c][1] || got[c].text !== c);
  ok(Object.keys(got).length === 68 && wrong.length === 0, `all 68 squares carry the right code on the right grid square${wrong.length ? ': wrong ' + wrong.join(', ') : ''}`);
  // ...and on screen: one left edge per column, columns in order left to right, rows in order top to bottom
  const lefts = [1, 2, 4, 5].map((x) => [...new Set(Object.keys(want).filter((c) => want[c][0] === x).map((c) => got[c].left))]);
  ok(lefts.every((l) => l.length === 1) && lefts[0][0] < lefts[1][0] && lefts[1][0] < lefts[2][0] && lefts[2][0] < lefts[3][0], `four straight columns on screen, outbound pair left of inbound pair: ${lefts.map((l) => l.join('/')).join(' < ')}`);
  const tops = (codes) => codes.map((c) => got[c].top); const rising = (a) => a.every((v, i) => i === 0 || v > a[i - 1]); const col = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => 'P-' + String(a + i).padStart(2, '0'));
  ok(rising(tops(col(1, 15))) && rising(tops(col(16, 30))) && rising(tops(col(31, 48))) && rising(tops(col(49, 66))), 'each column runs top to bottom: P-01..15, P-16..30, P-31..48, P-49..66');
  ok(got['P-01'].top === got['P-16'].top && got['P-01'].top === got['P-31'].top && got['P-01'].top === got['P-49'].top, 'the four columns start on the same top row');
  const under = (a, b) => got[a].left === got[b].left && got[a].top > got[b].top && got[a].top - got[b].top < got[b].h * 2;
  ok(under('STG-01', 'P-15') && under('STG-02', 'P-30') && got['STG-01'].top === got['STG-02'].top, 'STG-01 sits directly beneath P-15 and STG-02 directly beneath P-30');
  const lm = await p.$$eval('.mark', (els) => Object.fromEntries(els.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.landmark, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: e.textContent }]; })));
  const mid = (got['P-49'].left + got['P-49'].w + got['P-01'].left) / 2; const bottom = got['P-48'].top + got['P-48'].h;
  ok(lm.exit.cy < got['P-31'].top && lm.exit.cx < mid && lm.dock.cy < got['P-01'].top && lm.dock.cx > mid, 'Exit upper left, Dock upper right');
  ok(lm.walkway.cx > got['P-49'].left + got['P-49'].w && lm.walkway.cx < got['P-01'].left && lm.walkway.cy > got['P-01'].top && lm.walkway.cy < bottom, 'Walkway in the centre, between the two sides');
  ok(lm.entrance.cy > bottom && Math.abs(lm.entrance.cx - mid) < 40 && lm.prep.cy > bottom && lm.prep.cx > got['P-01'].left, 'Entrance bottom centre, Prep area bottom right');
  ok(await p.locator('.pos.clash').count() === 0 && await p.locator('.pos[data-code="RCV-DOCK"]').count() === 0, 'no two codes share a square; the dock is not drawn as a position');
  const sum = p.locator('[data-testid=map-sum]'); ok(await sum.getAttribute('data-version') === '4' && /checksum stubsum/.test(await sum.innerText()), 'the map version and checksum from Nexus are shown');
  ok(await p.locator('.pos[data-code="P-31"]').getAttribute('data-state') === 'mine' && await p.locator('.pos[data-code="P-01"]').getAttribute('data-state') === 'other', 'own pallet shown by id; the other company shown as occupied only');
  ok(!/hidden/.test(await p.locator('.pos[data-code="P-01"]').innerText()), "the other company's pallet id is not shown");
  ok(await p.locator('[data-testid=raw] .rawcall[data-path="/calendar"][data-status="200"]').count() >= 1 && /"company": "SOULED"/.test(await p.locator('[data-testid=raw] .rawcall[data-path="/calendar"] pre').first().textContent()), 'the raw answer and HTTP status of each call are shown');
  ok(/America\/New_York \(ET\)/.test(await p.locator('[data-testid=zone]').innerText()), 'the calendar says its times are America/New_York');
  // publish for 4 Dec 2026, 11:00 to 13:00 Eastern, from a browser that is not in Eastern time
  await p.fill('#start', '2026-12-04T11:00'); await p.fill('#end', '2026-12-04T13:00'); await p.fill('#pal', '3'); await p.click('#save'); await p.waitForSelector('#cal tbody tr[data-event^="DEV-"]');
  const mine = p.locator('#cal tbody tr[data-event^="DEV-"]'); const id = await mine.getAttribute('data-event'); const txt = async () => (await mine.innerText()).replace(/\s+/g, ' ');
  ok(/Fri, Dec 4, 11:00 AM to 1:00 PM ET SHIPBAY inbound 3 scheduled DEV-/.test(await txt()) && await mine.getAttribute('data-start') === '2026-12-04T16:00:00.000Z', `Eastern in, the right instant out, Eastern shown: ${await txt()}`);
  ok(/SOULED inbound 4 scheduled private/.test((await p.locator('#cal tbody tr[data-company=SOULED]').innerText()).replace(/\s+/g, ' ')), "the other company's event shows no reference");
  ok(/calendar_added/.test(await p.locator('#feed').innerText()), 'the change feed shows it');
  // change the same event: 12:00 to 14:00 Eastern, same id
  await mine.locator('button', { hasText: 'Edit' }).click();
  ok(await p.inputValue('#start') === '2026-12-04T11:00' && await p.inputValue('#end') === '2026-12-04T13:00' && new RegExp(id).test(await p.locator('#save').innerText()), 'Edit loads the event in Eastern time and names the id it will keep');
  await p.fill('#start', '2026-12-04T12:00'); await p.fill('#end', '2026-12-04T14:00'); await p.click('#save'); await p.waitForFunction(() => /12:00 PM to 2:00 PM ET/.test(document.querySelector('#cal').innerText));
  ok(await p.locator(`#cal tbody tr[data-event="${id}"]`).count() === 1 && await p.locator('#cal tbody tr[data-event^="DEV-"]').count() === 1 && await mine.getAttribute('data-start') === '2026-12-04T17:00:00.000Z', 'the same id, once, at the new time');
  ok(/calendar_changed/.test(await p.locator('#feed').innerText()) && /Updated DEV-/.test(await p.locator('#msg').innerText()), 'the change feed records the change');
  ok(/PUT \/api\/nexus\/calendar\/DEV-.* HTTP 200/.test(await p.locator('[data-testid=raw]').innerText()), 'the raw panel shows the PUT and its status');
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, fullPage: true });
  await mine.locator('button', { hasText: 'Cancel' }).click(); await p.waitForSelector('#cal tbody tr.gone');
  ok(/calendar_cancelled/.test(await p.locator('#feed').innerText()), 'cancelling marks it cancelled and the feed shows it');
  const html = await p.content(); ok(!/stub-staging-key/.test(html) && !/ankoqruedjujyefhrmtw/.test(html), 'no key or Nexus address anywhere in the page');
  ok(outside.length === 0, `requests from the browser to anywhere but this site: ${outside.length}`); ok(errors.length === 0, `page errors: ${errors.join(' | ') || 'none'}`);
  await browser.close(); srv.kill(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
