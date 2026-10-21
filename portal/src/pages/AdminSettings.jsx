// Admin settings — manage every login (shipbay admins only): add staff or client users, reset passwords, deactivate.
import { useEffect, useMemo, useState } from 'react';
import { supabase, fn } from '../lib';
import { useBrands } from '../shared';

const ROLES = [['shipbay_admin', 'ShipBay admin', 'Everything, including this page'], ['shipbay_staff', 'ShipBay staff', 'Warehouse screens and client accounts'], ['client_admin', 'Client admin', 'A brand’s portal: orders, documents, settings'], ['client_user', 'Client user', 'A brand’s portal, read-only']];
const roleLabel = (r) => ROLES.find((x) => x[0] === r)?.[1] || r;

export default function AdminSettings({ me }) {
  const [users, setUsers] = useState(null);
  const [orgs] = useBrands();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [cred, setCred] = useState(null);   // { email, password, mail } shown once
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => { const { data } = await supabase.from('profiles').select('*').order('role').order('full_name'); setUsers(data || []); };
  useEffect(() => { load(); }, []);
  const orgName = (id) => (orgs || []).find((o) => o.id === id)?.name || '';
  const list = useMemo(() => (users || []).filter((u) => !q || [u.full_name, u.email, roleLabel(u.role), orgName(u.org_id)].filter(Boolean).some((s) => s.toLowerCase().includes(q.toLowerCase()))), [users, q, orgs]);

  const reset = async (u) => {
    if (!window.confirm(`Reset ${u.email}’s password? Their current one stops working immediately.`)) return;
    setBusy(u.id);
    const r = await fn('admin-users', { action: 'reset', user_id: u.id, send_email: window.confirm('Email them the new password? (Cancel = show it to you only)') });
    setBusy(null);
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    setCred(r);
  };
  const setActive = async (u, active) => {
    if (!active && !window.confirm(`Deactivate ${u.email}? They won’t be able to sign in until you turn them back on.`)) return;
    setBusy(u.id);
    const r = await fn('admin-users', { action: 'set_active', user_id: u.id, active });
    setBusy(null);
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    load();
  };

  if (me?.role !== 'shipbay_admin') return <div className="card"><div className="empty">Only shipbay admins can manage users.</div></div>;
  return (
    <>
      <div className="pagehead">
        <div><h1>Admin settings<span className="dot">.</span></h1><p className="sub">Every login to shipbay.dashboard — staff and clients. Add a user, reset a password, switch someone off.</p></div>
        <div className="glance">
          <div><small>Staff</small><b>{(users || []).filter((u) => u.role.startsWith('shipbay') && u.active !== false).length}</b></div>
          <div><small>Client users</small><b>{(users || []).filter((u) => u.role.startsWith('client') && u.active !== false).length}</b></div>
          <div><small>Inactive</small><b>{(users || []).filter((u) => u.active === false).length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="opsbar">
        <input className="search" placeholder="Search name, email, role, brand…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Add user</button>
      </div>
      <div className="card">
        {users === null ? <div className="empty">Loading…</div> : (
          <div className="tablewrap"><table className="ordertable users">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Brand</th><th>Last seen</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((u) => (
              <tr key={u.id} className={u.active === false ? 'muted' : ''}>
                <td><b>{u.full_name || '—'}</b>{u.id === me.id && <span className="sm"> (you)</span>}{u.phone && <div className="sm">{u.phone}</div>}</td>
                <td>{u.email}</td>
                <td><span className={`pill ${u.role === 'shipbay_admin' ? 'connected' : ''}`}>{roleLabel(u.role)}</span></td>
                <td>{u.org_id ? orgName(u.org_id) : <span className="sm">—</span>}</td>
                <td className="sm">{u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'never'}</td>
                <td><span className={`statuspill ${u.active === false ? 'bad' : 'ok'}`}>{u.active === false ? 'Inactive' : 'Active'}</span></td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-xs" onClick={() => setEditing(u)}>Edit</button>{' '}
                  <button className="btn-xs" disabled={busy === u.id} onClick={() => reset(u)}>Reset password</button>{' '}
                  {u.id !== me.id && (u.active === false ? <button className="btn-xs" disabled={busy === u.id} onClick={() => setActive(u, true)}>Reactivate</button> : <button className="btn-xs" disabled={busy === u.id} onClick={() => setActive(u, false)}>Deactivate</button>)}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {adding && <UserModal orgs={orgs || []} onClose={() => setAdding(false)} onDone={(r) => { setAdding(false); setCred(r); load(); }} onErr={(t) => setMsg({ kind: 'err', text: t })} />}
      {editing && <UserModal user={editing} orgs={orgs || []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); setMsg({ kind: 'ok', text: 'Saved.' }); }} onErr={(t) => setMsg({ kind: 'err', text: t })} />}
      {cred && (
        <div className="overlay" onClick={() => setCred(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Login details<span className="dot">.</span></h3>
            <p className="lead">Shown once — copy them now. {cred.mail?.ok ? 'They’ve also been emailed.' : cred.mail?.error ? `Email failed: ${cred.mail.error}` : 'Not emailed.'}</p>
            <div className="credbox"><div><small>Sign in at</small><b>auth.shipbay3pl.com</b></div><div><small>Email</small><b>{cred.email}</b></div><div><small>Temporary password</small><b className="mono">{cred.password}</b></div></div>
            <div className="actions"><button className="btn-sm" onClick={() => navigator.clipboard?.writeText(`Sign in: https://auth.shipbay3pl.com\nEmail: ${cred.email}\nTemporary password: ${cred.password}`)}>Copy</button><button className="btn-sm primary" onClick={() => setCred(null)}>Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function UserModal({ user, orgs, onClose, onDone, onErr }) {
  const [f, setF] = useState({ full_name: user?.full_name || '', email: user?.email || '', phone: user?.phone || '', role: user?.role || 'shipbay_staff', org_id: user?.org_id || '', send_email: true });
  const [busy, setBusy] = useState(false);
  const client = f.role.startsWith('client');
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    const r = user
      ? await fn('admin-users', { action: 'update', user_id: user.id, full_name: f.full_name, phone: f.phone, role: f.role, org_id: client ? f.org_id : null })
      : await fn('admin-users', { action: 'create', email: f.email, full_name: f.full_name, phone: f.phone, role: f.role, org_id: client ? f.org_id : null, send_email: f.send_email });
    setBusy(false);
    if (r.error) return onErr(r.error);
    onDone(r);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{user ? 'Edit user' : 'Add user'}<span className="dot">.</span></h3>
        <div className="grid2">
          <div className="field"><label>Full name</label><input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} autoFocus /></div>
          <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        </div>
        <div className="field"><label>Email {user && <span className="sm">(can’t change — add a new user instead)</span>}</label><input type="email" required value={f.email} disabled={!!user} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="lbl">Role</div>
        <div className="chanlist">
          {ROLES.map(([k, l, d]) => <label key={k} className={f.role === k ? 'on' : ''}><input type="radio" name="role" checked={f.role === k} onChange={() => setF({ ...f, role: k })} /><div><b>{l}</b><div className="d">{d}</div></div></label>)}
        </div>
        {client && <div className="field"><label>Brand</label><select required value={f.org_id} onChange={(e) => setF({ ...f, org_id: e.target.value })}><option value="">— choose —</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
        {!user && <label className="chk" style={{ margin: '4px 0 10px' }}><input type="checkbox" checked={f.send_email} onChange={(e) => setF({ ...f, send_email: e.target.checked })} /> Email them their login details (you’ll see the password here too)</label>}
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{busy ? 'Saving…' : user ? 'Save' : 'Create login'}</button></div>
      </form>
    </div>
  );
}
