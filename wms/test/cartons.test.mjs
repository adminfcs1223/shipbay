// node --test test/   (no backend, no network: the Supabase client is a fake that serves synthetic rows)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCartons, checkCartons, attachCartons, canPrintCartons, sameLabels, findReceipt, lookupBookedReceipt, RECEIPT_LOOKUP_VERSION, expectedCode, PAGE } from '../src/cartons.js';

// ── synthetic data, built the way wms_receive builds it (migration 20261114180000, lines 566 and 590-591) ──
let pid = 0;
function receive(psku, lines) {   // lines: [{ name, item, cartons, cle, fba }]
  const id = `pal-${++pid}`; const mixed = lines.length > 1; const rowsN = lines.reduce((t, l) => t + (l.cle ? 1 : l.cartons), 0);
  const counted = lines.reduce((t, l) => t + (l.cle ? 0 : l.cartons), 0); const rows = []; let seq = 0;
  for (const l of lines) for (let g = 0; g < (l.cle ? 1 : l.cartons); g++) { seq += 1; rows.push({ id: `${id}-c${seq}`, pallet_id: id, seq, code: expectedCode(psku, seq, rowsN), item_no: l.item || null, item_name: l.name, units_per_carton: 6, fba: !!l.fba, cle: !!l.cle }); }
  return { pallet: { id, psku, mixed, cle: lines.every((l) => l.cle), cartons: counted || null, item_name: mixed ? `Mixed pallet · ${lines.length} products` : lines[0].name }, rows };
}
// a fake client: records every call, serves `rows` in pages, can fail on a chosen page
function fakeClient(rows, { failAt = -1, nullAt = -1, table = 'wms_cartons' } = {}) {
  const calls = [];
  const client = { calls, from(t) {
    const q = { t, ids: null, eq: null, range: null };
    const api = {
      select() { return api; },
      in(col, ids) { q.ids = ids; return api; },
      eq(col, v) { q.eq = [col, v]; return api; },
      order() { return api; },
      range(a, b) { q.range = [a, b]; return api; },
      then(res, rej) {
        calls.push({ ...q }); const n = calls.length - 1;
        if (t !== table) return Promise.resolve({ data: null, error: { message: `unexpected table ${t}` } }).then(res, rej);
        if (n === failAt) return Promise.resolve({ data: null, error: { message: 'upstream timeout' } }).then(res, rej);
        if (n === nullAt) return Promise.resolve({ data: null, error: null }).then(res, rej);
        let out = rows.filter((r) => (q.ids ? q.ids.includes(r.pallet_id) : true) && (q.eq ? r[q.eq[0]] === q.eq[1] : true));
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        return Promise.resolve({ data: out, error: null }).then(res, rej);
      },
    };
    return api;
  } };
  return client;
}
// the rule the screens used before this change when no rows were attached (label.js lines 25-26 at 02356bd)
const oldFallback = (p) => { const n = p.cartons || 0; const w = Math.max(2, String(n).length); const num = p.psku.replace(/\D/g, ''); return Array.from({ length: n }, (_, i) => ({ seq: i + 1, code: `C${num}${String(i + 1).padStart(w, '0')}` })); };

test('defect evidence: the old fallback prints wrong barcodes on a mixed pallet with an NCC line', () => {
  const { pallet, rows } = receive('PSKU-000101', [{ name: 'Bulk bags', cle: true }, { name: 'Record A', cartons: 5 }]);
  const real = rows.filter((c) => !c.cle).map((c) => c.code); const made = oldFallback(pallet).map((c) => c.code);
  assert.deepEqual(real, ['C00010102', 'C00010103', 'C00010104', 'C00010105', 'C00010106']);
  assert.deepEqual(made, ['C00010101', 'C00010102', 'C00010103', 'C00010104', 'C00010105']);
  assert.equal(rows.find((c) => c.code === made[0]).cle, true, 'the first made-up label is the NCC marker row, not a carton');
  assert.ok(!made.includes(real[4]), 'the last real carton never gets a label');
});
test('defect evidence: the old fallback pads differently once NCC rows push the row count past 99', () => {
  const { pallet, rows } = receive('PSKU-000102', [{ name: 'A', cartons: 99 }, { name: 'B', cle: true }]);
  assert.equal(rows[0].code, 'C000102001'); assert.equal(oldFallback(pallet)[0].code, 'C00010201');
});
test('defect evidence: the old fallback has no product on a mixed pallet even when its codes happen to match', () => {
  const { pallet, rows } = receive('PSKU-000103', [{ name: 'Record A', cartons: 3 }, { name: 'Record B', cartons: 2 }]);
  assert.deepEqual(oldFallback(pallet).map((c) => c.code), rows.map((c) => c.code));
  assert.ok(oldFallback(pallet).every((c) => c.item_name === undefined));
});

