// WMS → Warehouse Map. The real shared floor exactly as Nexus holds it, and the one place a pallet's floor position is set.
// Nexus HILLSBOROUGH is the only location registry: the map, its positions and who stands where are read from Nexus through
// ShipBay's own server-side bridge, refreshed every minute and right after every successful placement. The browser never talks
// to Nexus and never holds a Nexus key.
//   Place:     a pallet off the truck goes into an empty position.
//   Register:  a pallet that is already standing in a position is recorded there (in-place registration).
//   Move:      a stored pallet goes to another empty position.
//   Release:   the pallet has left its position; the position is freed. Stock is never deducted here.
// Every placement needs the employee's own confirmation, at the position, that nothing else stands there. Nexus then decides:
// a position another company (or ShipBay) already holds is refused by Nexus and the refusal is shown in plain words.
// Pallet IDs and positions can be scanned or typed; a position can also be tapped on the map. A scanner is never required.
import { useEffect, useMemo, useState } from 'react';
import { bridge } from './nexusBridge.js';
import { supabase } from './lib.js';
import { ScanBox, beep, palletIds, palletShort, StatusTag } from './parts.jsx';
import CreatePallet from './CreatePallet.jsx';
import { printLocationLabels, printPalletLabels } from './label.js';
import { fetchCartons, attachCartons } from './cartons.js';

const loc = (s) => String(s || '').trim().toUpperCase().replace(/^LOC-/, '');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const REFRESH_MS = 60000;   // well inside the five-minute limit; also refreshed after every confirmed placement
const MODES = [['place', 'Place'], ['register', 'Register in place'], ['move', 'Move'], ['release', 'Release']];
const REASONS = [['shipped_out', 'Shipped out'], ['emptied_and_removed', 'Emptied and removed'], ['moved_off_shared_floor', 'Moved off the shared floor'], ['correction', 'Correction (admin only)']];
const KEEP_PALLET = ['location_full', 'location_blocked', 'location_unavailable', 'location_not_found', 'location_not_confirmed', 'move_out_of_scope'];
// the approved colours: white open, blue Souled, orange ShipBay, grey unknown or error
export const TONES = {
  open: { bg: '#ffffff', bd: '#c3c9d2', fg: '#0F1B2A', label: 'Open' },
  souled: { bg: '#2563c9', bd: '#1d4f9f', fg: '#ffffff', label: 'Souled' },
  shipbay: { bg: '#FF6B15', bd: '#d9520a', fg: '#ffffff', label: 'ShipBay' },
  unknown: { bg: '#c9cdd3', bd: '#9aa1ab', fg: '#3a414b', label: 'Unknown or error' },
};
export function toneOf(p, o) {
  if (!p || p.status !== 'open' || !o || o.status !== 'open') return 'unknown';
  if (!Number(o.used)) return 'open';
  const who = (o.occupants || []).map((x) => String(x.company || '').toUpperCase());
  if ((o.your_pallets || []).length || who.includes('SHIPBAY')) return who.some((c) => c && c !== 'SHIPBAY') ? 'unknown' : 'shipbay';
  if (who.length && who.every((c) => c === 'SOULED')) return 'souled';
  return 'unknown';
}

