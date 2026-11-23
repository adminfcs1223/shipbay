// Orders → brand → wave → pack. Built for a phone held in one hand, one step on screen at a time.
// Orders arrive from each brand's own program through the connector (POST /api/orders); the WMS never fetches them.
// The picker never sees every order or every item: they open one wave (one trip), walk its stops in route order
// (far end first, ending at the pack station), confirm the exact units taken at each stop (stock leaves the position
// and its pallet only then), are sent back to the pack station, and pack the orders they just picked. Identical orders
// are packed together; an order can be split into several packages. A short stop goes to a manager and never blocks.
// The earlier pick-list screen is in git history (last at 7a52155).
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib';
import { beep, ScanBox } from './parts';
import { barcodeSvg } from './label';
import { printPages } from './print';
import { demoOrders } from './demo';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const byCode = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const PROBLEM = { missing: 'Not at the location', short: 'Short', other: 'Other problem' };
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

export default function Orders({ me, startBrand, clearStart }) {
  const [brands, setBrands] = useState(null); const [err, setErr] = useState(null);
  const [brand, setBrand] = useState(null); const [busy, setBusy] = useState(false);
  const load = async () => { const { data, error } = await supabase.rpc('wms_order_brands'); if (error) setErr(error.message); else { setErr(null); setBrands(data || []); } return data || []; };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (startBrand && brands) { const b = brands.find((x) => x.id === startBrand); if (b) setBrand(b); clearStart(); } }, [startBrand, brands]);

  const loadDemo = async () => {
    setBusy(true); setErr(null);
    const problem = await resetDemo();
    setBusy(false); if (problem) return setErr(problem);
    const rows = await load(); const b = rows.find((x) => x.client_code === 'DEMO'); if (b) setBrand(b);
  };

  if (brand) return <Brand me={me} brand={brand} back={() => { setBrand(null); load(); }} />;
  const due = (brands || []).reduce((s, b) => s + b.due_orders, 0);
  return (
    <>
      <header className="pagehead">
        <h1>Orders<span className="dot">.</span></h1>
        <div className="glance"><div><b className={due ? 'hot' : ''}>{num(due)}</b><small>To ship today</small></div><div><b>{num((brands || []).reduce((s, b) => s + b.ready, 0))}</b><small>Ready to pack</small></div></div>
      </header>
      {err && <div className="strip bad"><span>{err}</span><button onClick={() => { setErr(null); load(); }}>Try again</button></div>}
      {!brands ? <div className="empty">Loading…</div> : (
        <ul className="brandlist">
          {brands.map((b) => (
            <li key={b.id}><button onClick={() => setBrand(b)}>
              <div><b>{b.name}</b><span>{b.open_orders ? `${num(b.open_orders)} open order${b.open_orders === 1 ? '' : 's'}${b.ready ? ` · ${b.ready} ready to pack` : ''}` : b.ready ? `${b.ready} ready to pack` : 'No open orders'}</span></div>
              <div className="r"><b className={b.due_units ? 'hot' : ''}>{num(b.due_units)}</b><span>units to pick today</span></div>
            </button></li>
          ))}
          {!brands.some((b) => b.client_code === 'DEMO') && (
            <li className="demo"><button onClick={loadDemo} disabled={busy}><div><b>Demo Brand</b><span>{busy ? 'Loading sample data…' : 'Load 12 sample products and 8 sample orders to see the whole flow'}</span></div></button></li>
          )}
        </ul>
      )}
    </>
  );
}