test('fetchCartons: one page', async () => {
  const { pallet, rows } = receive('PSKU-000201', [{ name: 'A', cartons: 27 }]); const c = fakeClient(rows);
  assert.equal((await fetchCartons(c, [pallet.id])).length, 27); assert.equal(c.calls.length, 1); assert.deepEqual(c.calls[0].range, [0, PAGE - 1]);
});
test('fetchCartons: reads every page of a large receive (60 pallets x 500 cartons = 30,000 rows)', async () => {
  const all = []; const ids = [];
  for (let i = 0; i < 60; i++) { const { pallet, rows } = receive(`PSKU-${String(1000 + i).padStart(6, '0')}`, [{ name: 'A', cartons: 500 }]); ids.push(pallet.id); all.push(...rows); }
  const c = fakeClient(all); const got = await fetchCartons(c, ids);
  assert.equal(got.length, 30000); assert.equal(c.calls.length, 61); assert.equal(new Set(got.map((r) => r.code)).size, 30000);
});
test('fetchCartons: exactly one full page asks once more and stops', async () => {
  const { pallet, rows } = receive('PSKU-000202', [{ name: 'A', cartons: 500 }]); const c = fakeClient(rows);
  assert.equal((await fetchCartons(c, [pallet.id])).length, 500); assert.equal(c.calls.length, 2);
});
test('fetchCartons: a failed read throws, it is never "no cartons"', async () => {
  const { pallet, rows } = receive('PSKU-000203', [{ name: 'A', cartons: 5 }]);
  await assert.rejects(fetchCartons(fakeClient(rows, { failAt: 0 }), [pallet.id]), /upstream timeout/);
  await assert.rejects(fetchCartons(fakeClient(rows, { nullAt: 0 }), [pallet.id]), /could not be read/);
});
test('fetchCartons: a failure on a later page throws and returns nothing partial', async () => {
  const all = []; const ids = [];
  for (let i = 0; i < 3; i++) { const { pallet, rows } = receive(`PSKU-00030${i}`, [{ name: 'A', cartons: 400 }]); ids.push(pallet.id); all.push(...rows); }
  await assert.rejects(fetchCartons(fakeClient(all, { failAt: 1 }), ids), /upstream timeout/);
});
test('fetchCartons: no pallets, no request', async () => { const c = fakeClient([]); assert.deepEqual(await fetchCartons(c, []), []); assert.equal(c.calls.length, 0); });

test('checkCartons: single product passes', () => { const { pallet, rows } = receive('PSKU-000401', [{ name: 'A', cartons: 27 }]); assert.deepEqual(checkCartons(pallet, rows), []); });
test('checkCartons: mixed pallet passes', () => { const { pallet, rows } = receive('PSKU-000402', [{ name: 'A', cartons: 6 }, { name: 'B', cartons: 9 }, { name: 'C', cartons: 5 }]); assert.deepEqual(checkCartons(pallet, rows), []); });
test('checkCartons: mixed pallet with an NCC line passes, marker row not counted', () => { const { pallet, rows } = receive('PSKU-000403', [{ name: 'A', cle: true }, { name: 'B', cartons: 5 }]); assert.equal(pallet.cartons, 5); assert.equal(rows.length, 6); assert.deepEqual(checkCartons(pallet, rows), []); });
test('checkCartons: all-NCC pallet passes with no count', () => { const { pallet, rows } = receive('PSKU-000404', [{ name: 'A', cle: true }]); assert.equal(pallet.cartons, null); assert.deepEqual(checkCartons(pallet, rows), []); });
test('checkCartons: off-list pallet with zero cartons and zero rows passes', () => { assert.deepEqual(checkCartons({ id: 'p0', psku: 'PSKU-000405', mixed: false, cle: false, cartons: null }, []), []); });
test('checkCartons: an empty answer for a pallet that has cartons fails (the failed-read case)', () => { const { pallet } = receive('PSKU-000406', [{ name: 'A', cartons: 27 }]); assert.match(checkCartons(pallet, []).join(), /27 cartons on the pallet, 0 on file/); });
test('checkCartons: a short answer fails', () => { const { pallet, rows } = receive('PSKU-000407', [{ name: 'A', cartons: 27 }]); assert.ok(checkCartons(pallet, rows.slice(0, 20)).length > 0); });
test('checkCartons: duplicate barcode fails', () => { const { pallet, rows } = receive('PSKU-000408', [{ name: 'A', cartons: 4 }]); rows[3] = { ...rows[3], code: rows[2].code }; assert.match(checkCartons(pallet, rows).join(), /share a barcode/); });
test('checkCartons: a barcode from another pallet fails', () => { const { pallet, rows } = receive('PSKU-000409', [{ name: 'A', cartons: 4 }]); rows[1] = { ...rows[1], code: 'C00099902' }; assert.match(checkCartons(pallet, rows).join(), /does not match its pallet/); });
test('checkCartons: a row of another pallet fails', () => { const a = receive('PSKU-000410', [{ name: 'A', cartons: 2 }]); const b = receive('PSKU-000411', [{ name: 'B', cartons: 2 }]); assert.match(checkCartons(a.pallet, [a.rows[0], b.rows[1]]).join(), /another pallet/); });
test('checkCartons: a mixed-pallet carton with no product fails', () => { const { pallet, rows } = receive('PSKU-000412', [{ name: 'A', cartons: 2 }, { name: 'B', cartons: 2 }]); rows[2] = { ...rows[2], item_name: '' }; assert.match(checkCartons(pallet, rows).join(), /no product/); });
test('checkCartons: NCC pallet with no marker row fails', () => { assert.match(checkCartons({ id: 'p1', psku: 'PSKU-000413', mixed: false, cle: true, cartons: null }, []).join(), /NCC/); });

