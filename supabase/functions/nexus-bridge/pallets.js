// Put-away and moves. Order of work, every time:
//   1. ShipBay's own rules (wms_putaway_begin / wms_move_begin, as the signed-in user). A refusal here never reaches Nexus.
//   2. Nexus decides whether the position is free (POST /v1/pallets/assign|move with the journal row's Idempotency-Key).
//   3. Only on Nexus's yes is the pallet stored in ShipBay (wms_nexus_op_commit, as the bridge).
// No answer from Nexus leaves the request pending and changes nothing in ShipBay; the same scan re-sends the same key.
// If Nexus said yes and ShipBay then cannot record it, the bridge gives the position back in Nexus.
import { inWords } from './core.js';

const clean = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 64 ? v.trim() : null);
const undoOf = (op) => (op.kind === 'assign' ? { path: '/v1/pallets/release', body: { pallet: op.pallet, from: op.to } } : { path: '/v1/pallets/move', body: { pallet: op.pallet, to: op.from, from: op.to } });

async function send(ctx, op) {
  const { nx, service } = ctx;
  const r = await nx.call('POST', `/v1/pallets/${op.kind}`, { idem: op.key, body: op.kind === 'assign' ? { pallet: op.pallet, to: op.to } : { pallet: op.pallet, to: op.to, from: op.from } });
  if (r.status === 200 && r.body.ok) {
    try {
      const done = await service.rpc('wms_nexus_op_commit', { p_op: op.op });
      return { status: 200, body: { ok: true, ...done, replayed: r.body.replayed === true } };
    } catch (e) {
      // Nexus holds the position, ShipBay could not record it (for example the pallet was put on hold in between): give it back.
      const u = undoOf(op); const back = await nx.call('POST', u.path, { idem: `${op.key}:undo`, body: u.body }); const undone = back.status === 200 && back.body.ok;
      await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: undone ? 'reverted' : 'stuck', p_http: back.status, p_error: undone ? 'not_recorded' : 'undo_failed', p_note: String(e?.message || '').slice(0, 300) });
      return undone
        ? { status: 409, body: { ok: false, error: 'not_recorded', message: `${String(e?.message || 'ShipBay could not record it.')} The position was given back in Nexus. Nothing was stored.` } }
        : { status: 409, body: { ok: false, error: 'needs_admin', message: `Nexus has ${op.pallet} at ${op.to} but ShipBay could not record it, and the position could not be given back. Leave the pallet where it is and tell an admin.` } };
    }
  }
  if (r.status === 0 || r.status === 429 || r.status >= 500) {
    await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: 'pending', p_http: r.status, p_error: r.body.error || 'no_answer' });
    return { status: 503, body: { ok: false, error: 'nexus_no_answer', pending: true, message: `Nexus did not answer. ${op.pallet} is NOT put away yet. Scan it and ${op.to} again to retry.` } };
  }
  await service.rpc('wms_nexus_op_note', { p_op: op.op, p_state: 'refused', p_http: r.status, p_error: r.body.error || 'refused' });
  return { status: r.status, body: { ok: false, error: r.body.error || 'refused', message: inWords(r.body.error, op) } };
}

async function place(kind, ctx) {
  const { cfg, nx, user, body, send: out, fail } = ctx;
  if (!cfg.palletMoves) return fail(503, 'pallet_moves_off', 'Put-away through Nexus is switched off here.');
  const psku = clean(body.psku), location = clean(body.location);
  if (!psku || !location) return fail(400, 'bad_request', 'Scan the pallet label and the position.');
  const floor = await nx.floorIsExpected();
  if (floor === null) return fail(503, 'nexus_no_answer', 'Nexus did not answer. Nothing was changed. Try again.');
  if (!floor) return fail(502, 'not_the_expected_floor', 'ShipBay\'s Nexus key is not bound to the floor this build expects. Nothing was sent.');
  let op; try { op = await user.rpc(kind === 'assign' ? 'wms_putaway_begin' : 'wms_move_begin', { p_psku: psku, p_location: location }); }
  catch (e) { return fail(409, 'refused_by_shipbay', String(e?.message || 'ShipBay refused the request.')); }
  const r = await send(ctx, op); return out(r.body, r.status);
}

export const palletRoutes = [
  { method: 'POST', match: /^\/putaway$/, run: (ctx) => place('assign', ctx) },
  { method: 'POST', match: /^\/move$/, run: (ctx) => place('move', ctx) },
  // What Nexus says about the floor, for the put-away screen: each position's capacity, how many stand there, which companies, and ShipBay's own pallet ids. Nexus gives no other company's ids.
  { method: 'GET', match: /^\/floor$/, run: async ({ nx, send: out, fail }) => {
    const [m, o] = await Promise.all([nx.call('GET', '/v1/map'), nx.call('GET', '/v1/occupancy')]);
    if (m.status !== 200 || o.status !== 200) return fail(m.status === 0 || o.status === 0 ? 503 : 502, 'nexus_no_answer', 'Nexus did not answer.');
    return out({ ok: true, warehouse: m.body.warehouse, map_version: m.body.map_version, checksum: m.body.checksum, occupancy_state: m.body.occupancy_state, moves_enabled: m.body.moves_enabled,
      layout: m.body.layout, landmarks: m.body.landmarks, positions: m.body.positions, locations: o.body.locations });
  } },
  // Requests Nexus has not answered. GET lists them; POST re-sends each with its original key (safe to repeat).
  { method: 'GET', match: /^\/pending$/, run: async ({ user, send: out }) => out({ ok: true, open: await user.rpc('wms_nexus_ops_open', {}) }) },
  { method: 'POST', match: /^\/pending\/retry$/, run: async (ctx) => {
    if (!ctx.cfg.palletMoves) return ctx.fail(503, 'pallet_moves_off', 'Put-away through Nexus is switched off here.');
    if (!(await ctx.nx.floorIsExpected())) return ctx.fail(503, 'nexus_no_answer', 'Nexus did not answer. Nothing was changed.');
    const open = await ctx.service.rpc('wms_nexus_ops_pending', {}); const results = [];
    for (const o of open) { const r = await send(ctx, o); results.push({ pallet: o.pallet, to: o.to, ok: r.body.ok, error: r.body.error || null }); }
    return ctx.send({ ok: true, results });
  } },
];