// Rebuilds Demo Brand, then sends its orders through the real connector with the key the reset hands back.
async function resetDemo() {
  const { data, error } = await supabase.rpc('wms_demo_reset');
  if (error || !data?.key) return error?.message || 'The demo could not be reset.';
  for (const order of demoOrders(data.today)) {
    let res;
    try { res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.key}` }, body: JSON.stringify(order) }); }
    catch { return 'The orders endpoint could not be reached.'; }
    if (!res.ok) { let m = ''; try { m = (await res.json()).message; } catch { /* no body */ } return `Order ${order.order_number} was refused (${res.status}). ${m || ''}`; }
  }
  return null;
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sigOf = (o) => o.lines.map((l) => `${l.key}x${l.qty}`).join('|');
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

/* One package label per package, 4 x 6. It names the order, the ship-to and what is inside. It is not a carrier label. */
const PKG_CSS = `.pklabel { width: 4in; height: 6in; box-sizing: border-box; padding: .22in; font-family: Archivo, Arial, sans-serif; color: #000; display: flex; flex-direction: column; gap: .1in; }
.pklabel h1 { font-size: .3in; margin: 0; line-height: 1.05; } .pklabel h2 { font-size: .2in; margin: 0; } .pklabel .of { font-size: .34in; font-weight: 800; border: 3px solid #000; padding: .04in .12in; align-self: flex-start; }
.pklabel .to { font-size: .17in; line-height: 1.25; border-top: 2px solid #000; padding-top: .08in; } .pklabel ul { margin: 0; padding: 0; list-style: none; font-size: .15in; flex: 1; overflow: hidden; } .pklabel li { display: flex; justify-content: space-between; gap: .1in; border-bottom: 1px solid #999; padding: .03in 0; }
.pklabel .bc { height: .8in; } .pklabel .bc svg { width: 100%; height: 100%; } .pklabel .code { font-family: monospace; font-size: .15in; text-align: center; letter-spacing: .08em; } .pklabel small { font-size: .11in; }`;
function packageLabelHtml(brand, o, k) {
  const a = o.ship_to || {}; const names = Object.fromEntries(o.lines.map((l) => [l.key, l.name]));
  const to = [a.name || o.customer, a.company, a.address1, a.address2, [a.city, a.province_code || a.province, a.zip].filter(Boolean).join(', '), a.country_code && a.country_code !== 'US' ? a.country_code : null].filter(Boolean);
  return `<div class="pklabel"><h2>${esc(brand)}</h2><h1>Order ${esc(o.order_number)}</h1><div class="of">Package ${k.seq} of ${k.of}</div>
    <div class="to">${to.length ? to.map(esc).join('<br>') : 'No ship-to on the order'}</div>
    <ul>${k.items.map((it) => `<li><span>${esc(names[it.key] || it.key)}</span><b>× ${it.qty}</b></li>`).join('')}</ul>
    <div class="bc">${barcodeSvg(k.code)}</div><div class="code">${esc(k.code)}</div><small>Package label. The carrier label goes on separately.</small></div>`;
}
const printPackageLabels = (brand, orders) => printPages(orders.flatMap((o) => o.packages.map((k) => packageLabelHtml(brand, o, k))), 'pklabel', '4in 6in', 'Package labels', true, PKG_CSS);

function Brand({ me, brand, back }) {
  const [sum, setSum] = useState(null); const [wave, setWave] = useState(null); const [short, setShort] = useState(null);
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const loadSum = async () => { const { data, error } = await supabase.rpc('wms_orders_summary', { p_org: brand.id }); if (error) { setErr(error.message); return null; } setSum(data); return data; };
  useEffect(() => { (async () => {
    const s = await loadSum();
    if (s?.my_wave) { const { data } = await supabase.rpc('wms_wave', { p_wave: s.my_wave }); if (data) setWave(data); }   // pick up where this login left off
    setReady(true);
  })(); }, []);
  const start = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc('wms_wave_start', { p_org: brand.id }); setBusy(false);
    if (error) return setErr(error.message);
    setShort(data.short || []); setWave(data.wave || null); if (!data.wave) loadSum();
  };
  const leave = () => { setWave(null); setShort(null); loadSum(); };
  const resolve = async (line) => { const { error } = await supabase.rpc('wms_resolve_problem', { p_lines: [line] }); if (error) setErr(error.message); loadSum(); };

  if (wave?.status === 'picking') return <Pick brand={brand} wave={wave} setWave={setWave} leave={leave} manager={!!sum?.manager} />;
  if (wave?.status === 'packing') return <Pack brand={brand} wave={wave} setWave={setWave} leave={leave} />;
  if (wave?.status === 'done') return <WaveDone brand={brand} wave={wave} next={start} busy={busy} leave={leave} err={err} />;
  return (
    <>
      <header className="pagehead">
        <div><button className="backlink" onClick={back}>‹ Brands</button><h1>{brand.name}<span className="dot">.</span></h1></div>
        {sum && <div className="glance"><div><b className={sum.to_pick ? 'hot' : ''}>{num(sum.to_pick)}</b><small>Orders to pick</small></div><div><b>{num(sum.packed_today)}</b><small>Packed today</small></div></div>}
      </header>
      {err && <div className="strip bad"><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}
      {!ready ? <div className="empty">Loading…</div> : (
        <div className="wv-start" data-testid="wave-start">
          {short && !wave && <div className="strip bad" data-testid="no-wave"><span>{short.length ? `No wave can be built: the stock on file does not cover ${plural(new Set(short.map((s) => s.order_number)).size, 'open order')}. A manager has the list.` : 'There are no orders to pick right now.'}</span></div>}
          <button className="btn big go" data-testid="start-wave" onClick={start} disabled={busy || (sum && sum.to_pick === 0)}>{busy ? 'Building your wave…' : sum && sum.to_pick === 0 ? 'Nothing to pick' : 'Start the next wave'}</button>
          <p className="wv-note">You get one trip at a time: the stops in walking order, ending at your pack station. Then you pack what you picked.</p>
          {brand.client_code === 'DEMO' && <button className="swap" disabled={busy} onClick={async () => { setBusy(true); const problem = await resetDemo(); setBusy(false); setShort(null); if (problem) setErr(problem); loadSum(); }}>Reset the demo data</button>}
          {sum && sum.other_waves.length > 0 && <p className="wv-note">{sum.other_waves.map((w) => `Wave ${w.seq}: ${w.picker} (${w.status})`).join(' · ')}</p>}
          {sum && sum.with_manager > 0 && !sum.manager && <p className="wv-note" data-testid="with-manager">{plural(sum.with_manager, 'order')} {sum.with_manager === 1 ? 'is' : 'are'} with a manager.</p>}
          {sum?.manager && (sum.problems.length > 0 || (short && short.length > 0)) && (
            <section className="panel wv-mgr" data-testid="manager">
              <div className="panelhead"><h3>Needs a manager</h3><span>{plural(sum.problems.length + (short || []).length, 'item')}</span></div>
              <table className="grid"><thead><tr><th>Order</th><th>Item</th><th>What happened</th><th>Where</th><th>Reported</th><th /></tr></thead><tbody>
                {sum.problems.map((p) => <tr key={p.line_id}><td className="code">{p.order_number}</td><td>{p.name}</td><td>{PROBLEM[p.kind] || p.kind}{p.found != null ? `: ${p.found} of ${p.need} picked` : ''}{p.note ? ` · ${p.note}` : ''}</td><td className="code">{p.location || '—'}</td><td>{p.by || '—'}</td>
                  <td><button className="btn sm" onClick={() => resolve(p.line_id)}>Back to the pick list</button></td></tr>)}
                {(short || []).map((s, i) => <tr key={`s${i}`}><td className="code">{s.order_number}</td><td className="code">{s.sku}</td><td>Not enough stock on file: {num(s.need)} needed, {num(s.on_file)} free</td><td>—</td><td>System</td><td /></tr>)}
              </tbody></table>
            </section>
          )}
        </div>
      )}
    </>
  );
}

/* PICK: one stop at a time, in route order. Stock leaves the position only when the exact units are confirmed. */
function Pick({ brand, wave, setWave, leave, manager }) {
  const cur = wave.tasks.find((t) => !t.confirmed) || null;
  const [qty, setQty] = useState(''); const [scan, setScan] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setQty(cur ? String(cur.qty_planned) : ''); setScan(''); setErr(null); }, [cur?.id]);
  const done = wave.tasks.filter((t) => t.confirmed);
  const [fix, setFix] = useState(null);   // a stop that cannot be reopened because its pallet left the floor: { task, to, why }
  const call = async (fn, args) => { setBusy(true); setErr(null); const { data, error } = await supabase.rpc(fn, args); setBusy(false);
    if (error) { beep('bad'); setErr(error.message); if (fn === 'wms_wave_unconfirm' && /pick correction/.test(error.message)) setFix({ task: args.p_task, to: '', why: '' }); return false; } beep('ok'); setWave(data); return true; };
  const correct = async () => { setBusy(true); setErr(null); const { data, error } = await supabase.rpc('wms_pick_correct', { p_kind: 'wave_stop', p_id: fix.task, p_to_location: fix.to, p_reason: fix.why }); setBusy(false);
    if (error) { beep('bad'); return setErr(error.message); } beep('ok'); setFix(null); setWave(data.wave); };
  const fixForm = fix && (manager
    ? <section className="panel pad" data-testid="pick-correct">
        <div className="panelhead"><h3>Manager correction</h3><span>The pallet has left the floor. The picked units go back onto a ShipBay shelf, and the stop is picked again from there.</span></div>
        <label style={{ display: 'block', marginBottom: 8 }}>Shelf the units are going back to <input value={fix.to} onChange={(e) => setFix({ ...fix, to: e.target.value })} placeholder="A-01" data-testid="fix-to" /></label>
        <label style={{ display: 'block', marginBottom: 12 }}>Why <input value={fix.why} onChange={(e) => setFix({ ...fix, why: e.target.value })} placeholder="Order changed after the pallet shipped" data-testid="fix-why" style={{ minWidth: 320 }} /></label>
        <button className="btn sm" disabled={busy || !fix.to.trim() || fix.why.trim().length < 5} onClick={correct} data-testid="fix-go">Return the units to the shelf</button> <button className="swap" disabled={busy} onClick={() => setFix(null)}>Cancel</button>
      </section>
    : <div className="strip" data-testid="pick-correct-ask"><span>Leave the picked units to one side and ask a manager: they return them to a shelf from this screen.</span></div>);
  const confirm = (code) => { const n = Number(qty); if (qty === '' || !Number.isInteger(n) || n < 0) return setErr('Enter how many units you picked.'); return call('wms_wave_confirm', { p_task: cur.id, p_qty: n, p_scan: (typeof code === 'string' ? code : scan) || null }); };
  const handBack = async () => { setBusy(true); const { error } = await supabase.rpc('wms_wave_cancel', { p_wave: wave.id }); setBusy(false); if (error) return setErr(error.message); leave(); };
  const problems = wave.orders.filter((o) => o.pack_state === 'problem');

  if (!cur) return (
    <div className="wv-return" data-testid="return-prompt">
      <small>{brand.name} · wave {wave.seq}</small>
      <h1>Wave picked<span className="dot">.</span></h1>
      <p className="lead">Take everything back to your pack station.</p>
      {problems.length > 0 && <div className="strip bad"><span>{plural(problems.length, 'order')} came up short and went to a manager ({problems.map((o) => o.order_number).join(', ')}). Keep {problems.length === 1 ? 'its' : 'their'} items to one side.</span></div>}
      {err && <div className="strip bad"><span>{err}</span></div>}
      {fixForm}
      <button className="btn big go" data-testid="to-pack" disabled={busy} onClick={() => call('wms_wave_to_pack', { p_wave: wave.id })}>I’m at my pack station · start packing</button>
      <button className="swap" disabled={busy} onClick={() => call('wms_wave_unconfirm', { p_task: done[done.length - 1].id })}>Go back to the last stop</button>
    </div>
  );
  const sameSpot = wave.tasks.filter((t) => !t.confirmed && t.location === cur.location).length;
  return (
    <>
      <header className="pagehead">
        <div><small className="wv-crumb">{brand.name}</small><h1>Wave {wave.seq}<span className="dot">.</span></h1></div>
        <div className="glance"><div><b className="hot">{done.length + 1}</b><small>of {wave.tasks.length} stops</small></div><div><b>{wave.orders.length}</b><small>Orders</small></div></div>
      </header>
      {err && <div className="strip bad" data-testid="pick-err"><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}
      {fixForm}
      <section className="wv-stop" data-testid="stop">
        <div className="wv-where"><small>Go to</small><b>{cur.location}</b>{cur.psku && <span>Pallet {cur.psku}{cur.mixed ? ' · mixed pallet' : ''}</span>}{sameSpot > 1 && <em>{sameSpot} items to pick here</em>}</div>
        <div className="wv-what">{cur.image_url && <img src={cur.image_url} alt="" />}<div><b>{cur.name}</b><span className="code">{cur.sku}</span><span>for {plural(cur.orders, 'order')}</span></div><div className="wv-need"><small>Pick</small><b>{num(cur.qty_planned)}</b></div></div>
        <div className="wv-confirm">
          {cur.needs_scan && <ScanBox value={scan} onChange={setScan} onScan={(code) => { setScan(code); confirm(code); }} placeholder="Scan the item (carton label or barcode)" autoFocus />}
          <label>Units you picked<input className="bignum" data-testid="picked-qty" type="number" min="0" max={cur.qty_planned} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }} /></label>
          <button type="button" className="btn big go" data-testid="confirm-stop" disabled={busy} onClick={() => confirm()}>{Number(qty) === cur.qty_planned ? `Picked all ${num(cur.qty_planned)}` : Number(qty) === 0 && qty !== '' ? 'None here · tell a manager' : `Picked ${qty || '…'} of ${num(cur.qty_planned)} · tell a manager`}</button>
        </div>
      </section>
      <ol className="wv-route" data-testid="route">
        {wave.tasks.map((t) => (
          <li key={t.id} className={t.confirmed ? 'done' : t.id === cur.id ? 'now' : ''}>
            <i>{t.seq}</i><b className="code">{t.location}</b><span>{t.name}</span><em>{t.confirmed ? `${num(t.qty_picked)} of ${num(t.qty_planned)}` : num(t.qty_planned)}</em>
            {t.confirmed && <button className="swap" disabled={busy} onClick={() => call('wms_wave_unconfirm', { p_task: t.id })}>Redo</button>}
          </li>))}
        <li className="end"><i>⌂</i><b>Pack station</b><span>bring everything back here</span></li>
      </ol>
      {done.length === 0 && <button className="swap" disabled={busy} onClick={handBack}>Hand this wave back</button>}
    </>
  );
}

/* PACK: only the orders just picked, one group at a time. Identical orders are one group. An order can go out in several packages. */
function Pack({ brand, wave, setWave, leave }) {
  const pending = wave.orders.filter((o) => o.pack_state === 'pending');
  const groups = useMemo(() => { const m = new Map(); pending.forEach((o) => { const s = sigOf(o); if (!m.has(s)) m.set(s, []); m.get(s).push(o); }); return [...m.values()]; }, [wave]);
  const g = groups[0]; const first = g?.[0];
  const [extra, setExtra] = useState([]); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [printFail, setPrintFail] = useState(null);
  useEffect(() => { setExtra([]); setErr(null); }, [first?.id]);
  if (!g) return null;
  const rest = (key, total) => total - extra.reduce((s, p) => s + (p[key] || 0), 0);
  const pkgs = [Object.fromEntries(first.lines.map((l) => [l.key, rest(l.key, l.qty)])), ...extra];
  const empty = pkgs.findIndex((p) => Object.values(p).reduce((s, n) => s + n, 0) === 0);
  const setQ = (i, key, v, max) => { setErr(null); return setExtra((xs) => xs.map((p, j) => (j === i ? { ...p, [key]: Math.max(0, Math.min(max, Number(v) || 0)) } : p))); };
  const pack = async () => {
    if (empty >= 0) return setErr(`Package ${empty + 1} has nothing in it. Move an item into it or remove it.`);
    setBusy(true); setErr(null);
    const body = pkgs.map((p) => ({ items: Object.entries(p).filter(([, n]) => n > 0).map(([key, qty]) => ({ key, qty })) }));
    const ids = g.map((o) => o.id);
    const { data, error } = await supabase.rpc('wms_wave_pack', { p_wave: wave.id, p_orders: ids, p_packages: body }); setBusy(false);
    if (error) { beep('bad'); return setErr(error.message); }
    beep('ok');
    const packed = data.orders.filter((o) => ids.includes(o.id));
    setPrintFail((await printPackageLabels(brand.name, packed)) ? null : packed); setWave(data);
  };
  const problems = wave.orders.filter((o) => o.pack_state === 'problem'); const packedN = wave.orders.filter((o) => o.pack_state === 'packed').length;
  return (
    <>
      <header className="pagehead">
        <div><small className="wv-crumb">{brand.name} · wave {wave.seq}</small><h1>Pack<span className="dot">.</span></h1></div>
        <div className="glance"><div><b className="hot">{pending.length}</b><small>Orders to pack</small></div><div><b>{packedN}</b><small>Packed</small></div></div>
      </header>
      {printFail && <div className="strip bad"><span>The print window did not open for the last package labels.</span><button onClick={async () => { if (await printPackageLabels(brand.name, printFail)) setPrintFail(null); }}>Print them again</button></div>}
      {err && <div className="strip bad" data-testid="pack-err"><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}
      {problems.length > 0 && <div className="strip"><span>Set aside, with a manager: {problems.map((o) => o.order_number).join(', ')}.</span></div>}
      <section className="wv-pack" data-testid="pack-group">
        <div className="wv-ordhead">
          <h2>{g.length > 1 ? `${g.length} identical orders` : `Order ${first.order_number}`}</h2>
          <p>{g.length > 1 ? g.map((o) => o.order_number).join(' · ') : [first.customer, first.shipping_method].filter(Boolean).join(' · ') || 'One order'}</p>
          {g.filter((o) => o.notes).map((o) => <p key={o.id} className="wv-ordnote">{g.length > 1 ? `${o.order_number}: ` : ''}{o.notes}</p>)}
          {g.length > 1 && <p className="wv-note">Pack every one of them the same way. One set of package labels prints for each order.</p>}
        </div>
        {pkgs.map((p, i) => (
          <div className="wv-pkg" key={i} data-testid={`pkg-${i + 1}`}>
            <div className="wv-pkghead"><b>Package {i + 1}{pkgs.length > 1 ? ` of ${pkgs.length}` : ''}</b>{i > 0 && <button className="swap" onClick={() => setExtra((xs) => xs.filter((_, j) => j !== i - 1))}>Remove this package</button>}</div>
            <ul>{first.lines.map((l) => (i === 0 ? (p[l.key] > 0 || pkgs.length === 1) && <li key={l.key}>{l.image_url && <img src={l.image_url} alt="" />}<span>{l.name}<small className="code">{l.sku}</small></span><b>× {num(p[l.key])}</b></li>
              : <li key={l.key}>{l.image_url && <img src={l.image_url} alt="" />}<span>{l.name}<small className="code">{l.sku}</small></span>
                <input aria-label={`${l.name} in package ${i + 1}`} type="number" min="0" max={l.qty} inputMode="numeric" value={p[l.key] || ''} placeholder="0" onChange={(e) => setQ(i - 1, l.key, e.target.value, (p[l.key] || 0) + rest(l.key, l.qty))} /></li>))}
              {i === 0 && empty === 0 && <li className="none">Everything has been moved to other packages.</li>}
            </ul>
          </div>))}
        <button className="swap" data-testid="add-package" onClick={() => setExtra((xs) => [...xs, {}])}>Split into another package</button>
        <button className="btn big go" data-testid="pack" disabled={busy} onClick={pack}>{busy ? 'Saving…' : `Packed · print ${plural(pkgs.length * g.length, 'label')}`}</button>
      </section>
      {groups.length > 1 && <p className="wv-note">{plural(groups.length - 1, 'more group')} after this one.</p>}
    </>
  );
}

function WaveDone({ brand, wave, next, busy, leave, err }) {
  const packed = wave.orders.filter((o) => o.pack_state === 'packed'); const problems = wave.orders.filter((o) => o.pack_state === 'problem');
  return (
    <div className="wv-return" data-testid="wave-done">
      <small>{brand.name} · wave {wave.seq}</small>
      <h1>{packed.length ? 'Wave packed' : 'Nothing to pack'}<span className="dot">.</span></h1>
      <p className="lead">{packed.length ? `${plural(packed.length, 'order')} in ${plural(packed.reduce((s, o) => s + o.packages.length, 0), 'package')}.` : 'Every order in this wave came up short.'}</p>
      {problems.length > 0 && <div className="strip bad"><span>With a manager: {problems.map((o) => o.order_number).join(', ')}.</span></div>}
      {err && <div className="strip bad"><span>{err}</span></div>}
      <button className="btn big go" data-testid="next-wave" disabled={busy} onClick={next}>{busy ? 'Building your wave…' : 'Start the next wave'}</button>
      <button className="swap" onClick={leave}>Back to {brand.name}</button>
    </div>
  );
}
