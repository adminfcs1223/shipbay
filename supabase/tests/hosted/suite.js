// The hosted movement rehearsal, as plain steps. No imports: the same file runs
//   - locally under `node --test` (local.test.mjs: local database, the bridge in-process, the real Nexus service code), and
//   - inside the temporary dev-only runner (supabase/dev/runner/index.ts: the deployed bridge over HTTPS, genuine sign-ins).
// It decides nothing about HOW the bridge is reached. It is given five things (io) and only uses those:
//   io.call(who, method, path, body)   the bridge, as that synthetic login ('floor' | 'admin' | 'client'), 'public' (the public key only) or null (no sign-in)
//   io.lossy(who, method, path, body)  the same bridge, asked (dev-only test fault) to throw away Nexus's answer to this one write AFTER Nexus applied it
//   io.rpc(who, fn, args)              one of ShipBay's own floor functions, as that login, with that login's rights
//   io.snapshot()                      dev_movement_snapshot(): read-only
//   io.faultHold(psku, reason)         dev_fault_hold(): the one injected fault ShipBay has no floor function for
//
// Rules this file enforces on itself:
//   - PSKU-000001 at P-01 is never named in any request. Souled's cross-company conflict test needs it exactly as it is.
//     Every stage checks it before its first request and after its last one.
//   - A stage refuses to start unless its pallets are in the state it expects, and stops at the first check that fails.
//     Nothing is retried, repaired or released to "clean up".
//   - Every stage ends by proving that no pallet has more than one receipt, no adjustment was written, and every transfer nets to zero.

export const KEEP = { psku: 'PSKU-000001', at: 'P-01', units: 100, sku: 'SYN-LP-001' };
// which synthetic pallet plays which part: [receipt batch, position in the batch, units, product]
export const CAST = {
  M: ['syn-seed-1', 2, 100, 'SYN-LP-001'],    // moved P-11 -> P-12
  HELD: ['syn-seed-2', 1, 50, 'SYN-LP-002'],  // on HOLD since receiving: never reaches Nexus
  R1: ['syn-move-1', 1, 200, 'SYN-LP-002'],   // P-13: leaves the shared floor (still in custody), then comes back
  R2: ['syn-move-1', 2, 200, 'SYN-LP-002'],   // P-14: leaves the building
  L: ['syn-move-1', 3, 200, 'SYN-LP-002'],    // P-15 -> P-16: both answers from Nexus are lost
  F1: ['syn-move-1', 4, 200, 'SYN-LP-002'],   // P-17: Nexus accepted, ShipBay could not record; the pallet IS there
  F2: ['syn-move-2', 1, 1000, 'SYN-MLR-S'],   // P-18: Nexus accepted, ShipBay could not record; the pallet is NOT there
  G: ['syn-move-2', 2, 1000, 'SYN-MLR-S'],    // P-19 -> P-20: part-picked, moved, the pick reopened; then its planned stop follows it P-20 <-> P-19
};
export const POSITIONS = ['P-11', 'P-12', 'P-13', 'P-14', 'P-15', 'P-16', 'P-17', 'P-18', 'P-19', 'P-20'];
export const STAGES = ['preflight', 'move', 'release', 'lost', 'partial', 'picks', 'stops', 'final'];
const ORG_MAILERS = '5a000000-0000-4000-8000-0000000000a2';
const MAP_CHECKSUM = 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f';

/** True when a request body names the protected pallet or its position, in any spelling the bridge would accept. */
export const namesProtected = (body) => { const t = JSON.stringify(body || {}).toUpperCase().replace(/\s+/g, ''); return t.includes(KEEP.psku) || /"(LOC-)?P-0*1"/.test(t); };
class Stop extends Error {}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);   // object key order never matters
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const brief = (v) => { const s = JSON.stringify(v === undefined ? null : v); return s.length > 400 ? s.slice(0, 400) + '...' : s; };

