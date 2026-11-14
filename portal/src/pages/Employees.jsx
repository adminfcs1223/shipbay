// Warehouse employees — who can sign in at wms.shipbay3pl.com with an employee number + 6-digit PIN (admins only).
// A new employee is a WMS-only login (no email, no dashboard). An admin or staff login can be given a number too.
// PINs are stored hashed; a PIN is shown once here, right after it is set.
import { useMemo, useState } from 'react';
import { fn } from '../lib';

const newPin = () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return String(b[0] % 1000000).padStart(6, '0'); };

export default function Employees({ me, users, reload, say }) {
  const [modal, setModal] = useState(null);     // { kind: 'new' | 'edit' | 'pin', user? }
  const [shown, setShown] = useState(null);     // { name, employee_no, pin } shown once
  const [busy, setBusy] = useState(null);
  const emps = useMemo(() => (users || []).filter((u) => u.employee_no != null).sort((a, b) => a.employee_no - b.employee_no), [users]);
  const next = useMemo(() => Math.max(1000, ...emps.map((e) => e.employee_no)) + 1, [emps]);
  const canAssign = (users || []).filter((u) => u.employee_no == null && ['shipbay_admin', 'shipbay_staff'].includes(u.role) && u.active !== false);

  const setActive = async (u, active) => {
    if (!active && !window.confirm(`Switch off employee ${u.employee_no} (${u.full_name})? They won’t be able to sign in to the WMS until you turn them back on.`)) return;
    setBusy(u.id);
    const r = await fn('wms-employees', { action: 'set_active', user_id: u.id, active });
    setBusy(null); if (r.error) return say({ kind: 'err', text: r.error }); reload();
  };

  return (
    <>
      <div className="opsbar" style={{ marginTop: 28 }}>
        <h2 style={{ margin: 0 }}>Warehouse employees<span className="dot">.</span></h2>
        <div className="spacer" />
        <button className="btn-sm primary" onClick={() => setModal({ kind: 'new' })}>+ Add employee</button>
      </div>
      <div className="card">
        {users === null ? <div className="empty">Loading…</div> : emps.length === 0 ? <div className="empty">No employee numbers yet. Add one and they can sign in at wms.shipbay3pl.com with the number and a PIN.</div> : (
          <div className="tablewrap"><table className="ordertable users">
            <thead><tr><th>Employee #</th><th>Name</th><th>Access</th><th>Last WMS sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>{emps.map((u) => (
              <tr key={u.id} className={u.active === false ? 'muted' : ''}>
                <td><b className="mono" style={{ fontSize: 16 }}>{u.employee_no}</b></td>
                <td><b>{u.full_name || '—'}</b>{u.id === me.id && <span className="sm"> (you)</span>}</td>
                <td>{u.role === 'wms_employee' ? 'WMS only' : <>WMS + dashboard <span className="sm">({u.email})</span></>}</td>
                <td className="sm">{u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'never'}</td>
                <td><span className={`statuspill ${u.active === false ? 'bad' : 'ok'}`}>{u.active === false ? 'Off' : 'Active'}</span></td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-xs" onClick={() => setModal({ kind: 'edit', user: u })}>Edit</button>{' '}
                  <button className="btn-xs" onClick={() => setModal({ kind: 'pin', user: u })}>New PIN</button>{' '}
                  {u.role === 'wms_employee' && (u.active === false ? <button className="btn-xs" disabled={busy === u.id} onClick={() => setActive(u, true)}>Turn on</button> : <button className="btn-xs" disabled={busy === u.id} onClick={() => setActive(u, false)}>Turn off</button>)}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {modal && <EmployeeModal {...modal} next={next} canAssign={canAssign} onClose={() => setModal(null)}
        onDone={(res) => { setModal(null); reload(); if (res?.pin) setShown(res); else say({ kind: 'ok', text: 'Saved.' }); }} />}
      {shown && (
        <div className="overlay" onClick={() => setShown(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{shown.name}<span className="dot">.</span></h3>
            <p className="lead">Shown once. Give these to the employee; the PIN can’t be looked up later, only replaced.</p>
            <div className="credbox"><div><small>Sign in at</small><b>wms.shipbay3pl.com</b></div><div><small>Employee number</small><b className="mono">{shown.employee_no}</b></div><div><small>PIN</small><b className="mono">{shown.pin}</b></div></div>
            <div className="actions"><button className="btn-sm" onClick={() => navigator.clipboard?.writeText(`WMS: https://wms.shipbay3pl.com\nEmployee number: ${shown.employee_no}\nPIN: ${shown.pin}`)}>Copy</button><button className="btn-sm primary" onClick={() => setShown(null)}>Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function EmployeeModal({ kind, user, next, canAssign, onClose, onDone }) {
  const [who, setWho] = useState('new');       // 'new' person, or the id of an existing admin / staff login
  const [name, setName] = useState(user?.full_name || '');
  const [no, setNo] = useState(String(user?.employee_no ?? next));
  const [pin, setPin] = useState(() => (kind === 'edit' ? '' : newPin()));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const digits = (v, n) => v.replace(/\D/g, '').slice(0, n);

  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (kind !== 'edit' && pin.length !== 6) return setErr('The PIN is 6 digits.');
    setBusy(true);
    const r = kind === 'pin' ? await fn('wms-employees', { action: 'pin', user_id: user.id, pin })
      : kind === 'edit' ? await fn('wms-employees', { action: 'update', user_id: user.id, full_name: name, employee_no: no })
      : who === 'new' ? await fn('wms-employees', { action: 'create', full_name: name, employee_no: no, pin })
      : await fn('wms-employees', { action: 'assign', user_id: who, employee_no: no, pin });
    setBusy(false);
    if (r.error) return setErr(r.error);
    onDone(kind === 'edit' ? null : { name: kind === 'pin' ? user.full_name : who === 'new' ? name : canAssign.find((u) => u.id === who)?.full_name, employee_no: kind === 'pin' ? user.employee_no : Number(no), pin });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <h3>{kind === 'new' ? 'Add employee' : kind === 'edit' ? `Employee ${user.employee_no}` : `New PIN — ${user.full_name}`}<span className="dot">.</span></h3>
        {kind === 'new' && canAssign.length > 0 && (
          <div className="field"><label>Who</label>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="new">A new employee (WMS only)</option>
              {canAssign.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email} — already has a dashboard login</option>)}
            </select></div>
        )}
        {(kind === 'edit' || (kind === 'new' && who === 'new')) && <div className="field"><label>Full name</label><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></div>}
        <div className="grid2">
          {kind !== 'pin' && <div className="field"><label>Employee number</label><input inputMode="numeric" value={no} onChange={(e) => setNo(digits(e.target.value, 6))} required /></div>}
          {kind !== 'edit' && <div className="field"><label>PIN (6 digits)</label><div style={{ display: 'flex', gap: 8 }}><input inputMode="numeric" className="mono" value={pin} onChange={(e) => setPin(digits(e.target.value, 6))} required /><button type="button" className="btn-sm" onClick={() => setPin(newPin())}>New</button></div></div>}
        </div>
        {err && <div className="msg err">{err}</div>}
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{busy ? 'Saving…' : kind === 'new' ? 'Create employee' : kind === 'pin' ? 'Set PIN' : 'Save'}</button></div>
      </form>
    </div>
  );
}