test('attachCartons: each pallet gets its own rows and a pass mark; printing is allowed only then', () => {
  const a = receive('PSKU-000501', [{ name: 'A', cartons: 3 }]); const b = receive('PSKU-000502', [{ name: 'B', cartons: 2 }, { name: 'C', cartons: 2 }]);
  const got = attachCartons([a.pallet, b.pallet], [...b.rows, ...a.rows]);
  assert.equal(got.ok, true); assert.deepEqual(got.pallets[0]._cartons.map((c) => c.code), a.rows.map((c) => c.code)); assert.ok(got.pallets.every(canPrintCartons));
});
test('attachCartons: one bad pallet is named and cannot print; the failed-read shape cannot print', () => {
  const a = receive('PSKU-000503', [{ name: 'A', cartons: 3 }]); const b = receive('PSKU-000504', [{ name: 'B', cartons: 2 }]);
  const got = attachCartons([a.pallet, b.pallet], a.rows);
  assert.equal(got.ok, false); assert.equal(got.problems[0].psku, 'PSKU-000504'); assert.equal(canPrintCartons(got.pallets[0]), true); assert.equal(canPrintCartons(got.pallets[1]), false);
  assert.equal(canPrintCartons({ ...b.pallet, _cartons: [] }), false, 'what the old code built after a failed read');
  assert.equal(canPrintCartons({ ...b.pallet }), false); assert.equal(canPrintCartons(null), false);
});
test('attachCartons: rows for a pallet that was not asked for are flagged', () => {
  const a = receive('PSKU-000505', [{ name: 'A', cartons: 1 }]); const b = receive('PSKU-000506', [{ name: 'B', cartons: 1 }]);
  assert.equal(attachCartons([a.pallet], [...a.rows, ...b.rows]).ok, false);
});
test('canPrintCartons: the form draft may print before Receive', () => { assert.equal(canPrintCartons({ psku: 'PSKU-000601', _cartons: [{ seq: 1, code: 'C00060101' }], _draft: true }), true); });

test('sameLabels: early labels match what was received', () => { const { rows } = receive('PSKU-000701', [{ name: 'A', cle: true }, { name: 'B', cartons: 5, fba: true }]); assert.equal(sameLabels(rows.map(({ id, pallet_id, ...c }) => c), rows), true); });
test('sameLabels: a different code, product or FBA mark is a mismatch', () => {
  const { rows } = receive('PSKU-000702', [{ name: 'A', cartons: 3 }]);
  assert.equal(sameLabels(rows.map((c, i) => (i ? c : { ...c, code: 'C00070209' })), rows), false);
  assert.equal(sameLabels(rows.map((c, i) => (i ? c : { ...c, item_name: 'Other' })), rows), false);
  assert.equal(sameLabels(rows.map((c, i) => (i ? c : { ...c, fba: true })), rows), false);
  assert.equal(sameLabels(rows.slice(1), rows), false);
});

