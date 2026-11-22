// ShipBay development preview. The browser talks only to this site's own /api/nexus function, never to Nexus, and
// holds no Nexus credential. The preview passcode is kept for the tab's session only.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let pass = ''; try { pass = sessionStorage.getItem('preview-pass') || ''; } catch { /* storage unavailable */ }
  const say = (text, bad) => { const m = $('msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'strip' + (bad ? ' bad' : ''); };
  async function api(path, opts = {}) {
    const res = await fetch('/api/nexus' + path, { method: opts.method || 'GET', cache: 'no-store',
      headers: { 'x-preview-passcode': pass, ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    record(opts.method || 'GET', path, res.status, data);
    if (res.status === 401) { pass = ''; try { sessionStorage.removeItem('preview-pass'); } catch { /* ignore */ } showGate('That passcode was not accepted.'); throw new Error('passcode'); }
    if (!data || !data.ok) throw new Error((data && data.message) || `The preview could not be reached (${res.status}).`);
    return data;
  }
  // Read-only diagnostics: the HTTP status and the exact answer of each call this page made to its own function.
  const calls = [];
  function record(method, path, status, data) {
    calls.unshift({ method, path: path.split('?')[0], query: path.includes('?') ? path.slice(path.indexOf('?')) : '', status, data }); calls.length = Math.min(calls.length, 12);
    const box = $('rawlist'); if (!box) return; box.replaceChildren();
    for (const c of calls) { const d = el('details', 'rawcall'); d.dataset.path = c.path; d.dataset.status = c.status;
      d.append(el('summary', null, `${c.method} /api/nexus${c.path} → HTTP ${c.status}`), el('pre', null, (c.query ? c.query + '\n' : '') + JSON.stringify(c.data, null, 1))); box.append(d); }
  }
  function showGate(text) { $('app').hidden = true; $('gate').hidden = false; say(text || '', !!text); $('pass').focus(); }
  const when = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // The floor is drawn from Nexus's own answer: every position sits on the square (x, y) Nexus gives it, on the grid
  // Nexus describes in layout.grid. Nothing about the layout is written into this page.
  function drawFloor(map, occ) {
    const by = Object.fromEntries(occ.locations.map((l) => [l.code, l]));
    const grid = (map.layout && map.layout.grid) || {}; const blocks = (map.layout && map.layout.blocks) || [];
    const floor = $('floor'); floor.replaceChildren();
    const drawn = map.positions.filter((p) => Number.isInteger(p.x) && Number.isInteger(p.y));
    if (!Number.isInteger(grid.cols) || !Number.isInteger(grid.rows) || !drawn.length) { floor.append(el('p', 'note', 'Nexus sent a map this preview cannot draw (no grid or no squares).')); return; }
    const walk = blocks.find((b) => b.key === 'walkway'); const isWalk = (x) => walk && x >= walk.x[0] && x <= walk.x[1];
    floor.style.gridTemplateColumns = Array.from({ length: grid.cols }, (_, i) => (isWalk(i + 1) ? 'minmax(48px, .45fr)' : 'minmax(0, 1fr)')).join(' ');
    floor.style.gridTemplateRows = `auto repeat(${grid.rows}, minmax(34px, auto)) auto`;   // a landmark row above and below the squares
    const span = (x) => `${x[0]} / ${x[1] + 1}`;
    for (const b of blocks) {
      if (b.key === 'walkway') { const w = el('div', 'walk'); w.style.gridColumn = span(b.x); w.style.gridRow = `${b.y[0] + 1} / ${b.y[1] + 2}`; w.dataset.block = 'walkway'; floor.append(w); continue; }
      const t = el('div', `zone ${b.key}`); t.style.gridColumn = span(b.x); t.style.gridRow = `${b.y[0] + 1} / ${b.y[1] + 2}`; t.dataset.block = b.key; t.dataset.label = b.label; floor.append(t);
    }
    for (const l of map.landmarks || []) {
      const m = el('div', `mark ${l.key}`, l.label); m.dataset.landmark = l.key; m.dataset.at = l.at;
      if (l.edge === 'top' || l.edge === 'bottom') { m.style.gridColumn = span(l.x); m.style.gridRow = l.edge === 'top' ? '1' : String(grid.rows + 2); }
      else { m.style.gridColumn = span(l.x || (walk ? walk.x : [1, grid.cols])); m.style.gridRow = `2 / ${grid.rows + 2}`; m.classList.add('centre'); }
      floor.append(m);
    }
    const seen = new Set();
    for (const p of drawn) {
      const o = by[p.code] || {}; const mine = (o.your_pallets || []).length; const others = (o.occupants || []).filter((c) => c.company !== 'SHIPBAY');
      const state = p.status !== 'open' ? 'off' : mine ? 'mine' : others.length ? 'other' : 'free';
      const c = el('div', `pos ${state}`); c.dataset.code = p.code; c.dataset.state = state; c.dataset.kind = p.kind; c.dataset.x = p.x; c.dataset.y = p.y;
      c.style.gridColumn = String(p.x); c.style.gridRow = String(p.y + 1);
      if (seen.has(`${p.x},${p.y}`)) c.classList.add('clash'); seen.add(`${p.x},${p.y}`);
      c.append(el('b', null, p.code), el('span', null, state === 'mine' ? o.your_pallets.join(', ') : state === 'other' ? others.map((x) => `${x.company} ×${x.pallets}`).join(', ') : state === 'off' ? p.status : ''));
      floor.append(c);
    }
    const pallets = map.positions.filter((p) => p.kind === 'pallet'); const staging = map.positions.filter((p) => p.kind === 'staging');
    const used = occ.locations.filter((l) => l.used > 0).length;
    const facts = [['Pallet positions', pallets.length], ['Staging spots', staging.length], ['Occupied', used], ['Map version', map.map_version], ['Floor', map.warehouse], ['Occupancy', map.occupancy_state]];
    $('facts').replaceChildren(...facts.map(([k, v]) => { const d = el('div'); d.append(el('b', null, String(v)), el('small', null, k)); d.dataset.fact = k; return d; }));
    $('sum').textContent = `Map version ${map.map_version} · checksum ${map.checksum}`; $('sum').dataset.version = map.map_version; $('sum').dataset.checksum = map.checksum;
  }
  function drawCalendar(cal) {
    const body = $('cal').tBodies[0]; body.replaceChildren();
    if (!cal.events.length) { const r = body.insertRow(); const c = r.insertCell(); c.colSpan = 7; c.className = 'empty'; c.textContent = 'Nothing is scheduled in the next 30 days.'; return; }
    for (const e of [...cal.events].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))) {
      const r = body.insertRow(); if (e.status === 'cancelled') r.className = 'gone';
      [when(e.starts_at), e.company, e.direction, e.pallets ?? '—', e.status, e.mine ? e.id : 'private'].forEach((v, i) => { const c = r.insertCell(); c.textContent = String(v); if (i === 3) c.className = 'n'; });
      const c = r.insertCell();
      if (e.mine && e.status !== 'cancelled' && /^DEV-/.test(e.id)) { const b = el('button', 'btn sm', 'Cancel'); b.type = 'button'; b.addEventListener('click', async () => { try { await api('/calendar/' + encodeURIComponent(e.id), { method: 'DELETE' }); await load(); } catch (x) { if (x.message !== 'passcode') say(x.message, true); } }); c.append(b); }
    }
  }
  function drawFeed(feed) {
    const body = $('feed').tBodies[0]; body.replaceChildren();
    const rows = feed.changes.slice(-15).reverse();
    if (!rows.length) { const r = body.insertRow(); const c = r.insertCell(); c.colSpan = 6; c.className = 'empty'; c.textContent = 'No changes yet.'; return; }
    for (const g of rows) { const r = body.insertRow(); [g.seq, when(g.at), g.kind, g.company || '—', g.location || '—', g.pallet || g.event || '—'].forEach((v, i) => { const c = r.insertCell(); c.textContent = String(v); if (i === 0) c.className = 'n'; }); }
  }
  async function load() {
    const from = new Date(); from.setHours(0, 0, 0, 0); const to = new Date(from.getTime() + 30 * 864e5);
    const [map, occ, cal] = await Promise.all([api('/map'), api('/occupancy'), api(`/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)]);
    let feed = await api('/changes?after=0&limit=500');   // walk to the end of the feed, a page at a time
    while (feed.changes.length === 500) { const next = await api(`/changes?after=${feed.last}&limit=500`); if (!next.changes.length) break; feed = next; }
    drawFloor(map, occ); drawCalendar(cal); drawFeed(feed);
    $('gate').hidden = true; $('app').hidden = false;
  }
  $('gate').addEventListener('submit', async (e) => { e.preventDefault(); pass = $('pass').value; try { sessionStorage.setItem('preview-pass', pass); } catch { /* ignore */ } $('pass').value = ''; say('Loading…'); try { await load(); say(''); } catch (x) { if (x.message !== 'passcode') say(x.message, true); } });
  $('newev').addEventListener('submit', async (e) => {
    e.preventDefault(); const start = new Date($('start').value); if (Number.isNaN(start.getTime())) return say('Pick when it starts.', true);
    const id = 'DEV-' + Date.now().toString(36).toUpperCase();
    try { await api('/calendar/' + id, { method: 'PUT', body: { direction: $('dir').value, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 36e5).toISOString(), pallets: Number($('pal').value), status: 'scheduled' } }); say(`Published ${id} to the Nexus test floor.`); await load(); }
    catch (x) { if (x.message !== 'passcode') say(x.message, true); }
  });
  (async () => {
    const d = new Date(Date.now() + 864e5); d.setHours(10, 0, 0, 0); $('start').value = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    try { const s = await (await fetch('/api/nexus/status', { cache: 'no-store' })).json(); if (!s.ready) { say('This preview is not configured yet: its server-side secrets are missing.', true); return; } } catch { say('The preview function did not answer.', true); return; }
    if (!pass) return showGate();
    say('Loading…'); try { await load(); say(''); } catch (x) { if (x.message !== 'passcode') say(x.message, true); }
  })();
})();