// The floor drawn from Nexus's own layout: its grid, blocks and landmarks, each position at Nexus's x/y. The staging block is set
// apart from the pallet rows; the building's walls are drawn around it with openings where Nexus marks the exit, dock,
// entrance and prep area. Tapping a position picks it.
// A shared zone (Nexus kind "zone", map 5+): one outlined rectangle drawn from its layout block, never tiles, never counted in the
// position totals. ShipBay's own pallets are listed with their inbound / outbound status; another company appears as counts only.
export const zoneOf = (floor) => (floor?.layout?.blocks || []).filter((b) => b.location && Array.isArray(b.x) && Array.isArray(b.y));
function Zone({ b, o, sel, onPick, row }) {
  const mine = (o?.your_pallets_status || []).length ? o.your_pallets_status : (o?.your_pallets || []).map((p) => ({ pallet: p, zone_status: null }));
  const others = (o?.occupants || []).filter((x) => String(x.company || '').toUpperCase() !== 'SHIPBAY' && Number(x.pallets) > 0);
  const off = !o || o.status !== 'open';
  return (
    <button type="button" data-testid={`map-${b.location}`} data-zone="1" className={`wm-zone${sel ? ' sel' : ''}${off ? ' off' : ''}`} onClick={() => onPick(b.location)}
      title={`${b.label} · ${b.location} · shared${off ? ` · ${o ? o.status : 'no data'}` : ''}`} style={{ gridColumn: `${b.x[0]} / ${b.x[1] + 1}`, gridRow: `${row(b.x[0], b.y[0])} / ${row(b.x[0], b.y[1]) + 2}` }}>
      <b>{b.label}</b><small>{b.location} · shared{off ? ` · ${o ? o.status : 'no data'}` : ''}</small>
      <span className="wm-zone-chips">
        {mine.length > 0 && <i className="sb" data-testid="zone-shipbay">ShipBay {mine.length}</i>}
        {others.map((x) => <i key={x.company} className={String(x.company).toUpperCase() === 'SOULED' ? 'so' : 'ot'} data-testid={`zone-${String(x.company).toLowerCase()}`}>{String(x.company).toUpperCase() === 'SOULED' ? 'Souled' : x.company} {x.pallets}{x.inbound != null ? ` (${x.inbound} in · ${x.outbound} out)` : ''}</i>)}
        {!mine.length && !others.length && !off && <i className="em">Empty</i>}
      </span>
      {mine.length > 0 && <span className="wm-zone-mine">{mine.slice(0, 4).map((m) => <em key={m.pallet}>{palletShort(m.pallet)}{m.zone_status ? ` · ${m.zone_status}` : ''}</em>)}{mine.length > 4 && <em>+{mine.length - 4} more</em>}</span>}
    </button>);
}

