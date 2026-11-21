// Nexus screens: Overview, Pallets, FIFO, Cycle counts, Connections. Every read and write goes through a nexus_* function.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, num, day, stamp } from './lib.js';
import FloorMap from './FloorMap.jsx';

const TABS = [['overview', 'Overview'], ['map', 'Locations'], ['pallets', 'Pallets'], ['fifo', 'FIFO'], ['counts', 'Cycle counts'], ['connections', 'Connections']];
const STATUS = { open: 'Cartons to scan', counted: 'To put away', stored: 'Stored' };
const RESULT = { pending: 'Not counted yet', found: 'Found', misplaced: 'Wrong position', missing: 'Missing', unexpected: 'Not expected here' };
const useRpc = (fn, args, deps) => {
  const [s, set] = useState({ data: null, error: null, n: 0 });
  const load = () => supabase.rpc(fn, args).then(({ data, error }) => set((x) => ({ data: error ? x.data : data, error: error?.message || null, n: x.n + 1 })));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, deps);   // live: re-read every 15 s
  return [s.data, s.error, load];
};

export default function Nexus({ me, onSignOut, embed }) {
  const [tab, setTab] = useState('overview');
  if (embed) return <main className="embed"><FloorMap compact /></main>;
  const [ov, ovErr, reloadOv] = useRpc('nexus_overview', {}, []);
  const brands = ov?.brands || []; const zones = (ov?.zones || []).map((z) => z.zone).filter((z) => z !== '—');
  const tabs = TABS.filter(([k]) => k !== 'connections' || me.role === 'shipbay_admin');
  return (
    <div className="shell">
      <header className="top">
        <img src="/brand/nexus-logo.png" alt="Nexus" />
        <nav>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); if (k === 'overview') reloadOv(); }}>{l}</button>)}</nav>
        <div className="who"><b>{me.full_name || me.email}</b>{onSignOut && <button onClick={onSignOut}>Sign out</button>}</div>
      </header>
      <main>
        {ovErr && <div className="strip bad">{ovErr}</div>}
        {tab === 'overview' && <Overview ov={ov} />}
        {tab === 'map' && <><div className="head"><h1>Locations</h1></div><FloorMap admin={me.role === 'shipbay_admin'} /></>}
        {tab === 'pallets' && <Pallets brands={brands} />}
        {tab === 'fifo' && <Fifo brands={brands} />}
        {tab === 'counts' && <Counts brands={brands} zones={zones} />}
        {tab === 'connections' && <Connections brands={brands} />}
      </main>
    </div>
  );
}

function Overview({ ov }) {
  if (!ov) return <div className="empty">Loading…</div>;
  const t = ov.brands.reduce((a, b) => ({ s: a.s + b.pallets_stored, w: a.w + b.pallets_waiting, h: a.h + b.pallets_on_hold }), { s: 0, w: 0, h: 0 });
  return (
    <>
      <div className="head"><h1>Warehouse</h1>
        <div className="glance" data-testid="glance">
          <div><b>{num(t.s)}</b><small>Pallets stored</small></div><div><b className={t.w ? 'hot' : ''}>{num(t.w)}</b><small>Waiting for put-away</small></div>
          <div><b className={t.h ? 'hot' : ''}>{num(t.h)}</b><small>On hold</small></div><div><b>{num(ov.locations.used)} / {num(ov.locations.total)}</b><small>Positions used</small></div>
        </div></div>
      <div className="grid2">
        <section><h2>By brand</h2>
          <table data-testid="brand-table"><thead><tr><th>Brand</th><th className="n">Stored</th><th className="n">Waiting</th><th className="n">On hold</th><th className="n">Units on hand</th><th>Last change</th></tr></thead>
            <tbody>{ov.brands.map((b) => <tr key={b.org_id}><td><b>{b.brand}</b></td><td className="n">{num(b.pallets_stored)}</td><td className="n">{num(b.pallets_waiting)}</td><td className="n">{num(b.pallets_on_hold)}</td><td className="n">{num(b.units_on_hand)}</td><td>{stamp(b.last_change)}</td></tr>)}</tbody></table>
          {ov.brands.length === 0 && <div className="empty">No pallets on file yet.</div>}</section>
        <section><h2>By zone</h2>
          {ov.zones.map((z) => <div className="zone" key={z.zone}><div><b>{z.zone}</b><span>{z.used} of {z.positions} positions</span></div><div className="bar"><i style={{ width: `${z.positions ? Math.round((z.used / z.positions) * 100) : 0}%` }} /></div></div>)}
          {ov.zones.length === 0 && <div className="empty">No pallet positions set up.</div>}</section>
      </div>
    </>
  );
}

