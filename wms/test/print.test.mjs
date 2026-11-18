// printPages with a fake document: it may answer true only when the print window was actually asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { printPages } from '../src/print.js';

function fakeDoc({ win = 'ok', load = true } = {}) {
  const calls = { print: 0, appended: 0 }; let current = null;
  const doc = {
    calls,
    querySelectorAll: () => [],
    getElementById: (id) => (id === 'wms-print' ? current : null),
    createElement: () => {
      const f = { style: {}, dataset: {}, setAttribute() {}, remove() { if (current === f) current = null; }, onload: null, srcdoc: '' };
      Object.defineProperty(f, 'contentWindow', { get() {
        if (win === 'none') return null;
        return { focus() {}, document: {}, print: win === 'noprint' ? undefined : () => { calls.print += 1; if (win === 'throw') throw new Error('printing is blocked'); } };
      } });
      return f;
    },
    body: { appendChild(f) { calls.appended += 1; current = f; if (load) setTimeout(() => f.onload && f.onload(), 0); } },
  };
  return doc;
}
const page = ['<section class="cpage">x</section>'];

test('print asked for and not refused: true', async () => { const d = fakeDoc(); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 500), true); assert.equal(d.calls.print, 1); });
test('print() throws: false (was true before this change)', async () => { const d = fakeDoc({ win: 'throw' }); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 500), false); assert.equal(d.calls.print, 1); });
test('the frame has no window: false', async () => { assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', fakeDoc({ win: 'none' }), 500), false); });
test('the window has no print(): false', async () => { assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', fakeDoc({ win: 'noprint' }), 500), false); });
test('the frame never loads: false after the timeout', async () => { const d = fakeDoc({ load: false }); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 50), false); assert.equal(d.calls.print, 0); });
test('no pages: false, and no frame is made', async () => { const d = fakeDoc(); assert.equal(await printPages([], 'cpage', '2in 1in', 't', false, '', d, 500), false); assert.equal(d.calls.appended, 0); });
test('no document at all: false', async () => { assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', null, 500), false); });
test('a failure leaves it retryable: the next attempt can succeed', async () => {
  const d = fakeDoc({ win: 'throw' }); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 500), false);
  assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', fakeDoc(), 500), true);
});

// late callbacks: a fake document whose frame load and font readiness fire when the test says so
function slowDoc() {
  const calls = { print: 0 }; let current = null; const frames = [];
  const doc = {
    calls, frames, querySelectorAll: () => [], getElementById: (id) => (id === 'wms-print' ? current : null),
    createElement: () => {
      let fontsDone; const fonts = { ready: new Promise((r) => { fontsDone = r; }) };
      const f = { style: {}, dataset: {}, setAttribute() {}, remove() { if (current === f) current = null; }, onload: null, srcdoc: '', fontsDone };
      Object.defineProperty(f, 'contentWindow', { get: () => ({ focus() {}, document: { fonts }, print: () => { calls.print += 1; } }) });
      frames.push(f); return f;
    },
    body: { appendChild(f) { current = f; } },
  };
  return doc;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
test('timeout, then the frame loads late: no print', async () => {
  const d = slowDoc(); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 20), false);
  d.frames[0].onload?.(); d.frames[0].fontsDone(); await tick(120); assert.equal(d.calls.print, 0);
});
test('frame loads, fonts become ready only after the timeout: no print', async () => {
  const d = slowDoc(); const p = printPages(page, 'cpage', '2in 1in', 't', false, '', d, 30);
  await tick(0); d.frames[0].onload(); assert.equal(await p, false);
  d.frames[0].fontsDone(); await tick(120); assert.equal(d.calls.print, 0);
});
test('timed-out attempt, then a retry: the retry prints once, the old attempt never prints', async () => {
  const d = slowDoc(); assert.equal(await printPages(page, 'cpage', '2in 1in', 't', false, '', d, 20), false);
  const retry = printPages(page, 'cpage', '2in 1in', 't', false, '', d, 1000); await tick(0);
  d.frames[1].onload(); d.frames[1].fontsDone(); assert.equal(await retry, true);
  d.frames[0].onload?.(); d.frames[0].fontsDone(); await tick(120); assert.equal(d.calls.print, 1);
});
test('overlap: a second attempt replaces the first before it loads; only the second prints', async () => {
  const d = slowDoc(); const a = printPages(page, 'cpage', '2in 1in', 't', false, '', d, 1000); await tick(0);
  const b = printPages(page, 'cpage', '2in 1in', 't', false, '', d, 1000); await tick(0);
  d.frames[0].onload(); d.frames[0].fontsDone(); d.frames[1].onload(); d.frames[1].fontsDone();
  assert.equal(await b, true); await tick(120); assert.equal(d.calls.print, 1);
  assert.equal(await Promise.race([a, tick(1100).then(() => 'still open')]), false, 'the replaced attempt answers false');
});
