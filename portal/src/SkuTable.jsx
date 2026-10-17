// SKU list with inline editing — same component on the client's Products page and the staff SKUs page.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib';

const PACKAGING = [['', '—'], ['mailer', 'Mailer'], ['box_single', 'Box (single)'], ['box_double', 'Box (double)'], ['client_supplied', 'Client-supplied']];
const COLS = [
  ['sku', 'SKU', 'text', 120], ['name', 'Product', 'text', 150], ['variant', 'Variant', 'text', 100], ['barcode', 'Barcode / UPC', 'text', 120],
  ['weight_oz', 'Wt (oz)', 'number', 70], ['dims_in', 'L×W×H (in)', 'text', 95], ['declared_value', 'Value ($)', 'number', 80],
  ['packaging', 'Packaging', 'select', 115], ['low_stock_threshold', 'Low-stock', 'number', 75],
];
const EMPTY = { sku: '', name: '', variant: '', barcode: '', weight_oz: '', dims_in: '', declared_value: '', packaging: '', low_stock_threshold: '' };
const clean = (row) => {
  const r = {};
  for (const [k, , type] of COLS) {
    let v = row[k];
    if (v === '' || v == null) v = null;
    else if (type === 'number') { v = Number(String(v).replace(/[^0-9.]/g, '')); if (!isFinite(v)) v = null; }
    else v = String(v).trim();
    r[k] = v;
  }
  if (r.low_stock_threshold != null) r.low_stock_threshold = Math.round(r.low_stock_threshold);
  if (!r.name) r.name = r.sku;
  return r;
};

export default function SkuTable({ orgId, title = 'Products', staff = false, onCount }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // id or 'new'
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = async () => {
    if (!orgId) return;
    const { data } = await supabase.from('skus').select('*').eq('org_id', orgId).order('sku');
    setRows(data || []);
    onCount?.((data || []).filter((r) => r.active).length);
  };
  useEffect(() => { load(); setEditing(null); }, [orgId]);

  const list = useMemo(() => (rows || []).filter((r) => (showInactive || r.active) && (!q || [r.sku, r.name, r.variant, r.barcode].join(' ').toLowerCase().includes(q.toLowerCase()))), [rows, q, showInactive]);
  const active = (rows || []).filter((r) => r.active).length;

  const startEdit = (r) => { setEditing(r.id); setDraft(Object.fromEntries(COLS.map(([k]) => [k, r[k] ?? '']))); setMsg(null); };
  const startNew = () => { setEditing('new'); setDraft(EMPTY); setMsg(null); };
  const cancel = () => { setEditing(null); setDraft(EMPTY); };
  const save = async () => {
    const r = clean(draft);
    if (!r.sku) return setMsg({ kind: 'err', text: 'SKU code is required.' });
    setBusy(true); setMsg(null);
    const { error } = editing === 'new'
      ? await supabase.from('skus').insert({ ...r, org_id: orgId, active: true })
      : await supabase.from('skus').update(r).eq('id', editing);
    setBusy(false);
    if (error) return setMsg({ kind: 'err', text: error.message.includes('skus_org_id_sku_key') ? `SKU ${r.sku} already exists on this account.` : error.message });
    cancel(); load();
  };
  const setActive = async (r, active) => {
    if (!active && !confirm(`Remove ${r.sku} from the catalog? Order history is kept; you can restore it later.`)) return;
    await supabase.from('skus').update({ active }).eq('id', r.id); load();
  };
  const onKey = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); };

  const cell = (k, type) => type === 'select'
    ? <select value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}>{PACKAGING.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    : <input type={type === 'number' ? 'text' : 'text'} inputMode={type === 'number' ? 'decimal' : undefined} value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onKeyDown={onKey} autoFocus={k === 'sku'} />;

  const editRow = (
    <tr className="editing">
      {COLS.map(([k, , type]) => <td key={k}>{cell(k, type)}</td>)}
      <td className="r"><button className="btn-xs primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button> <button className="btn-xs" onClick={cancel}>Cancel</button></td>
    </tr>
  );

  return (
    <div className="card skucard">
      <div className="cardhead">
        <h3>{title}</h3><span className="tag">{active} active</span>
        <div className="spacer" />
        <input className="search" placeholder="Search SKU, name, barcode…" value={q} onChange={(e) => setQ(e.target.value)} />
        {rows?.some((r) => !r.active) && <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show removed</label>}
        <button className="btn-sm primary" onClick={startNew} disabled={editing === 'new'}>+ Add SKU</button>
      </div>
      {msg && <div className={`msg ${msg.kind}`} style={{ margin: '12px 18px 0' }}>{msg.text}</div>}
      <div className="tablewrap">
        <table className="skus">
          <thead><tr>{COLS.map(([k, l, , w]) => <th key={k} style={{ minWidth: w }}>{l}</th>)}<th style={{ minWidth: 110 }} /></tr></thead>
          <tbody>
            {editing === 'new' && editRow}
            {rows === null ? <tr><td colSpan={COLS.length + 1} className="empty">Loading…</td></tr>
              : list.length === 0 && editing !== 'new' ? <tr><td colSpan={COLS.length + 1} className="empty">{q ? 'No SKUs match.' : staff ? 'No SKUs yet — upload the client’s CSV from Onboarding → Inventory, or add one here.' : 'No products yet. Add them here or upload your product list from the Overview.'}</td></tr>
              : list.map((r) => editing === r.id ? <EditRowWrapper key={r.id}>{editRow}</EditRowWrapper> : (
                <tr key={r.id} className={r.active ? '' : 'inactive'}>
                  <td><b>{r.sku}</b></td><td>{r.name}</td><td>{r.variant || ''}</td><td>{r.barcode || ''}</td>
                  <td>{r.weight_oz ?? ''}</td><td>{r.dims_in || ''}</td><td>{r.declared_value != null ? `$${Number(r.declared_value).toFixed(2)}` : ''}</td>
                  <td>{PACKAGING.find((p) => p[0] === (r.packaging || ''))?.[1] || ''}</td><td>{r.low_stock_threshold ?? ''}</td>
                  <td className="r">
                    {r.active ? <><button className="edit" onClick={() => startEdit(r)}>edit</button> · <button className="edit" onClick={() => setActive(r, false)}>remove</button></> : <button className="edit" onClick={() => setActive(r, true)}>restore</button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const EditRowWrapper = ({ children }) => children;