function Pallets({ brands }) {
  const [org, setOrg] = useState(''); const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const [rows, err] = useRpc('nexus_pallets', { p_org: org || null, p_q: q || null }, [org, q]);
  const list = (rows || []).filter((r) => !status || (status === 'held' ? r.held : r.status === status && !r.held));
  return (
    <>
      <div className="head"><h1>Pallets</h1><div className="glance"><div><b>{num(list.length)}</b><small>Shown</small></div></div></div>
      <div className="filters">
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="stored">Stored</option><option value="counted">To put away</option><option value="open">Cartons to scan</option><option value="held">On hold</option></select>
        <input aria-label="Search" placeholder="Pallet, position or item…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <div className="strip bad">{err}</div>}
      <table data-testid="pallet-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Item</th><th>Position</th><th>Status</th><th className="n">Cartons</th><th className="n">Units</th><th>Received</th><th className="n">Age</th><th className="n">Labels printed</th></tr></thead>
        <tbody>{list.map((r) => <tr key={r.id}><td className="code">{r.psku}</td><td>{r.org_name}</td><td>{r.item_name}{r.item_no ? <span className="sm"> · {r.item_no}</span> : null}</td><td className="code">{r.location_code || '—'}</td>
          <td><span className={`pill ${r.held ? 'held' : r.status}`}>{r.held ? 'On hold' : STATUS[r.status] || r.status}</span></td><td className="n">{r.cartons ?? '—'}</td><td className="n">{r.units_total ?? '—'}</td><td>{day(r.received_at)}</td><td className="n">{r.age_days}d</td><td className="n" title={r.last_printed_at ? `last ${stamp(r.last_printed_at)}` : ''}>{r.label_prints ? `${r.label_prints}×` : 'Not printed'}</td></tr>)}</tbody></table>
      {rows && list.length === 0 && <div className="empty">Nothing matches.</div>}
    </>
  );
}

function Fifo({ brands }) {
  const [org, setOrg] = useState(''); const [sku, setSku] = useState('');
  const [prods] = useRpc('nexus_products', { p_org: org || null }, [org]);
  const [rows, err] = useRpc('nexus_fifo', { p_org: org || null, p_sku: sku || null }, [org, sku]);
  return (
    <>
      <div className="head"><h1>FIFO</h1></div>
      <div className="filters">
        <select aria-label="Brand" value={org} onChange={(e) => { setOrg(e.target.value); setSku(''); }}><option value="">Choose a brand…</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <select aria-label="Product" value={sku} onChange={(e) => setSku(e.target.value)} disabled={!org}><option value="">Choose a product…</option>{(org ? prods || [] : []).map((p) => <option key={p.sku_id} value={p.sku_id}>{p.sku} · {p.name} ({p.pallets})</option>)}</select>
      </div>
      {err && sku && <div className="strip bad">{err}</div>}
      {!sku ? <div className="empty">Pick a brand and a product to see which pallet to pull first.</div> : (
        <table data-testid="fifo-table"><thead><tr><th className="n">Pull</th><th>Pallet</th><th>Position</th><th>Zone</th><th>Received</th><th className="n">Age</th><th className="n">On hand at position</th></tr></thead>
          <tbody>{(rows || []).map((r) => <tr key={r.psku} className={r.pick_order === 1 ? 'first' : ''}><td className="n"><b>{r.pick_order === 1 ? 'First' : r.pick_order}</b></td><td className="code">{r.psku}</td><td className="code">{r.location_code}</td><td>{r.zone || '—'}</td><td>{day(r.received_at)}</td><td className="n">{r.age_days}d</td><td className="n">{num(r.on_hand_here)}</td></tr>)}</tbody></table>)}
    </>
  );
}

