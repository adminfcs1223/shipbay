// Pack & Ship — the packing station, one brand at a time. Pull an order (scan the packing slip or pick from the queue),
// scan every unit to verify the pick, weigh the box, shop rates through Veeqo, buy the label, print it on the 4×6
// printer. Marking shipped deducts inventory and pushes tracking back to the brand's order system (Veeqo or Shopify).
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fn } from '../lib';
import { ScanBox, beep, STATUS, SOURCE, dueClass, fmtDate, money, printPackingSlip } from '../ops';
import { useBrands, BrandPicker, BrandBar } from '../shared';

const OPEN = ['new', 'picked', 'packed'];
const BOXES = [
  ['Poly mailer', '', '', ''], ['Bubble mailer', '', '', ''], ['Box 6×4×4', 6, 4, 4], ['Box 8×6×4', 8, 6, 4], ['Box 10×8×6', 10, 8, 6], ['Box 12×10×8', 12, 10, 8], ['Box 14×12×10', 14, 12, 10], ['Custom', '', '', ''],
];
const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL Express', 'Amazon Shipping', 'Other'];
const pref = (k, d) => { try { return localStorage.getItem(`shipbay-pack:${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`shipbay-pack:${k}`, v); } catch { /* ignore */ } };

export default function PackShip({ me, go, params, brand, setBrand }) {
  const [rows, setRows] = useState(null);
  const [orgs] = useBrands();
  const org = brand || '';
  const [creating, setCreating] = useState(false);
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
    const { data: r } = await supabase.from('v_orders_queue').select('*').in('status', OPEN).order('ship_by', { ascending: true, nullsFirst: false }).order('placed_at', { ascending: true }).limit(800);
    setRows(r || []);
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
  const orgRow = (orgs || []).find((o) => o.id === org) || null;

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

  if (!org) {
    const stats = (o) => { const rs = (rows || []).filter((r) => r.org_id === o.id); return [['To pack', rs.filter((r) => r.status !== 'packed').length], ['Packed, no label', rs.filter((r) => r.status === 'packed').length, rs.some((r) => r.status === 'packed')]]; };
    return (
      <>
        <div className="pagehead"><div><h1>Pack &amp; Ship<span className="dot">.</span></h1><p className="sub">Pick the brand you’re packing for. The station then only shows that brand’s orders and catalog.</p></div></div>
        <BrandPicker orgs={orgs} onPick={setBrand} stats={stats} title="Brands" />
      </>
    );
  }

  return (
    <>
      <BrandBar org={orgRow} onBack={() => { setBrand(null); setSel(null); }}>
        <button className="btn-sm" onClick={() => setCreating(true)}>+ Create order</button>
        <label className="mult">Label <select value={labelFormat} onChange={(e) => setLabelFormat(e.target.value)}><option value="PDF">PDF (4×6, print from browser)</option><option value="ZPL">ZPL (raw thermal)</option></select></label>
        <button className="btn-sm" onClick={() => go('orders', { org })}>All orders</button>
      </BrandBar>
      <div className="pagehead">
        <div><h1>Pack &amp; Ship<span className="dot">.</span></h1><p className="sub">Scan the packing slip or pick an order, scan every unit, weigh the box, buy the label. Tracking goes back to the brand’s system automatically.</p></div>
        <div className="glance">
          <div><small>To pack</small><b>{queue.filter((r) => r.status !== 'packed').length}</b></div>
          <div><small>Packed, no label</small><b className={queue.some((r) => r.status === 'packed') ? 'hot' : ''}>{queue.filter((r) => r.status === 'packed').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="ops packship">
        <div className="card queue">
          <div className="cardhead"><h3>Queue</h3><span className="sm">{queue.length} open</span></div>
          {rows === null ? <div className="empty">Loading…</div> : queue.length === 0 ? <div className="empty">Nothing to pack. 🎉</div> : (
            <ul className="queuelist">{queue.map((r) => (
              <li key={r.id}><button className={`qitem ${r.id === sel ? 'active' : ''}`} onClick={() => setSel(r.id)}>
                <div className="top"><b>{r.order_number}</b><span className={`statuspill ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0]}</span></div>
                <div className="meta">{r.marketplace || (r.channel === 'veeqo' ? 'Veeqo' : r.channel === 'manual' ? 'Manual' : SOURCE[r.source] || 'Shopify')} · {r.units} unit{r.units === 1 ? '' : 's'}{r.ship_by ? <> · <span className={`due ${dueClass(r.ship_by)}`}>ship by {fmtDate(r.ship_by)}</span></> : ''}</div>
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
                <div className="sm">{done.shopify?.ok ? `Tracking sent to ${done.shopify.channel === 'veeqo' ? 'Veeqo' : 'Shopify'} — the customer and the marketplace get it from there.` : done.shopify?.skipped ? `${done.shopify.channel === 'veeqo' ? 'Veeqo' : done.shopify.channel === 'shopify' ? 'Shopify' : 'Channel'}: ${done.shopify.skipped}.` : done.shopify?.error ? `${done.shopify.channel === 'veeqo' ? 'Veeqo' : 'Shopify'} update failed: ${done.shopify.error}` : ''}</div>
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
      {creating && orgRow && <CreateOrder org={orgRow} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load().then(() => setSel(id)); }} />}
    </>
  );
}

