// Put-away, moves, releases and reconciliation. Order of work, every time:
//   1. ShipBay's own rules (the *_begin functions, as the signed-in user). A refusal here never reaches Nexus.
//   2. Nexus decides (POST /v1/pallets/assign | move | release with the journal row's Idempotency-Key).
//   3. Only on Nexus's yes is the result recorded in ShipBay (wms_nexus_op_commit, as the bridge).
// No answer from Nexus: the request stays pending and nothing changes in ShipBay; sending again re-sends the same key.
// Nexus said yes and ShipBay cannot record it: the request is marked out of sync and the position STAYS RESERVED in Nexus.
// This file never releases a position on its own. A release happens only when a person confirms, at the position, that the
// pallet is not standing there (routes /release and /reconcile/undo).
import { inWords } from './core.js';

const clean = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 64 ? v.trim() : null);
// The real floor (forward-only) takes a pallet into a position only with the floor's confirmation that it is physically empty:
// confirmed_empty: true and confirmed_by: who checked (2 to 80 characters). ShipBay sends it only for a request whose employee
// confirmed at the position (the bridge refuses /putaway and /move on the real floor without it), naming that employee.
const confirmer = (op) => { const n = String(op.by || '').trim().slice(0, 80); return n.length >= 2 ? n : 'ShipBay floor staff'; };
const nexusBody = (op, cfg = {}) => {
  const b = op.kind === 'assign' ? { pallet: op.pallet, to: op.to } : op.kind === 'move' ? { pallet: op.pallet, to: op.to, from: op.from } : { pallet: op.pallet, from: op.from };
  if (cfg.mode === 'production' && op.kind !== 'release') { b.confirmed_empty = true; b.confirmed_by = confirmer(op); }
  return b;
};
export { nexusBody };
const where = (op) => op.to || op.from;

async function send(ctx, op) {
  const { nx, service } = ctx;
  // checked again at the last moment. A refusal here leaves ShipBay's journal exactly as it is (the request may have been sent
  // before, with its answer lost, so it is never marked refused here): it waits until a new authorization covers it.
  const stop = ctx.authorize({ pallet: op.pallet, positions: [op.to, op.from] });
  if (stop) return { status: stop.status, body: { ok: false, error: stop.error, op: op.op, waiting: true, message: `${stop.message} The request for ${op.pallet} at ${where(op)} stays waiting in ShipBay.` } };
  const lose = !!(ctx.fault && ctx.fault.lose); if (lose) ctx.fault.lose = false;   // a test fault drops one answer, once (see core.js)
  const r = await nx.call('POST', `/v1/pallets/${op.kind}`, { idem: op.key, body: nexusBody(op, ctx.cfg), lose });
  if (r.status === 200 && r.body.ok) {
    try {
      const done = await service.rpc('wms_nexus_op_commit', { p_op: op.op });
      return { status: 200, body: { ok: true, ...done, replayed: r.body.replayed === true } };
    } catch (e) {
      // Nexus holds it; ShipBay could not record it (for example the pallet was put on hold in between). Keep the reservation, record the problem.
      const why = String(e?.message || 'ShipBay could not record it.').slice(0, 300);
      try { await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: 'out_of_sync', p_http: 200, p_error: 'not_recorded', p_problem: why }); } catch { /* the journal row stays pending: the retry run will meet Nexus's replay and try again */ }
      return { status: 409, body: { ok: false, error: 'out_of_sync', op: op.op, message: `Nexus accepted ${op.pallet} at ${where(op)}, but ShipBay could not record it: ${why} The position stays reserved in Nexus. Leave the pallet where it is and tell an admin.` } };
    }
  }
  if (r.status === 0 || r.status === 429 || r.status >= 500) {
    await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: 'pending', p_http: r.status, p_error: r.body.error || 'no_answer' });
    return { status: 503, body: { ok: false, error: 'nexus_no_answer', pending: true, op: op.op, message: `Nexus did not answer. Nothing is confirmed for ${op.pallet} at ${where(op)}. Send it again.`, ...(r.lost ? { test_fault: 'answer_lost' } : {}) } };
  }
  await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: 'refused', p_http: r.status, p_error: r.body.error || 'refused' });
  return { status: r.status, body: { ok: false, error: r.body.error || 'refused', nexus_http: r.status, request: op.key, message: inWords(r.body.error, { pallet: op.pallet, to: where(op), http: r.status, request: op.key }) } };
}

