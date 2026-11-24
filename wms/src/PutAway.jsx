// WMS → Put away: place, move and release pallets on the shared floor. ShipBay checks its own rules, Nexus decides who
// stands where, and only then does ShipBay record it. Every answer on this screen comes from ShipBay's bridge; the browser
// never talks to Nexus. Only present in a build made with VITE_NEXUS_BRIDGE=on.
//   A position is released only here, by a person who confirms at the position that the pallet is no longer standing in it.
//   Nothing else on this screen, and nothing in the bridge, frees a position.
import { useEffect, useState } from 'react';
import { bridge } from './nexusBridge.js';
import { ScanBox, beep, normPsku } from './parts.jsx';

const loc = (s) => String(s || '').trim().toUpperCase().replace(/^LOC-/, '');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const MODES = [['putaway', 'Put away'], ['move', 'Move a stored pallet'], ['release', 'Pallet left the floor']];
const REASONS = [['shipped_out', 'Shipped out'], ['emptied_and_removed', 'Emptied and removed'], ['moved_off_shared_floor', 'Moved off the shared floor'], ['correction', 'Correction (admin only)']];
const NO_PALLET_RESET = ['location_full', 'location_blocked', 'location_unavailable', 'location_not_found'];

export default function PutAway() {
  const [mode, setMode] = useState('putaway');
  const [psku, setPsku] = useState(null); const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);                // { tone: 'ok' | 'bad' | 'wait', title, text, again? }
  const [floor, setFloor] = useState(null); const [status, setStatus] = useState(null); const [open, setOpen] = useState([]);
  const [rel, setRel] = useState({ at: null, reason: '', sure: false });   // release: the position scanned, why, and the confirmation
  const [sure, setSure] = useState({});                  // per out-of-sync request: the admin's confirmation tick
  const [exc, setExc] = useState(null);                  // admin only: ShipBay's own exceptions. A report: nothing in it deducts stock.

  const refresh = async () => {
    const [s, f, p] = await Promise.all([bridge('/status'), bridge('/floor'), bridge('/pending')]);
    setStatus(s); setFloor(f.ok ? f : { ok: false, message: f.message }); if (p.ok) setOpen(p.open || []);
    if (s.ok && s.connection !== 'off') { const r = await bridge('/reconcile'); setExc(r.ok ? r.exceptions || null : null); }   // 403 for floor staff: the section simply does not show
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 60000); return () => clearInterval(t); }, []);
  const pick = (m) => { setMode(m); setPsku(null); setLast(null); setRel({ at: null, reason: '', sure: false }); };

  const call = async (path, body, done) => {
    setBusy(true); setLast(null); const r = await bridge(path, { method: 'POST', body }); setBusy(false);
    if (r.ok) { beep('ok'); setPsku(null); setRel({ at: null, reason: '', sure: false }); setLast({ tone: 'ok', ...done(r) }); }
    else if (r.pending || r.status === 0) { beep('bad'); setLast({ tone: 'wait', title: 'Not confirmed.', text: r.message, again: () => call(path, body, done) }); }
    else { beep('bad'); setLast({ tone: 'bad', title: r.error === 'out_of_sync' ? 'Needs an admin.' : 'Not done.', text: r.message || 'The request was refused.' }); if (!NO_PALLET_RESET.includes(r.error)) setPsku(null); }
    refresh();
  };
  const place = (p, to) => call(mode === 'move' ? '/move' : '/putaway', { psku: p, location: to },
    (r) => ({ title: `${r.psku} is at ${r.location}.`, text: mode === 'move' ? `Moved from ${r.from}. Quantity unchanged.` : `${num(r.units_posted)} units are on the shelf count.` }));
  const release = (p) => call('/release', { psku: p, location: rel.at, reason: rel.reason, confirmed: true }, (r) => ({ title: `${r.from} is free.`, text: r.note ? `${r.psku} left the floor. ${r.note}` : r.pallet_status === 'off_floor' ? `${r.psku} is off the shared floor and still in ShipBay custody. Its stock is kept.` : `${r.psku} left the floor. Its stock was not changed.` }));
  const retryAll = async () => { setBusy(true); const r = await bridge('/pending/retry', { method: 'POST' }); setBusy(false);
    setLast(r.ok ? { tone: r.results.every((x) => x.ok) ? 'ok' : 'bad', title: 'Sent again.', text: r.results.map((x) => `${x.pallet} ${x.kind} ${x.to || x.from}: ${x.ok ? 'confirmed' : 'not confirmed'}`).join(' · ') || 'Nothing was waiting.' } : { tone: 'wait', title: 'Not confirmed.', text: r.message }); refresh(); };
  const resolve = (o, how) => call(how === 'record' ? '/reconcile/record' : '/reconcile/undo', { op: o.op, confirmed: true },
    (r) => (how === 'record' ? { title: `${r.psku} is recorded at ${r.location}.`, text: 'ShipBay now matches Nexus.' } : { title: `${o.to} is free.`, text: `Nexus no longer holds ${o.pallet} there. ShipBay's record was not changed.` }));

  const lines = (x) => (x.lines || []).map((l) => `${num(l.units)} × ${l.sku} at ${l.position || 'no position'}`).join(' · ');
  const pallets = floor?.ok ? floor.locations.filter((l) => l.kind === 'pallet' || l.kind === 'staging') : [];
  const free = pallets.filter((l) => l.status === 'open' && l.free > 0);
  // what Nexus shows ShipBay for a position: other companies by name and count only (Nexus never sends their pallet ids)
  const others = (l) => (l.occupants || []).filter((o) => o.company !== 'SHIPBAY');
  const taken = pallets.filter((l) => Number(l.used) > 0 || l.status !== 'open');
  const here = rel.at ? pallets.find((l) => l.code === rel.at) : null;
  const closed = status && (!status.ok || status.connection === 'off' || !status.pallet_moves);
  const notOpen = floor?.ok && !floor.moves_enabled;
  const waiting = open.filter((o) => o.state === 'pending'); const broken = open.filter((o) => o.state === 'out_of_sync');

  return (
    <>
      <header className="pagehead">
        <div><h1>Put away<span className="dot">.</span></h1>{floor?.ok && <p className="when" data-testid="pa-floor">Nexus floor {floor.warehouse} · map version {floor.map_version}{status?.ok && !status.pallet_moves ? ' · read-only' : ''}</p>}
          {floor?.ok && floor.checksum && <p className="when" data-testid="pa-checksum" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>Map checksum {floor.checksum}</p>}</div>
        {floor?.ok && <div className="glance"><div><b>{num(free.length)}</b><small>Free positions</small></div><div><b>{num(pallets.reduce((n, l) => n + (l.your_pallets || []).length, 0))}</b><small>ShipBay pallets</small></div><div><b>{num(open.length)}</b><small>Not confirmed</small></div></div>}
      </header>
      {closed && <div className="strip bad" data-testid="pa-closed"><b>Put-away through Nexus is off.</b><span>This environment is not set up to place pallets. Nothing on this screen will store a pallet.</span></div>}
      {floor && !floor.ok && !closed && <div className="strip bad"><b>Nexus is not answering.</b><span>{floor.message} Do not put pallets away until it does.</span><button onClick={refresh}>Try again</button></div>}
      {notOpen && <div className="strip bad" data-testid="pa-notopen"><b>The floor is not open.</b><span>Nexus has not verified the starting occupancy of this floor, so it refuses every put-away.</span></div>}
      {last && <div className={`strip ${last.tone === 'ok' ? 'ok' : 'bad'}`} data-testid="pa-result" data-tone={last.tone}><b>{last.title}</b><span>{last.text}</span>{last.again && <button disabled={busy} onClick={last.again}>Send again</button>}</div>}

      <section className="panel pad">
        <div className="seg" style={{ marginBottom: 16, width: 'fit-content' }}>{MODES.map(([k, label]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => pick(k)}>{label}</button>)}</div>
        {mode !== 'release' && (!psku
          ? <ScanBox key="p" autoFocus placeholder="Scan the pallet label" onScan={(c) => { setLast(null); setPsku(normPsku(c)); }} />
          : (<>
            <div className="hold" data-testid="pa-pallet" style={{ marginBottom: 12 }}><b>{psku}</b> · now scan the position it is standing in. <button className="btn sm" onClick={() => setPsku(null)}>Different pallet</button></div>
            <ScanBox key="l" autoFocus placeholder={busy ? 'Asking Nexus…' : 'Scan the position label'} onScan={(c) => { if (!busy) place(psku, loc(c)); }} />
          </>))}
        {mode === 'release' && (!rel.at
          ? <ScanBox key="r" autoFocus placeholder="Go to the position and scan its label" onScan={(c) => { setLast(null); setRel({ at: loc(c), reason: '', sure: false }); }} />
          : (<div data-testid="pa-release">
            <div className="hold" style={{ marginBottom: 12 }}><b>{rel.at}</b> · {here ? (here.your_pallets || []).length ? 'Nexus has these ShipBay pallets here:' : 'Nexus has no ShipBay pallet here.' : 'Nexus does not list this position.'} <button className="btn sm" onClick={() => setRel({ at: null, reason: '', sure: false })}>Different position</button></div>
            {(here?.your_pallets || []).length > 0 && (<>
              <label style={{ display: 'block', marginBottom: 10 }}>Why did it leave?{' '}
                <select value={rel.reason} onChange={(e) => setRel({ ...rel, reason: e.target.value })} data-testid="pa-reason"><option value="">Choose…</option>{REASONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
              <label className="sc-check" style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={rel.sure} onChange={(e) => setRel({ ...rel, sure: e.target.checked })} data-testid="pa-sure" /> I am standing at {rel.at} and the pallet is no longer in it.</label>
              <ul className="sc-list">{here.your_pallets.map((id) => <li key={id} className="sc-row"><div><b>{id}</b><span>Frees {rel.at} in Nexus. The pallet's stock is not changed.</span></div><div className="r"><button className="btn sm" disabled={busy || !rel.reason || !rel.sure} onClick={() => release(id)}>Release {rel.at}</button></div></li>)}</ul>
            </>)}
          </div>))}
      </section>

      {broken.length > 0 && <section className="panel pad" data-testid="pa-broken">
        <header className="panelhead"><h3>Needs an admin</h3><span>Nexus accepted these and ShipBay did not record them. The positions stay reserved.</span></header>
        <ul className="sc-list">{broken.map((o) => <li key={o.op} className="sc-row"><div><b>{o.pallet} at {o.to || o.from}</b><span>{o.problem || 'ShipBay could not record it.'}</span>
          <label className="sc-check"><input type="checkbox" checked={!!sure[o.op]} onChange={(e) => setSure({ ...sure, [o.op]: e.target.checked })} /> I have been to {o.to || o.from} and checked.</label></div>
          <div className="r"><button className="btn sm" disabled={busy || !sure[o.op]} onClick={() => resolve(o, 'record')}>The pallet is there: record it</button>{o.kind !== 'release' && <button className="btn sm" disabled={busy || !sure[o.op]} onClick={() => resolve(o, 'undo')}>It is not there: free the position</button>}</div></li>)}</ul>
      </section>}

      {exc && exc.needs_action + exc.off_floor.length > 0 && <section className="panel pad" data-testid="pa-exceptions">
        <header className="panelhead"><h3>ShipBay records to settle</h3><span>{num(exc.needs_action)} need action</span></header>
        <ul className="sc-list">
          {exc.departed_with_stock.map((x) => <li key={x.pallet_id} className="sc-row" data-testid="exc-departed"><div><b>{x.pallet} left {x.left_from} with {num(x.units)} units still on the books</b><span>{x.brand} · {lines(x)}. {x.action}</span></div></li>)}
          {exc.held_in_shipbay_only.map((x) => <li key={x.pallet_id} className="sc-row"><div><b>{x.pallet} shows {x.position} in ShipBay only</b><span>{x.action}</span></div></li>)}
          {exc.stops_without_pallet.map((x) => <li key={x.task} className="sc-row"><div><b>Wave {x.wave}: {num(x.units)} planned from {x.pallet} at {x.stop_position}</b><span>The pallet is {x.pallet_position ? `at ${x.pallet_position}` : 'off the floor'}. {x.action}</span></div></li>)}
          {exc.picks_without_pallet.map((x) => <li key={x.position + x.sku} className="sc-row"><div><b>{x.position}: {num(x.units)} × {x.sku} picked with no pallet named</b><span>{x.action}</span></div></li>)}
          {exc.off_floor.map((x) => <li key={x.pallet_id} className="sc-row"><div><b>{x.pallet} is off the shared floor with {num(x.units)} units</b><span>{x.brand} · left {x.left_from}. {x.action}</span></div></li>)}
        </ul>
      </section>}

      {waiting.length > 0 && <section className="panel pad" data-testid="pa-open">
        <header className="panelhead"><h3>Not confirmed by Nexus</h3><button className="btn sm" disabled={busy} onClick={retryAll}>Send all again</button></header>
        <ul className="sc-list">{waiting.map((o) => <li key={o.op} className="sc-row"><div><b>{o.pallet} {o.kind === 'release' ? `leaving ${o.from}` : `to ${o.to}`}</b><span>Not confirmed yet. Sent {o.attempts} time{o.attempts === 1 ? '' : 's'} by {o.by || 'staff'}.</span></div></li>)}</ul>
      </section>}

      {floor?.ok && <section className="panel pad" data-testid="pa-shared">
        <header className="panelhead"><h3>Shared floor</h3><span>{num(taken.length)} of {num(pallets.length)} positions in use</span></header>
        {taken.length === 0 ? <p>No position is in use.</p> : <ul className="sc-list">{taken.map((l) => <li key={l.code} className="sc-row" data-testid={`pa-pos-${l.code}`}><div><b>{l.code}</b><span>{(l.your_pallets || []).length ? `ShipBay: ${l.your_pallets.join(', ')}` : ''}{(l.your_pallets || []).length && others(l).length ? ' · ' : ''}{others(l).map((o) => `${o.company}: ${num(o.pallets)} pallet${o.pallets === 1 ? '' : 's'}`).join(' · ')}</span></div><div className="r">{l.status !== 'open' ? l.status : `${num(l.used)} of ${num(l.capacity)}`}</div></li>)}</ul>}
      </section>}

      {floor?.ok && <section className="panel pad">
        <header className="panelhead"><h3>Free positions</h3><span>{num(free.length)} of {num(pallets.length)}</span></header>
        <p data-testid="pa-free" style={{ lineHeight: 1.9, fontVariantNumeric: 'tabular-nums' }}>{free.map((l) => l.code).join(' · ') || 'None.'}</p>
      </section>}
    </>
  );
}
