// Compliance — staff review of every document clients and staff upload. Approving flips the matching onboarding step to done
// (documents_sync_task trigger); rejecting sends it back with a note the client sees on their side.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';

const TABS = [['pending', 'Needs review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];
const KIND_LABEL = { intake_form: 'Intake form', w9: 'W-9', formation_cert: 'Formation Certificate', rate_card: 'Rate Card', agreement: 'Account Agreement', sla: 'SLA', insurance: 'Insurance certificate', resale_cert: 'Resale certificate', packaging_spec: 'Packaging spec', returns_rules: 'Returns / exchange rules', packing_sops: 'Packing methods & SOPs', routing_guide: 'Routing guide', sku_catalog: 'SKU catalog', other: 'Other' };
const PILL = { pending: ['In review', 'pending'], approved: ['Approved', 'approved'], rejected: ['Rejected', 'rejected'] };
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const ago = (d) => { const h = (Date.now() - new Date(d)) / 36e5; return h < 1 ? 'just now' : h < 24 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`; };
const size = (b) => (!b ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const previewable = (d) => /pdf|image\//.test(d.mime || '') || /\.(pdf|png|jpe?g|webp)$/i.test(d.storage_path);

export default function Compliance({ me }) {
  const [docs, setDocs] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [people, setPeople] = useState({});
  const [tab, setTab] = useState('pending');
  const [orgFilter, setOrgFilter] = useState('');
  const [sel, setSel] = useState(null);
  const [url, setUrl] = useState(null);
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const [{ data: d }, { data: o }, { data: p }] = await Promise.all([
      supabase.from('documents').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('orgs').select('id, name, status, founding_account').order('name'),
      supabase.from('profiles').select('id, full_name, email, role'),
    ]);
    setDocs(d || []); setOrgs(o || []);
    setPeople(Object.fromEntries((p || []).map((x) => [x.id, x])));
  };
  useEffect(() => { load(); }, []);

  const orgName = (id) => orgs.find((o) => o.id === id)?.name || '—';
  const who = (id) => people[id] ? (people[id].full_name || people[id].email) + (['shipbay_admin', 'shipbay_staff'].includes(people[id].role) ? ' (shipbay)' : '') : '—';

  const list = useMemo(() => (docs || []).filter((d) => (tab === 'all' || d.status === tab) && (!orgFilter || d.org_id === orgFilter)), [docs, tab, orgFilter]);
  const counts = useMemo(() => ({ pending: (docs || []).filter((d) => d.status === 'pending').length }), [docs]);
  const current = list.find((d) => d.id === sel) || null;

  // auto-select first item in the list; refresh the preview when selection changes
  useEffect(() => { if (!current && list.length) setSel(list[0].id); if (!list.length) setSel(null); }, [list, current]);
  useEffect(() => {
    setUrl(null); setNote(current?.review_note || ''); setExpires(current?.expires_at || '');
    if (!current) return;
    let live = true;
    supabase.storage.from('client-docs').createSignedUrl(current.storage_path, 900).then(({ data }) => { if (live) setUrl(data?.signedUrl || null); });
    return () => { live = false; };
  }, [current?.id]);

  const review = async (status) => {
    if (!current) return;
    if (status === 'rejected' && !note.trim()) return setMsg({ kind: 'err', text: 'Add a short note so the client knows what to fix.' });
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('documents').update({ status, reviewed_by: me.id, reviewed_at: new Date().toISOString(), review_note: note.trim() || null, expires_at: expires || null }).eq('id', current.id);
    setBusy(false);
    if (error) return setMsg({ kind: 'err', text: error.message });
    setMsg({ kind: 'ok', text: `${KIND_LABEL[current.kind] || current.title} for ${orgName(current.org_id)} ${status}.` });
    const idx = list.findIndex((d) => d.id === current.id);
    await load();
    const next = list[idx + 1] || list[idx - 1];
    if (tab !== 'all' && next) setSel(next.id);
  };

  // per-account compliance summary (required paperwork approved / total)
  const PAPERWORK = ['intake_form', 'w9', 'formation_cert', 'rate_card', 'agreement', 'sla'];
  const summary = orgs.filter((o) => ['onboarding', 'active'].includes(o.status)).map((o) => {
    const mine = (docs || []).filter((d) => d.org_id === o.id);
    const ok = PAPERWORK.filter((k) => mine.some((d) => d.task_key === k && d.status === 'approved')).length;
    const waiting = mine.filter((d) => d.status === 'pending').length;
    const expiring = mine.filter((d) => d.status === 'approved' && d.expires_at && (new Date(d.expires_at) - Date.now()) < 30 * 864e5).length;
    return { ...o, ok, waiting, expiring };
  });

  return (
    <>
      <div className="pagehead">
        <div><h1>Compliance<span className="dot">.</span></h1><p className="sub">Review what clients send in. Approving checks the step off their onboarding; rejecting sends it back with your note.</p></div>
        <div className="glance">
          <div><small>Awaiting review</small><b className={counts.pending ? 'hot' : ''}>{counts.pending}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="accountstrip">
        {summary.map((o) => (
          <button key={o.id} className={`acctchip ${orgFilter === o.id ? 'on' : ''}`} onClick={() => setOrgFilter(orgFilter === o.id ? '' : o.id)}>
            <b>{o.name}</b>
            <span>{o.ok}/{PAPERWORK.length} paperwork approved{o.waiting ? ` · ${o.waiting} waiting` : ''}{o.expiring ? ` · ${o.expiring} expiring` : ''}</span>
            <div className="bar"><i style={{ width: `${(100 * o.ok) / PAPERWORK.length}%` }} /></div>
          </button>
        ))}
      </div>

      <div className="compliance">
        <div className="card queue">
          <div className="tabs">
            {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'pending' && counts.pending ? <i>{counts.pending}</i> : null}</button>)}
          </div>
          {docs === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{tab === 'pending' ? 'Nothing waiting — you’re caught up.' : 'Nothing here.'}</div> : (
            <ul className="queuelist">
              {list.map((d) => (
                <li key={d.id}>
                  <button className={`qitem ${d.id === sel ? 'active' : ''}`} onClick={() => setSel(d.id)}>
                    <div className="top"><b>{KIND_LABEL[d.kind] || d.title}</b><span className={`pill ${PILL[d.status]?.[1]}`}>{PILL[d.status]?.[0]}</span></div>
                    <div className="meta">{orgName(d.org_id)} · {ago(d.created_at)} · {who(d.uploaded_by)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card review">
          {!current ? <div className="empty">Select a document.</div> : <>
            <div className="cardhead">
              <div>
                <h3>{KIND_LABEL[current.kind] || current.title}</h3>
                <div className="small">{orgName(current.org_id)} · uploaded {fmt(current.created_at)} by {who(current.uploaded_by)}{current.size_bytes ? ` · ${size(current.size_bytes)}` : ''}{current.task_key ? ` · onboarding step: ${current.task_key.replace(/_/g, ' ')}` : ''}</div>
              </div>
              <div className="spacer" />
              {url && <a className="btn-sm" href={url} target="_blank" rel="noopener">Open in new tab ↗</a>}
            </div>
            <div className="preview">
              {!url ? <div className="empty">Loading preview…</div> : previewable(current) ? <iframe title="document" src={url} /> : <div className="empty">No inline preview for this file type — open it in a new tab.</div>}
            </div>
            {current.status !== 'pending' && <div className="note" style={{ margin: '10px 0 0' }}>{PILL[current.status][0]} {fmt(current.reviewed_at)} by {who(current.reviewed_by)}{current.review_note ? ` — “${current.review_note}”` : ''}{current.expires_at ? ` · expires ${fmt(current.expires_at)}` : ''}</div>}
            <div className="actions">
              <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Note to client (required to reject)</label><input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. page 2 is missing the signature" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Expires (optional)</label><input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
              <button className="btn-sm reject" disabled={busy} onClick={() => review('rejected')}>Reject</button>
              <button className="btn-sm primary" disabled={busy} onClick={() => review('approved')}>{current.status === 'approved' ? 'Re-approve' : 'Approve'}</button>
            </div>
          </>}
        </div>
      </div>
    </>
  );
}