function Floor({ floor, selected, onPick }) {
  const grid = floor.layout?.grid || {}; const cols = Number(grid.cols) || 5; const rows = Number(grid.rows) || 18;
  const blocks = floor.layout?.blocks || []; const stg = blocks.find((b) => b.key === 'staging'); const zones = zoneOf(floor);
  // rows above row 1 (map 5: the zone at y = -2..0). Positions keep their y; the drawing is shifted down by top_rows.
  const top = Math.max(Number(grid.top_rows) || 0, ...zones.map((z) => 1 - Math.min(...z.y)), 0);
  // half-row grid: every position spans two lines; the staging block (and only its columns) drops one full row so it stands apart
  const inStg = (x, y) => stg && x >= stg.x[0] && x <= stg.x[1] && y >= stg.y[0];
  const row = (x, y) => 2 * (y + top) - 1 + (inStg(x, y) ? 2 : 0);
  const cells0 = (floor.positions || []).filter((p) => p.x && p.y);
  const total = Math.max(2 * (rows + top), ...cells0.map((p) => row(p.x, p.y) + 1));
  const occ = new Map((floor.locations || []).map((l) => [l.code, l]));
  const cells = cells0;
  const walk = blocks.find((b) => b.key === 'walkway'); const marks = floor.landmarks || [];
  const wall = (edge) => {
    const ms = marks.filter((m) => m.edge === edge && Array.isArray(m.x));
    const parts = []; for (let c = 1; c <= cols;) { const m = ms.find((x) => x.x[0] === c); if (m) { parts.push({ m, from: c, to: m.x[1] }); c = m.x[1] + 1; } else { parts.push({ from: c, to: c }); c += 1; } }
    return <div className={`wm-wall ${edge}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{parts.map((s) => s.m
      ? <div key={s.from} className="wm-door" data-testid={`mark-${s.m.key}`} style={{ gridColumn: `${s.from} / ${s.to + 1}` }}>{s.m.label}</div>
      : <div key={s.from} className="wm-solid" style={{ gridColumn: `${s.from} / ${s.to + 1}` }} />)}</div>;
  };
  const side = (b) => blocks.filter((x) => x.key !== 'walkway' && x.key !== 'staging' && !x.location && x.x[0] === b);
  return (
    <div className="wm-floor" data-testid="pa-map">
      <div className="wm-sides" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {[...side(1), ...side(Math.max(1, cols - 1))].map((b) => <div key={b.key} style={{ gridColumn: `${b.x[0]} / ${b.x[1] + 1}` }}>{b.label}</div>)}
      </div>
      {wall('top')}
      <div className="wm-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${total}, 18px)`, rowGap: 5 }}>
        {walk && <div className="wm-walk" style={{ gridColumn: `${walk.x[0]} / ${walk.x[1] + 1}`, gridRow: `1 / ${total + 1}` }}><span>{walk.label}</span></div>}
        {stg && <div className="wm-stglabel" style={{ gridColumn: `${stg.x[0]} / ${stg.x[1] + 1}`, gridRow: `${row(stg.x[0], stg.y[0]) - 2} / ${row(stg.x[0], stg.y[0])}` }}>{stg.label}</div>}
        {zones.map((b) => <Zone key={b.location} b={b} o={occ.get(b.location)} sel={selected === b.location} onPick={onPick} row={row} />)}
        {cells.map((p) => {
          const o = occ.get(p.code); const t = toneOf(p, o); const c = TONES[t];
          const who = t === 'shipbay' ? (o.your_pallets || []).join(', ') || 'ShipBay' : t === 'souled' ? 'Souled' : t === 'unknown' ? (p.status !== 'open' ? p.status : o ? 'Check' : 'No data') : '';
          return (
            <button key={p.code} type="button" data-testid={`map-${p.code}`} data-tone={t} className={`wm-tile${selected === p.code ? ' sel' : ''}`} onClick={() => onPick(p.code)}
              title={`${p.code} · ${c.label}${who && t !== 'open' ? ` · ${who}` : ''}`} style={{ gridColumn: p.x, gridRow: `${row(p.x, p.y)} / span 2`, background: c.bg, borderColor: c.bd, color: c.fg }}>
              <b>{p.code}</b>{t !== 'open' && <small>{t === 'shipbay' && (o.your_pallets || []).length === 1 ? palletShort(o.your_pallets[0]) : who}</small>}
            </button>);
        })}
      </div>
      {wall('bottom')}
    </div>
  );
}

function Legend({ counts }) {
  return <p className="wm-legend" data-testid="wm-legend">{Object.entries(TONES).map(([k, c]) => <span key={k}><i style={{ background: c.bg, borderColor: c.bd }} />{c.label} <b>{num(counts[k] || 0)}</b></span>)}</p>;
}