// before any write: the switch is on and Nexus itself says this key is bound to the expected floor
async function ready(ctx, scope = {}) {
  if (!ctx.cfg.palletMoves) return ctx.fail(503, 'pallet_moves_off', 'Placing and releasing pallets through Nexus is switched off here.');
  const stop = ctx.authorize({ ...scope, floorCodesOnly: true }); if (stop) return ctx.fail(stop.status, stop.error, stop.message);
  const floor = await ctx.nx.floorIsExpected();
  if (floor === null) return ctx.fail(503, 'nexus_no_answer', 'Nexus did not answer. Nothing was changed. Try again.');
  if (!floor) return ctx.fail(502, 'not_the_expected_floor', 'ShipBay\'s Nexus key is not bound to the floor this build expects. Nothing was sent.');
  return null;
}
async function request(ctx, fn, args, scope) {
  const stop = await ready(ctx, scope); if (stop) return stop;
  let op; try { op = await ctx.user.rpc(fn, args); } catch (e) { return ctx.fail(409, 'refused_by_shipbay', String(e?.message || 'ShipBay refused the request.')); }
  const r = await send(ctx, op); return ctx.send(r.body, r.status);
}
// The real floor starts blank: a position may hold stock that is not on any system, so every placement there needs the employee's
// confirmation, at the position, that it is physically empty. Refused before ShipBay's journal or Nexus is touched.
const unconfirmed = (ctx) => (ctx.cfg.mode === 'production' && ctx.body.confirmed_clear !== true
  ? ctx.fail(400, 'location_not_confirmed', 'Look at the position and confirm it is physically empty before placing a pallet there. Nothing was sent.') : null);
const scans = (ctx) => { const psku = clean(ctx.body.psku), location = clean(ctx.body.location); return psku && location ? { psku, location } : null; };

// ShipBay's journal next to Nexus's occupancy. Admin or staff only. Read-only: it reports, it corrects nothing.
async function reconcile({ nx, user, send: out, fail }) {
  if (!(await user.rpc('wms_nexus_admin', {}))) return fail(403, 'not_admin', 'Only ShipBay admin or staff can reconcile occupancy.');
  const o = await nx.call('GET', '/v1/occupancy'); if (o.status !== 200 || !o.body.ok) return fail(o.status === 0 ? 503 : 502, 'nexus_no_answer', 'Nexus did not answer. Nothing was compared.');
  const [journal, open] = [await user.rpc('wms_nexus_journal', {}), await user.rpc('wms_nexus_ops_open', {})];
  const nexus = new Map(); for (const l of o.body.locations || []) for (const p of l.your_pallets || []) nexus.set(String(p).toUpperCase(), l.code);
  const waiting = new Map(open.map((x) => [String(x.pallet).toUpperCase(), x])); const seen = new Set(); const differences = [];
  for (const j of journal) {
    const id = String(j.pallet).toUpperCase(); seen.add(id); const n = nexus.get(id) || null; const w = waiting.get(id) || null;
    if (!w && j.journal !== n) differences.push({ pallet: j.pallet, kind: n === null ? 'shipbay_only' : j.journal === null ? 'nexus_only' : 'different_position', shipbay: j.journal, nexus: n });
    // after a release the pallet row shows no position; a row that still shows one is a difference too
    if (!w && j.pallet_row !== j.journal) differences.push({ pallet: j.pallet, kind: 'pallet_row_differs', shipbay: j.journal, pallet_row: j.pallet_row });
  }
  for (const [id, code] of nexus) if (!seen.has(id) && !waiting.has(id)) differences.push({ pallet: id, kind: 'nexus_only', shipbay: null, nexus: code });
  // what an admin must act on in ShipBay's own records (departed pallets with units on the books, positions held in ShipBay only, ...). Not part of in_sync: that compares positions.
  let exceptions = null; try { exceptions = await user.rpc('wms_nexus_exceptions', {}); } catch { /* the report is not installed on this database */ }
  return out({ ok: true, exceptions, needs_action: exceptions ? Number(exceptions.needs_action || 0) : null, as_of: o.body.as_of || null, warehouse: o.body.warehouse, in_sync: differences.length === 0 && open.length === 0, placed_in_nexus: nexus.size, differences,
    waiting: open.map((x) => ({ op: x.op, kind: x.kind, pallet: x.pallet, to: x.to, from: x.from, state: x.state, problem: x.problem || null, nexus_has_it_at: nexus.get(String(x.pallet).toUpperCase()) || null })) });
}

// Nexus map version 4 → the shape ShipBay's registry function reads. Pallet and staging positions only: the dock is not a position.
export function registrySnapshot(map) {
  const kind = { pallet: 'pallet', staging: 'floor' }; const status = { open: 'active', blocked: 'blocked', unavailable: 'blocked' };
  return { version: map.map_version, checksum: map.checksum, warehouse: map.warehouse,
    locations: (map.positions || []).filter((p) => kind[p.kind]).map((p) => ({ id: p.code, code: p.code, kind: kind[p.kind], zone: p.block || null, capacity: p.capacity ?? null, status: status[p.status] || 'blocked', version: map.map_version })) };
}