function Counts({ brands, zones }) {
  const [list, err, reload] = useRpc('nexus_counts_list', {}, []);
  const [open, setOpen] = useState(null); const [zone, setZone] = useState(''); const [org, setOrg] = useState(''); const [msg, setMsg] = useState(null);
  const start = async () => {
    setMsg(null); const { data, error } = await supabase.rpc('nexus_count_start', { p_zone: zone || null, p_org: org || null });
    if (error) return setMsg({ kind: 'bad', text: error.message }); await reload(); setOpen(data);
  };
  if (open) return <Count id={open} info={(list || []).find((c) => c.id === open)} back={() => { setOpen(null); reload(); }} />;
  return (
    <>
      <div className="head"><h1>Cycle counts</h1></div>
      <div className="filters">
        <select aria-label="Zone" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">Whole warehouse</option>{zones.map((z) => <option key={z} value={z}>Zone {z}</option>)}</select>
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <button className="btn primary" onClick={start}>Start a count</button>
      </div>
      {(msg || err) && <div className="strip bad">{msg?.text || err}</div>}
      <table data-testid="count-table"><thead><tr><th>Started</th><th>Area</th><th>By</th><th>Status</th><th className="n">Found</th><th className="n">Wrong position</th><th className="n">Missing</th><th className="n">Not expected</th><th /></tr></thead>
        <tbody>{(list || []).map((c) => <tr key={c.id}><td>{stamp(c.started_at)}</td><td>{[c.zone ? `Zone ${c.zone}` : 'Whole warehouse', c.brand].filter(Boolean).join(' · ')}</td><td>{c.started_by}</td><td><span className={`pill ${c.status}`}>{c.status === 'open' ? 'Open' : 'Closed'}</span></td>
          <td className="n">{c.totals.found || 0}</td><td className="n">{c.totals.misplaced || 0}</td><td className="n">{c.totals.missing || 0}</td><td className="n">{c.totals.unexpected || 0}</td><td><button className="btn sm" onClick={() => setOpen(c.id)}>{c.status === 'open' ? 'Count' : 'View'}</button></td></tr>)}</tbody></table>
      {list && list.length === 0 && <div className="empty">No counts yet.</div>}
    </>
  );
}

function Count({ id, info, back }) {
  const [lines, err, reload] = useRpc('nexus_count_lines_list', { p_count: id }, [id]);
  const [loc, setLoc] = useState(''); const [psku, setPsku] = useState(''); const [last, setLast] = useState(null); const [closed, setClosed] = useState(info?.status === 'closed');
  const pRef = useRef(null); const lRef = useRef(null);
  const scan = async (e) => {
    e.preventDefault(); if (!loc.trim() || !psku.trim()) return;
    const { data, error } = await supabase.rpc('nexus_count_scan', { p_count: id, p_location: loc, p_psku: psku });
    setLast(error ? { kind: 'bad', text: error.message } : { kind: data.result === 'found' ? 'ok' : 'bad', text: `${data.psku}: ${RESULT[data.result]}${data.result === 'misplaced' ? ` (belongs in ${data.expected}, seen in ${data.seen})` : ''}` });
    setPsku(''); pRef.current?.focus(); reload();
  };
  const close = async () => { const { error } = await supabase.rpc('nexus_count_close', { p_count: id }); if (error) return setLast({ kind: 'bad', text: error.message }); setClosed(true); reload(); };
  const left = (lines || []).filter((l) => l.result === 'pending').length;
  return (
    <>
      <div className="head"><div><button className="back" onClick={back}>‹ Cycle counts</button><h1>{info?.zone ? `Zone ${info.zone}` : 'Whole warehouse'}{info?.brand ? ` · ${info.brand}` : ''}</h1></div>
        <div className="glance"><div><b className={left ? 'hot' : ''}>{left}</b><small>Left to count</small></div><div><b>{(lines || []).length}</b><small>Pallets</small></div></div></div>
      {!closed && <form className="filters" onSubmit={scan}>
        <input ref={lRef} aria-label="Position" placeholder="Scan position" value={loc} onChange={(e) => setLoc(e.target.value)} autoFocus />
        <input ref={pRef} aria-label="Pallet" placeholder="Scan pallet label" value={psku} onChange={(e) => setPsku(e.target.value)} />
        <button className="btn primary">Record</button><span className="spacer" /><button type="button" className="btn" onClick={close}>Finish count</button>
      </form>}
      {closed && <div className="strip ok">Count closed. Nothing was moved or adjusted; the differences below are for an admin to act on.</div>}
      {(last || err) && <div className={`strip ${last?.kind || 'bad'}`} data-testid="count-last">{last?.text || err}</div>}
      <table data-testid="line-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Expected</th><th>Seen</th><th>Result</th><th>By</th></tr></thead>
        <tbody>{(lines || []).map((l) => <tr key={l.psku}><td className="code">{l.psku}</td><td>{l.brand}</td><td className="code">{l.expected || '—'}</td><td className="code">{l.seen || '—'}</td><td><span className={`pill r-${l.result}`}>{RESULT[l.result]}</span></td><td>{l.counted_by || '—'}</td></tr>)}</tbody></table>
    </>
  );
}

