// Pack & Ship — the packing station. Pull an order (scan the packing slip or pick from the queue), scan every unit to
// verify the pick, weigh the box, shop rates through Veeqo, buy the label, print it on the 4×6 printer. Marking shipped
// deducts inventory and pushes tracking to Shopify, which relays it to the marketplace through Mirakl Connect.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fn } from '../lib';
import { ScanBox, beep, STATUS, SOURCE, dueClass, fmtDate, money, printPackingSlip } from '../ops';

const OPEN = ['new', 'picked', 'packed'];
const BOXES = [
  ['Poly mailer', '', '', ''], ['Bubble mailer', '', '', ''], ['Box 6×4×4', 6, 4, 4], ['Box 8×6×4', 8, 6, 4], ['Box 10×8×6', 10, 8, 6], ['Box 12×10×8', 12, 10, 8], ['Box 14×12×10', 14, 12, 10], ['Custom', '', '', ''],
];
const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL Express', 'Amazon Shipping', 'Other'];
const pref = (k, d) => { try { return localStorage.getItem(`shipbay-pack:${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`shipbay-pack:${k}`, v); } catch { /* ignore */ } };

export default function PackShip({ me, go, params }) {
  const [rows, setRows] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [org, setOrg] = useState(params?.org || '');
  const [sel, setSel] = useState(params?.order || null);
  const [lines, setLines] = useState([]);
  const [last, setLast] = useState(null);
  const [box, setBox] = useState(pref('box', 'Box 8×6×4'));
  const [dims, setDims] = useState({ l: '', w: '', h: '' });
  const [weight, setWeight] = useState('');
  const [labelFormat, setLabelFormat] = useState(pref('format', 'PDF'));
  const [rates, setRates] = useState(null);
  const [pick, setPick] = useState(null);
  const [opts, setOpts] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [done, setDone] = useState(null);
  const [frozen, setFrozen] = useState(null); // the order just shipped: it leaves the open queue but stays on screen until Next
  const [manual, setManual] = useState(false);
  const [man, setMan] = useState({ carrier: 'USPS', service: '', tracking: '', label_cost: '' });
  const labelWin = useRef(null);

  const load = async () => {
    const [{ data: r }, { data: o }] = await Promise.all([
      supabase.from('v_orders_queue').select('*').in('status', OPEN).order('ship_by', { ascending: true, nullsFirst: false }).order('placed_at', { ascending: true }).limit(500),
      supabase.from('orgs').select('id, name').order('name'),
    ]);
    setRows(r || []); setOrgs(o || []);
  };
  const loadLines = async (id) => { const { data } = await supabase.from('order_lines').select('*').eq('order_id', id).order('name'); setLines(data || []); };
  useEffect(() => { load(); }, []);
  const current = (rows || []).find((r) => r.id === sel) || (frozen?.id === sel ? frozen : null);
  useEffect(() => {
    setLast(null); setRates(null); setPick(null); setOpts({}); setDone(null); setManual(false); setMsg(null); if (frozen && frozen.id !== sel) setFrozen(null);
    if (current) loadLines(current.id); else setLines([]);
    // prefill the packed weight from the catalog weights when we have them
  }, [current?.id]);
  useEffect(() => {
    if (!current || !lines.length) return;
    (async () => {
      const ids = lines.filter((l) => l.sku_id).map((l) => l.sku_id);
      if (!ids.length) return;
      const { data } = await supabase.from('skus').select('id, weight_oz').in('id', ids);
      const w = lines.reduce((s, l) => s + (Number(data?.find((x) => x.id === l.sku_id)?.weight_oz) || 0) * l.qty, 0);
      if (w > 0) setWeight(String(Math.round((w + 3) * 10) / 10)); else setWeight('');
    })();
  }, [current?.id, lines.length]);
  useEffect(() => { const b = BOXES.find((x) => x[0] === box); if (b && b[1]) setDims({ l: b[1], w: b[2], h: b[3] }); setPref('box', box); }, [box]);
  useEffect(() => setPref('format', labelFormat), [labelFormat]);

  const queue = useMemo(() => (rows || []).filter((r) => !org || r.org_id === org), [rows, org]);
  const physical = lines.filter((l) => l.is_physical && l.qty > 0);
  const verified = physical.reduce((s, l) => s + l.qty_verified, 0);
  const units = physical.reduce((s, l) => s + l.qty, 0);
  const complete = units > 0 && verified >= units;
  const orgName = (id) => orgs.find((o) => o.id === id)?.name || current?.org_name || '';

  // a scan is either an order number (pull it up) or an item (verify it)
  const scan = async (code) => {
    const byOrder = (rows || []).find((r) => r.order_number.replace(/^#/, '').toLowerCase() === code.replace(/^#/, '').toLowerCase());
    if (byOrder && (!current || byOrder.id !== current.id)) { setSel(byOrder.id); beep('ok'); return; }
    if (!current) { beep('bad'); return setLast({ kind: 'bad', text: `No open order matches ${code}. Pick one from the queue.` }); }
    if (done) return;
    const { data, error } = await supabase.rpc('scan_pack', { p_order_id: current.id, p_code: code, p_qty: 1 });
    if (error) { beep('bad'); return setLast({ kind: 'bad', text: error.message }); }
    if (!data.found) { beep('bad'); return setLast({ kind: 'bad', text: `Unknown barcode ${code} — not in ${current.org_name}’s catalog. Assign it under Receiving or SKUs.` }); }
    if (data.wrong_item || data.extra) { beep('bad'); return setLast({ kind: 'bad', text: `${data.sku} · ${data.name}: ${data.message}` }); }
    beep(data.complete ? 'done' : 'ok');
    setLast({ kind: 'ok', sku: data.sku, name: data.name, v: data.qty_verified, q: data.qty, complete: data.complete });
    await loadLines(current.id);
    if (data.complete) load();
  };
  const reset = async () => { if (!current) return; await supabase.rpc('reset_pack', { p_order_id: current.id }); setLast(null); loadLines(current.id); load(); };

  const getRates = async () => {
    setBusy('rates'); setMsg(null); setRates(null); setPick(null);
    const r = await fn('labels', { action: 'rates', order_id: current.id, parcel: { weight_oz: Number(weight), length: dims.l, width: dims.w, height: dims.h } });
    setBusy(null);
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    if (!r.quotes?.length) return setMsg({ kind: 'err', text: 'Veeqo returned no rates for this parcel — check the address and weight.' });
    setRates(r); setPick(r.quotes[0].rate_id);
    const q = r.quotes[0]; const o = {}; for (const so of q.options || []) if (so.type === 'select' && so.values?.length) o[so.key] = so.values[0].value; setOpts(o);
  };
  const choose = (q) => { setPick(q.rate_id); const o = {}; for (const so of q.options || []) if (so.type === 'select' && so.values?.length) o[so.key] = so.values[0].value; setOpts(o); };
  const buy = async () => {
    const q = rates.quotes.find((x) => x.rate_id === pick); if (!q) return;
    setBusy('buy'); setMsg(null);
    labelWin.current = window.open('', '_blank'); // open now so the browser doesn't block the label tab later
    if (labelWin.current) labelWin.current.document.write('<p style="font-family:sans-serif;padding:20px">Buying label…</p>');
    const r = await fn('labels', { action: 'buy', order_id: current.id, remote_shipment_id: rates.remote_shipment_id, rate_id: q.rate_id, request_token: rates.request_token, options: opts, parcel: { weight_oz: Number(weight), length: dims.l, width: dims.w, height: dims.h }, packaging: box, label_format: labelFormat });
    setBusy(null);
    if (r.error) { labelWin.current?.close(); return setMsg({ kind: 'err', text: r.error }); }
    beep('done'); setDone(r); setFrozen({ ...current, status: 'shipped' });
    if (r.label_url && labelWin.current) labelWin.current.location = r.label_url; else labelWin.current?.close();
    load();
  };
  const shipManual = async (e) => {
    e.preventDefault(); setBusy('manual'); setMsg(null);
    const r = await fn('labels', { action: 'manual', order_id: current.id, carrier: man.carrier, service: man.service, tracking: man.tracking, label_cost: man.label_cost ? Number(man.label_cost) : null, packaging: box, weight_oz: weight ? Number(weight) : null });
    setBusy(null);
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    beep('done'); setDone({ ...r, carrier: man.carrier, service: man.service, manual: true }); setFrozen({ ...current, status: 'shipped' }); load();
  };
  const next = () => { const n = queue.find((r) => r.id !== sel && OPEN.includes(r.status)); setFrozen(null); setSel(n?.id || null); };

  return (
    <>
      <div className="pagehead">
        <div><h1>Pack &amp; Ship<span className="dot">.</span></h1><p className="sub">Scan the packing slip or pick an order, scan every unit, weigh the box, buy the label. Tracking goes back to Shopify (and on to the marketplace) automatically.</p></div>
        <div className="glance">
          <div><small>To pack</small><b>{queue.filter((r) => r.status !== 'packed').length}</b></div>
          <div><small>Packed, no label</small><b className={queue.some((r) => r.status === 'packed') ? 'hot' : ''}>{queue.filter((r) => r.status === 'packed').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="opsbar">
        <select value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All clients</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <div className="spacer" />
        <label className="mult">Label format <select value={labelFormat} onChange={(e) => setLabelFormat(e.target.value)}><option value="PDF">PDF (4×6, print from browser)</option><option value="ZPL">ZPL (raw thermal)</option></select></label>
        <button className="btn-sm" onClick={() => go('orders', { org })}>All orders</button>
      </div>

      <div className="ops packship">
        <div className="card queue">
          <div className="cardhead"><h3>Queue</h3><span className="sm">{queue.length} open</span></div>
          {rows === null ? <div className="empty">Loading…</div> : queue.length === 0 ? <div className="empty">Nothing to pack. 🎉</div> : (
            <ul className="queuelist">{queue.map((r) => (
              <li key={r.id}><button className={`qitem ${r.id === sel ? 'active' : ''}`} onClick={() => setSel(r.id)}>
                <div className="top"><b>{r.order_number}</b><span className={`statuspill ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0]}</span></div>
                <div className="meta">{r.org_name} · {r.marketplace || SOURCE[r.source] || 'Shopify'} · {r.units} unit{r.units === 1 ? '' : 's'}{r.ship_by ? <> · <span className={`due ${dueClass(r.ship_by)}`}>ship by {fmtDate(r.ship_by)}</span></> : ''}</div>
              </button></li>
            ))}</ul>
          )}
        </div>

        <div className="card detail station">
          <ScanBox onScan={scan} placeholder={current ? `Scan each item for ${current.order_number}…` : 'Scan a packing slip barcode to pull up an order…'} />
          {!current ? <div className="empty">Scan a packing slip, or pick an order from the queue.</div> : <>
            <div className="cardhead">
              <div><h3>{current.order_number} <span className={`statuspill ${STATUS[current.status]?.[1]}`}>{STATUS[current.status]?.[0]}</span>{current.marketplace && <span className="pill connected" style={{ marginLeft: 6 }}>{current.marketplace}</span>}</h3>
                <div className="small">{current.org_name}{current.ship_by ? <> · <span className={`due ${dueClass(current.ship_by)}`}>ship by {fmtDate(current.ship_by)}</span></> : ''}{current.shipping_method ? ` · ${current.shipping_method}` : ''}{current.is_international ? ' · international' : ''}</div></div>
              <div className="spacer" />
              <button className="btn-sm" onClick={() => printPackingSlip(current, lines, current.org_name)}>Packing slip</button>
              {!done && verified > 0 && <button className="btn-sm" onClick={reset}>Reset scans</button>}
            </div>

            <div className="detailgrid">
              <div><div className="lbl">Ship to</div><div className="addr">{current.ship_to?.name}<br />{current.ship_to?.address1}{current.ship_to?.address2 ? `, ${current.ship_to.address2}` : ''}<br />{[current.ship_to?.city, current.ship_to?.province_code, current.ship_to?.zip].filter(Boolean).join(', ')}{current.ship_to?.country_code && current.ship_to.country_code !== 'US' ? ` · ${current.ship_to.country}` : ''}</div></div>
              <div><div className="lbl">Progress</div><div className="progress"><div className="bar"><i style={{ width: `${units ? (100 * verified) / units : 0}%` }} /></div><span>{verified} / {units} scanned</span></div>{current.notes && <div className="note" style={{ marginTop: 8 }}>{current.notes}</div>}</div>
            </div>

            {last && !done && (
              <div className={`scanfeed ${last.kind}`}>
                {last.kind === 'ok' ? <><b>{last.name}</b><span>{last.sku}</span><em>{last.v} / {last.q}</em>{last.complete && <small>All items verified — box it up</small>}</> : <b>{last.text}</b>}
              </div>
            )}

            <table className="lines"><thead><tr><th>SKU</th><th>Item</th><th className="n">Qty</th><th className="n">Scanned</th></tr></thead>
              <tbody>{physical.map((l) => <tr key={l.id} className={l.qty_verified >= l.qty ? 'ok' : l.qty_verified > 0 ? 'part' : ''}><td>{l.sku || '—'}</td><td>{l.name}</td><td className="n">{l.qty}</td><td className="n"><b>{l.qty_verified}</b></td></tr>)}</tbody></table>

            {done ? (
              <div className="shipped">
                <h4>Shipped ✓ {done.carrier}{done.service ? ` · ${done.service}` : ''}</h4>
                <div>Tracking <b>{done.tracking}</b>{done.cost != null && ` · ${money(done.cost)}`}</div>
                <div className="sm">{done.shopify?.ok ? 'Tracking sent to Shopify — the customer and the marketplace get it from there.' : done.shopify?.skipped ? `Shopify: ${done.shopify.skipped}.` : done.shopify?.error ? `Shopify update failed: ${done.shopify.error}` : ''}</div>
                <div className="actions">
                  {done.label_url && <a className="btn-sm primary" href={done.label_url} target="_blank" rel="noopener">{done.label_format === 'ZPL' ? 'Download ZPL' : 'Open label (print 4×6)'}</a>}
                  <button className="btn-sm" onClick={() => printPackingSlip(current, lines, current.org_name)}>Packing slip</button>
                  <button className="btn-sm" onClick={next}>Next order →</button>
                </div>
              </div>
            ) : (
              <div className={`parcel ${complete ? '' : 'waiting'}`}>
                <div className="lbl">{complete ? 'Box it up' : `Scan all ${units} units to unlock the label step`}</div>
                <div className="parcelrow">
                  <label>Packaging<select value={box} onChange={(e) => setBox(e.target.value)}>{BOXES.map((b) => <option key={b[0]} value={b[0]}>{b[0]}</option>)}</select></label>
                  <label>L × W × H (in)<div className="dims"><input type="number" min="0" step="0.1" value={dims.l} onChange={(e) => setDims({ ...dims, l: e.target.value })} placeholder="L" /><input type="number" min="0" step="0.1" value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} placeholder="W" /><input type="number" min="0" step="0.1" value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} placeholder="H" /></div></label>
                  <label>Packed weight (oz)<input type="number" min="0.1" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="from the scale" /></label>
                  <button className="btn-sm primary" disabled={!complete || !weight || busy === 'rates'} onClick={getRates}>{busy === 'rates' ? 'Getting rates…' : 'Get rates'}</button>
                </div>

                {rates && (
                  <div className="rates">
                    {rates.quotes.map((q) => (
                      <label key={q.rate_id} className={`rate ${pick === q.rate_id ? 'on' : ''}`}>
                        <input type="radio" name="rate" checked={pick === q.rate_id} onChange={() => choose(q)} />
                        <div><b>{q.carrier} · {q.service_name}</b><div className="sm">{q.delivery_date ? `est. ${new Date(q.delivery_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : 'no delivery estimate'}{q.meets_promise === false ? ' · misses ship-by promise' : ''}</div></div>
                        <em>{money(q.total_charge)}</em>
                      </label>
                    ))}
                    {(() => { const q = rates.quotes.find((x) => x.rate_id === pick); const sel_ = (q?.options || []).filter((o) => o.type === 'select' && o.values?.length > 1); return sel_.length ? (
                      <div className="rateopts">{sel_.map((o) => <label key={o.key}>{o.label || o.title}<select value={opts[o.key] ?? ''} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.value })}>{o.values.map((v) => <option key={v.value} value={v.value}>{v.label}{v.price ? ` (+$${Number(v.price).toFixed(2)})` : ''}</option>)}</select></label>)}</div>) : null; })()}
                    <div className="actions"><span className="sm">Quotes expire {rates.expires_at ? new Date(rates.expires_at).toLocaleTimeString() : 'soon'} · ship from {rates.from?.company || rates.from?.name}</span><div className="spacer" /><button className="btn-sm primary big" disabled={!pick || busy === 'buy'} onClick={buy}>{busy === 'buy' ? 'Buying label…' : `Buy label & ship · ${money(rates.quotes.find((x) => x.rate_id === pick)?.total_charge)}`}</button></div>
                  </div>
                )}

                <div className="manualtoggle"><button className="linkbtn" onClick={() => setManual(!manual)}>{manual ? 'Hide' : 'Label bought elsewhere? Enter tracking manually'}</button></div>
                {manual && (
                  <form className="manual" onSubmit={shipManual}>
                    <label>Carrier<select value={man.carrier} onChange={(e) => setMan({ ...man, carrier: e.target.value })}>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</select></label>
                    <label>Service<input value={man.service} onChange={(e) => setMan({ ...man, service: e.target.value })} placeholder="Ground Advantage…" /></label>
                    <label>Tracking #<input required value={man.tracking} onChange={(e) => setMan({ ...man, tracking: e.target.value })} /></label>
                    <label>Cost ($)<input type="number" step="0.01" value={man.label_cost} onChange={(e) => setMan({ ...man, label_cost: e.target.value })} /></label>
                    <button className="btn-sm primary" disabled={!complete || busy === 'manual'}>{busy === 'manual' ? 'Saving…' : 'Mark shipped'}</button>
                  </form>
                )}
              </div>
            )}
          </>}
        </div>
      </div>
    </>
  );
}
