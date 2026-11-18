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