/* ---------- Create order by hand (sample, replacement, wholesale, phone order) ---------- */
const US = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
export function CreateOrder({ org, onClose, onCreated }) {
  const [skus, setSkus] = useState([]);
  const [o, setO] = useState({ order_number: '', email: '', shipping_method: '', ship_by: '', notes: '', ship_to: { name: '', company: '', address1: '', address2: '', city: '', province_code: 'NJ', zip: '', country_code: 'US', phone: '' } });
  const [lines, setLines] = useState([{ sku_id: '', qty: 1 }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { supabase.from('skus').select('id, sku, name, variant').eq('org_id', org.id).eq('active', true).order('sku').then(({ data }) => setSkus(data || [])); }, [org.id]);
  const setTo = (k, v) => setO({ ...o, ship_to: { ...o.ship_to, [k]: v } });
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    const ls = lines.filter((l) => l.sku_id && Number(l.qty) > 0);
    if (!ls.length) return setErr('Add at least one item.');
    if (!o.ship_to.name || !o.ship_to.address1 || !o.ship_to.city || !o.ship_to.zip) return setErr('Name, address, city and ZIP are required.');
    setBusy(true);
    const { data, error } = await supabase.rpc('create_manual_order', { p_org_id: org.id, p_order: { ...o, ship_to: { ...o.ship_to, country: o.ship_to.country_code === 'US' ? 'United States' : o.ship_to.country_code } }, p_lines: ls.map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty) })) });
    setBusy(false);
    if (error) return setErr(error.message);
    onCreated(data);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Create order — {org.name}<span className="dot">.</span></h3>
        <p className="sm" style={{ marginBottom: 12 }}>For samples, replacements, wholesale or phone orders that aren’t in the brand’s system. It goes straight into the queue; nothing is sent back to Veeqo or Shopify.</p>
        {err && <div className="msg err">{err}</div>}
        <div className="grid2">
          <div className="field"><label>Order # (blank = auto)</label><input value={o.order_number} onChange={(e) => setO({ ...o, order_number: e.target.value })} placeholder="M-…" /></div>
          <div className="field"><label>Ship by</label><input type="date" value={o.ship_by} onChange={(e) => setO({ ...o, ship_by: e.target.value })} /></div>
        </div>
        <div className="lbl">Ship to</div>
        <div className="grid2">
          <div className="field"><label>Name</label><input required value={o.ship_to.name} onChange={(e) => setTo('name', e.target.value)} /></div>
          <div className="field"><label>Company</label><input value={o.ship_to.company} onChange={(e) => setTo('company', e.target.value)} /></div>
          <div className="field"><label>Address</label><input required value={o.ship_to.address1} onChange={(e) => setTo('address1', e.target.value)} /></div>
          <div className="field"><label>Apt / suite</label><input value={o.ship_to.address2} onChange={(e) => setTo('address2', e.target.value)} /></div>
          <div className="field"><label>City</label><input required value={o.ship_to.city} onChange={(e) => setTo('city', e.target.value)} /></div>
          <div className="field"><label>State / ZIP</label><div style={{ display: 'flex', gap: 8 }}><select value={o.ship_to.province_code} onChange={(e) => setTo('province_code', e.target.value)}>{US.map((st) => <option key={st}>{st}</option>)}</select><input required placeholder="ZIP" value={o.ship_to.zip} onChange={(e) => setTo('zip', e.target.value)} /></div></div>
          <div className="field"><label>Phone</label><input value={o.ship_to.phone} onChange={(e) => setTo('phone', e.target.value)} /></div>
          <div className="field"><label>Email</label><input type="email" value={o.email} onChange={(e) => setO({ ...o, email: e.target.value })} /></div>
        </div>
        <div className="lbl">Items</div>
        <div className="exprows">
          {lines.map((l, i) => (
            <div className="exprow" key={i}>
              <select value={l.sku_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku_id: e.target.value } : x)))}><option value="">— item —</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}</select>
              <input type="number" min="1" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <button type="button" className="btn-xs" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>×</button>
            </div>
          ))}
          <div><button type="button" className="btn-xs" onClick={() => setLines([...lines, { sku_id: '', qty: 1 }])}>+ Add item</button></div>
        </div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="field"><label>Shipping method / notes for the packer</label><input value={o.shipping_method} onChange={(e) => setO({ ...o, shipping_method: e.target.value })} placeholder="Ground, 2-day, gift wrap…" /></div>
          <div className="field"><label>Notes</label><input value={o.notes} onChange={(e) => setO({ ...o, notes: e.target.value })} /></div>
        </div>
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{busy ? 'Creating…' : 'Create order'}</button></div>
      </form>
    </div>
  );
}
