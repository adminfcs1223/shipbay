// A stand-in for Nexus staging, for tests only. Same answers' shape as the v1 contract; the floor is the approved layout:
// left two lines of 18, right two lines of 15, two staging spots. Synthetic data. It records every request it receives.
export function makeStub({ test = true, warehouse = 'HILLSBOROUGH-TEST', key = 'stub-staging-key-0123456789' } = {}) {
  const calls = []; const events = new Map(); const changes = []; let seq = 0;
  const positions = [];
  for (let n = 1; n <= 72; n++) {
    const side = n <= 36 ? 'inbound' : 'outbound'; const drawn = n > 36 || (n - 1) % 18 < 15; if (!drawn) continue;
    positions.push({ code: 'P-' + String(n).padStart(2, '0'), kind: 'pallet', zone: side, block: side, col: Math.floor(((n - 1) % 36) / 18) + 1, row: ((n - 1) % 18) + 1, capacity: 1, status: 'open' });
  }
  positions.push({ code: 'STG-01', kind: 'staging', zone: 'staging', block: 'staging', col: 1, row: 1, capacity: null, status: 'open' }, { code: 'STG-02', kind: 'staging', zone: 'staging', block: 'staging', col: 2, row: 1, capacity: null, status: 'open' },
    { code: 'RCV-DOCK', kind: 'dock', zone: 'receiving', block: 'dock', col: 1, row: 1, capacity: null, status: 'open' });
  const placed = { 'P-37': { company: 'SHIPBAY', ids: ['SYN-SB-0001'] }, 'P-01': { company: 'SOULED', ids: ['hidden'] } };
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input)); const m = init.method || 'GET'; const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ m, url: url.href, host: url.host, path: url.pathname.replace('/functions/v1/nexus', ''), search: url.search, headers, body });
    const path = url.pathname.replace('/functions/v1/nexus', '');
    if (path === '/v1/health') return j({ ok: true, service: 'nexus', api: '1.0.0-draft' });
    if (headers.authorization !== `Bearer ${key}`) return j({ ok: false, error: 'unauthorized', message: 'send Authorization: Bearer <key>' }, 401);
    if (path === '/v1/map') return j({ ok: true, warehouse, test, map_version: 2, checksum: 'stubsum', occupancy_state: test ? 'synthetic' : 'not_initialized', moves_enabled: test, positions,
      landmarks: [{ key: 'exit', label: 'Exit' }, { key: 'dock', label: 'Dock' }, { key: 'walkway', label: 'Walkway' }, { key: 'prep', label: 'Prep area' }, { key: 'entrance', label: 'Entrance' }], not_drawn: [] });
    if (path === '/v1/occupancy') return j({ ok: true, warehouse, test, occupancy_state: 'synthetic', moves_enabled: test, locations: positions.map((p) => { const o = placed[p.code];
      return { code: p.code, capacity: p.capacity, used: o ? 1 : 0, free: p.capacity == null ? null : p.capacity - (o ? 1 : 0), occupants: o ? [{ company: o.company, pallets: 1 }] : [], your_pallets: o && o.company === 'SHIPBAY' ? o.ids : [] }; }) });
    if (path === '/v1/changes') { const after = Number(url.searchParams.get('after') || 0); const out = changes.filter((c) => c.seq > after).slice(0, Number(url.searchParams.get('limit') || 200)); return j({ ok: true, changes: out, last: out.length ? out[out.length - 1].seq : after }); }
    if (path === '/v1/calendar' && m === 'GET') return j({ ok: true, warehouse, events: [{ company: 'SOULED', direction: 'inbound', starts_at: new Date(Date.now() + 2 * 864e5).toISOString(), ends_at: null, pallets: 4, status: 'scheduled', mine: false },
      ...[...events.values()].map((e) => ({ company: 'SHIPBAY', mine: true, ...e }))] });
    const ev = path.match(/^\/v1\/calendar\/([^/]+)$/)?.[1];
    if (ev && (m === 'PUT' || m === 'DELETE')) { const id = decodeURIComponent(ev); const was = events.get(id); const next = m === 'DELETE' ? { ...was, status: 'cancelled' } : { id, ends_at: null, pallets: null, status: 'scheduled', ...was, ...body };
      events.set(id, next); changes.push({ seq: ++seq, at: new Date().toISOString(), kind: m === 'DELETE' ? 'calendar.cancelled' : was ? 'calendar.changed' : 'calendar.created', v: 1, company: 'SHIPBAY', event: id }); return j({ ok: true, event: id, changed: true, created: !was, status: next.status }); }
    if (/^\/v1\/pallets\//.test(path)) return j({ ok: false, error: 'forbidden', message: 'key lacks the scope' }, 403);
    return j({ ok: false, error: 'not_found', message: 'unknown path or method' }, 404);
  }
  return { fetchImpl, calls, events, key };
}