export const palletRoutes = [
  { method: 'POST', match: /^\/putaway$/, run: (ctx) => { const s = scans(ctx); if (s && unconfirmed(ctx)) return unconfirmed(ctx); return s ? request(ctx, 'wms_putaway_begin', { p_psku: s.psku, p_location: s.location }, { pallet: s.psku, positions: [s.location] }) : ctx.fail(400, 'bad_request', 'Scan the pallet label and the position.'); } },
  { method: 'POST', match: /^\/move$/, run: (ctx) => { const s = scans(ctx); if (s && unconfirmed(ctx)) return unconfirmed(ctx); return s ? request(ctx, 'wms_move_begin', { p_psku: s.psku, p_location: s.location }, { pallet: s.psku, positions: [s.location] }) : ctx.fail(400, 'bad_request', 'Scan the pallet label and the position.'); } },
  // Explicit release: a person at the position states the pallet is no longer standing there, and says why it left.
  { method: 'POST', match: /^\/release$/, run: (ctx) => { const s = scans(ctx);
    if (!s) return ctx.fail(400, 'bad_request', 'Give the pallet and the position it left.');
    if (ctx.body.confirmed !== true) return ctx.fail(400, 'not_confirmed', 'Confirm at the position that the pallet is no longer standing there.');
    return request(ctx, 'wms_release_begin', { p_psku: s.psku, p_location: s.location, p_reason: clean(ctx.body.reason), p_confirmed: true }, { pallet: s.psku, positions: [s.location] }); } },
  // What Nexus says about the floor, for the put-away screen: each position's capacity, how many stand there, which companies, and ShipBay's own pallet ids. Nexus gives no other company's ids.
  { method: 'GET', match: /^\/floor$/, run: async ({ nx, send: out, fail }) => {
    const [m, o] = await Promise.all([nx.call('GET', '/v1/map'), nx.call('GET', '/v1/occupancy')]);
    if (m.status !== 200 || o.status !== 200) return fail(m.status === 0 || o.status === 0 ? 503 : 502, 'nexus_no_answer', 'Nexus did not answer.');
    return out({ ok: true, warehouse: m.body.warehouse, map_version: m.body.map_version, checksum: m.body.checksum, occupancy_state: m.body.occupancy_state, moves_enabled: m.body.moves_enabled,
      layout: m.body.layout, landmarks: m.body.landmarks, positions: m.body.positions, locations: o.body.locations });
  } },
  // Requests Nexus has not answered. GET lists them (with the ones that need an admin); POST re-sends the unanswered ones with their original keys (safe to repeat).
  { method: 'GET', match: /^\/pending$/, run: async ({ user, send: out }) => out({ ok: true, open: await user.rpc('wms_nexus_ops_open', {}) }) },
  { method: 'POST', match: /^\/pending\/retry$/, run: async (ctx) => {
    const stop = await ready(ctx); if (stop) return stop;
    const results = []; for (const o of await ctx.service.rpc('wms_nexus_ops_pending', {})) { const r = await send(ctx, o); results.push({ pallet: o.pallet, kind: o.kind, to: o.to, from: o.from, ok: r.body.ok, error: r.body.error || null }); }
    return ctx.send({ ok: true, results });
  } },
  { method: 'GET', match: /^\/reconcile$/, run: reconcile },
  // Out of sync, pallet IS at the position (admin confirms there): ShipBay records what Nexus already holds. Nothing is sent to Nexus.
  { method: 'POST', match: /^\/reconcile\/record$/, run: async ({ user, body, send: out, fail }) => {
    if (body.confirmed !== true || !clean(body.op)) return fail(400, 'not_confirmed', 'Confirm at the position that the pallet is standing there.');
    try { return out({ ok: true, ...(await user.rpc('wms_nexus_resolve_record', { p_op: body.op, p_confirmed: true })) }); } catch (e) { return fail(409, 'refused_by_shipbay', String(e?.message || 'ShipBay refused the request.')); }
  } },
  // Out of sync, pallet is NOT at the position (admin confirms there): a corrective request goes to Nexus with its own key.
  { method: 'POST', match: /^\/reconcile\/undo$/, run: (ctx) => (ctx.body.confirmed !== true || !clean(ctx.body.op)
    ? ctx.fail(400, 'not_confirmed', 'Confirm at the position that the pallet is not standing there.') : request(ctx, 'wms_nexus_fix_begin', { p_op: ctx.body.op, p_confirmed: true })) },
  // ShipBay's copy of the position list (P-01..P-66, STG-01, STG-02) from the Nexus map. A report unless the switch is on AND the caller asks to apply.
  { method: 'POST', match: /^\/registry\/sync$/, run: async ({ cfg, nx, user, service, body, send: out, fail }) => {
    if (!(await user.rpc('wms_nexus_admin', {}))) return fail(403, 'not_admin', 'Only ShipBay admin or staff can sync the position list.');
    const m = await nx.call('GET', '/v1/map'); if (m.status !== 200 || !m.body.ok) return fail(m.status === 0 ? 503 : 502, 'nexus_no_answer', 'Nexus did not answer. Nothing was changed.');
    if (m.body.warehouse !== cfg.floor) return fail(502, 'not_the_expected_floor', 'Nothing was changed.');
    const apply = body.apply === true && cfg.registryWrites; const snap = registrySnapshot(m.body);
    const report = await service.rpc('nexus_registry_apply', { p_snapshot: snap, p_dry_run: !apply });
    return out({ ok: true, applied: apply, map_version: snap.version, checksum: snap.checksum, positions: snap.locations.length, report });
  } },
];