test('findReceipt: finds the pallets a key made; no key or no match is an empty list; a failed read throws', async () => {
  const pallets = [{ id: 'a', batch_key: 'k1', pallet_id: null }, { id: 'b', batch_key: 'k2', pallet_id: null }];
  assert.deepEqual((await findReceipt(fakeClient(pallets, { table: 'wms_pallets' }), 'k1')).map((p) => p.id), ['a']);
  assert.deepEqual(await findReceipt(fakeClient(pallets, { table: 'wms_pallets' }), 'k9'), []);
  assert.deepEqual(await findReceipt(fakeClient(pallets, { table: 'wms_pallets' }), ''), []);
  await assert.rejects(findReceipt(fakeClient(pallets, { table: 'wms_pallets', failAt: 0 }), 'k1'), /upstream timeout/);
});

test('KNOWN GAP (documented in checkCartons): a missing trailing NCC marker on a mixed pallet is NOT detected', () => {
  const { pallet, rows } = receive('PSKU-000801', [{ name: 'A', cartons: 3 }, { name: 'B', cle: true }]);
  assert.equal(rows.length, 4); assert.deepEqual(checkCartons(pallet, rows), []);
  const missingLast = rows.slice(0, 3);
  assert.deepEqual(checkCartons(pallet, missingLast), [], 'passes: this case is not provable from the pallet row; labels are unaffected, NCC stock would be');
});
test('a missing NCC marker at the start or middle IS detected (numbering gap)', () => {
  const a = receive('PSKU-000802', [{ name: 'A', cle: true }, { name: 'B', cartons: 3 }]);
  assert.match(checkCartons(a.pallet, a.rows.slice(1)).join(), /not 1 to/);
  const b = receive('PSKU-000803', [{ name: 'A', cartons: 2 }, { name: 'B', cle: true }, { name: 'C', cartons: 2 }]);
  assert.match(checkCartons(b.pallet, b.rows.filter((c) => !c.cle)).join(), /not 1 to/);
});

// ── booked "Did it go through?": the dedicated lookup only; transport and server errors are never "not found" ──
const FL = { key: 'k-booked-1', rpc: 'wms_receive_booking', payload: { p_org: 'org-A', p_inbound: 'bk-1', p_key: 'k-booked-1', p_pallets: 1, p_notes: null, p_lines: [{ sku: 's', cartons: 2 }], p_mode: 'partial', p_hold_reason: null } };
const rpcClient = (answer) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(fn, args) : answer; },
  from: () => { throw new Error('the general pallet search must not be used for a booked receipt'); } }; };
test('lookupBookedReceipt: calls only wms_receipt_lookup, bound to brand, booking, key, version and the exact request content', async () => {
  const c = rpcClient({ data: { state: 'not_found' }, error: null });
  assert.deepEqual(await lookupBookedReceipt(c, FL), { state: 'not_found' });
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].fn, 'wms_receipt_lookup');
  assert.deepEqual(c.calls[0].args, { p_org: 'org-A', p_inbound: 'bk-1', p_key: 'k-booked-1', p_version: RECEIPT_LOOKUP_VERSION, p_lines: FL.payload.p_lines, p_pallets: 1, p_notes: null, p_mode: 'partial', p_hold_reason: null });
});
test('lookupBookedReceipt: received returns the pallets; other-receipt answers are their own states', async () => {
  assert.deepEqual((await lookupBookedReceipt(rpcClient({ data: { state: 'received', pallets: [{ id: 'p1', batch_key: 'k-booked-1' }] } }), FL)).pallets.map((p) => p.id), ['p1']);
  for (const st of ['different_request', 'key_used_elsewhere']) assert.deepEqual(await lookupBookedReceipt(rpcClient({ data: { state: st } }), FL), { state: st });
});
test('lookupBookedReceipt: transport failure, server error, empty or odd answers throw (never "not found")', async () => {
  await assert.rejects(lookupBookedReceipt(rpcClient(new TypeError('Failed to fetch')), FL), /Failed to fetch/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: null, error: { message: 'This login cannot look up receipts.' } }), FL), /cannot look up/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: null, error: null }), FL), /not understood/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: { state: 'maybe' } }), FL), /not understood/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: { state: 'received', pallets: [] } }), FL), /incomplete/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: { state: 'received', pallets: [{ id: 'x', batch_key: 'other' }] } }), FL), /incomplete/);
  await assert.rejects(lookupBookedReceipt(rpcClient({ data: { state: 'not_found' } }), { key: 'k', payload: { p_org: 'org-A' } }), /no booking/);
});
