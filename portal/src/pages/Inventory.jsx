import { useState } from 'react';
import { supabase, fmtDate, fmtDateTime } from '../lib';
import { Pill, Kpi, Modal, Field, Empty, useAsync, Seg } from '../ui';

export default function Inventory({ me, org }) {
  const [tab, setTab] = useState('stock');
  return (
    <>
      <div className="topbar">
        <div><h1>Inventory</h1><div className="sub">{org ? 'Your SKUs, on-hand counts, and inbound shipments' : 'All clients'}</div></div>
        <Seg value={tab} onChange={setTab} options={[['stock', 'Stock'], ['inbound', 'Inbound / receiving']]} />
      </div>
      {tab === 'stock' ? <Stock me={me} org={org} /> : <Inbound me={me} org={org} />}
    </>
  );
}

function Stock({ me, org }) {
  const [edit, setEdit] = useState(null);
  const [adj, setAdj] = useState(null);
  const { data, loading, reload } = useAsync(async () => {
    let q = supabase.from('inventory_levels').select('*').order('sku');
    if (org) q = q.eq('org_id', org.id);
    const { data, error } = await q; if (error) throw error; return data;
  }, [org?.id]);
  const rows = (data || []).filter((s) => s.is_physical);
  const low = rows.filter((s) => s.active && s.on_hand - s.reserved <= s.low_stock_threshold);
  const units = rows.reduce((a, s) => a + s.on_hand, 0);
  const inactive = (data || []).filter((s) => !s.active).length;

  return (
    <>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <Kpi label="Active SKUs" value={rows.filter((s) => s.active).length} />
        <Kpi label="Units on hand" value={units.toLocaleString()} />
        <Kpi label="Low stock" value={low.length} tone={low.length ? 'warn' : 'ok'} hint="Available ≤ threshold" />
        {inactive > 0 && <Kpi label="Needs review" value={inactive} tone="warn" hint="Auto-created from Shopify orders" />}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3>Stock</h3><div className="spacer" />
          <button className="btn sm" onClick={() => setEdit({ org_id: org?.id, sku: '', name: '', variant: '', packaging: 'mailer', low_stock_threshold: 5, active: true })}>+ Add SKU</button>
        </div>
        {loading ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No SKUs yet. Add them here or import from Shopify.</Empty> : (
          <table>
            <thead><tr><th>SKU</th><th>Product</th><th>Packaging</th><th className="num">On hand</th><th className="num">Reserved</th><th className="num">Available</th><th>Status</th><th></th></tr></thead>
            <tbody>{rows.map((s) => {
              const avail = s.on_hand - s.reserved; const isLow = s.active && avail <= s.low_stock_threshold;
              return (
                <tr key={s.sku_id}>
                  <td className="mono">{s.sku}</td>
                  <td>{s.name}{s.variant && <span className="muted"> · {s.variant}</span>}</td>
                  <td className="small muted">{s.packaging?.replace('_', ' ')}</td>
                  <td className="num">{s.on_hand}</td><td className="num muted">{s.reserved}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{avail}</td>
                  <td>{!s.active ? <span className="pill warn">review</span> : isLow ? <span className="pill warn">low</span> : <span className="pill ok">ok</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setEdit({ id: s.sku_id, org_id: s.org_id, sku: s.sku, name: s.name, variant: s.variant || '', packaging: s.packaging, low_stock_threshold: s.low_stock_threshold, active: s.active })}>Edit</button>
                    {me.isStaff && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setAdj(s)}>Adjust</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {edit && <SkuModal sku={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {adj && <AdjustModal sku={adj} onClose={() => setAdj(null)} onSaved={() => { setAdj(null); reload(); }} />}
    </>
  );
}

function SkuModal({ sku, onClose, onSaved }) {
  const [f, setF] = useState(sku); const [err, setErr] = useState(null);
  const save = async () => {
    const { id, ...rest } = f;
    const { error } = id ? await supabase.from('skus').update(rest).eq('id', id) : await supabase.from('skus').insert(rest);
    if (error) setErr(error.message); else onSaved();
  };
  return (
    <Modal title={sku.id ? 'Edit SKU' : 'Add SKU'} onClose={onClose}>
      <div className="form-grid">
        <Field label="SKU"><input type="text" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Product name"><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Variant"><input type="text" value={f.variant} onChange={(e) => setF({ ...f, variant: e.target.value })} /></Field>
        <Field label="Default packaging"><select value={f.packaging} onChange={(e) => setF({ ...f, packaging: e.target.value })}><option value="mailer">Poly mailer</option><option value="box_single">Box (single)</option><option value="box_double">Box (double)</option><option value="client_supplied">Client supplied</option></select></Field>
        <Field label="Low-stock threshold"><input type="number" value={f.low_stock_threshold} onChange={(e) => setF({ ...f, low_stock_threshold: Number(e.target.value) })} /></Field>
        <Field label="Active"><select value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}><option value="1">Active</option><option value="0">Inactive</option></select></Field>
      </div>
      {err && <div className="alert bad">{err}</div>}
      <div className="row" style={{ marginTop: 10 }}><div className="spacer" /><button className="btn primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

function AdjustModal({ sku, onClose, onSaved }) {
  const [qty, setQty] = useState(''); const [reason, setReason] = useState('cycle_count'); const [note, setNote] = useState(''); const [err, setErr] = useState(null);
  const save = async () => {
    const n = Number(qty); if (!n) return setErr('Enter a non-zero quantity (negative to remove).');
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('inventory_moves').insert({ org_id: sku.org_id, sku_id: sku.sku_id, qty: n, reason, note, created_by: user.id });
    if (error) setErr(error.message); else onSaved();
  };
  return (
    <Modal title={`Adjust ${sku.sku}`} sub={`On hand ${sku.on_hand}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Quantity (+/−)"><input type="number" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Reason"><select value={reason} onChange={(e) => setReason(e.target.value)}><option value="cycle_count">Cycle count</option><option value="adjust">Adjustment</option><option value="damage">Damage</option><option value="return_restock">Return restock</option><option value="transfer">Transfer</option></select></Field>
      </div>
      <Field label="Note"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={save}>Post adjustment</button></div>
    </Modal>
  );
}

function Inbound({ me, org }) {
  const [sel, setSel] = useState(null); const [creating, setCreating] = useState(false);
  const { data, loading, reload } = useAsync(async () => {
    let q = supabase.from('inbound_shipments').select('*, inbound_lines(*, skus(sku, name))').order('created_at', { ascending: false });
    if (org) q = q.eq('org_id', org.id);
    const { data, error } = await q; if (error) throw error; return data;
  }, [org?.id]);
  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3>Inbound shipments</h3><div className="spacer" />
          <button className="btn sm primary" onClick={() => setCreating(true)}>+ Announce inbound</button>
        </div>
        {loading ? <Empty>Loading…</Empty> : !data?.length ? <Empty>No inbound shipments. Announce one so receiving knows what to expect.</Empty> : (
          <table>
            <thead><tr><th>Reference</th>{!org && <th>Client</th>}<th>From</th><th>Carrier</th><th>Expected</th><th className="num">Pallets</th><th className="num">Cartons</th><th className="num">Units</th><th>Status</th></tr></thead>
            <tbody>{data.map((i) => (
              <tr key={i.id} className="click" onClick={() => setSel(i)}>
                <td className="mono">{i.reference}</td>{!org && <td className="small muted">{me.orgNames?.[i.org_id]}</td>}
                <td className="small">{i.origin}</td><td className="small">{i.carrier}{i.tracking && <div className="mono muted">{i.tracking}</div>}</td>
                <td>{fmtDate(i.expected_at)}</td><td className="num">{i.pallets}</td><td className="num">{i.cartons}</td>
                <td className="num">{i.inbound_lines.reduce((a, l) => a + (l.qty_received ?? l.qty_expected), 0)}</td>
                <td><Pill s={i.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <InboundForm org={org} me={me} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {sel && <InboundModal inbound={sel} staff={me.isStaff} onClose={() => setSel(null)} onChange={() => { setSel(null); reload(); }} />}
    </>
  );
}

function InboundForm({ org, me, onClose, onSaved }) {
  const orgId = org?.id || me.orgs?.[0]?.id;
  const [f, setF] = useState({ org_id: orgId, reference: '', carrier: '', tracking: '', origin: '', expected_at: '', pallets: 0, cartons: 0, notes: '' });
  const [lines, setLines] = useState([{ sku_id: '', qty_expected: '' }]); const [err, setErr] = useState(null);
  const { data: skus } = useAsync(async () => (await supabase.from('skus').select('id, sku, name').eq('org_id', f.org_id).eq('is_physical', true).order('sku')).data, [f.org_id]);
  const save = async () => {
    if (!f.reference) return setErr('Reference is required.');
    const { data: { user } } = await supabase.auth.getUser();
    const { data: ib, error } = await supabase.from('inbound_shipments').insert({ ...f, expected_at: f.expected_at || null, created_by: user.id }).select('id').single();
    if (error) return setErr(error.message);
    const ls = lines.filter((l) => l.sku_id && Number(l.qty_expected) > 0).map((l) => ({ inbound_id: ib.id, sku_id: l.sku_id, qty_expected: Number(l.qty_expected) }));
    if (ls.length) { const { error: e2 } = await supabase.from('inbound_lines').insert(ls); if (e2) return setErr(e2.message); }
    onSaved();
  };
  return (
    <Modal title="Announce inbound shipment" sub="Tell receiving what's coming so it can be checked in against your counts." onClose={onClose}>
      {!org && <Field label="Client"><select value={f.org_id} onChange={(e) => setF({ ...f, org_id: e.target.value })}>{me.orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
      <div className="form-grid">
        <Field label="Reference / PO #"><input type="text" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Expected date"><input type="date" value={f.expected_at} onChange={(e) => setF({ ...f, expected_at: e.target.value })} /></Field>
        <Field label="Shipping from"><input type="text" value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })} /></Field>
        <Field label="Carrier"><input type="text" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} /></Field>
        <Field label="Tracking / PRO #"><input type="text" value={f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.value })} /></Field>
        <Field label="Pallets"><input type="number" value={f.pallets} onChange={(e) => setF({ ...f, pallets: Number(e.target.value) })} /></Field>
        <Field label="Cartons"><input type="number" value={f.cartons} onChange={(e) => setF({ ...f, cartons: Number(e.target.value) })} /></Field>
      </div>
      <h3 style={{ margin: '6px 0' }}>Contents</h3>
      {lines.map((l, i) => (
        <div className="row" key={i} style={{ marginBottom: 6 }}>
          <select style={{ flex: 1 }} value={l.sku_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, sku_id: e.target.value } : x))}><option value="">Select SKU…</option>{skus?.map((s) => <option key={s.id} value={s.id}>{s.sku} — {s.name}</option>)}</select>
          <input type="number" placeholder="Qty" style={{ width: 100 }} value={l.qty_expected} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty_expected: e.target.value } : x))} />
          <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setLines([...lines, { sku_id: '', qty_expected: '' }])}>+ Line</button>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={save}>Announce</button></div>
    </Modal>
  );
}

function InboundModal({ inbound: i, staff, onClose, onChange }) {
  const [counts, setCounts] = useState(Object.fromEntries(i.inbound_lines.map((l) => [l.id, l.qty_received ?? l.qty_expected])));
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const receivable = staff && ['expected', 'in_transit'].includes(i.status);
  const receive = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('receive_inbound', { p_inbound_id: i.id, p_counts: Object.entries(counts).map(([line_id, q]) => ({ line_id, qty_received: Number(q) || 0 })) });
    setBusy(false); if (error) setErr(error.message); else onChange();
  };
  const mark = async (status) => { const { error } = await supabase.from('inbound_shipments').update({ status }).eq('id', i.id); if (error) setErr(error.message); else onChange(); };
  return (
    <Modal title={`Inbound ${i.reference}`} sub={`${i.origin || ''} · ${i.carrier || ''} · expected ${fmtDate(i.expected_at)}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}><Pill s={i.status} />{i.received_at && <span className="muted small">received {fmtDateTime(i.received_at)}</span>}<div className="spacer" /><span className="small muted">{i.pallets} pallets · {i.cartons} cartons</span></div>
      <table>
        <thead><tr><th>SKU</th><th>Product</th><th className="num">Expected</th><th className="num">{receivable ? 'Counted' : 'Received'}</th></tr></thead>
        <tbody>{i.inbound_lines.map((l) => (
          <tr key={l.id}><td className="mono">{l.skus?.sku}</td><td>{l.skus?.name}</td><td className="num">{l.qty_expected}</td>
            <td className="num" style={{ width: 120 }}>{receivable ? <input type="number" value={counts[l.id]} onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} style={{ textAlign: 'right' }} /> : (l.qty_received ?? '—')}
              {!receivable && l.qty_received != null && l.qty_received !== l.qty_expected && <span className="pill warn" style={{ marginLeft: 6 }}>{l.qty_received - l.qty_expected > 0 ? '+' : ''}{l.qty_received - l.qty_expected}</span>}</td></tr>
        ))}</tbody>
      </table>
      {i.notes && <div className="small muted" style={{ marginTop: 10 }}>{i.notes}</div>}
      {err && <div className="alert bad" style={{ marginTop: 10 }}>{err}</div>}
      {receivable && (
        <div className="row" style={{ marginTop: 14 }}>
          {i.status === 'expected' && <button className="btn" onClick={() => mark('in_transit')}>Mark in transit</button>}
          <div className="spacer" /><button className="btn primary" disabled={busy} onClick={receive}>{busy ? 'Receiving…' : 'Confirm received → add to stock'}</button>
        </div>
      )}
    </Modal>
  );
}