export default function WarehouseMap({ go }) {
  const [mode, setMode] = useState('place');
  const [psku, setPsku] = useState(null); const [pallet, setPallet] = useState(null);   // pallet id entered, and what ShipBay knows of it
  const [atRaw, setAt] = useState('');                    // position as typed, scanned or tapped
  const at = loc(atRaw);
  const [reason, setReason] = useState(''); const [sure, setSure] = useState(false); const [zs, setZs] = useState('');   // zs: inbound | outbound, for the shared zone
  const [busy, setBusy] = useState(false); const [last, setLast] = useState(null);
  const [floor, setFloor] = useState(null); const [status, setStatus] = useState(null); const [open, setOpen] = useState([]); const [exc, setExc] = useState(null);
  const [fixSure, setFixSure] = useState({}); const [brands, setBrands] = useState([]); const [at0, setAt0] = useState(null); const [creating, setCreating] = useState(false);

  const refresh = async () => {
    const [s, f, p] = await Promise.all([bridge('/status'), bridge('/floor'), bridge('/pending')]);
    setStatus(s); setFloor(f.ok ? f : { ok: false, message: f.message }); if (p.ok) setOpen(p.open || []); setAt0(new Date());
    if (s.ok && s.connection !== 'off') { const r = await bridge('/reconcile'); setExc(r.ok ? r.exceptions || null : null); }   // floor staff get 403: the section does not show
  };
  useEffect(() => {
    refresh(); const t = setInterval(refresh, REFRESH_MS); const vis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', vis);
    supabase.rpc('wms_brands').then(({ data }) => setBrands(data || []), () => {});
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);

  const pos = useMemo(() => new Map((floor?.ok ? floor.positions || [] : []).map((p) => [p.code, p])), [floor]);
  const occ = useMemo(() => new Map((floor?.ok ? floor.locations || [] : []).map((l) => [l.code, l])), [floor]);
  const nexusAt = (id) => { for (const l of occ.values()) if ((l.your_pallets || []).includes(id)) return l.code; return null; };
  const counts = useMemo(() => { const c = {}; for (const p of pos.values()) if (p.x && p.y) { const t = toneOf(p, occ.get(p.code)); c[t] = (c[t] || 0) + 1; } return c; }, [pos, occ]);
  const brandOf = (id) => brands.find((b) => b.id === id)?.name || '';

  const reset = (keepMode = true) => { setPsku(null); setPallet(null); setAt(''); setReason(''); setSure(false); setZs(''); if (!keepMode) setLast(null); };
  const pick = (m) => { setMode(m); reset(); setLast(null); };
  // a scanned label is exact; a number alone is looked up as both SB-PAL-… and PSKU-… (one number sequence, so at most one matches)
  const identify = async (raw) => {
    const ids = palletIds(raw); setPsku(ids[0]); setPallet({ loading: true }); setLast(null);
    const { data, error } = await supabase.from('wms_pallets').select('*').in('psku', ids).limit(2);
    const row = (data || [])[0] || null; if (row) setPsku(row.psku);
    setPallet(error ? { error: error.message } : row || { missing: true });
  };
  const tap = (code) => { setAt(code); if (mode === 'release' && !psku) { const mine = occ.get(code)?.your_pallets || []; if (mine.length === 1) identify(mine[0]); } };

  const call = async (path, body, done) => {
    setBusy(true); setLast(null); const r = await bridge(path, { method: 'POST', body }); setBusy(false);
    if (r.ok) { beep('ok'); reset(); setLast({ tone: 'ok', ...done(r) }); }
    else if (r.pending || r.status === 0) { beep('bad'); setLast({ tone: 'wait', title: 'Not confirmed.', text: r.message, again: () => call(path, body, done) }); }
    else { beep('bad'); setLast({ tone: 'bad', title: r.error === 'out_of_sync' ? 'Needs an admin.' : 'Not done.', text: r.message || 'The request was refused.' }); if (!KEEP_PALLET.includes(r.error)) reset(); }
    refresh();
  };
  // into the shared Receiving / Outbound zone, or a status change inside it: no empty-position confirmation, the status instead
  const toZone = () => call('/zone', { psku, zone_status: zs },
    (r) => ({ title: `${r.psku} is in Receiving / Outbound (${zs}).`, text: r.from && r.from !== r.location ? `Moved from ${r.from}. Quantity unchanged.` : r.from === r.location ? 'Status changed. It stays in the zone.' : 'Recorded in Nexus.' }));
  const place = () => call(mode === 'move' ? '/move' : '/putaway', { psku, location: at, confirmed_clear: true, ...(mode === 'register' ? { in_place: true } : {}) },
    (r) => ({ title: `${r.psku} is at ${r.location}.`, text: mode === 'move' ? `Moved from ${r.from}. Quantity unchanged.` : mode === 'register' ? `Registered where it stands. ${num(r.units_posted)} units on the shelf count.` : `${num(r.units_posted)} units on the shelf count.` }));
  const release = () => call('/release', { psku, location: at, reason, confirmed: true },
    (r) => ({ title: `${r.from} is free.`, text: r.note ? `${r.psku} left the floor. ${r.note}` : r.pallet_status === 'off_floor' ? `${r.psku} is off the shared floor and still in ShipBay custody. Its stock is kept.` : `${r.psku} left the floor. Its stock was not changed.` }));
  const retryAll = async () => { setBusy(true); const r = await bridge('/pending/retry', { method: 'POST' }); setBusy(false);
    setLast(r.ok ? { tone: r.results.every((x) => x.ok) ? 'ok' : 'bad', title: 'Sent again.', text: r.results.map((x) => `${x.pallet} ${x.kind} ${x.to || x.from}: ${x.ok ? 'confirmed' : 'not confirmed'}`).join(' · ') || 'Nothing was waiting.' } : { tone: 'wait', title: 'Not confirmed.', text: r.message }); refresh(); };
  const resolve = (o, how) => call(how === 'record' ? '/reconcile/record' : '/reconcile/undo', { op: o.op, confirmed: true },
    (r) => (how === 'record' ? { title: `${r.psku} is recorded at ${r.location}.`, text: 'ShipBay now matches Nexus.' } : { title: `${o.to} is free.`, text: `Nexus no longer holds ${o.pallet} there. ShipBay's record was not changed.` }));
  const reprint = async () => {
    let rows = []; try { rows = await fetchCartons(supabase, [pallet.id]); } catch { /* the label prints without carton lines */ }
    const [p] = attachCartons([pallet], rows).pallets; printPalletLabels([p], (x) => brandOf(x.org_id));
    supabase.rpc('wms_mark_printed', { p_ids: [pallet.id] }).then(() => {}, () => {});
  };
  const printPositions = (codes) => printLocationLabels(codes.map((c) => ({ code: c, zone: (floor.layout?.blocks || []).find((b) => b.key === pos.get(c)?.block)?.label || pos.get(c)?.block || (c.startsWith('STG') ? 'Staging' : '') })));

  const live = status?.ok && status.connection === 'production';
  const canMove = status?.ok && status.pallet_moves && floor?.ok && floor.moves_enabled;
  const target = at ? occ.get(at) : null; const targetPos = at ? pos.get(at) : null; const targetTone = at ? toneOf(targetPos, target) : null;
  const where = psku ? nexusAt(psku) : null;
  const isZone = !!at && (targetPos?.kind === 'zone' || zoneOf(floor?.ok ? floor : null).some((z) => z.location === at));
  const zoneStatusOf = (id) => ((occ.get(where || '')?.your_pallets_status || []).find((x) => x.pallet === id) || {}).zone_status || null;
  const curZs = where && occ.get(where)?.kind === 'zone' ? zoneStatusOf(psku) : null;
  const palletOk = pallet && !pallet.loading && !pallet.error && !pallet.missing;
  const palletProblem = !palletOk ? null : pallet.status === 'void' ? `${psku} was voided.` : pallet.held ? `${psku} is on HOLD.` : null;
  const ready = psku && palletOk && !palletProblem && at && targetPos && !busy && canMove;
  const posCodes = [...pos.values()].filter((p) => p.x && p.y).map((p) => p.code);
  const waiting = open.filter((o) => o.state === 'pending'); const broken = open.filter((o) => o.state === 'out_of_sync');
  const steps = mode === 'release'
    ? { p: 'Scan or type the pallet ID, or tap its position', l: 'Position it left (scan, type or tap)' }
    : mode === 'move' ? { p: 'Scan or type the pallet ID', l: 'New position (scan, type or tap)' }
      : mode === 'register' ? { p: 'Scan or type the pallet ID', l: 'Position it is standing in (scan, type or tap)' }
        : { p: 'Scan or type the pallet ID', l: 'Empty position (scan, type or tap)' };

  return (
    <>
      <header className="pagehead">
        <div><h1>Warehouse Map<span className="dot">.</span></h1>
          {floor?.ok && <p className="when" data-testid="pa-floor">Nexus {floor.warehouse} · map version {floor.map_version} · {num(posCodes.length)} positions{at0 ? ` · updated ${at0.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : ''}{status?.ok && !status.pallet_moves ? ' · read-only' : ''}</p>}
          {floor?.ok && floor.checksum && <p className="when" data-testid="pa-checksum" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>Map checksum {floor.checksum}</p>}</div>
        {floor?.ok && <div className="glance"><div><b>{num(counts.open)}</b><small>Open</small></div><div><b>{num(counts.shipbay)}</b><small>ShipBay</small></div><div><b>{num(counts.souled)}</b><small>Souled</small></div><div><b>{num(open.length)}</b><small>Not confirmed</small></div></div>}
      </header>
      {status && !status.ok && <div className="strip bad"><b>No connection to Nexus.</b><span>{status.message || 'The WMS server did not answer.'}</span><button onClick={refresh}>Try again</button></div>}
      {floor && !floor.ok && <div className="strip bad" data-testid="wm-nofloor"><b>Nexus is not answering.</b><span>{floor.message} Do not place pallets until the map is back.</span><button onClick={refresh}>Try again</button></div>}
      {status?.ok && !canMove && floor?.ok && <div className="strip bad" data-testid="pa-closed"><b>Placing pallets is not switched on yet.</b><span>The map is live. Placements, moves and releases will open here once ShipBay's Nexus movement key is installed.</span></div>}
      {last && <div className={`strip ${last.tone === 'ok' ? 'ok' : 'bad'}`} data-testid="pa-result" data-tone={last.tone}><b>{last.title}</b><span>{last.text}</span>{last.again && <button disabled={busy} onClick={last.again}>Send again</button>}</div>}

      <div className="wm-layout">
        <section className="panel pad wm-mappanel">
          <header className="panelhead"><h3>Hillsborough floor</h3><span>Tap a position to use it</span></header>
          {floor?.ok ? <Floor floor={floor} selected={at} onPick={tap} /> : <div className="wm-floor wm-off" data-testid="pa-map-off">{floor ? 'The map could not be read from Nexus.' : 'Loading the map…'}</div>}
          <Legend counts={counts} />
          {floor?.ok && zoneOf(floor).map((z) => { const o = occ.get(z.location); const mine = o?.your_pallets_status || [];
            const others = (o?.occupants || []).filter((x) => String(x.company || '').toUpperCase() !== 'SHIPBAY' && Number(x.pallets) > 0);
            return (mine.length > 0 || others.length > 0) && (
              <div key={z.location} className="wm-zonelist" data-testid="wm-zonelist"><b>{z.label}</b>
                {mine.map((m) => <span key={m.pallet}><button type="button" className="linkish" onClick={() => { setAt(z.location); identify(m.pallet); }}>{m.pallet}</button> {m.zone_status}{m.since ? ` · since ${new Date(m.since).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</span>)}
                {others.map((x) => <span key={x.company}>{String(x.company).toUpperCase() === 'SOULED' ? 'Souled' : x.company}: {x.pallets} pallet{x.pallets === 1 ? '' : 's'}{x.inbound != null ? ` (${x.inbound} inbound, ${x.outbound} outbound)` : ''}</span>)}
              </div>); })}
        </section>

        <section className="panel pad wm-act" data-testid="wm-act">
          <div className="seg wm-seg">{MODES.map(([k, label]) => <button key={k} data-testid={`mode-${k}`} className={mode === k ? 'on' : ''} onClick={() => pick(k)}>{label}</button>)}</div>

          <label className="wm-step">1 · {steps.p}</label>
          {!psku ? <ScanBox key={`p-${mode}`} autoFocus placeholder="e.g. 40 or SB-PAL-000040" onScan={identify} />
            : (<div className="hold" data-testid="pa-pallet"><b>{psku}</b>{' '}
              {pallet?.loading ? 'Looking it up…' : pallet?.missing ? <span>is not a ShipBay pallet. Check the label, or create it in Receiving.</span> : pallet?.error ? <span>could not be looked up: {pallet.error}</span>
                : (<><span data-testid="pa-pallet-info">{brandOf(pallet.org_id) || 'Unknown brand'} · {pallet.item_name || (pallet.mixed ? 'Mixed pallet' : '—')}{pallet.units_total ? ` · ${num(pallet.units_total)} units` : ''} · </span><StatusTag s={pallet.status} />{pallet.held && <span className="tag bad">HOLD</span>}
                  <span> · {where ? `Nexus has it at ${where}${curZs ? ` (${curZs})` : ''}` : 'not on the shared floor in Nexus'}</span></>)}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn sm" onClick={() => reset()}>Different pallet</button>{palletOk && <button className="btn sm" data-testid="pa-reprint" onClick={reprint}>Reprint pallet label</button>}</div>
              {palletProblem && <p className="wm-warn">{palletProblem} It cannot be placed.</p>}
            </div>)}

          <label className="wm-step">2 · {steps.l}</label>
          <ScanBox key={`l-${mode}`} value={atRaw} onChange={setAt} placeholder="e.g. P-12 or STG-01" onScan={(c) => setAt(loc(c))} />
          {at && !targetPos && floor?.ok && <p className="wm-warn" data-testid="pa-badpos">Nexus has no position {at}.</p>}
          {isZone && <p className="sm" data-testid="pa-target">{at}: Receiving / Outbound, shared by both companies, no pallet limit.</p>}
          {mode !== 'release' && psku && isZone && (
            <div className="hold wm-confirm" data-testid="pa-zone">
              <b>{curZs ? `${psku} is in Receiving / Outbound as ${curZs}.` : `Send ${psku} to Receiving / Outbound.`}</b> Is it inbound or outbound?
              <div className="seg" style={{ marginTop: 10 }}>{['inbound', 'outbound'].map((s) => <button key={s} type="button" data-testid={`zs-${s}`} className={zs === s ? 'on' : ''} disabled={s === curZs} onClick={() => setZs(s)}>{s === 'inbound' ? 'Inbound' : 'Outbound'}</button>)}</div>
              <div style={{ marginTop: 10 }}><button className="btn go" data-testid="pa-zone-yes" disabled={!(psku && palletOk && !palletProblem && zs && !busy && canMove)} onClick={toZone}>
                {busy ? 'Asking Nexus…' : !zs ? 'Choose inbound or outbound' : curZs ? `Change to ${zs}` : `Send to Receiving / Outbound as ${zs}`}</button></div>
              {!canMove && <p className="sm">Placing is not switched on yet.</p>}
            </div>)}
          {at && targetPos && !isZone && <p className="sm" data-testid="pa-target">{at}: {TONES[targetTone].label}{targetTone === 'shipbay' ? ` (${(target.your_pallets || []).join(', ')})` : ''}{targetTone === 'souled' ? ' — Souled holds it. Nexus will refuse a placement here.' : ''}</p>}

          {mode !== 'release' && psku && at && targetPos && !isZone && (
            <div className="hold wm-confirm" data-testid="pa-confirm">
              {mode === 'register'
                ? <><b>Go to {at}.</b> Register {psku} only if it is standing in {at} right now and nothing else is.</>
                : <><b>Look at {at} now.</b> {mode === 'move' ? 'Move' : 'Place'} {psku} only if nothing is standing there, including stock that is not on any system.</>}
              <div style={{ marginTop: 10 }}><button className="btn go" data-testid="pa-confirm-yes" disabled={!ready} onClick={place}>
                {busy ? 'Asking Nexus…' : mode === 'register' ? `${psku} is in ${at}: register it` : `${at} is empty: ${mode === 'move' ? 'move' : 'place'} ${psku}`}</button></div>
              {!canMove && <p className="sm">Placing is not switched on yet.</p>}
            </div>)}

          {mode === 'release' && psku && at && (
            <div className="hold wm-confirm" data-testid="pa-release">
              {where !== at ? <p className="wm-warn">Nexus has {psku} {where ? `at ${where}, not ${at}` : 'nowhere on the floor'}. Check the label and the position.</p> : (<>
                <label style={{ display: 'block', marginBottom: 10 }}>Why did it leave?{' '}
                  <select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="pa-reason"><option value="">Choose…</option>{REASONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
                <label className="sc-check" style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} data-testid="pa-sure" /> I am at {at} and {psku} is no longer in it.</label>
                <button className="btn go" data-testid="pa-release-yes" disabled={busy || !reason || !sure || !canMove} onClick={release}>Release {at}</button>
                <p className="sm">Frees {at} in Nexus. The pallet's stock is not changed.</p></>)}
            </div>)}

          {creating ? <CreatePallet brands={brands} onCancel={() => setCreating(false)} onDone={(p) => { setCreating(false); setMode('place'); reset(); identify(p.psku); }} />
            : <p className="sm" style={{ marginTop: 18 }}>A pallet that is not on the system yet: <button className="btn sm" data-testid="wm-create" onClick={() => { setCreating(true); setLast(null); }}>Create a pallet</button></p>}
        </section>
      </div>

      {broken.length > 0 && <section className="panel pad" data-testid="pa-broken">
        <header className="panelhead"><h3>Needs an admin</h3><span>Nexus accepted these and ShipBay did not record them. The positions stay reserved.</span></header>
        <ul className="sc-list">{broken.map((o) => <li key={o.op} className="sc-row"><div><b>{o.pallet} at {o.to || o.from}</b><span>{o.problem || 'ShipBay could not record it.'}</span>
          <label className="sc-check"><input type="checkbox" checked={!!fixSure[o.op]} onChange={(e) => setFixSure({ ...fixSure, [o.op]: e.target.checked })} /> I have been to {o.to || o.from} and checked.</label></div>
          <div className="r"><button className="btn sm" disabled={busy || !fixSure[o.op]} onClick={() => resolve(o, 'record')}>The pallet is there: record it</button>{o.kind !== 'release' && <button className="btn sm" disabled={busy || !fixSure[o.op]} onClick={() => resolve(o, 'undo')}>It is not there: free the position</button>}</div></li>)}</ul>
      </section>}

      {waiting.length > 0 && <section className="panel pad" data-testid="pa-open">
        <header className="panelhead"><h3>Not confirmed by Nexus</h3><button className="btn sm" disabled={busy} onClick={retryAll}>Send all again</button></header>
        <ul className="sc-list">{waiting.map((o) => <li key={o.op} className="sc-row"><div><b>{o.pallet} {o.kind === 'release' ? `leaving ${o.from}` : `to ${o.to}`}</b><span>Not confirmed yet. Sent {o.attempts} time{o.attempts === 1 ? '' : 's'} by {o.by || 'staff'}.</span></div></li>)}</ul>
      </section>}

      {exc && exc.needs_action + (exc.off_floor || []).length > 0 && <section className="panel pad" data-testid="pa-exceptions">
        <header className="panelhead"><h3>ShipBay records to settle</h3><span>{num(exc.needs_action)} need action</span></header>
        <ul className="sc-list">
          {(exc.departed_with_stock || []).map((x) => <li key={x.pallet_id} className="sc-row"><div><b>{x.pallet} left {x.left_from} with {num(x.units)} units still on the books</b><span>{x.brand}. {x.action}</span></div></li>)}
          {(exc.held_in_shipbay_only || []).map((x) => <li key={x.pallet_id} className="sc-row"><div><b>{x.pallet} shows {x.position} in ShipBay only</b><span>{x.action}</span></div></li>)}
          {(exc.stops_without_pallet || []).map((x) => <li key={x.task} className="sc-row"><div><b>Wave {x.wave}: {num(x.units)} planned from {x.pallet} at {x.stop_position}</b><span>{x.action}</span></div></li>)}
          {(exc.off_floor || []).map((x) => <li key={x.pallet_id} className="sc-row"><div><b>{x.pallet} is off the shared floor with {num(x.units)} units</b><span>{x.brand} · left {x.left_from}. {x.action}</span></div></li>)}
        </ul>
      </section>}

      {floor?.ok && <section className="panel pad" data-testid="wm-labels">
        <header className="panelhead"><h3>Position labels</h3><span>4 × 6, with the LOC- barcode the scan reads</span></header>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" data-testid="wm-print-one" disabled={!targetPos} onClick={() => printPositions([at])}>{targetPos ? `Print ${at}` : 'Tap a position to print one'}</button>
          <button className="btn sm" data-testid="wm-print-all" onClick={() => printPositions(posCodes)}>Print all {num(posCodes.length)}</button>
        </div>
      </section>}
      {live === false && status?.ok && <p className="sm">Connection: {status.connection}.</p>}
    </>
  );
}
