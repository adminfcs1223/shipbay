// The ShipBay MVP rehearsal (supabase/dev/MVP-REHEARSAL.md) as plain steps: one fresh synthetic pallet, receive -> put away
// at one vacant shared position -> three manual orders -> wave pick and pack two -> ship two with test tracking (no label is
// bought) -> the third is short and is cancelled -> reconcile to zero -> release the pallet from Nexus.
// No imports: the same file runs locally (mvp.test.mjs: local database, the bridge in-process, the real Nexus code) and in
// the temporary dev-only runner (supabase/dev/runner/runner.js, stage "mvp": the deployed bridge, genuine sign-ins).
//
// It is given (io):
//   io.call(who, method, path, body)  the bridge, as 'floor' | 'admin' | null (no sign-in; only for GET /status)
//   io.rpc(who, fn, args)             ShipBay's own functions, as that login, with that login's rights
//   io.snapshot()                     dev_movement_snapshot(): read-only
//   io.product(who, row)              the product row {org_id, sku, name, barcode}: found by (org_id, sku), else inserted, as that login
//   io.cancelOrder(who, id)           the portal's own cancel: orders.status = 'cancelled', as that login (the database decides)
//
// Rules it enforces on itself, before any request leaves:
//   - only P-50 or P-49; never P-01, P-02, P-03 or any other position;
//   - every request about a pallet names THIS run's pallet (found by its fresh receiving key) and nothing else;
//   - PSKU-000001, anything ShipBay has at P-01..P-03, every journal entry that is not this run's, and what Nexus shows at
//     P-01..P-03 are read at the start and must be identical at the end;
//   - the run stops at the first unexpected answer. It never retries a refused request, never makes a new key for one, and
//     never releases or corrects anything to "clean up". A request Nexus did not answer is resent only through the bridge's
//     own /pending/retry (same key).
//   - it can be run again after it stopped: every step looks first at what is already done (fresh identifiers make that safe).
// It cannot change ShipBay's movement switches (they are secrets Derek sets by hand). It reports them at the start and the end.

