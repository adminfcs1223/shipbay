import { useState } from 'react';
import { supabase, fmtMoney, fmtDate, monthStart } from '../lib';
import { Pill, Kpi, Modal, Field, Empty, useAsync } from '../ui';

export default function Billing({ me, org }) {
  const [sel, setSel] = useState(null);
  const [period, setPeriod] = useState(monthStart().slice(0, 7));
  const [genOrg, setGenOrg] = useState(org?.id || me.orgs?.[0]?.id || '');
  const [msg, setMsg] = useState(null);

  const { data, loading, reload } = useAsync(async () => {
    let q = supabase.from('invoices').select('*, invoice_lines(*)').order('period_start', { ascending: false });
    if (org) q = q.eq('org_id', org.id);
    const { data, error } = await q; if (error) throw error; return data;
  }, [org?.id]);

  const { data: rc } = useAsync(async () => {
    if (!org) return null;
    const { data } = await supabase.from('rate_cards').select('*').eq('org_id', org.id).lte('effective_from', new Date().toISOString().slice(0, 10)).order('effective_from', { ascending: false }).limit(1);
    return data?.[0] || null;
  }, [org?.id]);

  const { data: snap } = useAsync(async () => {
    let q = supabase.from('storage_snapshots').select('*').eq('period', monthStart()); if (org) q = q.eq('org_id', org.id);
    return (await q).data;
  }, [org?.id]);

  const generate = async () => {
    setMsg(null);
    const { error } = await supabase.rpc('generate_invoice', { p_org_id: genOrg, p_period: `${period}-01` });
    if (error) setMsg(['bad', error.message]); else { setMsg(['ok', 'Draft invoice generated from the rate card. Review, then mark Sent.']); reload(); }
  };

  const outstanding = (data || []).filter((i) => i.status === 'sent').reduce((a, i) => a + Number(i.total), 0);
  const last = (data || []).find((i) => i.status !== 'draft');

  return (
    <>
      <div className="topbar">
        <div><h1>Billing</h1><div className="sub">{org ? 'Statements built from your rate card. Postage on your own account is never billed here.' : 'Generate and send monthly statements'}</div></div>
        {me.isStaff && (
          <div className="actions">
            {!org && <select value={genOrg} onChange={(e) => setGenOrg(e.target.value)} style={{ width: 200 }}>{me.orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 170 }} />
            <button className="btn primary" onClick={generate}>Generate draft</button>
          </div>
        )}
      </div>
      {msg && <div className={`alert ${msg[0]}`} style={{ marginBottom: 14 }}>{msg[1]}</div>}

      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <Kpi label="Outstanding" value={fmtMoney(outstanding)} tone={outstanding ? 'warn' : ''} />
        <Kpi label="Last statement" value={last ? fmtMoney(last.total) : '—'} hint={last ? `${fmtDate(last.period_start)} – ${fmtDate(last.period_end)}` : 'None issued yet'} />
        {rc && <Kpi label="Pick & pack" value={`${fmtMoney(rc.pick_pack_first)} + ${fmtMoney(rc.pick_pack_addl)}`} hint={rc.label} />}
        {snap?.length > 0 && <Kpi label="Storage footprint" value={`${snap.reduce((a, s) => a + s.pallets, 0)}P · ${snap.reduce((a, s) => a + s.shelves, 0)}S · ${snap.reduce((a, s) => a + s.bins, 0)}B`} hint="Pallets · shelves · bins this month" />}
      </div>

      {rc && org && <RateCard rc={rc} />}

      <div className="card" style={{ padding: 0, marginTop: 14 }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><h3>Statements</h3></div>
        {loading ? <Empty>Loading…</Empty> : !data?.length ? <Empty>No statements yet.</Empty> : (
          <table>
            <thead><tr><th>Invoice</th>{!org && <th>Client</th>}<th>Period</th><th>Issued</th><th>Due</th><th className="num">Total</th><th>Status</th></tr></thead>
            <tbody>{data.map((i) => (
              <tr key={i.id} className="click" onClick={() => setSel(i)}>
                <td className="mono">{i.invoice_number}</td>{!org && <td className="small muted">{me.orgNames?.[i.org_id]}</td>}
                <td>{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td><td>{fmtDate(i.issued_at)}</td><td>{fmtDate(i.due_at)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(i.total)}</td><td><Pill s={i.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {sel && <InvoiceModal inv={sel} staff={me.isStaff} orgName={org?.name || me.orgNames?.[sel.org_id]} onClose={() => setSel(null)} onChange={() => { setSel(null); reload(); }} />}
    </>
  );
}

function RateCard({ rc }) {
  const waived = (d) => d && new Date(d) >= new Date();
  return (
    <div className="card">
      <div className="row"><h3>Your rate card — {rc.label}</h3><div className="spacer" /><span className="small muted">effective {fmtDate(rc.effective_from)}{rc.effective_to && ` – ${fmtDate(rc.effective_to)}`}</span></div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <R l="Pick & pack (first unit)" v={fmtMoney(rc.pick_pack_first)} />
        <R l="Each additional unit" v={fmtMoney(rc.pick_pack_addl)} />
        <R l="Storage / pallet / mo" v={fmtMoney(rc.storage_pallet)} n={waived(rc.storage_waived_until) && `waived through ${fmtDate(rc.storage_waived_until)}`} />
        <R l="Storage / shelf / mo" v={fmtMoney(rc.storage_shelf)} />
        <R l="Receiving / pallet" v={fmtMoney(rc.receiving_pallet)} />
        <R l="Receiving / carton" v={fmtMoney(rc.receiving_carton)} />
        <R l="Returns processing" v={fmtMoney(rc.returns_fee)} />
        <R l="Poly mailer" v={fmtMoney(rc.packaging_mailer)} n="$0 if you supply" />
        <R l="Shipper box single / double" v={`${fmtMoney(rc.packaging_box_single)} / ${fmtMoney(rc.packaging_box_double)}`} />
        <R l="International handling" v={fmtMoney(rc.intl_surcharge)} />
        <R l="Monthly minimum" v={fmtMoney(rc.monthly_minimum)} n={waived(rc.minimum_waived_until) && `waived through ${fmtDate(rc.minimum_waived_until)}`} />
        {rc.postage_guarantee_avg && <R l="Postage guarantee" v={`avg ≤ ${fmtMoney(rc.postage_guarantee_avg)}/label`} n={`through ${fmtDate(rc.postage_guarantee_until)}`} />}
      </div>
      {rc.notes && <div className="small muted" style={{ marginTop: 10 }}>{rc.notes}</div>}
    </div>
  );
}
const R = ({ l, v, n }) => (<div><div className="small muted">{l}</div><div style={{ fontWeight: 600 }}>{v}</div>{n && <div className="small" style={{ color: 'var(--ok)' }}>{n}</div>}</div>);

function InvoiceModal({ inv, staff, orgName, onClose, onChange }) {
  const [err, setErr] = useState(null);
  const set = async (patch) => { const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id); if (error) setErr(error.message); else onChange(); };
  const lines = (inv.invoice_lines || []).filter((l) => l.active !== false).sort((a, b) => a.sort - b.sort);
  return (
    <Modal title={`Invoice ${inv.invoice_number}`} sub={`${orgName || ''} · ${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}><Pill s={inv.status} />{inv.due_at && <span className="small muted">due {fmtDate(inv.due_at)}</span>}{inv.paid_at && <span className="small muted">paid {fmtDate(inv.paid_at)}</span>}<div className="spacer" /><button className="btn sm" onClick={() => window.print()}>Print / PDF</button></div>
      <table>
        <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="num">{Number(l.qty).toLocaleString()}</td><td className="num">{fmtMoney(l.unit_price)}</td><td className="num">{fmtMoney(l.amount)}</td></tr>)}
          <tr><td colSpan={3} style={{ textAlign: 'right', fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 700, fontSize: 16 }}>{fmtMoney(inv.total)}</td></tr>
        </tbody>
      </table>
      {inv.notes && <div className="small muted" style={{ marginTop: 10 }}>{inv.notes}</div>}
      {err && <div className="alert bad" style={{ marginTop: 10 }}>{err}</div>}
      {staff && (
        <div className="row" style={{ marginTop: 14 }}>
          {inv.status === 'draft' && <button className="btn" onClick={() => set({ status: 'void' })}>Void</button>}
          <div className="spacer" />
          {inv.status === 'draft' && <button className="btn primary" onClick={() => set({ status: 'sent', issued_at: new Date().toISOString() })}>Mark sent (visible to client)</button>}
          {inv.status === 'sent' && <button className="btn primary" onClick={() => set({ status: 'paid', paid_at: new Date().toISOString() })}>Mark paid</button>}
        </div>
      )}
    </Modal>
  );
}
