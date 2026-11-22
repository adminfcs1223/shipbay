// WMS → Put away: scan the pallet label, scan the position. ShipBay checks its own rules, Nexus decides whether the position
// is free, and only then is the pallet stored and its stock posted. Every answer on this screen comes from ShipBay's bridge;
// the browser never talks to Nexus. Only present in a build made with VITE_NEXUS_BRIDGE=on.
import { useEffect, useState } from 'react';
import { bridge } from './nexusBridge.js';
import { ScanBox, beep, normPsku } from './parts.jsx';

const loc = (s) => String(s || '').trim().toUpperCase().replace(/^LOC-/, '');
const num = (n) => Number(n || 0).toLocaleString('en-US');

export default function PutAway() {
  const [mode, setMode] = useState('putaway');           // 'putaway' = a received pallet · 'move' = a pallet already stored
  const [psku, setPsku] = useState(null); const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);                // { tone: 'ok' | 'bad' | 'wait', title, text, retry? }
  const [floor, setFloor] = useState(null); const [status, setStatus] = useState(null); const [open, setOpen] = useState([]);

  const refresh = async () => {
    const [s, f, p] = await Promise.all([bridge('/status'), bridge('/floor'), bridge('/pending')]);
    setStatus(s); setFloor(f.ok ? f : { ok: false, message: f.message }); if (p.ok) setOpen(p.open || []);
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 60000); return () => clearInterval(t); }, []);

  const send = async (p, to) => {
    setBusy(true); setLast(null); const r = await bridge(mode === 'move' ? '/move' : '/putaway', { method: 'POST', body: { psku: p, location: to } }); setBusy(false);
    if (r.ok) {
      beep('ok'); setPsku(null);
      setLast({ tone: 'ok', title: `${r.psku} is at ${r.location}.`, text: mode === 'move' ? `Moved from ${r.from}. Stock is unchanged.` : `${num(r.units_posted)} units are on the shelf count.` });
    } else if (r.pending || r.status === 0) {
      beep('bad'); setLast({ tone: 'wait', title: 'Not confirmed.', text: r.message, retry: { p, to } });
    } else {
      beep('bad'); setLast({ tone: 'bad', title: 'Not put away.', text: r.message || 'The request was refused.' });
      if (r.error !== 'location_full' && r.error !== 'location_blocked' && r.error !== 'location_unavailable' && r.error !== 'location_not_found') setPsku(null);   // a taken position: keep the pallet, scan another position
    }
    refresh();
  };
  const retryAll = async () => { setBusy(true); const r = await bridge('/pending/retry', { method: 'POST' }); setBusy(false);
    setLast(r.ok ? { tone: r.results.every((x) => x.ok) ? 'ok' : 'bad', title: 'Sent again.', text: r.results.map((x) => `${x.pallet} to ${x.to}: ${x.ok ? 'stored' : 'not stored'}`).join(' · ') || 'Nothing was waiting.' } : { tone: 'wait', title: 'Not confirmed.', text: r.message }); refresh(); };

  const pallets = floor?.ok ? floor.locations.filter((l) => l.kind === 'pallet' || l.kind === 'staging') : [];
  const free = pallets.filter((l) => l.status === 'open' && l.free > 0);
  const closed = status && (!status.ok || status.connection === 'off' || !status.pallet_moves);
  const notOpen = floor?.ok && !floor.moves_enabled;

  return (
    <>
      <header className="pagehead">
        <div><h1>Put away<span className="dot">.</span></h1>{floor?.ok && <p className="when" data-testid="pa-floor">Nexus floor {floor.warehouse} · map version {floor.map_version}</p>}</div>
        {floor?.ok && <div className="glance"><div><b>{num(free.length)}</b><small>Free positions</small></div><div><b>{num(pallets.reduce((n, l) => n + (l.your_pallets || []).length, 0))}</b><small>ShipBay pallets</small></div><div><b>{num(open.length)}</b><small>Not confirmed</small></div></div>}
      </header>
      {closed && <div className="strip bad" data-testid="pa-closed"><b>Put-away through Nexus is off.</b><span>This environment is not set up to place pallets. Nothing on this screen will store a pallet.</span></div>}
      {floor && !floor.ok && !closed && <div className="strip bad"><b>Nexus is not answering.</b><span>{floor.message} Do not put pallets away until it does.</span><button onClick={refresh}>Try again</button></div>}
      {notOpen && <div className="strip bad" data-testid="pa-notopen"><b>The floor is not open.</b><span>Nexus has not verified the starting occupancy of this floor, so it refuses every put-away.</span></div>}
      {last && <div className={`strip ${last.tone === 'ok' ? 'ok' : 'bad'}`} data-testid="pa-result" data-tone={last.tone}><b>{last.title}</b><span>{last.text}</span>{last.retry && <button disabled={busy} onClick={() => send(last.retry.p, last.retry.to)}>Send again</button>}</div>}

      <section className="panel pad">
        <div className="seg" style={{ marginBottom: 16, width: 'fit-content' }}>
          <button className={mode === 'putaway' ? 'on' : ''} onClick={() => { setMode('putaway'); setPsku(null); setLast(null); }}>Put away</button>
          <button className={mode === 'move' ? 'on' : ''} onClick={() => { setMode('move'); setPsku(null); setLast(null); }}>Move a stored pallet</button>
        </div>
        {!psku
          ? <ScanBox key="p" autoFocus placeholder="Scan the pallet label" onScan={(c) => { setLast(null); setPsku(normPsku(c)); }} />
          : (<>
            <div className="hold" data-testid="pa-pallet" style={{ marginBottom: 12 }}><b>{psku}</b> · now scan the position it is standing in. <button className="btn sm" onClick={() => setPsku(null)}>Different pallet</button></div>
            <ScanBox key="l" autoFocus placeholder={busy ? 'Asking Nexus…' : 'Scan the position label'} onScan={(c) => { if (!busy) send(psku, loc(c)); }} />
          </>)}
      </section>

      {open.length > 0 && <section className="panel pad" data-testid="pa-open">
        <header className="panelhead"><h3>Not confirmed by Nexus</h3><button className="btn sm" disabled={busy} onClick={retryAll}>Send all again</button></header>
        <ul className="sc-list">{open.map((o) => <li key={o.op} className="sc-row"><div><b>{o.pallet} to {o.to}</b><span>{o.state === 'stuck' ? 'Needs an admin: Nexus and ShipBay disagree. Leave the pallet where it is.' : `Not stored yet. Sent ${o.attempts} time${o.attempts === 1 ? '' : 's'} by ${o.by || 'staff'}.`}</span></div></li>)}</ul>
      </section>}

      {floor?.ok && <section className="panel pad">
        <header className="panelhead"><h3>Free positions</h3><span>{num(free.length)} of {num(pallets.length)}</span></header>
        <p data-testid="pa-free" style={{ lineHeight: 1.9, fontVariantNumeric: 'tabular-nums' }}>{free.map((l) => l.code).join(' · ') || 'None.'}</p>
      </section>}
    </>
  );
}
