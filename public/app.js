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
    if (res.status === 401) { pass = ''; try { sessionStorage.removeItem('preview-pass'); } catch { /* ignore */ } showGate('That passcode was not accepted.'); throw new Error('passcode'); }
    if (!data || !data.ok) throw new Error((data && data.message) || `The preview could not be reached (${res.status}).`);
    return data;
  }
  function showGate(text) { $('app').hidden = true; $('gate').hidden = false; say(text || '', !!text); $('pass').focus(); }
  const when = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function drawFloor(map, occ) {
    const by = Object.fromEntries(occ.locations.map((l) => [l.code, l]));
    const floor = $('floor'); floor.replaceChildren();
    const cell = (p) => {
      const o = by[p.code] || {}; const mine = (o.your_pallets || []).length; const others = (o.occupants || []).filter((c) => c.company !== 'SHIPBAY');
      const state = p.status !== 'open' ? 'off' : mine ? 'mine' : others.length ? 'other' : 'free';
      const c = el('div', `pos ${state}`); c.dataset.code = p.code; c.dataset.state = state; c.dataset.kind = p.kind;
      c.append(el('b', null, p.code), el('span', null, state === 'mine' ? o.your_pallets.join(', ') : state === 'other' ? others.map((x) => `${x.company} ×${x.pallets}`).join(', ') : state === 'off' ? p.status : ''));
      return c;
    };
    const block = (name, title) => {
      const ps = map.positions.filter((p) => p.block === name); if (!ps.length) return null;
      const cols = Math.max(...ps.map((p) => p.col)); const rows = Math.max(...ps.map((p) => p.row));
      const b = el('div', `block ${name}`); b.dataset.block = name; b.append(el('h3', null, `${title} · ${ps.length}`));
      const g = el('div', 'grid'); g.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) { const p = ps.find((x) => x.col === c && x.row === r); g.append(p ? cell(p) : el('div', 'pos gap')); }
      b.append(g); return b;
    };
    const mark = (key) => { const l = (map.landmarks || []).find((x) => x.key === key); return el('div', `mark ${key}`, l ? l.label : ''); };
    const left = el('div', 'side left'); left.append(mark('exit'), block('outbound', 'Outbound side') || el('div'), mark('prep'));
    const mid = el('div', 'side mid'); mid.append(mark('walkway'));
    const right = el('div', 'side right'); right.append(mark('dock'), block('dock', 'Dock') || el('div'), block('inbound', 'Inbound side') || el('div'), block('staging', 'Staging') || el('div'), mark('entrance'));
    floor.append(left, mid, right);
    const pallets = map.positions.filter((p) => p.kind === 'pallet'); const staging = map.positions.filter((p) => p.kind === 'staging');
    const used = occ.locations.filter((l) => l.used > 0).length;
    const facts = [['Pallet positions', pallets.length], ['Staging spots', staging.length], ['Occupied', used], ['Map version', map.map_version], ['Floor', map.warehouse], ['Occupancy', map.occupancy_state]];
    $('facts').replaceChildren(...facts.map(([k, v]) => { const d = el('div'); d.append(el('b', null, String(v)), el('small', null, k)); d.dataset.fact = k; return d; }));
    $('badge').title = `checksum ${map.checksum}`;
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