export async function runStage(io, stage) {
  const checks = []; let mutating = 0;
  const check = (name, got, want) => { const pass = same(got, want); checks.push(pass ? { pass, name } : { pass, name, got: brief(got), want: brief(want) }); if (!pass) throw new Stop(name); };
  const ok = (name, cond, got) => { checks.push(cond ? { pass: true, name } : { pass: false, name, got: brief(got) }); if (!cond) throw new Stop(name); };
  const guard = (body) => { if (namesProtected(body)) throw new Stop(`REFUSED BY THE SUITE: a request named ${KEEP.psku} or ${KEEP.at}`); };
  const call = (who, method, path, body) => { guard(body); if (method === 'POST') mutating++; return io.call(who, method, path, body); };
  const lossy = async (who, path, body) => { guard(body); mutating++; const r = await io.lossy(who, 'POST', path, body); ok(`${path} ${body.psku}: the request reached Nexus and its answer was thrown away`, r.lost === true, r); return r; };
  const refused = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message || e); } };
  const snap = () => io.snapshot();
  const cast = (s) => Object.fromEntries(Object.entries(CAST).map(([k, [batch, pos]]) => [k, s.pallets.find((p) => p.batch === batch && p.pos === pos) || null]));
  const pal = (s, psku) => s.pallets.find((p) => p.psku === psku);
  const row = (s, psku) => { const p = pal(s, psku); return [p.status, p.location, Number(p.receipts), Number(p.received_units), Number(p.adjustments), Number(p.transfers), Number(p.transfer_net), Number(p.on_books)]; };
  const stock = (s, sku) => Object.fromEntries(s.stock.filter((x) => x.sku === sku).map((x) => [x.location, x.qty]));
  const ledger = (s) => [Number(s.ledger_rows), Number(s.ledger_units)];
  const grew = (a, b) => [Number(b.ledger_rows) - Number(a.ledger_rows), Number(b.ledger_units) - Number(a.ledger_units)];
  const ops = (s, psku) => s.ops.filter((o) => o.psku === psku);
  const floor = async () => { const f = await call('floor', 'GET', '/floor'); ok('GET /floor answers 200', f.status === 200 && Array.isArray(f.locations), f); const at = (code) => { const l = f.locations.find((x) => x.code === code); return { mine: l?.your_pallets || [], used: Number(l?.used || 0) }; }; return { f, at }; };
  const mineInNexus = (f) => Object.fromEntries(f.locations.filter((l) => (l.your_pallets || []).length).map((l) => [l.code, l.your_pallets]));
  const short = (r, ...keys) => [r.status, ...keys.map((k) => r[k])];

  // PSKU-000001 at P-01: ShipBay's row, its one receipt, its one journal entry, and Nexus's own answer
  const keepIntact = async (when) => {
    const s = await snap(); const { at } = await floor();
    check(`${when}: ${KEEP.psku} is stored at ${KEEP.at} with one receipt of ${KEEP.units} and no other ledger row`, [...row(s, KEEP.psku), Number(pal(s, KEEP.psku).ledger_rows)], ['stored', KEEP.at, 1, KEEP.units, 0, 0, 0, KEEP.units, 1]);
    check(`${when}: its journal is still the one put-away`, ops(s, KEEP.psku).map((o) => [o.kind, o.state, o.to]), [['assign', 'done', KEEP.at]]);
    check(`${when}: Nexus has exactly ${KEEP.psku} at ${KEEP.at}`, at(KEEP.at), { mine: [KEEP.psku], used: 1 });
    return s;
  };
  // no stage may leave a second receipt, an adjustment or an unbalanced transfer behind
  const ledgerRules = (s, when) => {
    check(`${when}: no pallet has more than one receipt`, s.pallets.filter((p) => Number(p.receipts) > 1).map((p) => p.psku), []);
    check(`${when}: no adjustment was written for any pallet`, s.pallets.filter((p) => Number(p.adjustments) !== 0).map((p) => p.psku), []);
    check(`${when}: every pallet's transfers net to zero`, s.pallets.filter((p) => Number(p.transfer_net) !== 0).map((p) => p.psku), []);
    check(`${when}: the ledger holds no adjustment at all`, s.by_reason.adjust || null, null);
    const size = Object.fromEntries(Object.values(CAST).map(([b, pos, units]) => [`${b}#${pos}`, units])); size['syn-seed-1#1'] = KEEP.units;
    check(`${when}: each receipt is the pallet's own quantity, once`, s.pallets.filter((p) => Number(p.receipts) === 1 && Number(p.received_units) !== size[`${p.batch}#${p.pos}`]).map((p) => p.psku), []);
  };
  const noSignIn = async (path, body) => {
    check(`POST ${path} with no sign-in is refused (401)`, (await call(null, 'POST', path, body)).status, 401);
    ok(`POST ${path} with only the public key is refused`, [401, 403].includes((await call('public', 'POST', path, body)).status));
    check(`POST ${path} as the client login is refused (403)`, short(await call('client', 'POST', path, body), 'error'), [403, 'not_staff']);
  };

  const stages = {
    // ---- 0. read-only: the switches, the sign-ins, the starting state, the positions the suite will use ----
    async preflight() {
      const st = await call('floor', 'GET', '/status');
      check('status: staging connection, test floor, pallet movement on, calendar and position-list writes off', [st.status, st.connection, st.floor, st.pallet_moves, st.calendar_writes, st.registry_writes], [200, 'staging', 'HILLSBOROUGH-TEST', true, false, false]);
      check('the dev-only test fault (lost answers) is switched on', st.test_faults, true);
      check('GET /floor with no sign-in is refused (401)', (await call(null, 'GET', '/floor')).status, 401);
      ok('GET /floor with only the public key is refused', [401, 403].includes((await call('public', 'GET', '/floor')).status));
      check('GET /floor as the client login is refused (403)', short(await call('client', 'GET', '/floor'), 'error'), [403, 'not_staff']);
      const s = await keepIntact('before anything'); const c = cast(s);
      check('all eight synthetic pallets for the suite are on file', Object.entries(c).filter(([, p]) => !p).map(([k]) => k), []);
      check('they are open, unplaced and have no stock; only the HOLD pallet is held', Object.entries(c).map(([k, p]) => [k, p.status, p.location, p.held, Number(p.ledger_rows)]), Object.keys(CAST).map((k) => [k, 'open', null, k === 'HELD', 0]));
      check('the stock ledger is the one receipt from the first placement', ledger(s), [1, KEEP.units]);
      check('the journal is the one put-away from the first placement', s.ops.map((o) => [o.psku, o.kind, o.state]), [[KEEP.psku, 'assign', 'done']]);
      check('the OFF-FLOOR holding location exists, is not shared and cannot be picked from', s.off_floor, { exists: true, pickable: false, shared: false });
      check('the one synthetic order is waiting', s.orders.map((o) => [o.number, o.status, o.org]), [['SYN-ORD-1', 'new', ORG_MAILERS]]);
      const { f, at } = await floor();
      check('Nexus: test floor, map version 4, the agreed checksum, moves enabled', [f.warehouse, f.map_version, f.checksum, f.moves_enabled], ['HILLSBOROUGH-TEST', 4, MAP_CHECKSUM, true]);
      check('Nexus holds exactly one ShipBay pallet', mineInNexus(f), { [KEEP.at]: [KEEP.psku] });
      check('P-11 to P-20 are empty in Nexus (no company stands there)', POSITIONS.filter((p) => at(p).used !== 0), []);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      const rec = await call('admin', 'GET', '/reconcile'); check('ShipBay and Nexus agree before the suite starts', [rec.status, rec.in_sync, rec.placed_in_nexus, rec.differences], [200, true, 1, []]);
      check('preflight sent no write', mutating, 0);
    },

    // ---- 1. moving a pallet ----
    async move() {
      const s0 = await keepIntact('before'); const c = cast(s0); const M = c.M.psku, R1 = c.R1.psku, HELD = c.HELD.psku;
      check('start: the pallets for this stage are open and unplaced', [c.M, c.R1, c.HELD].map((p) => [p.status, p.location]), [['open', null], ['open', null], ['open', null]]);
      await noSignIn('/move', { psku: M, location: 'P-12' });
      const early = await call('floor', 'POST', '/move', { psku: M, location: 'P-12' }); ok('a pallet that was never put away cannot be moved (409, ShipBay refuses, Nexus is not asked)', early.status === 409 && early.error === 'refused_by_shipbay' && /not put away yet/.test(early.message), early);
      const held = await call('floor', 'POST', '/putaway', { psku: HELD, location: 'P-11' }); ok('the pallet on HOLD is refused by ShipBay', held.status === 409 && held.error === 'refused_by_shipbay' && /on HOLD/.test(held.message), held);
      let s = await snap(); check('none of those refusals wrote anything', [grew(s0, s), s.ops.length], [[0, 0], s0.ops.length]);
      check('Nexus was not asked: P-11 and P-12 are still empty', [(await floor()).at('P-11').used, (await floor()).at('P-12').used], [0, 0]);

      const p1 = await call('floor', 'POST', '/putaway', { psku: M, location: 'P-11' }); check(`put-away ${M} at P-11`, short(p1, 'ok', 'location', 'units_posted'), [200, true, 'P-11', 100]);
      const p2 = await call('floor', 'POST', '/putaway', { psku: R1, location: 'P-13' }); check(`put-away ${R1} at P-13`, short(p2, 'ok', 'location', 'units_posted'), [200, true, 'P-13', 200]);
      const s1 = await snap(); check('two receipts, one per pallet', [grew(s0, s1), row(s1, M), row(s1, R1)], [[2, 300], ['stored', 'P-11', 1, 100, 0, 0, 0, 100], ['stored', 'P-13', 1, 200, 0, 0, 0, 200]]);

      const full = await call('floor', 'POST', '/move', { psku: M, location: 'P-13' }); check('moving onto a position ShipBay itself occupies: Nexus refuses (409 location_full)', short(full, 'error'), [409, 'location_full']);
      const here = await call('floor', 'POST', '/move', { psku: M, location: 'P-11' }); ok('moving to where it already stands is refused', here.status === 409 && /already at P-11/.test(here.message), here);
      const shelf = await call('floor', 'POST', '/move', { psku: M, location: 'A-01' }); ok('moving to a private shelf is refused: not a shared pallet position', shelf.status === 409 && /not a shared pallet position/.test(shelf.message), shelf);
      s = await snap(); check('the refused moves changed no position and wrote no stock', [grew(s1, s), row(s, M)], [[0, 0], ['stored', 'P-11', 1, 100, 0, 0, 0, 100]]);

      const mv = await call('floor', 'POST', '/move', { psku: M, location: 'P-12' }); check(`move ${M} P-11 to P-12`, short(mv, 'ok', 'from', 'location'), [200, true, 'P-11', 'P-12']);
      const s2 = await snap();
      check('the move wrote one transfer pair and changed no quantity', grew(s1, s2), [2, 0]);
      check(`${M}: still one receipt of 100, no adjustment, two transfer rows that net to zero, 100 on the books`, row(s2, M), ['stored', 'P-12', 1, 100, 0, 2, 0, 100]);
      check('SYN-LP-001 stock: 100 at P-01 (untouched) and 100 at P-12, nothing left at P-11', stock(s2, 'SYN-LP-001'), { 'P-01': 100, 'P-12': 100 });
      const { f, at } = await floor(); check('Nexus: P-11 is free, P-12 holds the pallet', [at('P-11'), at('P-12')], [{ mine: [], used: 0 }, { mine: [M], used: 1 }]);
      check('Nexus holds exactly ShipBay\'s three pallets', mineInNexus(f), { 'P-01': [KEEP.psku], 'P-12': [M], 'P-13': [R1] });
      const again = await call('floor', 'POST', '/move', { psku: M, location: 'P-12' }); ok('the same move scanned again is refused', again.status === 409 && /already at P-12/.test(again.message), again);
      const s3 = await snap(); check('and wrote nothing', grew(s2, s3), [0, 0]);
      check(`${M}'s accepted requests: one put-away, one move`, ops(s3, M).filter((o) => o.state === 'done').map((o) => [o.kind, o.from, o.to, o.attempts]), [['assign', null, 'P-11', 1], ['move', 'P-11', 'P-12', 1]]);
      check('the refused move is on record as refused', ops(s3, M).filter((o) => o.state === 'refused').map((o) => [o.kind, o.to, o.http, o.error]), [['move', 'P-13', 409, 'location_full']]);
      ledgerRules(s3, 'after the move stage'); await keepIntact('after');
    },

    // ---- 2. releasing a pallet that has physically left its position ----
    async release() {
      const s0 = await keepIntact('before'); const c = cast(s0); const R1 = c.R1.psku, R2 = c.R2.psku;
      check('start: one pallet stands at P-13, the other is open', [[c.R1.status, c.R1.location], [c.R2.status, c.R2.location]], [['stored', 'P-13'], ['open', null]]);
      const body = (psku, location, reason, confirmed = true) => ({ psku, location, reason, ...(confirmed ? { confirmed: true } : {}) });
      await noSignIn('/release', body(R1, 'P-13', 'moved_off_shared_floor'));
      check('a release without the confirmation made at the position is refused (400)', short(await call('floor', 'POST', '/release', body(R1, 'P-13', 'moved_off_shared_floor', false)), 'error'), [400, 'not_confirmed']);
      const why = await call('floor', 'POST', '/release', { psku: R1, location: 'P-13', confirmed: true }); ok('a release without a reason is refused', why.status === 409 && /Say why/.test(why.message), why);
      const wrong = await call('floor', 'POST', '/release', body(R1, 'P-14', 'moved_off_shared_floor')); ok('a release naming the wrong position is refused', wrong.status === 409 && /at P-13, not P-14/.test(wrong.message), wrong);
      const forced = await call('floor', 'POST', '/release', body(R1, 'P-13', 'correction')); ok('the floor login cannot force a correction', forced.status === 409 && /admin or staff/.test(forced.message), forced);
      let s = await snap(); check('the refused releases changed nothing', [grew(s0, s), row(s, R1)], [[0, 0], ['stored', 'P-13', 1, 200, 0, 0, 0, 200]]);
      check('and P-13 is still held in Nexus', (await floor()).at('P-13'), { mine: [R1], used: 1 });

      // a) off the shared floor, still in ShipBay's custody: stock is kept and follows the pallet to the holding location
      const off = await call('floor', 'POST', '/release', body(R1, 'P-13', 'moved_off_shared_floor')); check(`release ${R1} from P-13 (moved off the shared floor)`, short(off, 'ok', 'pallet_status', 'from'), [200, true, 'off_floor', 'P-13']);
      const s1 = await snap();
      check('the release wrote one transfer pair and changed no quantity', grew(s0, s1), [2, 0]);
      check(`${R1}: off the floor, no position shown, one receipt, no adjustment, 200 still on the books`, row(s1, R1), ['off_floor', null, 1, 200, 0, 2, 0, 200]);
      check('its 200 units are at OFF-FLOOR and no longer at P-13', stock(s1, 'SYN-LP-002'), { 'OFF-FLOOR': 200 });
      check('where it stood is kept in the log', s1.left_floor_log.filter((x) => x.psku === R1).map((x) => [x.from, x.reason, Number(x.units_on_books)]), [['P-13', 'moved_off_shared_floor', 200]]);
      check('Nexus: P-13 is free', (await floor()).at('P-13'), { mine: [], used: 0 });
      const twice = await call('floor', 'POST', '/release', body(R1, 'P-13', 'moved_off_shared_floor')); ok('a second release of the same pallet is refused', twice.status === 409 && /already left the shared floor/.test(twice.message), twice);
      // back onto the floor: a transfer from the holding location, never a second receipt
      const back = await call('floor', 'POST', '/putaway', { psku: R1, location: 'P-13' }); check(`${R1} comes back to P-13`, short(back, 'ok', 'location', 'pallet_status'), [200, true, 'P-13', 'stored']);
      const s2 = await snap();
      check('coming back wrote one transfer pair and no receipt', [grew(s1, s2), s2.by_reason.receive.rows - s1.by_reason.receive.rows], [[2, 0], 0]);
      check(`${R1}: stored at P-13 again, still ONE receipt of 200, four transfer rows that net to zero`, row(s2, R1), ['stored', 'P-13', 1, 200, 0, 4, 0, 200]);
      check('its 200 units are back at P-13 and OFF-FLOOR is empty', stock(s2, 'SYN-LP-002'), { 'P-13': 200 });

      // b) gone from the building, and the answer to the release is lost on the way back
      const put = await call('floor', 'POST', '/putaway', { psku: R2, location: 'P-14' }); check(`put-away ${R2} at P-14`, short(put, 'ok', 'location', 'units_posted'), [200, true, 'P-14', 200]);
      const s3 = await snap();
      const lost = await lossy('floor', '/release', body(R2, 'P-14', 'shipped_out')); check('the bridge reports that nothing is confirmed (503, pending)', short(lost, 'error', 'pending'), [503, 'nexus_no_answer', true]);
      s = await snap(); check('ShipBay still shows the pallet at P-14 and wrote nothing', [grew(s3, s), row(s, R2)], [[0, 0], ['stored', 'P-14', 1, 200, 0, 0, 0, 200]]);
      check('Nexus already freed P-14', (await floor()).at('P-14'), { mine: [], used: 0 });
      check('the release is listed as waiting', (await call('floor', 'GET', '/pending')).open.map((o) => [o.pallet, o.kind, o.from, o.state]), [[R2, 'release', 'P-14', 'pending']]);
      const sent = await call('floor', 'POST', '/release', body(R2, 'P-14', 'shipped_out')); check('the same release sent again: Nexus replays its answer, ShipBay records it once', short(sent, 'ok', 'replayed', 'pallet_status'), [200, true, true, 'departed']);
      ok('the answer says the 200 units are still on the books', /200 units are still on the books at P-14/.test(String(sent.note)), sent.note);
      const s4 = await snap();
      check('the release deducted nothing and wrote nothing to the ledger', grew(s3, s4), [0, 0]);
      check(`${R2}: departed, no position shown, one receipt, no adjustment, no transfer, 200 still on the books`, row(s4, R2), ['departed', null, 1, 200, 0, 0, 0, 200]);
      check('one release request, sent twice with one key', ops(s4, R2).filter((o) => o.kind === 'release').map((o) => [o.state, o.reason, o.confirmed, o.attempts]), [['done', 'shipped_out', true, 2]]);
      check('the units left on the books are flagged on the request', /still on the books/.test(String(ops(s4, R2).find((o) => o.kind === 'release').problem)), true);
      const gone = await call('floor', 'POST', '/putaway', { psku: R2, location: 'P-14' }); ok('a departed pallet cannot be put away again', gone.status === 409 && /left the building/.test(gone.message), gone);
      const rel2 = await call('floor', 'POST', '/release', body(R2, 'P-14', 'shipped_out')); ok('and cannot be released again', rel2.status === 409 && /already left the shared floor/.test(rel2.message), rel2);
      const s5 = await snap(); check('neither wrote anything', grew(s4, s5), [0, 0]);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      ledgerRules(s5, 'after the release stage'); await keepIntact('after');
    },

    // ---- 3. Nexus applied the request but its answer never arrived ----
    async lost() {
      const s0 = await keepIntact('before'); const c = cast(s0); const L = c.L.psku;
      check('start: the pallet is open and unplaced', [c.L.status, c.L.location, Number(c.L.ledger_rows)], ['open', null, 0]);
      check('a test fault asked for by the client login is refused before anything runs (403)', short(await io.lossy('client', 'POST', '/putaway', { psku: L, location: 'P-15' }), 'error'), [403, 'not_staff']);
      ok('and with only the public key', [401, 403].includes((await io.lossy('public', 'POST', '/putaway', { psku: L, location: 'P-15' })).status));
      check('neither left a request behind', [ops(await snap(), L).length, (await floor()).at('P-15').used], [0, 0]);
      const lost = await lossy('floor', '/putaway', { psku: L, location: 'P-15' }); check('put-away, answer lost: the bridge reports that nothing is confirmed (503, pending)', short(lost, 'error', 'pending'), [503, 'nexus_no_answer', true]);
      let s = await snap(); check('ShipBay stored nothing and posted no stock', [grew(s0, s), row(s, L)], [[0, 0], ['open', null, 0, 0, 0, 0, 0, 0]]);
      const key = ops(s, L)[0]?.key; check('one request is on record, waiting', ops(s, L).map((o) => [o.kind, o.state, o.to, o.attempts, o.http]), [['assign', 'pending', 'P-15', 1, 0]]);
      check('Nexus already holds P-15 for the pallet', (await floor()).at('P-15'), { mine: [L], used: 1 });
      check('the request is listed as waiting', (await call('floor', 'GET', '/pending')).open.map((o) => [o.pallet, o.kind, o.to, o.state]), [[L, 'assign', 'P-15', 'pending']]);
      const other = await call('floor', 'POST', '/putaway', { psku: L, location: 'P-16' }); ok('scanning a different position while one is waiting is refused', other.status === 409 && /already has a request for P-15/.test(other.message), other);
      const done = await call('floor', 'POST', '/putaway', { psku: L, location: 'P-15' }); check('the same scan again: Nexus replays its answer and the pallet is stored once', short(done, 'ok', 'replayed', 'location', 'units_posted'), [200, true, true, 'P-15', 200]);
      const s1 = await snap();
      check('exactly one receipt of 200 was posted', [grew(s0, s1), row(s1, L)], [[1, 200], ['stored', 'P-15', 1, 200, 0, 0, 0, 200]]);
      check('one request, one key, sent twice', ops(s1, L).map((o) => [o.kind, o.state, o.attempts, o.key === key]), [['assign', 'done', 2, true]]);
      check('Nexus still holds exactly that one pallet at P-15', (await floor()).at('P-15'), { mine: [L], used: 1 });
      const third = await call('floor', 'POST', '/putaway', { psku: L, location: 'P-15' }); ok('a third scan is refused: already put away', third.status === 409 && /already put away/.test(third.message), third);
      s = await snap(); check('and posted nothing', grew(s1, s), [0, 0]);

      // the same on a move, finished by the bridge's own retry run instead of a re-scan
      const mv = await lossy('floor', '/move', { psku: L, location: 'P-16' }); check('move, answer lost (503, pending)', short(mv, 'error', 'pending'), [503, 'nexus_no_answer', true]);
      s = await snap(); check('ShipBay still shows P-15 and moved no stock', [grew(s1, s), row(s, L), stock(s, 'SYN-LP-002')['P-15']], [[0, 0], ['stored', 'P-15', 1, 200, 0, 0, 0, 200], 200]);
      let fl = await floor(); check('Nexus already moved it: P-15 free, P-16 held', [fl.at('P-15'), fl.at('P-16')], [{ mine: [], used: 0 }, { mine: [L], used: 1 }]);
      check('the retry run with no sign-in is refused (401)', (await call(null, 'POST', '/pending/retry')).status, 401);
      check('the retry run as the client login is refused (403)', short(await call('client', 'POST', '/pending/retry'), 'error'), [403, 'not_staff']);
      const retry = await call('floor', 'POST', '/pending/retry'); check('the retry run finishes the move', [retry.status, retry.results.map((x) => [x.pallet, x.kind, x.to, x.ok])], [200, [[L, 'move', 'P-16', true]]]);
      const s2 = await snap();
      check('one transfer pair, no quantity change, still one receipt', [grew(s1, s2), row(s2, L)], [[2, 0], ['stored', 'P-16', 1, 200, 0, 2, 0, 200]]);
      check('its 200 units are at P-16 and nothing is left at P-15', [stock(s2, 'SYN-LP-002')['P-16'], stock(s2, 'SYN-LP-002')['P-15'] ?? 0], [200, 0]);
      const again = await call('floor', 'POST', '/pending/retry'); check('a second retry run finds nothing to do', [again.status, again.results], [200, []]);
      const s3 = await snap(); check('and wrote nothing', grew(s2, s3), [0, 0]);
      fl = await floor(); check('Nexus: P-15 free, P-16 held by the pallet', [fl.at('P-15'), fl.at('P-16')], [{ mine: [], used: 0 }, { mine: [L], used: 1 }]);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      ledgerRules(s3, 'after the lost-answer stage'); await keepIntact('after');
    },

    // ---- 4. Nexus accepted, ShipBay could not record it: the position stays reserved until an admin decides at the position ----
    async partial() {
      const s0 = await keepIntact('before'); const c = cast(s0); const F1 = c.F1.psku, F2 = c.F2.psku;
      check('start: both pallets are open and unplaced', [c.F1, c.F2].map((p) => [p.status, p.location, p.held]), [['open', null, false], ['open', null, false]]);
      const waiting = async () => { const r = await call('admin', 'GET', '/reconcile'); return [r.status, r.in_sync, r.differences, r.waiting.map((w) => [w.pallet, w.kind, w.state, w.nexus_has_it_at])]; };
      check('ShipBay and Nexus agree before the faults', await waiting(), [200, true, [], []]);

      // a) the pallet IS standing at the position: an admin confirms it there and ShipBay records what Nexus already holds
      await lossy('floor', '/putaway', { psku: F1, location: 'P-17' });
      await io.faultHold(F1, 'Synthetic: damage found while waiting for Nexus');
      const r1 = await call('floor', 'POST', '/pending/retry'); check('Nexus says yes on the retry, ShipBay cannot record it: reported as out of sync', [r1.status, r1.results.map((x) => [x.pallet, x.kind, x.to, x.ok, x.error])], [200, [[F1, 'assign', 'P-17', false, 'out_of_sync']]]);
      let s = await snap();
      check('ShipBay stored nothing and posted no stock', [grew(s0, s), row(s, F1)], [[0, 0], ['open', null, 0, 0, 0, 0, 0, 0]]);
      check('the request is marked out of sync, with the reason', ops(s, F1).map((o) => [o.kind, o.state, o.http, o.error, /HOLD/.test(String(o.problem))]), [['assign', 'out_of_sync', 200, 'not_recorded', true]]);
      check('the position STAYS reserved in Nexus: nothing released it', (await floor()).at('P-17'), { mine: [F1], used: 1 });
      const scan = await call('floor', 'POST', '/putaway', { psku: F1, location: 'P-19' }); ok('the floor cannot place it elsewhere: it needs an admin', scan.status === 409 && /needs an admin/.test(scan.message), scan);
      check('the retry run leaves it alone', (await call('floor', 'POST', '/pending/retry')).results, []);
      check('the floor login cannot reconcile (403)', short(await call('floor', 'GET', '/reconcile'), 'error'), [403, 'not_admin']);
      check('the client login cannot reconcile (403)', short(await call('client', 'GET', '/reconcile'), 'error'), [403, 'not_staff']);
      check('reconciliation (admin) shows it waiting, with where Nexus has it', await waiting(), [200, false, [], [[F1, 'assign', 'out_of_sync', 'P-17']]]);
      const OP1 = ops(s, F1)[0].op;
      check('recording without the confirmation made at the position is refused (400)', short(await call('admin', 'POST', '/reconcile/record', { op: OP1 }), 'error'), [400, 'not_confirmed']);
      const nf = await call('floor', 'POST', '/reconcile/record', { op: OP1, confirmed: true }); ok('the floor login cannot record it', nf.status === 409 && /Only ShipBay admin or staff/.test(nf.message), nf);
      const stillHeld = await call('admin', 'POST', '/reconcile/record', { op: OP1, confirmed: true }); ok('while the pallet is on HOLD even an admin cannot record it', stillHeld.status === 409 && /HOLD/.test(stillHeld.message), stillHeld);
      s = await snap(); check('none of that changed anything', [grew(s0, s), ops(s, F1).map((o) => o.state), (await floor()).at('P-17')], [[0, 0], ['out_of_sync'], { mine: [F1], used: 1 }]);
      const notAdmin = await refused(() => io.rpc('floor', 'wms_hold_disposition', { p_pallet: c.F1.id, p_action: 'release', p_ref: 'SYN-REHEARSAL' })); ok('the floor login cannot lift the HOLD', /Only a ShipBay admin/.test(String(notAdmin)), notAdmin);
      await io.rpc('admin', 'wms_hold_disposition', { p_pallet: c.F1.id, p_action: 'release', p_ref: 'SYN-REHEARSAL' });
      const rec = await call('admin', 'POST', '/reconcile/record', { op: OP1, confirmed: true }); check('the admin lifts the HOLD and records it', short(rec, 'ok', 'location', 'units_posted'), [200, true, 'P-17', 200]);
      const s1 = await snap();
      check('exactly one receipt of 200 was posted', [grew(s0, s1), row(s1, F1)], [[1, 200], ['stored', 'P-17', 1, 200, 0, 0, 0, 200]]);
      check('the request is closed with who decided and how', ops(s1, F1).map((o) => [o.kind, o.state, o.confirmed, o.resolved_by, /confirmation at the position/.test(String(o.resolution))]), [['assign', 'done', true, 'Test Admin (synthetic)', true]]);
      check('Nexus holds the same one pallet at P-17: recording sent it nothing new', (await floor()).at('P-17'), { mine: [F1], used: 1 });
      check('ShipBay and Nexus agree again', await waiting(), [200, true, [], []]);

      // b) the pallet is NOT at the position: only an admin's confirmed correction frees it, with its own key
      await lossy('floor', '/putaway', { psku: F2, location: 'P-18' });
      await io.rpc('admin', 'wms_void_pallet', { p_id: c.F2.id, p_reason: 'Synthetic: not on the floor' });
      const r2 = await call('floor', 'POST', '/pending/retry'); check('Nexus says yes on the retry, ShipBay cannot record a voided pallet: out of sync', [r2.status, r2.results.map((x) => [x.pallet, x.kind, x.to, x.ok, x.error])], [200, [[F2, 'assign', 'P-18', false, 'out_of_sync']]]);
      s = await snap(); check('ShipBay posted no stock for it', [grew(s1, s), row(s, F2)], [[0, 0], ['void', null, 0, 0, 0, 0, 0, 0]]);
      check('P-18 stays reserved in Nexus', (await floor()).at('P-18'), { mine: [F2], used: 1 });
      check('reconciliation shows it waiting', await waiting(), [200, false, [], [[F2, 'assign', 'out_of_sync', 'P-18']]]);
      const OP2 = ops(s, F2)[0].op;
      const cannot = await call('admin', 'POST', '/reconcile/record', { op: OP2, confirmed: true }); ok('a voided pallet cannot be recorded as standing there', cannot.status === 409 && /voided/.test(cannot.message), cannot);
      check('undoing without the confirmation made at the position is refused (400)', short(await call('admin', 'POST', '/reconcile/undo', { op: OP2 }), 'error'), [400, 'not_confirmed']);
      const nf2 = await call('floor', 'POST', '/reconcile/undo', { op: OP2, confirmed: true }); ok('the floor login cannot undo it', nf2.status === 409 && /Only ShipBay admin or staff/.test(nf2.message), nf2);
      check('P-18 is still reserved after those refusals', (await floor()).at('P-18'), { mine: [F2], used: 1 });
      const undo = await call('admin', 'POST', '/reconcile/undo', { op: OP2, confirmed: true }); check('the admin confirms it is not there: the correction is accepted by Nexus', short(undo, 'ok', 'kind', 'reason'), [200, true, 'release', 'correction']);
      const s2 = await snap(); const o2 = ops(s2, F2);
      check('the original request is closed as undone and the correction names it', o2.map((o) => [o.kind, o.state, o.reason, o.confirmed, o.fixes === OP2]), [['assign', 'undone', null, false, false], ['release', 'done', 'correction', true, true]]);
      ok('the correction used its own key', o2[1].key !== o2[0].key && /^SB-FIX-/.test(o2[1].key), [o2[0].key, o2[1].key]);
      check('no stock was ever posted for the voided pallet', [grew(s1, s2), row(s2, F2)], [[0, 0], ['void', null, 0, 0, 0, 0, 0, 0]]);
      check('Nexus: P-18 is free', (await floor()).at('P-18'), { mine: [], used: 0 });
      check('ShipBay and Nexus agree again', await waiting(), [200, true, [], []]);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      ledgerRules(s2, 'after the partial-failure stage'); await keepIntact('after');
    },

    // ---- 5. a part-picked pallet is moved, then the pick is reopened ----
    async picks() {
      const s0 = await keepIntact('before'); const c = cast(s0); const G = c.G.psku;
      check('start: the pallet is open and the order is new', [c.G.status, c.G.location, s0.orders.map((o) => o.status)], ['open', null, ['new']]);
      const put = await call('floor', 'POST', '/putaway', { psku: G, location: 'P-19' }); check(`put-away ${G} at P-19`, short(put, 'ok', 'location', 'units_posted'), [200, true, 'P-19', 1000]);
      const no = await refused(() => io.rpc('client', 'wms_wave_start', { p_org: ORG_MAILERS })); ok('the client login cannot start a pick', /cannot work orders/.test(String(no)), no);
      const w = (await io.rpc('floor', 'wms_wave_start', { p_org: ORG_MAILERS })).wave;
      check('the pick is routed to the pallet at P-19', (w?.tasks || []).map((t) => [t.location, t.sku, t.qty_planned, t.psku]), [['P-19', 'SYN-MLR-S', 40, G]]);
      const task = w.tasks[0].id;
      await io.rpc('floor', 'wms_wave_confirm', { p_task: task, p_qty: 40, p_scan: c.G.carton });
      const s1 = await snap(); check('40 picked: 960 left at P-19', [stock(s1, 'SYN-MLR-S'), s1.by_sku['SYN-MLR-S']], [{ 'P-19': 960 }, 960]);
      const mv = await call('floor', 'POST', '/move', { psku: G, location: 'P-20' }); check(`move the part-picked ${G} P-19 to P-20`, short(mv, 'ok', 'from', 'location'), [200, true, 'P-19', 'P-20']);
      const s2 = await snap();
      check('the move carried what is really left: nothing at P-19, 960 at P-20, total unchanged', [stock(s2, 'SYN-MLR-S'), s2.by_sku['SYN-MLR-S'], grew(s1, s2)[1]], [{ 'P-20': 960 }, 960, 0]);
      check(`${G}: still one receipt of 1000, no adjustment, transfers net to zero`, [pal(s2, G).status, pal(s2, G).location, Number(pal(s2, G).receipts), Number(pal(s2, G).received_units), Number(pal(s2, G).adjustments), Number(pal(s2, G).transfer_net), Number(pal(s2, G).on_books)], ['stored', 'P-20', 1, 1000, 0, 0, 960]);
      await io.rpc('floor', 'wms_wave_unconfirm', { p_task: task });
      const s3 = await snap();
      check('reopening the pick puts the 40 back where the pallet stands NOW (P-20), not at P-19', [stock(s3, 'SYN-MLR-S'), s3.by_sku['SYN-MLR-S']], [{ 'P-20': 1000 }, 1000]);
      const fl = await floor(); check('Nexus: P-19 free, P-20 held by the pallet', [fl.at('P-19'), fl.at('P-20')], [{ mine: [], used: 0 }, { mine: [G], used: 1 }]);
      ledgerRules(s3, 'after the pick stage'); await keepIntact('after');
    },

    // ---- 6. a planned pick follows its pallet; nothing is picked, reopened or released while Nexus has not settled a move ----
    async stops() {
      const s0 = await keepIntact('before'); const c = cast(s0); const G = c.G.psku;
      check('start: the pallet stands at P-20 with all 1000 units', [c.G.status, c.G.location, stock(s0, 'SYN-MLR-S')], ['stored', 'P-20', { 'P-20': 1000 }]);
      const wave = async () => (await io.rpc('floor', 'wms_wave_start', { p_org: ORG_MAILERS })).wave;
      const stopNow = async () => (await wave()).tasks.map((t) => [t.location, t.qty_planned, t.psku, t.confirmed]);
      const w = await wave(); check('start: the reopened pick is planned at P-20 and not yet picked', w.tasks.map((t) => [t.location, t.qty_planned, t.psku, t.confirmed]), [['P-20', 40, G, false]]); const task = w.tasks[0].id;
      const rel = await call('floor', 'POST', '/release', { psku: G, location: 'P-20', reason: 'moved_off_shared_floor', confirmed: true });
      ok('a pallet with a pick planned from it cannot be released (ShipBay refuses, Nexus is not asked)', rel.status === 409 && rel.error === 'refused_by_shipbay' && /still has a pick planned/.test(rel.message), rel);
      check('Nexus still holds P-20 for it', (await floor()).at('P-20'), { mine: [G], used: 1 });
      const mv = await call('floor', 'POST', '/move', { psku: G, location: 'P-19' }); check(`move ${G} P-20 to P-19 with the pick still planned`, short(mv, 'ok', 'from', 'location'), [200, true, 'P-20', 'P-19']);
      check('the planned stop followed the pallet to P-19', await stopNow(), [['P-19', 40, G, false]]);
      let s = await snap(); check('all 1000 units are at P-19', [stock(s, 'SYN-MLR-S'), grew(s0, s)], [{ 'P-19': 1000 }, [2, 0]]);
      // a move Nexus has applied but ShipBay has not heard about: nothing may be picked from the pallet until it is settled
      const back = await lossy('floor', '/move', { psku: G, location: 'P-20' }); check('move back, answer lost (503, pending)', short(back, 'error', 'pending'), [503, 'nexus_no_answer', true]);
      const early = await refused(() => io.rpc('floor', 'wms_wave_confirm', { p_task: task, p_qty: 40, p_scan: c.G.carton })); ok('the stop cannot be picked while the move is not settled', /waiting for Nexus/.test(String(early)), early);
      const s1 = await snap(); check('nothing was picked and nothing moved in ShipBay', [stock(s1, 'SYN-MLR-S'), grew(s, s1)], [{ 'P-19': 1000 }, [0, 0]]);
      const r1 = await call('floor', 'POST', '/pending/retry'); check('the retry run settles the move', [r1.status, r1.results.map((x) => [x.pallet, x.kind, x.to, x.ok])], [200, [[G, 'move', 'P-20', true]]]);
      check('the planned stop followed the pallet back to P-20', await stopNow(), [['P-20', 40, G, false]]);
      await io.rpc('floor', 'wms_wave_confirm', { p_task: task, p_qty: 40, p_scan: c.G.carton });
      s = await snap(); check('40 picked at P-20: 960 left there', stock(s, 'SYN-MLR-S'), { 'P-20': 960 });
      const away = await lossy('floor', '/move', { psku: G, location: 'P-19' }); check('move again, answer lost (503, pending)', short(away, 'error', 'pending'), [503, 'nexus_no_answer', true]);
      const reopen = await refused(() => io.rpc('floor', 'wms_wave_unconfirm', { p_task: task })); ok('the pick cannot be reopened while the move is not settled', /waiting for Nexus/.test(String(reopen)), reopen);
      const s2 = await snap(); check('nothing was put back', [stock(s2, 'SYN-MLR-S'), grew(s, s2)], [{ 'P-20': 960 }, [0, 0]]);
      const r2 = await call('floor', 'POST', '/pending/retry'); check('the retry run settles it', [r2.status, r2.results.map((x) => [x.pallet, x.kind, x.to, x.ok])], [200, [[G, 'move', 'P-19', true]]]);
      s = await snap(); check('the move carried the 960 really left; nothing remains at P-20', stock(s, 'SYN-MLR-S'), { 'P-19': 960 });
      const home = await call('floor', 'POST', '/move', { psku: G, location: 'P-20' }); check(`move ${G} back to P-20`, short(home, 'ok', 'from', 'location'), [200, true, 'P-19', 'P-20']);
      await io.rpc('floor', 'wms_wave_unconfirm', { p_task: task });
      const s3 = await snap();
      check('reopened: the 40 are back at P-20, where the pallet stands, and the stop is planned there again', [stock(s3, 'SYN-MLR-S'), s3.by_sku['SYN-MLR-S'], await stopNow()], [{ 'P-20': 1000 }, 1000, [['P-20', 40, G, false]]]);
      check(`${G}: still one receipt of 1000, no adjustment, transfers net to zero, 1000 on the books`, [pal(s3, G).status, pal(s3, G).location, Number(pal(s3, G).receipts), Number(pal(s3, G).received_units), Number(pal(s3, G).adjustments), Number(pal(s3, G).transfer_net), Number(pal(s3, G).on_books)], ['stored', 'P-20', 1, 1000, 0, 0, 1000]);
      const fl = await floor(); check('Nexus: P-19 free, P-20 held by the pallet', [fl.at('P-19'), fl.at('P-20')], [{ mine: [], used: 0 }, { mine: [G], used: 1 }]);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      ledgerRules(s3, 'after the planned-stop stage'); await keepIntact('after');
    },

    // ---- 7. read-only: the end state, in ShipBay and in Nexus ----
    async final() {
      const s = await keepIntact('at the end'); const c = cast(s); const { f } = await floor();
      check('every pallet is where the suite left it', Object.fromEntries(Object.entries(c).map(([k, p]) => [k, [p.status, p.location, p.held]])),
        { M: ['stored', 'P-12', false], HELD: ['open', null, true], R1: ['stored', 'P-13', false], R2: ['departed', null, false], L: ['stored', 'P-16', false], F1: ['stored', 'P-17', false], F2: ['void', null, false], G: ['stored', 'P-20', false] });
      check('Nexus holds exactly these ShipBay pallets', mineInNexus(f), { 'P-01': [KEEP.psku], 'P-12': [c.M.psku], 'P-13': [c.R1.psku], 'P-16': [c.L.psku], 'P-17': [c.F1.psku], 'P-20': [c.G.psku] });
      check('the positions the suite freed are empty in Nexus', ['P-11', 'P-14', 'P-15', 'P-18', 'P-19'].filter((p) => (f.locations.find((l) => l.code === p)?.used || 0) !== 0), []);
      check('receipts: seven pallets were ever put away, one receipt each, 2000 units in all', s.by_reason.receive, { rows: 7, units: 2000 });
      check('transfers net to zero across the ledger', s.by_reason.transfer.units, 0);
      check('units on the books by product', s.by_sku, { 'SYN-LP-001': 200, 'SYN-LP-002': 800, 'SYN-MLR-S': 1000 });
      check('the only stock standing where no pallet stands is the departed pallet\'s 200 at P-14, which is flagged', stock(s, 'SYN-LP-002')['P-14'], 200);
      check('the pallet that never reached Nexus has no request on record', ops(s, c.HELD.psku).filter((o) => o.state !== 'refused').length, 0);
      const rec = await call('admin', 'GET', '/reconcile'); check('ShipBay and Nexus agree', [rec.status, rec.in_sync, rec.placed_in_nexus, rec.differences, rec.waiting], [200, true, 6, [], []]);
      check('nothing is waiting for Nexus', (await call('floor', 'GET', '/pending')).open, []);
      ledgerRules(s, 'at the end'); check('the final stage sent no write', mutating, 0);
    },
  };

  if (!stages[stage]) return { stage, ok: false, error: 'unknown_stage', stages: STAGES };
  let stopped = null;
  try { await stages[stage](); } catch (e) { stopped = e instanceof Stop ? e.message : `the stage threw: ${String(e?.message || e).slice(0, 300)}`; }
  const failed = checks.filter((x) => !x.pass);
  return { stage, ok: !stopped && failed.length === 0, passed: checks.filter((x) => x.pass).length, failed: failed.length, writes_sent: mutating, stopped_at: stopped, checks };
}
