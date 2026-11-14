// Inventory lists. A brand uploads its list (.xlsx or .csv) from its onboarding: the columns are matched, the rows are
// rolled up into products, and the list is sent to ShipBay. It reaches the brand's product database only after ShipBay
// approves it (review_inventory_list); every new product gets an item number then. Counts are EXPECTED units, not stock.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib';
import { LIST_FIELDS, guessMap, buildItems, readListFile } from './invlist';

const num = (n) => Number(n || 0).toLocaleString();
const when = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** The newest list for a brand that is still waiting, plus the newest one overall (to show a rejection note). */
export function useInventoryLists(orgId) {
  const [lists, setLists] = useState([]);
  const reload = async () => {
    if (!orgId) return setLists([]);
    const { data } = await supabase.from('inventory_lists').select('*').eq('org_id', orgId).neq('status', 'replaced').order('submitted_at', { ascending: false }).limit(5);
    setLists(data || []);
  };
  useEffect(() => { reload(); }, [orgId]);
  return { pending: lists.find((l) => l.status === 'pending') || null, latest: lists[0] || null, reload };
}

export function ListLine({ list }) {
  if (!list) return null;
  const rest = list.units - list.units_fba - list.units_fbm;
  return <><b>{num(list.products)} products · {num(list.units)} units</b>{list.units_fba + list.units_fbm > 0 && <> ({num(list.units_fba)} FBA · {num(list.units_fbm)} FBM{rest > 0 ? ` · ${num(rest)} not marked` : ''})</>}</>;
}

