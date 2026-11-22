// Browser check of the preview against the stand-in Nexus. Needs Playwright (not a dependency of this site):
//   PLAYWRIGHT=/path/to/node_modules/playwright CHROME=/path/to/chrome node test/preview.e2e.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright'); const { spawn } = require('child_process'); const path = require('path');
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
(async () => {
  const srv = spawn('node', [path.join(__dirname, 'serve.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise((r) => srv.stdout.on('data', (d) => /READY/.test(d) && r()));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const outside = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
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
  ok(await p.locator('[data-block=outbound] .pos[data-kind=pallet]').count() === 36 && await p.locator('[data-block=inbound] .pos[data-kind=pallet]').count() === 30, 'left 2 x 18 = 36, right 2 x 15 = 30');
  const box = async (sel) => p.locator(sel).first().boundingBox(); const L = await box('[data-block=outbound]'), R = await box('[data-block=inbound]'), S = await box('[data-block=staging]');
  ok(L.x < R.x && S.x >= R.x - 1 && S.y > R.y, 'outbound on the left, inbound on the right, staging at the bottom right');
  ok(await p.locator('.pos[data-code="P-37"]').getAttribute('data-state') === 'mine' && await p.locator('.pos[data-code="P-01"]').getAttribute('data-state') === 'other', 'own pallet shown by id; the other company shown as occupied only');
  ok(!/hidden/.test(await p.locator('.pos[data-code="P-01"]').innerText()), "the other company's pallet id is not shown");
  ok(await p.locator('.pos[data-code="P-16"]').count() === 0 && await p.locator('.pos[data-code="P-72"]').count() === 1, 'P-16 is not drawn; P-72 is');
  const cal0 = await p.locator('#cal tbody tr').count();
  await p.click('#newev .btn'); await p.waitForFunction((n) => document.querySelectorAll('#cal tbody tr').length > n, cal0);
  const row = (await p.locator('#cal tbody tr', { hasText: 'DEV-' }).innerText()).replace(/\s+/g, ' ');
  ok(/SHIPBAY inbound 6 scheduled DEV-/.test(row), `a synthetic event is published and listed: ${row}`);
  ok(/SOULED inbound 4 scheduled private/.test((await p.locator('#cal tbody tr', { hasText: 'SOULED' }).innerText()).replace(/\s+/g, ' ')), "the other company's event shows no reference");
  ok(/calendar\.created/.test(await p.locator('#feed').innerText()), 'the change feed shows it');
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, fullPage: true });
  await p.locator('#cal tbody tr', { hasText: 'DEV-' }).locator('button').click(); await p.waitForSelector('#cal tbody tr.gone');
  ok(/calendar\.cancelled/.test(await p.locator('#feed').innerText()), 'cancelling marks it cancelled and the feed shows it');
  const html = await p.content(); ok(!/stub-staging-key/.test(html) && !/ankoqruedjujyefhrmtw/.test(html), 'no key or Nexus address anywhere in the page');
  ok(outside.length === 0, `requests from the browser to anywhere but this site: ${outside.length}`); ok(errors.length === 0, `page errors: ${errors.join(' | ') || 'none'}`);
  await browser.close(); srv.kill(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