export const MVP = {
  org: '5a000000-0000-4000-8000-0000000000a1',   // Synthetic Records
  sku: 'MVP-RH-1124', name: 'MVP rehearsal product', barcode: 'MVP-RH-1124-BC',
  key: 'mvp-rehearsal-1124', cartons: 2, perCarton: 6,
  orders: [['MVP-RH-1', 6], ['MVP-RH-2', 6], ['MVP-RH-3', 6]],
  tracking: ['TEST-MVP-RH-0001', 'TEST-MVP-RH-0002'],
  positions: ['P-50', 'P-49'],
  forbidden: ['P-01', 'P-02', 'P-03'],
  keep: 'PSKU-000001',
};
const code = (v) => String(v || '').toUpperCase().replace(/\s+/g, '').replace(/^LOC-/, '');
class Stop extends Error {}
const brief = (v) => { const s = JSON.stringify(v === undefined ? null : v); return s.length > 400 ? s.slice(0, 400) + '...' : s; };
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const switches = (st) => (st ? `connection ${st.connection}, pallet moves ${st.pallet_moves}, registry writes ${st.registry_writes}, calendar writes ${st.calendar_writes}, test faults ${st.test_faults}` : 'unknown (the bridge did not answer)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The position the run may use, or why not. */
export function allowedPosition(p) {
  const c = code(p);
  if (MVP.forbidden.includes(c)) return { ok: false, why: `${c} is never used by this rehearsal` };
  if (!MVP.positions.includes(c)) return { ok: false, why: `${c || 'no position'} is not one of ${MVP.positions.join(', ')}` };
  return { ok: true, code: c };
}

export async function runMvp(io, { position = 'P-50', retries = 3, retryDelayMs = 2000, stopAfter = null, faults = false } = {}) {
  const checks = []; let writes = 0; let pallet = null; const notes = [];
  const result = (extra) => ({ runner: 'mvp', position: code(position), pallet: pallet?.psku || null, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length, writes_sent: writes, checks, notes, ...extra });
  const ok = (name, cond, got) => { checks.push(cond ? { pass: true, name } : { pass: false, name, got: brief(got) }); if (!cond) throw new Stop(name); };
  const check = (name, got, want) => { const pass = same(got, want); checks.push(pass ? { pass, name } : { pass, name, got: brief(got), want: brief(want) }); if (!pass) throw new Stop(name); };
  const pos = allowedPosition(position);
  if (!pos.ok) return result({ ok: false, error: 'position_refused', message: pos.why, writes_sent: 0 });
  const at = pos.code;

  // every bridge request passes through here
  const guard = (body) => {
    const b = body || {};
    if (b.location !== undefined && code(b.location) !== at) throw new Stop(`REFUSED BY THE RUN: position ${b.location}`);
    if (b.psku !== undefined && (!pallet || code(b.psku) !== pallet.psku)) throw new Stop(`REFUSED BY THE RUN: pallet ${b.psku}`);
    const t = JSON.stringify(b).toUpperCase().replace(/\s+/g, '');
    if (t.includes(MVP.keep) || MVP.forbidden.some((f) => new RegExp(`"(LOC-)?${f}"`).test(t))) throw new Stop('REFUSED BY THE RUN: a request named a protected pallet or position');
  };
  const call = (who, method, path, body) => { guard(body); if (method === 'POST') writes++; return io.call(who, method, path, body); };
  const rpc = (who, fn, args) => io.rpc(who, fn, args);
  const refused = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message || e); } };
  const mine = (s) => s.pallets.filter((p) => p.batch === MVP.key);
  const protectedState = (s, floor) => ({
    keep: s.pallets.find((p) => p.psku === MVP.keep) || null,
    shipbay_at: s.pallets.filter((p) => MVP.forbidden.includes(p.location)),
    other_ops: s.ops.filter((o) => !pallet || o.psku !== pallet.psku),
    nexus_at: floor.filter((l) => MVP.forbidden.includes(l.code)).map((l) => ({ code: l.code, capacity: l.capacity, used: l.used, occupants: l.occupants, your_pallets: l.your_pallets })),
  });
  const floorNow = async () => { const f = await call('floor', 'GET', '/floor'); ok('GET /floor answers', f.status === 200 && Array.isArray(f.locations), f); return f.locations; };
  // a write to Nexus through the bridge: on no answer, only the bridge's own retry with the same key
  // faults (local only, needs NEXUS_TEST_FAULTS): Nexus does the write and its answer is thrown away on the way back
  const nexusWrite = async (path, body, want) => {
    let r;
    if (faults) { guard(body); writes++; r = await io.lossy('floor', 'POST', path, body); ok(`${path}: the answer was lost and the bridge says nothing is confirmed (503, pending)`, r.lost === true && r.status === 503 && r.pending === true, r); }
    else r = await call('floor', 'POST', path, body);
    for (let i = 0; r.status === 503 && r.pending === true && i < retries; i++) {
      notes.push(`${path}: Nexus did not answer (attempt ${i + 1}); resending through /pending/retry with the same key`);
      if (retryDelayMs) await sleep(retryDelayMs);
      const again = await call('floor', 'POST', '/pending/retry', {});
      const mineAgain = (again.results || []).find((x) => code(x.pallet) === pallet.psku && x.kind === want);
      r = mineAgain && mineAgain.ok ? { status: 200, ok: true, retried: true } : { status: 503, pending: true, again };
    }
    return r;
  };

  let start;
  try {
    // ---- 0. before anything: switches, the protected records, the destination ----
    const st = await io.call(null, 'GET', '/status');
    notes.push(`switches at start: ${switches(st)}`);
    check('switches set by hand for the run: connection staging, pallet moves on, registry and calendar writes off, test faults ' + (faults ? 'on' : 'off'),
      [st.status, st.connection, st.pallet_moves, st.registry_writes, st.calendar_writes, st.test_faults], [200, 'staging', true, false, false, !!faults]);
    const mw = st.move_window || {};
    notes.push(`movement authorization at start: open ${mw.open}, closes ${mw.closes_at}, ${mw.seconds_left}s left, positions ${mw.positions}, pallets ${mw.pallets || 'any'}`);
    ok(`a movement authorization is open for ${at} with at least 5 minutes left, naming no position but P-50 / P-49`,
      mw.open === true && mw.seconds_left >= 300 && Array.isArray(mw.positions) && mw.positions.includes(at) && mw.positions.every((p) => MVP.positions.includes(p)), mw);
    let s = await io.snapshot();
    pallet = mine(s)[0] || null;
    ok(`at most one pallet under the receiving key ${MVP.key}`, mine(s).length <= 1, mine(s).map((p) => p.psku));
    ok(`${MVP.keep} is stored at P-01`, s.pallets.some((p) => p.psku === MVP.keep && p.status === 'stored' && p.location === 'P-01'), s.pallets.find((p) => p.psku === MVP.keep));
    const stuck = s.ops.filter((o) => ['pending', 'out_of_sync'].includes(o.state) && (!pallet || o.psku !== pallet.psku));
    ok('no other request to Nexus is waiting or out of sync', stuck.length === 0, stuck);
    let floor = await floorNow();
    start = protectedState(s, floor);
    const dest = floor.find((l) => l.code === at);
    ok(`${at} exists in Nexus`, !!dest, floor.map((l) => l.code));
    const oursThere = pallet && pallet.status === 'stored' && pallet.location === at;
    const released = pallet && ['departed', 'off_floor'].includes(pallet.status);
    if (!oursThere && !released) ok(`${at} is vacant in Nexus (capacity ${dest.capacity}, nothing there)`, Number(dest.used) === 0 && (dest.occupants || []).length === 0 && Number(dest.free) >= 1, dest);
    if (stopAfter === 'preflight') return result({ ok: true, stopped_by_request: 'preflight' });

    // ---- 1. product and receipt ----
    const sku = await io.product('admin', { org_id: MVP.org, sku: MVP.sku, name: MVP.name, barcode: MVP.barcode });
    ok(`product ${MVP.sku} on file for Synthetic Records`, !!sku && !!sku.id, sku);
    if (!pallet) {
      const lines = [{ sku: sku.id, cartons: MVP.cartons, units_per_carton: MVP.perCarton }];
      await rpc('floor', 'wms_receive', { p_org: MVP.org, p_lines: lines, p_pallets: 1, p_notes: 'MVP rehearsal', p_key: MVP.key });
      await rpc('floor', 'wms_receive', { p_org: MVP.org, p_lines: lines, p_pallets: 1, p_notes: 'MVP rehearsal', p_key: MVP.key });   // the same request again
      s = await io.snapshot();
      ok('the receipt and its repeat made exactly one pallet', mine(s).length === 1, mine(s));
      pallet = mine(s)[0];
    }
    ok(`the pallet is Synthetic Records' and nothing is booked for it before put-away, or it is already this run's`, pallet.org === MVP.org && (pallet.status !== 'open' || Number(pallet.receipts) === 0), pallet);
    if (stopAfter === 'receive') return result({ ok: true, stopped_by_request: 'receive' });

    // ---- 2. count ----
    if (pallet.status === 'open') {
      const digits = pallet.psku.replace(/\D/g, '');
      for (let i = 1; i <= MVP.cartons; i++) {
        const c = await rpc('floor', 'wms_scan_carton', { p_code: `C${digits}${String(i).padStart(2, '0')}` });
        ok(`carton ${i} of ${MVP.cartons} belongs to ${pallet.psku}`, c && c.psku === pallet.psku && Number(c.total) === MVP.cartons, c);
      }
      await rpc('floor', 'wms_complete_count', { p_pallet: pallet.id });
      s = await io.snapshot(); pallet = mine(s)[0];
    }
    ok(`${pallet.psku} is counted or further along`, ['counted', 'stored', 'departed', 'off_floor'].includes(pallet.status), pallet);

    // ---- 3. put away at the position, through Nexus ----
    if (['counted', 'stored'].includes(pallet.status)) ok(`the movement authorization covers ${pallet.psku}`, !mw.pallets || mw.pallets.includes(pallet.psku), mw.pallets);
    if (pallet.status === 'counted') {
      const r = await nexusWrite('/putaway', { psku: pallet.psku, location: at }, 'assign');
      ok(`put-away of ${pallet.psku} at ${at}: Nexus said yes`, r.status === 200 && r.ok === true, r);
      s = await io.snapshot(); pallet = mine(s)[0];
      const again = await call('floor', 'POST', '/putaway', { psku: pallet.psku, location: at });   // the same scan again
      ok('a second put-away of the stored pallet is refused by ShipBay and sends nothing new to Nexus', again.status !== 200, again);
      notes.push(`second put-away answered ${again.status} ${again.error || ''}`);
    }
    s = await io.snapshot(); pallet = mine(s)[0];
    if (pallet.status === 'stored') {
      check(`${pallet.psku} stored at ${at} with one receipt of ${MVP.cartons * MVP.perCarton}`, [pallet.location, Number(pallet.receipts), Number(pallet.received_units)], [at, 1, MVP.cartons * MVP.perCarton]);
      floor = await floorNow();
      ok(`Nexus shows ${pallet.psku} at ${at}`, (floor.find((l) => l.code === at)?.your_pallets || []).map(code).includes(pallet.psku), floor.find((l) => l.code === at));
    }
    if (stopAfter === 'putaway') return result({ ok: true, stopped_by_request: 'putaway' });

    // ---- 4. three manual orders ----
    const orderId = {};
    for (const [n, q] of MVP.orders) {
      const have = s.orders.find((o) => o.number === n && o.org === MVP.org);
      orderId[n] = have ? have.id : await rpc('admin', 'create_manual_order', { p_org_id: MVP.org, p_order: { order_number: n, ship_to: { name: `Rehearsal ${n}`, country_code: 'US' } }, p_lines: [{ sku_id: sku.id, qty: q }] });
      ok(`order ${n} on file`, !!orderId[n], orderId[n]);
    }
    const dup = await refused(() => rpc('admin', 'create_manual_order', { p_org_id: MVP.org, p_order: { order_number: MVP.orders[0][0] }, p_lines: [{ sku_id: sku.id, qty: 1 }] }));
    ok('creating MVP-RH-1 again is refused', /already used/.test(String(dup)), dup);
    s = await io.snapshot();
    const status = (n) => s.orders.find((o) => o.number === n)?.status;

    // ---- 5. wave pick and pack the two the stock covers ----
    const [o1, o2, o3] = MVP.orders.map((x) => x[0]);
    if (![o1, o2].every((n) => ['packed', 'shipped'].includes(status(n)))) {
      const others = s.orders.filter((o) => o.org === MVP.org && ['new', 'picked'].includes(o.status) && !MVP.orders.some(([n]) => n === o.number));
      ok('no other open order of Synthetic Records could join the wave', others.length === 0, others);
      const w = await rpc('floor', 'wms_wave_start', { p_org: MVP.org });
      const wave = w && w.wave;
      ok('the wave started (or the floor login\'s open wave was found)', !!wave && !!wave.id, w);
      check('the wave holds MVP-RH-1 and MVP-RH-2 only', wave.orders.map((o) => o.order_number).sort(), [o1, o2]);
      ok(`every stop is ${MVP.sku} at ${at}`, wave.tasks.every((t) => t.sku === MVP.sku && code(t.location) === at), wave.tasks);
      if (w.short) ok('MVP-RH-3 is reported short', w.short.some((x) => x.order_number === o3) || status(o3) !== 'new', w.short);
      for (const t of wave.tasks) {
        if (t.confirmed) continue;
        await rpc('floor', 'wms_wave_confirm', { p_task: t.id, p_qty: t.qty_planned, p_scan: MVP.barcode });
        const twice = await refused(() => rpc('floor', 'wms_wave_confirm', { p_task: t.id, p_qty: t.qty_planned, p_scan: MVP.barcode }));
        ok('confirming the same stop again is refused', /already confirmed/.test(String(twice)), twice);
      }
      let packing = await rpc('floor', 'wms_wave_to_pack', { p_wave: wave.id });
      for (const o of packing.orders || []) {
        if (o.pack_state !== 'pending') continue;
        await rpc('floor', 'wms_wave_pack', { p_wave: wave.id, p_orders: [o.id], p_packages: [{ items: [{ key: MVP.sku, qty: 6 }], weight_oz: 16, packaging: 'box' }] });
      }
      s = await io.snapshot();
    }
    check('MVP-RH-1 and -2 are packed or shipped', [o1, o2].map(status).map((x) => (x === 'shipped' ? 'packed' : x)), ['packed', 'packed']);
    let sum = (await rpc('admin', 'wms_stock_summary', { p_org: MVP.org })).products.find((p) => p.sku === MVP.sku);
    ok(`after the pick: nothing left at ${at}`, Number(sum.on_hand) === 0 && Number(sum.picked_out) === -12, sum);

    // ---- 6. ship with test tracking (no label is bought); the repeat returns the same shipment ----
    for (const [n, t] of [[o1, MVP.tracking[0]], [o2, MVP.tracking[1]]]) {
      const a = await rpc('admin', 'ship_order', { p_order_id: orderId[n], p_carrier: 'USPS', p_service: 'Ground Advantage', p_tracking: t, p_label_source: 'manual', p_label_cost: null, p_packaging: 'Box 8×6×4', p_weight_oz: 16 });
      const b = await rpc('admin', 'ship_order', { p_order_id: orderId[n], p_carrier: 'USPS', p_service: 'Ground Advantage', p_tracking: t, p_label_source: 'manual', p_label_cost: null, p_packaging: 'Box 8×6×4', p_weight_oz: 16 });
      ok(`${n} shipped with ${t}; the repeat returns the same shipment`, !!a && a === b, [a, b]);
    }

    // ---- 7. the third order is short: cancelled through the portal's own cancel ----
    s = await io.snapshot();
    if (status(o3) !== 'cancelled') {
      sum = (await rpc('admin', 'wms_stock_summary', { p_org: MVP.org })).products.find((p) => p.sku === MVP.sku);
      ok('MVP-RH-3 is short: nothing on hand for its 6', Number(sum.on_hand) === 0 && Number(sum.on_open_orders) === 6, sum);
      const why = await rpc('admin', '_order_commitment', { p_order: orderId[o3] });
      ok('no warehouse work stands on MVP-RH-3', why === null, why);
      await io.cancelOrder('admin', orderId[o3]);
      s = await io.snapshot();
    }
    check('order states', [o1, o2, o3].map(status), ['shipped', 'shipped', 'cancelled']);

    // ---- 8. reconcile ----
    sum = (await rpc('admin', 'wms_stock_summary', { p_org: MVP.org })).products.find((p) => p.sku === MVP.sku);
    check(`${MVP.sku}: received, picked out, shipped, on hand, waiting, open orders, transfers, reconciled`,
      [sum.received, sum.picked_out, sum.shipped, sum.on_hand, sum.picked_not_shipped, sum.on_open_orders, sum.transfers_net, sum.reconciled], [12, -12, 12, 0, 0, 0, 0, true]);

    // ---- 9. release the empty pallet from Nexus ----
    pallet = mine(s)[0];
    if (pallet.status === 'stored') {
      ok(`${pallet.psku} has nothing left on the books before it leaves`, Number(pallet.on_books) === 0, pallet);
      const r = await nexusWrite('/release', { psku: pallet.psku, location: at, confirmed: true, reason: 'emptied_and_removed' }, 'release');
      ok(`release of ${pallet.psku} from ${at}: Nexus said yes`, r.status === 200 && r.ok === true, r);
      s = await io.snapshot(); pallet = mine(s)[0];
    }
    ok(`${pallet.psku} has left the floor`, pallet.status === 'departed' && !pallet.location, pallet);
    floor = await floorNow();
    const freed = floor.find((l) => l.code === at);
    ok(`${at} is vacant in Nexus again`, Number(freed.used) === 0 && !(freed.your_pallets || []).length, freed);
    const mineOps = s.ops.filter((o) => o.psku === pallet.psku);
    check(`this run's requests to Nexus: one put-away and one release, both done`, mineOps.map((o) => [o.kind, o.state]), [['assign', 'done'], ['release', 'done']]);

    // ---- 10. nothing else changed ----
    check('PSKU-000001, ShipBay at P-01..P-03, every other journal entry, and Nexus at P-01..P-03: as at the start', protectedState(s, floor), start);
    const fin = await io.call(null, 'GET', '/status');
    notes.push(`switches at end: ${switches(fin)}. The runner cannot turn them off: Derek deletes NEXUS_BRIDGE_MODE and NEXUS_PALLET_MOVES now.`);
    return result({ ok: true, switches_at_end: fin });
  } catch (e) {
    let fin = null; try { fin = await io.call(null, 'GET', '/status'); } catch { /* unreachable */ }
    notes.push(`STOPPED. Switches now: ${switches(fin)}. The runner cannot turn them off: Derek deletes NEXUS_BRIDGE_MODE and NEXUS_PALLET_MOVES now.`);
    return result({ ok: false, stopped_at: e instanceof Stop ? e.message : 'error', error: e instanceof Stop ? undefined : String(e?.message || e).slice(0, 300), switches_at_end: fin || null });
  }
}
