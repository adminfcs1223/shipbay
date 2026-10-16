import { useState } from 'react';
import { supabase, fmtDateTime, fmtDate } from '../lib';
import { Pill, Modal, Field, Empty, useAsync, Seg } from '../ui';

export default function Returns({ me, org }) {
  const [tab, setTab] = useState('tickets');
  return (
    <>
      <div className="topbar">
        <div><h1>Returns & support</h1><div className="sub">Report an issue, ask a question, or log a return coming back to the warehouse</div></div>
        <Seg value={tab} onChange={setTab} options={[['tickets', 'Support'], ['returns', 'Returns']]} />
      </div>
      {tab === 'tickets' ? <Tickets me={me} org={org} /> : <ReturnsList me={me} org={org} />}
    </>
  );
}

function Tickets({ me, org }) {
  const [sel, setSel] = useState(null); const [creating, setCreating] = useState(false); const [show, setShow] = useState('open');
  const { data, loading, reload } = useAsync(async () => {
    let q = supabase.from('tickets').select('*, ticket_messages(count)').order('updated_at', { ascending: false });
    if (org) q = q.eq('org_id', org.id);
    if (show === 'open') q = q.neq('status', 'closed');
    const { data, error } = await q; if (error) throw error; return data;
  }, [org?.id, show]);
  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3>Tickets</h3><Seg value={show} onChange={setShow} options={[['open', 'Open'], ['all', 'All']]} /><div className="spacer" />
          <button className="btn sm primary" onClick={() => setCreating(true)}>+ New ticket</button>
        </div>
        {loading ? <Empty>Loading…</Empty> : !data?.length ? <Empty>Nothing open. Need something? Open a ticket and ShipBay replies here.</Empty> : (
          <table>
            <thead><tr><th>Subject</th>{!org && <th>Client</th>}<th>Priority</th><th>Status</th><th className="num">Messages</th><th>Updated</th></tr></thead>
            <tbody>{data.map((t) => (
              <tr key={t.id} className="click" onClick={() => setSel(t)}>
                <td style={{ fontWeight: 500 }}>{t.subject}</td>{!org && <td className="small muted">{me.orgNames?.[t.org_id]}</td>}
                <td><span className={`pill ${t.priority === 'urgent' ? 'bad' : t.priority === 'high' ? 'warn' : 'neutral'}`}>{t.priority}</span></td>
                <td><Pill s={t.status} /></td><td className="num">{t.ticket_messages?.[0]?.count ?? 0}</td><td className="small">{fmtDateTime(t.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <NewTicket me={me} org={org} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {sel && <Thread ticket={sel} me={me} onClose={() => setSel(null)} onChange={reload} />}
    </>
  );
}

function NewTicket({ me, org, onClose, onSaved }) {
  const [f, setF] = useState({ org_id: org?.id || me.orgs?.[0]?.id, subject: '', priority: 'normal', body: '' }); const [err, setErr] = useState(null);
  const save = async () => {
    if (!f.subject || !f.body) return setErr('Subject and message are required.');
    const { data: { user } } = await supabase.auth.getUser();
    const { data: t, error } = await supabase.from('tickets').insert({ org_id: f.org_id, subject: f.subject, priority: f.priority, created_by: user.id }).select('id').single();
    if (error) return setErr(error.message);
    const { error: e2 } = await supabase.from('ticket_messages').insert({ ticket_id: t.id, org_id: f.org_id, author_id: user.id, body: f.body });
    if (e2) return setErr(e2.message); onSaved();
  };
  return (
    <Modal title="New ticket" onClose={onClose}>
      {!org && <Field label="Client"><select value={f.org_id} onChange={(e) => setF({ ...f, org_id: e.target.value })}>{me.orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
      <div className="form-grid">
        <Field label="Subject"><input type="text" autoFocus value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Order #1042 shipped to wrong address" /></Field>
        <Field label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent — customer impacted</option></select></Field>
      </div>
      <Field label="Message"><textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={save}>Open ticket</button></div>
    </Modal>
  );
}

function Thread({ ticket: t, me, onClose, onChange }) {
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [err, setErr] = useState(null);
  const { data: msgs, reload } = useAsync(async () => (await supabase.from('ticket_messages').select('*, profiles(full_name, role)').eq('ticket_id', t.id).order('created_at')).data, [t.id]);
  const send = async () => {
    if (!body.trim()) return;
    const { error } = await supabase.from('ticket_messages').insert({ ticket_id: t.id, org_id: t.org_id, author_id: me.id, body, internal: me.isStaff && internal });
    if (error) return setErr(error.message);
    await supabase.from('tickets').update({ status: me.isStaff ? 'pending' : 'open' }).eq('id', t.id);
    setBody(''); reload(); onChange();
  };
  const setStatus = async (status) => { await supabase.from('tickets').update({ status }).eq('id', t.id); onChange(); onClose(); };
  return (
    <Modal title={t.subject} sub={`Opened ${fmtDateTime(t.created_at)}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}><Pill s={t.status} /><span className="pill neutral">{t.priority}</span><div className="spacer" />
        {t.status !== 'closed' ? <button className="btn sm" onClick={() => setStatus('closed')}>Close ticket</button> : <button className="btn sm" onClick={() => setStatus('open')}>Reopen</button>}</div>
      <div className="thread">
        {msgs?.map((m) => {
          const staffMsg = ['shipbay_admin', 'shipbay_staff'].includes(m.profiles?.role);
          return (<div key={m.id} className={`msg ${m.author_id === me.id ? 'mine' : ''} ${m.internal ? 'internal' : ''}`}>
            <div className="who">{m.profiles?.full_name || 'User'}{staffMsg && ' · ShipBay'}{m.internal && ' · internal note'} — {fmtDateTime(m.created_at)}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>);
        })}
      </div>
      {t.status !== 'closed' && (
        <div style={{ marginTop: 14 }}>
          <textarea rows={3} placeholder="Reply…" value={body} onChange={(e) => setBody(e.target.value)} />
          {err && <div className="alert bad" style={{ marginTop: 6 }}>{err}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            {me.isStaff && <label style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (hidden from client)</label>}
            <div className="spacer" /><button className="btn primary" onClick={send}>Send</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ReturnsList({ me, org }) {
  const [creating, setCreating] = useState(false); const [sel, setSel] = useState(null);
  const { data, loading, reload } = useAsync(async () => {
    let q = supabase.from('returns').select('*, orders(order_number, customer_name)').order('created_at', { ascending: false });
    if (org) q = q.eq('org_id', org.id);
    const { data, error } = await q; if (error) throw error; return data;
  }, [org?.id]);
  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <h3>Returns</h3><div className="spacer" /><button className="btn sm primary" onClick={() => setCreating(true)}>+ Log return</button>
        </div>
        {loading ? <Empty>Loading…</Empty> : !data?.length ? <Empty>No returns logged. When a customer sends something back, log the RMA so receiving can match it.</Empty> : (
          <table>
            <thead><tr><th>RMA</th>{!org && <th>Client</th>}<th>Order</th><th>Reason</th><th>Status</th><th>Disposition</th><th>Received</th></tr></thead>
            <tbody>{data.map((r) => (
              <tr key={r.id} className="click" onClick={() => setSel(r)}>
                <td className="mono">{r.rma}</td>{!org && <td className="small muted">{me.orgNames?.[r.org_id]}</td>}
                <td>{r.orders?.order_number || '—'}<div className="small muted">{r.orders?.customer_name}</div></td>
                <td className="small">{r.reason}</td><td><Pill s={r.status} /></td><td className="small">{r.disposition || '—'}</td><td className="small">{fmtDate(r.received_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <NewReturn me={me} org={org} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {sel && <ReturnModal r={sel} staff={me.isStaff} onClose={() => setSel(null)} onChange={() => { setSel(null); reload(); }} />}
    </>
  );
}

function NewReturn({ me, org, onClose, onSaved }) {
  const [f, setF] = useState({ org_id: org?.id || me.orgs?.[0]?.id, rma: '', order_number: '', reason: 'exchange', notes: '' }); const [err, setErr] = useState(null);
  const save = async () => {
    if (!f.rma) return setErr('RMA / reference is required.');
    const { data: { user } } = await supabase.auth.getUser();
    let order_id = null;
    if (f.order_number) { const { data } = await supabase.from('orders').select('id').eq('org_id', f.org_id).eq('order_number', f.order_number.startsWith('#') ? f.order_number : `#${f.order_number}`).maybeSingle(); order_id = data?.id ?? null; }
    const { error } = await supabase.from('returns').insert({ org_id: f.org_id, rma: f.rma, order_id, reason: f.reason, notes: f.notes, created_by: user.id });
    if (error) setErr(error.message); else onSaved();
  };
  return (
    <Modal title="Log a return" sub="Receiving matches the package to this RMA when it arrives." onClose={onClose}>
      {!org && <Field label="Client"><select value={f.org_id} onChange={(e) => setF({ ...f, org_id: e.target.value })}>{me.orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
      <div className="form-grid">
        <Field label="RMA / reference"><input type="text" autoFocus value={f.rma} onChange={(e) => setF({ ...f, rma: e.target.value })} placeholder="Redo RMA or order # + EXC" /></Field>
        <Field label="Original order #"><input type="text" value={f.order_number} onChange={(e) => setF({ ...f, order_number: e.target.value })} placeholder="#1042" /></Field>
        <Field label="Reason"><select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{['exchange', 'refund', 'damaged in transit', 'wrong item', 'defective', 'other'].map((r) => <option key={r}>{r}</option>)}</select></Field>
      </div>
      <Field label="Instructions"><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. Inspect strap stitching; restock if unused, otherwise hold for photos." /></Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={save}>Log return</button></div>
    </Modal>
  );
}

function ReturnModal({ r, staff, onClose, onChange }) {
  const [disp, setDisp] = useState(r.disposition || 'restock'); const [err, setErr] = useState(null);
  const set = async (patch) => { const { error } = await supabase.from('returns').update(patch).eq('id', r.id); if (error) setErr(error.message); else onChange(); };
  return (
    <Modal title={`Return ${r.rma}`} sub={`${r.orders?.order_number || 'no order linked'} · ${r.reason}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}><Pill s={r.status} />{r.received_at && <span className="small muted">received {fmtDateTime(r.received_at)}</span>}</div>
      {r.notes && <div className="msg" style={{ marginBottom: 12 }}><div className="who">Client instructions</div>{r.notes}</div>}
      {err && <div className="alert bad">{err}</div>}
      {staff && (
        <div className="stack">
          {['requested', 'in_transit'].includes(r.status) && <div className="row"><div className="spacer" /><button className="btn primary" onClick={() => set({ status: 'received', received_at: new Date().toISOString() })}>Mark received at warehouse</button></div>}
          {['received', 'inspected'].includes(r.status) && (
            <div className="row">
              <select value={disp} onChange={(e) => setDisp(e.target.value)} style={{ width: 240 }}><option value="restock">Restock — resellable</option><option value="hold">Hold for client decision</option><option value="dispose">Dispose / damaged</option><option value="return_to_client">Return to client</option></select>
              <div className="spacer" />
              <button className="btn primary" onClick={() => set({ status: disp === 'restock' ? 'restocked' : disp === 'dispose' ? 'disposed' : 'inspected', disposition: disp })}>Save disposition</button>
            </div>
          )}
          {disp === 'restock' && ['received', 'inspected'].includes(r.status) && <div className="alert info small">Restocking: post the unit back into inventory from Inventory → Adjust (reason: return restock) after saving.</div>}
          {!['closed'].includes(r.status) && <div className="row"><div className="spacer" /><button className="btn sm" onClick={() => set({ status: 'closed' })}>Close</button></div>}
        </div>
      )}
    </Modal>
  );
}