function Connections({ brands }) {
  const [list, err, reload] = useRpc('nexus_clients_list', {}, []);
  const [name, setName] = useState(''); const [picked, setPicked] = useState([]); const [made, setMade] = useState(null); const [msg, setMsg] = useState(null);
  const create = async (e) => {
    e.preventDefault(); setMsg(null); setMade(null);
    const { data, error } = await supabase.rpc('nexus_client_create', { p_name: name, p_org_ids: picked });
    if (error) return setMsg(error.message); setMade(data); setName(''); setPicked([]); reload();
  };
  const toggle = async (c) => { await supabase.rpc('nexus_client_set_active', { p_id: c.id, p_active: !c.active }); reload(); };
  const base = useMemo(() => `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc`, []);
  return (
    <>
      <div className="head"><h1>Connections</h1></div>
      <section><h2>Connect a WMS</h2>
        <form className="filters" onSubmit={create}>
          <input aria-label="WMS name" placeholder="Name, e.g. Souled Sneakers WMS" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="checks">{brands.map((b) => <label key={b.org_id}><input type="checkbox" checked={picked.includes(b.org_id)} onChange={() => setPicked(picked.includes(b.org_id) ? picked.filter((x) => x !== b.org_id) : [...picked, b.org_id])} />{b.brand}</label>)}</div>
          <button className="btn primary" disabled={!name.trim() || !picked.length}>Create key</button>
        </form>
        {(msg || err) && <div className="strip bad">{msg || err}</div>}
        {made && <div className="strip ok" data-testid="new-key"><b>Copy this key now. It is shown once and not stored.</b><code>{made.key}</code></div>}
      </section>
      <table data-testid="client-table"><thead><tr><th>WMS</th><th>Brands it can see</th><th>Status</th><th>Last used</th><th /></tr></thead>
        <tbody>{(list || []).map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{(c.brands || []).join(', ')}</td><td><span className={`pill ${c.active ? 'stored' : 'closed'}`}>{c.active ? 'Active' : 'Off'}</span></td><td>{stamp(c.last_used_at)}</td><td><button className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Turn off' : 'Turn on'}</button></td></tr>)}</tbody></table>
      <section className="api"><h2>What a connected WMS can ask</h2>
        <p>Send a POST with the key to any of these. Answers cover only the brands on that connection, and nothing can be changed through them.</p>
        <pre>{`POST ${base}/nexus_api_counts    {"p_key": "<key>"}                      pallet and unit counts per brand
POST ${base}/nexus_api_pallets   {"p_key": "<key>"}                      every pallet: position, status, age
POST ${base}/nexus_api_fifo      {"p_key": "<key>", "p_sku": "<SKU>"}    which pallet to pull first`}</pre></section>
    </>
  );
}
