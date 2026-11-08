// Careers — the roles on shipbay3pl.com/careers and the applications sent from it. Owner only (RLS: is_owner()).
// Tables job_postings + job_applications (migration 20261108060000_careers). Only status 'open' shows on the site.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib';
import { ago } from './util';

const SITE = 'https://www.shipbay3pl.com/careers';
const STATUS = [['open', 'Open — on the site'], ['paused', 'Paused — hidden'], ['closed', 'Closed — hidden']];
const STATUS_PILL = { open: 'ok', paused: 'warn', closed: 'muted' };
const APP_STATUS = [['new', 'New'], ['reviewed', 'Reviewed'], ['interview', 'Interview'], ['hired', 'Hired'], ['rejected', 'Rejected']];
const APP_PILL = { new: 'warn', reviewed: 'navy', interview: 'ok', hired: 'ok', rejected: 'muted' };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const BLANK = { title: '', slug: '', team: '', location: '', work_mode: '', employment_type: '', pay: '', schedule: '', summary: '', description: '', responsibilities: [], requirements: [], status: 'open', sort: 100 };

export default function Careers() {
  const [posts, setPosts] = useState(null);
  const [apps, setApps] = useState(null);
  const [view, setView] = useState('roles');
  const [editing, setEditing] = useState(null);   // a posting row, or BLANK for new
  const [msg, setMsg] = useState(null);
  const [roleFilter, setRoleFilter] = useState('');
  const [openApp, setOpenApp] = useState(null);

  const load = async () => {
    const [p, a] = await Promise.all([
      supabase.from('job_postings').select('*').order('sort').order('created_at'),
      supabase.from('job_applications').select('*').order('created_at', { ascending: false }),
    ]);
    if (p.error || a.error) setMsg({ kind: 'err', text: (p.error || a.error).message });
    setPosts(p.data || []); setApps(a.data || []);
  };
  useEffect(() => { load(); }, []);

  const countFor = (id) => (apps || []).filter((a) => a.posting_id === id).length;
  const newCount = (apps || []).filter((a) => a.status === 'new').length;
  const shownApps = useMemo(() => (apps || []).filter((a) => !roleFilter || a.posting_id === roleFilter), [apps, roleFilter]);

  const setStatus = async (p, status) => {
    const { error } = await supabase.from('job_postings').update({ status }).eq('id', p.id);
    if (error) return setMsg({ kind: 'err', text: error.message });
    setMsg({ kind: 'ok', text: `${p.title} is ${status === 'open' ? 'live on the site' : status === 'paused' ? 'paused — hidden from the site' : 'closed — hidden from the site'}.` }); load();
  };
  const remove = async (p) => {
    if (!window.confirm(`Delete “${p.title}” for good? Its applications are kept. To just hide it, use Pause or Close.`)) return;
    const { error } = await supabase.from('job_postings').delete().eq('id', p.id);
    if (error) return setMsg({ kind: 'err', text: error.message });
    setMsg({ kind: 'ok', text: `${p.title} deleted.` }); load();
  };
  const updateApp = async (a, patch) => {
    const { error } = await supabase.from('job_applications').update(patch).eq('id', a.id);
    if (error) return setMsg({ kind: 'err', text: error.message });
    setApps((xs) => xs.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
  };

  return (
    <div className="careers">
      <div className="pagehead">
        <div><h1>Careers<span className="dot">.</span></h1></div>
        <div className="glance">
          <div><small>Open roles</small><b>{posts ? posts.filter((p) => p.status === 'open').length : '—'}</b></div>
          <div><small>Applications</small><b>{apps ? apps.length : '—'}</b></div>
          <div><small>New</small><b className={newCount ? 'hot' : ''}>{apps ? newCount : '—'}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="opsbar">
        <div className="tabs">
          <button className={view === 'roles' ? 'on' : ''} onClick={() => setView('roles')}>Roles</button>
          <button className={view === 'apps' ? 'on' : ''} onClick={() => setView('apps')}>Applications{newCount ? ` · ${newCount} new` : ''}</button>
        </div>
        <div className="spacer" />
        <a className="btn-sm" href={SITE} target="_blank" rel="noreferrer">View careers page ↗</a>
        <button className="btn-sm primary" onClick={() => setEditing({ ...BLANK, sort: ((posts || []).reduce((m, p) => Math.max(m, p.sort || 0), 0) + 10) })}>+ New role</button>
      </div>

      {view === 'roles' && (
        <div className="card">
          {posts === null ? <div className="empty">Loading…</div> : !posts.length ? <div className="empty">No roles yet. Add one with + New role.</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Role</th><th>Team</th><th>How</th><th>Type</th><th>Pay</th><th>Status</th><th className="n" style={{ textAlign: 'right' }}>Applicants</th><th /></tr></thead>
              <tbody>{posts.map((p) => (
                <tr key={p.id} className={p.status === 'open' ? '' : 'muted'}>
                  <td><b>{p.title}</b><div className="sm">{p.location || '—'}</div></td>
                  <td>{p.team || <span className="sm">—</span>}</td>
                  <td>{p.work_mode || <span className="sm">—</span>}</td>
                  <td>{p.employment_type || <span className="sm missing">not set</span>}</td>
                  <td className="num">{p.pay || <span className="sm missing">not set</span>}</td>
                  <td><span className={`statuspill ${STATUS_PILL[p.status]}`}>{p.status === 'open' ? 'Open' : p.status === 'paused' ? 'Paused' : 'Closed'}</span></td>
                  <td className="n"><button className="linkbtn" onClick={() => { setRoleFilter(p.id); setView('apps'); }}>{countFor(p.id)}</button></td>
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-xs primary" onClick={() => setEditing(p)}>Edit</button>{' '}
                    {p.status === 'open' ? <button className="btn-xs" onClick={() => setStatus(p, 'paused')}>Pause</button> : <button className="btn-xs" onClick={() => setStatus(p, 'open')}>Reopen</button>}{' '}
                    {p.status === 'open' && <><a className="btn-xs" href={`${SITE}#${p.slug}`} target="_blank" rel="noreferrer">On site ↗</a>{' '}</>}
                    <button className="btn-xs" onClick={() => remove(p)}>Delete</button>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}

      {view === 'apps' && (
        <div className="card">
          <div className="cardhead row">
            <select className="pick" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">Every role</option>
              {(posts || []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          {apps === null ? <div className="empty">Loading…</div> : !shownApps.length ? <div className="empty">No applications yet.</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Applicant</th><th>Role</th><th>Contact</th><th>Based in</th><th>Received</th><th>Status</th><th /></tr></thead>
              <tbody>{shownApps.map((a) => (
                <ApplicantRow key={a.id} a={a} open={openApp === a.id} onToggle={() => { setOpenApp(openApp === a.id ? null : a.id); if (a.status === 'new') updateApp(a, { status: 'reviewed' }); }} onUpdate={(patch) => updateApp(a, patch)} />
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}

      {editing && <RoleEditor row={editing} taken={(posts || []).filter((p) => p.id !== editing.id).map((p) => p.slug)} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); setMsg({ kind: 'ok', text: t }); load(); }} />}
    </div>
  );
}

function ApplicantRow({ a, open, onToggle, onUpdate }) {
  const [notes, setNotes] = useState(a.notes || '');
  const link = a.link && /^https?:\/\//i.test(a.link) ? a.link : null;
  return (
    <>
      <tr className={a.status === 'new' ? 'unread' : ''}>
        <td><button className="linkbtn strong" onClick={onToggle}>{a.name}</button></td>
        <td>{a.posting_title || '—'}</td>
        <td><a href={`mailto:${a.email}`}>{a.email}</a>{a.phone && <div className="sm"><a href={`tel:${a.phone}`}>{a.phone}</a></div>}</td>
        <td>{a.city || <span className="sm">—</span>}</td>
        <td className="sm" title={new Date(a.created_at).toLocaleString()}>{ago(a.created_at)}</td>
        <td>
          <select className={`pick statuspick ${APP_PILL[a.status]}`} value={a.status} onChange={(e) => onUpdate({ status: e.target.value })}>
            {APP_STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </td>
        <td className="n"><button className="btn-xs" onClick={onToggle}>{open ? 'Close' : 'Open'}</button></td>
      </tr>
      {open && (
        <tr className="appdetail"><td colSpan={7}>
          <div className="appgrid">
            <div>
              <div className="lbl">Why this role</div>
              <p className="appmsg">{a.message || <span className="sm">No message.</span>}</p>
              {a.link && <><div className="lbl">Resume / LinkedIn</div><p>{link ? <a href={link} target="_blank" rel="noreferrer">{a.link} ↗</a> : a.link}</p></>}
            </div>
            <div>
              <div className="lbl">Your notes</div>
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (a.notes || '') && onUpdate({ notes: notes || null })} placeholder="Only you see these" />
              <div className="row" style={{ marginTop: 8 }}><a className="btn-xs primary" href={`mailto:${a.email}?subject=${encodeURIComponent(`Your application — ${a.posting_title || 'ShipBay 3PL'}`)}`}>Email {a.name.split(' ')[0]}</a></div>
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}

function RoleEditor({ row, taken, onClose, onSaved }) {
  const isNew = !row.id;
  const [f, setF] = useState({ ...BLANK, ...row, responsibilities: (row.responsibilities || []).join('\n'), requirements: (row.requirements || []).join('\n') });
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = (k) => (e) => { const v = e.target.value; setF((x) => ({ ...x, [k]: v, ...(k === 'title' && !slugTouched ? { slug: slugify(v) } : {}) })); };
  const lines = (s) => s.split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);

  const save = async (e) => {
    e.preventDefault(); setErr(null);
    const slug = slugify(f.slug || f.title);
    if (!f.title.trim()) return setErr('The role needs a title.');
    if (!slug) return setErr('The link name needs at least one letter or number.');
    if (taken.includes(slug)) return setErr(`Another role already uses the link /careers#${slug}.`);
    const t = (v) => (String(v ?? '').trim() || null);
    const rec = { title: f.title.trim(), slug, team: t(f.team), location: t(f.location), work_mode: t(f.work_mode), employment_type: t(f.employment_type), pay: t(f.pay), schedule: t(f.schedule), summary: t(f.summary), description: t(f.description), responsibilities: lines(f.responsibilities), requirements: lines(f.requirements), status: f.status, sort: Number(f.sort) || 100 };
    setBusy(true);
    const { error } = isNew ? await supabase.from('job_postings').insert(rec) : await supabase.from('job_postings').update(rec).eq('id', row.id);
    setBusy(false);
    if (error) return setErr(error.message);
    onSaved(`${rec.title} ${isNew ? 'added' : 'saved'}${rec.status === 'open' ? ' — live on the careers page.' : ' — hidden from the site until you reopen it.'}`);
  };

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <form className="modal wide roleeditor" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>{isNew ? 'New role' : f.title || 'Edit role'}<span className="dot">.</span></h3>
        {err && <div className="msg err">{err}</div>}
        <div className="grid2">
          <div className="field"><label>Title</label><input value={f.title} onChange={set('title')} autoFocus={isNew} placeholder="Warehouse associate" /></div>
          <div className="field"><label>Pay</label><input value={f.pay || ''} onChange={set('pay')} placeholder="$19/hr · $45,000 + commission" /></div>
          <div className="field"><label>Team</label><input value={f.team || ''} onChange={set('team')} placeholder="Warehouse" /></div>
          <div className="field"><label>Type</label><input value={f.employment_type || ''} onChange={set('employment_type')} list="emptypes" placeholder="Full-time" /><datalist id="emptypes"><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Commission only</option><option>Internship</option></datalist></div>
          <div className="field"><label>How</label><input value={f.work_mode || ''} onChange={set('work_mode')} list="modes" placeholder="In person" /><datalist id="modes"><option>In person</option><option>Virtual</option><option>In person or virtual</option></datalist></div>
          <div className="field"><label>Where</label><input value={f.location || ''} onChange={set('location')} placeholder="Hillsborough, NJ" /></div>
          <div className="field span2"><label>Schedule</label><input value={f.schedule || ''} onChange={set('schedule')} placeholder="Mon–Fri, 9am–5pm" /></div>
        </div>
        <div className="field"><label>Description</label><textarea rows={4} value={f.description || ''} onChange={set('description')} /></div>
        <div className="grid2">
          <div className="field"><label>What they’ll do <span className="sm">· one per line</span></label><textarea rows={6} value={f.responsibilities} onChange={set('responsibilities')} /></div>
          <div className="field"><label>What they bring <span className="sm">· one per line</span></label><textarea rows={6} value={f.requirements} onChange={set('requirements')} /></div>
        </div>
        <div className="grid3">
          <div className="field"><label>Status</label><select value={f.status} onChange={set('status')}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="field"><label>Order on the page</label><input type="number" value={f.sort} onChange={set('sort')} /></div>
          <div className="field"><label>Link name</label><input value={f.slug} onChange={(e) => { setSlugTouched(true); setF((x) => ({ ...x, slug: e.target.value })); }} placeholder="warehouse-associate" /></div>
        </div>
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add role' : 'Save'}</button></div>
      </form>
    </div>,
    document.body,
  );
}