function ItemsTable({ items, limit }) {
  const rows = limit ? items.slice(0, limit) : items;
  return (
    <div className="previewwrap listitems"><table className="preview">
      <thead><tr><th>Product</th><th>ASIN</th><th>Supplier</th><th className="n">FBA</th><th className="n">FBM</th><th className="n">Units</th></tr></thead>
      <tbody>{rows.map((o, i) => (
        <tr key={o.id || i}>
          <td>{o.sku_code && <b>{o.sku_code} </b>}{o.code && <b>{o.code} </b>}{o.name}</td>
          <td className="mono">{o.asins?.length ? o.asins.join(' / ') : <span className="sm">none</span>}</td>
          <td>{o.supplier || ''}</td><td className="n">{o.qty_fba || ''}</td><td className="n">{o.qty_fbm || ''}</td><td className="n"><b>{num(o.qty)}</b></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

/* ---------- the brand's side (also used by ShipBay to send a list on a brand's behalf) ---------- */
export function ListUploadModal({ org, me, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [map, setMap] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  const onFile = async (f) => {
    if (!f) return; setErr(null); setBusy(true);
    try {
      const parsed = await readListFile(f);
      if (parsed.length < 2) throw new Error('That file has a header row and nothing under it.');
      setFile(f); setRows(parsed); setMap(guessMap(parsed[0]));
    } catch (e) { setErr(e.message || 'That file could not be read.'); }
    setBusy(false);
  };
  const headers = rows ? rows[0] : [];
  const built = useMemo(() => (rows && map.name != null ? buildItems(rows.slice(1), map) : null), [rows, map]);
  const s = built?.stats;

  const send = async () => {
    setBusy(true); setErr(null);
    const path = `${org.id}/sku_catalog/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (upErr) { setBusy(false); return setErr(upErr.message); }
    const { data: doc, error: dErr } = await supabase.from('documents').insert({ org_id: org.id, kind: 'sku_catalog', title: `Inventory list — ${org.name}`, storage_path: path, mime: file.type || null, size_bytes: file.size, task_key: 'sku_catalog', status: 'pending', uploaded_by: me.id, visible_to_client: true }).select('id').single();
    if (dErr) { setBusy(false); return setErr(dErr.message); }
    const { error } = await supabase.rpc('submit_inventory_list', { p_org: org.id, p_items: built.items, p_file_name: file.name, p_storage_path: path, p_note: note || null, p_document: doc.id });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone({ kind: 'ok', text: `Inventory list sent: ${num(s.products)} products, ${num(s.units)} units. ShipBay reviews it before it goes into the product list.` });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide xl">
        <h3>Inventory list<span className="dot">.</span></h3>
        {!rows ? <>
          <div className="drop" onClick={() => ref.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
            <b>{busy ? 'Reading…' : 'Drop an Excel file or a .csv here'}</b><span>or click to choose · one row per product with a quantity, or one row per unit · product name required; ASIN, your SKU, FBA / FBM and supplier are picked up when present</span>
          </div>
          <input ref={ref} type="file" accept=".xlsx,.csv,text/csv" style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          {err && <div className="msg err" style={{ marginTop: 12 }}>{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button></div>
        </> : <>
          <p className="lead"><b>{file.name}</b> · {num(rows.length - 1)} rows · <button className="linkbtn" onClick={() => { setRows(null); setFile(null); setErr(null); }}>choose a different file</button></p>
          <div className="mapgrid">
            {LIST_FIELDS.map(([key, label, required]) => (
              <label key={key}><span>{label}{required && <i> *</i>}</span>
                <select value={map[key] ?? ''} onChange={(e) => setMap((m) => { const n = { ...m }; if (e.target.value === '') delete n[key]; else n[key] = Number(e.target.value); return n; })}>
                  <option value="">{key === 'qty' ? 'No column: each row is one unit' : 'Not in this file'}</option>
                  {headers.map((h, i) => <option key={i} value={i}>{String(h).trim() || `(column ${i + 1}, no heading)`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {map.name == null ? <div className="msg err">Pick which column holds the product name.</div> : <>
            <div className="liststats">
              <div><b>{num(s.products)}</b><small>Products</small></div>
              <div><b>{num(s.units)}</b><small>Units</small></div>
              <div><b>{num(s.fba)}</b><small>FBA</small></div>
              <div><b>{num(s.fbm)}</b><small>FBM</small></div>
              <div><b>{num(s.noAsin)}</b><small>Without an ASIN</small></div>
            </div>
            <ItemsTable items={built.items} limit={8} />
            <div className="note">Showing {Math.min(8, s.products)} of {num(s.products)} products.{s.perUnit ? ' Each row was counted as one unit.' : ''} Rows that share an ASIN are one product{s.multiAsin ? `; ${s.multiAsin} product${s.multiAsin > 1 ? 's carry' : ' carries'} more than one ASIN` : ''}. Products without an ASIN are kept and get an item number.</div>
            <div className="field" style={{ marginTop: 12 }}><label>Anything ShipBay should know about this list</label><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
          </>}
          {err && <div className="msg err">{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy || !built || !s.products} onClick={send}>{busy ? 'Sending…' : built ? `Send ${num(s.products)} products to ShipBay` : 'Send to ShipBay'}</button></div>
        </>}
      </div>
    </div>
  );
}

/* ---------- ShipBay's side: read the list, approve or send it back ---------- */
export function ListReviewModal({ list, org, onClose, onDone }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    (async () => {   // PostgREST caps a page at 1,000 rows; a list can hold 20,000 products
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('inventory_list_items').select('*').eq('list_id', list.id).order('pos').range(from, from + 999);
        if (error) { setErr(error.message); break; }
        all.push(...(data || [])); if (!data || data.length < 1000) break;
      }
      setItems(all);
    })();
  }, [list.id]);
  const shown = useMemo(() => { const t = q.trim().toLowerCase(); return (items || []).filter((i) => !t || [i.name, i.supplier, i.code, ...(i.asins || [])].filter(Boolean).join(' ').toLowerCase().includes(t)); }, [items, q]);

  const decide = async (approve) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc('review_inventory_list', { p_list: list.id, p_approve: approve, p_note: approve ? null : note });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone(approve ? { kind: 'ok', text: `Inventory list approved: ${num(data.new)} new products, ${num(data.updated)} updated. ${org.name} now has ${num(data.total)} products.` } : { kind: 'ok', text: `List sent back to ${org.name}.` });
  };
  const viewFile = async () => { const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(list.storage_path, 600); if (error) return setErr(error.message); window.open(data.signedUrl, '_blank', 'noopener'); };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide xl">
        <h3>Inventory list — {org.name}<span className="dot">.</span></h3>
        <p className="lead">Sent {when(list.submitted_at)}{list.submitted_by_name ? ` by ${list.submitted_by_name}` : ''}{list.file_name ? <> · {list.storage_path ? <button className="linkbtn" onClick={viewFile}>{list.file_name}</button> : list.file_name}</> : null}</p>
        {list.note && <div className="msg ok" style={{ marginBottom: 12 }}>{list.note}</div>}
        <div className="liststats">
          <div><b>{num(list.products)}</b><small>Products</small></div>
          <div><b>{num(list.units)}</b><small>Units expected</small></div>
          <div><b>{num(list.units_fba)}</b><small>FBA</small></div>
          <div><b>{num(list.units_fbm)}</b><small>FBM</small></div>
          <div><b>{items ? num(items.filter((i) => !i.asins?.length).length) : '…'}</b><small>Without an ASIN</small></div>
        </div>
        <input className="search" style={{ width: '100%', margin: '4px 0 8px' }} placeholder="Search product, ASIN, supplier…" value={q} onChange={(e) => setQ(e.target.value)} />
        {items === null ? <div className="empty">Loading…</div> : <ItemsTable items={shown} />}
        {rejecting && <div className="field" style={{ marginTop: 12 }}><label>What needs fixing (the brand sees this)</label><input value={note} onChange={(e) => setNote(e.target.value)} autoFocus maxLength={300} /></div>}
        {err && <div className="msg err" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row">
          <button className="btn-sm" onClick={onClose}>Close</button>
          {rejecting
            ? <><button className="btn-sm" onClick={() => setRejecting(false)}>Back</button><button className="btn-sm primary" disabled={busy || !note.trim()} onClick={() => decide(false)}>{busy ? 'Sending…' : 'Send it back'}</button></>
            : <><button className="btn-sm" disabled={busy} onClick={() => setRejecting(true)}>Send back</button><button className="btn-sm primary" disabled={busy || !items} onClick={() => decide(true)}>{busy ? 'Approving…' : `Approve ${num(list.products)} products`}</button></>}
        </div>
      </div>
    </div>
  );
}
