import { useEffect, useState } from 'react';
import { supabase } from '../lib';

const PHASES = [['paperwork', 'Paperwork'], ['systems', 'Systems'], ['inventory', 'Inventory'], ['go_live', 'Go-live']];
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null);

export default function Onboarding({ me }) {
  const [accounts, setAccounts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('v_onboarding_progress').select('*').in('status', ['onboarding', 'active']).order('created_at', { ascending: false });
    setAccounts(data || []);
    setSelected((s) => s ?? data?.[0]?.org_id ?? null);
  };
  useEffect(() => { load(); }, []);

  const onboarding = (accounts || []).filter((a) => a.status === 'onboarding');
  const current = (accounts || []).find((a) => a.org_id === selected);

  return (
    <>
      <div className="pagehead">
        <div><h1>Onboarding<span className="dot">.</span></h1><div className="sub">Every account between “yes” and first shipped order.</div></div>
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Start onboarding</button>
      </div>

      <div className="onb">
        <div className="card">
          <div className="cardhead"><h3>Accounts</h3><div className="spacer" /><span className="tag">{onboarding.length} in progress</span></div>
          {accounts === null ? <div className="empty">Loading…</div> : accounts.length === 0 ? <div className="empty">No accounts yet. Start one from a website lead or by name.</div> : (
            <ul className="acctlist">
              {accounts.map((a) => (
                <li key={a.org_id}>
                  <button className={`acct ${a.org_id === selected ? 'active' : ''}`} onClick={() => setSelected(a.org_id)}>
                    <div className="nm">{a.name}{a.founding_account && <span className="tag founding">founding</span>}{a.status === 'active' && <span className="tag live">live</span>}</div>
                    <div className="meta">{a.contact_name || a.contact_email || '—'} · {a.done}/{a.total} done{a.go_live_date ? ` · go-live ${fmt(a.go_live_date)}` : ''}</div>
                    <div className="bar"><i style={{ width: `${a.total ? (100 * a.done) / a.total : 0}%` }} /></div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {current ? <AccountDetail key={current.org_id} account={current} me={me} onChange={load} /> : <div className="card"><div className="empty">Pick an account.</div></div>}
      </div>

      {adding && <StartOnboarding onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setSelected(id); load(); }} />}
    </>
  );
}

function AccountDetail({ account, me, onChange }) {
  const [org, setOrg] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    const [{ data: o }, { data: t }] = await Promise.all([
      supabase.from('orgs').select('*').eq('id', account.org_id).single(),
      supabase.from('onboarding_tasks').select('*').eq('org_id', account.org_id).order('sort'),
    ]);
    setOrg(o); setTasks(t || []);
  };
  useEffect(() => { load(); }, [account.org_id]);

  const toggle = async (t) => {
    const done = !t.done;
    await supabase.from('onboarding_tasks').update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? me.id : null }).eq('id', t.id);
    load(); onChange();
  };
  const saveNote = async (t, note) => {
    await supabase.from('onboarding_tasks').update({ note: note.trim() || null }).eq('id', t.id);
    setEditing(null); load();
  };
  const setGoLive = async (date) => {
    await supabase.from('orgs').update({ go_live_date: date || null }).eq('id', org.id); load(); onChange();
  };
  const markLive = async () => {
    if (!confirm(`Mark ${org.name} as live? This moves them out of onboarding.`)) return;
    await supabase.from('orgs').update({ status: 'active' }).eq('id', org.id); load(); onChange();
  };

  if (!org || !tasks) return <div className="card"><div className="empty">Loading…</div></div>;
  const done = tasks.filter((t) => t.done).length;

  return (
    <div className="card detail">
      <div className="cardhead">
        <div><h2>{org.name}</h2><div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>{done} of {tasks.length} steps complete</div></div>
        <div className="spacer" />
        {org.status === 'onboarding' && done === tasks.length && <button className="btn-sm primary" onClick={markLive}>Mark live</button>}
      </div>
      <div className="facts">
        <div><small>Contact</small><span>{org.contact_name || '—'}</span><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{org.contact_email}{org.contact_phone ? ` · ${org.contact_phone}` : ''}</div></div>
        <div><small>Status</small><span>{org.status === 'active' ? 'Live' : 'Onboarding'}{org.founding_account ? ' · Founding account' : ''}</span></div>
        <div><small>Go-live date</small><input type="date" value={org.go_live_date || ''} onChange={(e) => setGoLive(e.target.value)} style={{ font: '14px var(--font-body)', border: '1.5px solid var(--line)', borderRadius: 8, padding: '5px 8px' }} /></div>
        <div><small>Shopify</small><span>{org.shopify_domain || 'Not connected'}</span></div>
      </div>
      {org.notes && <div style={{ padding: '12px 18px', fontSize: 13, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>{org.notes}</div>}
      <div className="phase">
        {PHASES.map(([key, label]) => {
          const list = tasks.filter((t) => t.phase === key); if (!list.length) return null;
          return (
            <div key={key}>
              <h4>{label} · {list.filter((t) => t.done).length}/{list.length}</h4>
              {list.map((t) => (
                <div key={t.id} className={`task ${t.done ? 'done' : ''}`}>
                  <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
                  <div>
                    <div className="lbl">{t.label}</div>
                    {editing === t.id ? (
                      <input className="noteedit" autoFocus defaultValue={t.note || ''} placeholder="Add a note — who, what, when" onBlur={(e) => saveNote(t, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveNote(t, e.target.value); if (e.key === 'Escape') setEditing(null); }} />
                    ) : (
                      <div className="note">{t.note || <button className="edit" onClick={() => setEditing(t.id)}>+ note</button>}{t.note && <> · <button className="edit" onClick={() => setEditing(t.id)}>edit</button></>}</div>
                    )}
                  </div>
                  <div className="when">{t.done && t.done_at ? fmt(t.done_at) : ''}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StartOnboarding({ onClose, onCreated }) {
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('leads').select('id, name, brand, email, source, created_at').is('org_id', null).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setLeads((data || []).filter((l) => l.email && !/test|example\.com/i.test(l.email + l.brand + l.name))));
  }, []);

  const start = async () => {
    setBusy(true); setErr(null);
    if (leadId) {
      const { data, error } = await supabase.rpc('convert_lead', { p_lead_id: leadId });
      setBusy(false); if (error) return setErr(error.message); return onCreated(data);
    }
    if (!name.trim()) { setBusy(false); return setErr('Enter the brand name.'); }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data, error } = await supabase.from('orgs').insert({ name: name.trim(), slug, contact_name: contact || null, contact_email: email || null }).select('id').single();
    if (!error) await supabase.from('rate_cards').insert({ org_id: data.id, label: 'Standard (<1,000 orders/mo)' });
    setBusy(false); if (error) return setErr(error.message); onCreated(data.id);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Start onboarding<span className="dot">.</span></h3>
        <p className="lead">Pick a website lead, or enter the brand by hand. Either way they get the full checklist.</p>
        <div className="field"><label>From a website lead</label>
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">— choose —</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.brand || l.name} · {l.email} · {l.source || 'website'}</option>)}
          </select>
        </div>
        <div className="or">OR</div>
        <div className="field"><label>Brand name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={!!leadId} /></div>
        <div className="field"><label>Contact name</label><input type="text" value={contact} onChange={(e) => setContact(e.target.value)} disabled={!!leadId} /></div>
        <div className="field"><label>Contact email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!leadId} /></div>
        {err && <div className="msg err">{err}</div>}
        <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start onboarding'}</button></div>
      </div>
    </div>
  );
}
