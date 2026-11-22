// Shared dock calendar. Reading: ShipBay's own shipments (private detail, from ShipBay's database as the signed-in user) next
// to the Nexus calendar. Publishing: only what wms_calendar_plan says, and only direction, time, pallets and status.
// A shipment with a date and no confirmed time is never sent: the plan reports it as held and this file skips it.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC = ['id', 'mine', 'company', 'direction', 'starts_at', 'ends_at', 'date', 'time_confirmed', 'pallets', 'status', 'updated_at'];
const slim = (e) => Object.fromEntries(PUBLIC.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
const SENDABLE = ['direction', 'starts_at', 'ends_at', 'pallets', 'status'];

export const calendarRoutes = [
  { method: 'GET', match: /^\/calendar$/, run: async ({ nx, user, query, send, fail }) => {
    const from = query.get('from'), to = query.get('to');
    if (!DAY.test(from || '') || !DAY.test(to || '') || from > to) return fail(400, 'bad_request', 'from and to are dates (YYYY-MM-DD).');
    const shipments = await user.rpc('wms_calendar_shipments', { p_from: from, p_to: to });
    // a day wider on each side in UTC so every Eastern day in the range is covered; the screen places events on their Eastern day
    const pad = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString();
    const r = await nx.call('GET', `/v1/calendar?from=${encodeURIComponent(pad(from, -1))}&to=${encodeURIComponent(pad(to, 2))}`);
    const ok = r.status === 200 && r.body.ok && Array.isArray(r.body.events);
    return send({ ok: true, shipments, nexus: ok ? { ok: true, warehouse: r.body.warehouse, events: r.body.events.map(slim) } : { ok: false, error: r.status === 0 ? 'nexus_no_answer' : r.body.error || 'refused', events: [] } });
  } },
  { method: 'POST', match: /^\/calendar\/sync$/, run: async ({ cfg, nx, service, send, fail }) => {
    const plan = await service.rpc('wms_calendar_plan', {});
    const held = plan.filter((a) => a.action === 'hold_date_only').map((a) => ({ shipment: a.shipment, booking_id: a.booking_id, reason: a.reason }));
    const todo = plan.filter((a) => a.action === 'put' || a.action === 'cancel');
    if (!cfg.calendarWrites) return send({ ok: true, dry_run: true, would_send: todo.map((a) => ({ shipment: a.shipment, booking_id: a.booking_id, action: a.action, body: a.body || null, reason: a.reason || null })), held });
    if (todo.length) { const floor = await nx.floorIsExpected(); if (!floor) return fail(floor === null ? 503 : 502, floor === null ? 'nexus_no_answer' : 'not_the_expected_floor', 'Nothing was sent.'); }
    const results = [];
    for (const a of todo) {
      const path = `/v1/calendar/${encodeURIComponent(a.booking_id)}`;
      const body = a.action === 'put' ? Object.fromEntries(SENDABLE.filter((k) => a.body[k] !== undefined).map((k) => [k, a.body[k]])) : undefined;
      const r = a.action === 'put' ? await nx.call('PUT', path, { body }) : await nx.call('DELETE', path);
      const done = r.status === 200 && r.body.ok;
      if (done) await service.rpc('wms_calendar_mark', { p_shipment: a.shipment, p_state: a.action === 'put' ? 'published' : 'cancelled', p_hash: a.hash || null });
      results.push({ shipment: a.shipment, booking_id: a.booking_id, action: a.action, ok: done, status: r.status, error: done ? null : r.body.error || 'no_answer' });
    }
    return send({ ok: true, dry_run: false, results, held });
  } },
];
