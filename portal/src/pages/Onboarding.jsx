import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib';
import { CATEGORY, providerName } from '../providers';

export const DOC_KIND = { intake_form: 'intake_form', w9: 'w9', formation_cert: 'formation_cert', rate_card: 'rate_card', agreement: 'agreement', sla: 'sla', packaging_spec: 'packaging_spec', returns_rules: 'returns_rules', packing_sops: 'packing_sops', sku_catalog: 'sku_catalog' };
// what a document task accepts: default PDF only; 'pdf,doc,image' for specs / SOPs
export const ACCEPT = {
  pdf: { mimes: ['application/pdf'], ext: '.pdf', label: 'PDF' },
  'pdf,doc,image': { mimes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'], ext: '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.heic', label: 'file' },
};
export const acceptFor = (t) => ACCEPT[t.accept] || ACCEPT.pdf;
// shipbay uploads these first; the client downloads, signs and uploads the signed copy
export const SIGN_KEYS = ['rate_card', 'agreement', 'sla'];
const fn = async (name, body) => {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) { // FunctionsHttpError carries the JSON body the function returned
    let msg = error.message; try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    return { error: msg };
  }
  return data || {};
};
export const BILLING = [
  ['ach', 'ACH / bank debit', 'We pull each invoice from the client’s bank account on the due date.'],
  ['card', 'Credit card on file', 'Card charged on the due date (processing fee may apply).'],
  ['wire', 'Wire transfer', 'Client wires each invoice; we send remittance details.'],
  ['check', 'Check', 'Mailed to 115 Stryker Ln, Hillsborough NJ 08844.'],
  ['net_terms', 'Net terms (invoice)', 'Invoice sent monthly; client pays by the due date.'],
];

export const PHASES = [
  { key: 'paperwork', label: 'Paperwork', icon: 'paperwork' },
  { key: 'systems', label: 'Systems', icon: 'systems' },
  { key: 'inventory', label: 'Inventory', icon: 'inventory' },
  { key: 'go_live', label: 'Go-live / Test', icon: 'golive' },
];
const GO_LIVE_STATUS = [
  ['on_time', 'On time', 'ok'],
  ['at_risk', 'At risk', 'warn'],
  ['delayed', 'Delayed', 'bad'],
  ['on_hold', 'On hold', 'muted'],
  ['complete', 'Complete', 'navy'],
];
export const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null);

/* Phase icons — shipbay theme: navy tile, orange accent, 2px strokes */
export const PhaseIcon = ({ kind }) => {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', viewBox: '0 0 24 24' };
  switch (kind) {
    case 'paperwork': return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" className="accent" /></svg>;
    case 'systems': return <svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M7 10h3l2-3 2 6 2-3h1" className="accent" /></svg>;
    case 'inventory': return <svg {...common}><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" className="accent" /></svg>;
    case 'golive': return <svg {...common}><path d="M12 2.5c3 2 4.5 5.5 4.5 9.5v3h-9v-3c0-4 1.5-7.5 4.5-9.5z" /><path d="M7.5 12.5L4.5 15v3.5l3-1.5" /><path d="M16.5 12.5l3 2.5v3.5l-3-1.5" /><circle cx="12" cy="9.5" r="1.6" className="accent" /><path d="M10 18.5c0 1.5.7 2.5 2 3.5 1.3-1 2-2 2-3.5" className="accent" /></svg>;
    default: return null;
  }
};

export default function Onboarding({ me }) {
  const [accounts, setAccounts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('v_onboarding_progress').select('*').in('status', ['onboarding', 'active']).order('created_at', { ascending: false });
    setAccounts(data || []);
    // coming back from a provider's OAuth screen: ?org=<id> lands on that account
    const back = new URLSearchParams(window.location.search).get('org');
    setSelected((s) => s ?? (back && data?.some((a) => a.org_id === back) ? back : null) ?? data?.[0]?.org_id ?? null);
  };
  useEffect(() => { load(); }, []);

  const onboarding = (accounts || []).filter((a) => a.status === 'onboarding');
  const current = (accounts || []).find((a) => a.org_id === selected);

  return (
    <>
      <div className="pagehead">
        <div><h1>Onboarding<span className="dot">.</span></h1></div>
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
                    <div className="meta">{a.contact_name || a.contact_email || '—'} · {a.done}/{a.total} done{a.go_live_date ? ` · est. ${fmt(a.go_live_date)}` : ''}</div>
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
  const [docs, setDocs] = useState([]);
  const [openPhase, setOpenPhase] = useState(null);
  const [editing, setEditing] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false);
  const [conns, setConns] = useState([]);
  const [portalOpen, setPortalOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(null); // task key: label_access | shopify_connected
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [skuCount, setSkuCount] = useState(0);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const load = async () => {
    const [{ data: o }, { data: t }, { data: d }, { data: c }, { count: n }] = await Promise.all([
      supabase.from('orgs').select('*').eq('id', account.org_id).single(),
      supabase.from('onboarding_tasks').select('*').eq('org_id', account.org_id).order('sort'),
      supabase.from('documents').select('*').eq('org_id', account.org_id).not('task_key', 'is', null).order('created_at', { ascending: false }),
      supabase.from('integrations').select('*').eq('org_id', account.org_id).order('created_at'),
      supabase.from('skus').select('id', { count: 'exact', head: true }).eq('org_id', account.org_id).eq('active', true),
    ]);
    setOrg(o); setTasks(t || []); setDocs(d || []); setConns(c || []); setSkuCount(n || 0);
  };
  useEffect(() => { load(); }, [account.org_id]);

  // result of an OAuth round-trip: #conn=<provider>|ok|<message>
  useEffect(() => {
    const m = /conn=([^&]+)/.exec(window.location.hash);
    if (!m) return;
    const [provider, ok, msg] = decodeURIComponent(m[1]).split('|');
    setFlash({ kind: ok === 'ok' ? 'ok' : 'err', text: ok === 'ok' ? `${providerName(provider)} connected.` : `${providerName(provider)}: ${msg}` });
    setOpenPhase('systems');
    history.replaceState(null, '', window.location.pathname);
  }, []);

  const connAction = async (c, action) => {
    if (action === 'disconnect' && !confirm(`Disconnect ${providerName(c.provider)}? Stored credentials are wiped.`)) return;
    setBusyId(c.id);
    const r = await fn('integrations', { action, integration_id: c.id });
    setBusyId(null);
    if (r.error) setFlash({ kind: 'err', text: r.error });
    else if (action === 'test') setFlash({ kind: r.ok ? 'ok' : 'err', text: r.ok ? `${providerName(c.provider)} is live.` : `${providerName(c.provider)}: ${r.error}` });
    load(); onChange();
  };

  const patchOrg = async (patch) => { await supabase.from('orgs').update(patch).eq('id', org.id); load(); onChange(); };
  const toggle = async (t) => {
    const done = !t.done;
    await supabase.from('onboarding_tasks').update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? me.id : null }).eq('id', t.id);
    load(); onChange();
  };
  const upload = async (t, file, forSignature = false) => {
    if (!file) return;
    const acc = acceptFor(t);
    if (!acc.mimes.includes(file.type) && !acc.ext.split(',').some((e) => file.name.toLowerCase().endsWith(e))) return alert(`Please upload a ${acc.label === 'PDF' ? 'PDF' : 'PDF, Word, Excel or image file'}.`);
    const path = `${org.id}/${t.key}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upErr) return alert(upErr.message);
    const { error } = await supabase.from('documents').insert({ org_id: org.id, kind: DOC_KIND[t.key] || 'other', title: `${t.label}${forSignature ? ' (for signature)' : ''} — ${org.name}`, storage_path: path, mime: file.type || null, size_bytes: file.size, task_key: t.key, status: forSignature ? 'approved' : 'pending', for_signature: forSignature, reviewed_by: forSignature ? me.id : null, reviewed_at: forSignature ? new Date().toISOString() : null, uploaded_by: me.id });
    if (error) return alert(error.message);
    load(); onChange();
  };
  const schedule = async (t, date) => {
    await supabase.from('onboarding_tasks').update({ scheduled_for: date || null }).eq('id', t.id);
    if (date) { // keep an inbound record so receiving can work against it
      const { data: ex } = await supabase.from('inbound_shipments').select('id').eq('org_id', org.id).eq('reference', 'Initial inbound transfer').maybeSingle();
      if (ex) await supabase.from('inbound_shipments').update({ expected_at: date }).eq('id', ex.id);
      else await supabase.from('inbound_shipments').insert({ org_id: org.id, reference: 'Initial inbound transfer', status: 'expected', expected_at: date, created_by: me.id });
    }
    load(); onChange();
  };
  const viewDoc = async (d) => {
    const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(d.storage_path, 600);
    if (error) return alert(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  const saveNote = async (t, note) => { await supabase.from('onboarding_tasks').update({ note: note.trim() || null }).eq('id', t.id); setEditing(null); load(); };
  const markLive = async () => {
    if (!confirm(`Mark ${org.name} as live? This moves them out of onboarding.`)) return;
    await patchOrg({ status: 'active', go_live_status: 'complete' });
  };

  if (!org || !tasks) return <div className="card"><div className="empty">Loading…</div></div>;
  const required = tasks.filter((t) => !t.optional);
  const done = required.filter((t) => t.done).length;
  const pct = required.length ? Math.round((100 * done) / required.length) : 0;
  const next = required.find((t) => !t.done);
  const status = GO_LIVE_STATUS.find((s) => s[0] === org.go_live_status) || GO_LIVE_STATUS[0];

  return (
    <div className="card detail">
      <div className="cardhead headline">
        <h2>{org.name}</h2>
        <div className="progress">
          <div className="bar big"><i style={{ width: `${pct}%` }} /></div>
          <div className="next">{next ? <><span className="pct">{pct}%</span> · next: <b>{next.label}</b></> : <><span className="pct">100%</span> · <b>all steps complete</b></>}</div>
        </div>
        {org.status === 'onboarding' && done === required.length && <button className="btn-sm primary" onClick={markLive}>Mark live</button>}
      </div>
      {flash && <div className={`msg ${flash.kind} flash`}>{flash.text}<button onClick={() => setFlash(null)} aria-label="Dismiss">×</button></div>}

      <div className="facts">
        <div><small>Contact</small><span>{org.contact_name || '—'}</span><div className="sub2">{org.contact_email}{org.contact_phone ? ` · ${org.contact_phone}` : ''}</div></div>
        <div><small>Status</small><span>{org.status === 'active' ? 'Live' : 'Onboarding'}</span>{org.founding_account && <span className="tag founding solid">Founding account</span>}</div>
        <div>
          <small>Est. go-live date</small>
          <input type="date" className="inlinedate" value={org.go_live_date || ''} onChange={(e) => patchOrg({ go_live_date: e.target.value || null })} />
          <select className={`statusselect ${status[2]}`} value={org.go_live_status} onChange={(e) => patchOrg({ go_live_status: e.target.value })}>
            {GO_LIVE_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <small>Sales rep</small><span>{org.sales_rep}</span><div className="sub2">{org.sales_rep_phone}<br />{org.sales_rep_email}</div>
          <small style={{ marginTop: 12 }}>Account Operations Manager</small><span>{org.ops_manager}</span><div className="sub2">{org.ops_manager_phone}<br />{org.ops_manager_email}</div>
        </div>
      </div>

      <div className="phases">
        {PHASES.map((p) => {
          const list = required.filter((t) => t.phase === p.key);
          const d = list.filter((t) => t.done).length;
          const ppct = list.length ? (100 * d) / list.length : 0;
          const complete = list.length > 0 && d === list.length;
          return (
            <button key={p.key} className={`phasetile ${openPhase === p.key ? 'open' : ''} ${complete ? 'complete' : ''}`} onClick={() => setOpenPhase(openPhase === p.key ? null : p.key)}>
              <div className="tile"><PhaseIcon kind={p.icon} /></div>
              <div className="plabel">{p.label}</div>
              <div className="pcount">{d}/{list.length}</div>
              <div className="bar"><i style={{ width: `${ppct}%` }} /></div>
            </button>
          );
        })}
      </div>

      {openPhase && (
        <div className="phase open">
          {tasks.filter((t) => t.phase === openPhase).map((t) => {
            const sign = SIGN_KEYS.includes(t.key);
            const tpl = sign ? docs.find((d) => d.task_key === t.key && d.for_signature) : null;
            const mine = docs.filter((d) => d.task_key === t.key && !d.for_signature);
            const latest = mine[0];
            const multi = t.key === 'additional_docs';
            const cat = CATEGORY[t.key];
            const list = cat ? conns.filter((c) => c.category === cat.key && c.status !== 'disconnected') : [];
            const state = t.done ? 'done'
              : t.kind === 'document' && latest ? 'pending'
              : t.kind === 'billing' && org.billing_method ? 'done'
              : t.kind === 'portal' && org.portal_user_id ? 'done'
              : t.kind === 'integration' && list.some((c) => c.status === 'connected') ? 'done'
              : t.kind === 'integration' && list.length ? 'pending'
              : t.kind === 'catalog' && skuCount > 0 ? 'done'
              : t.kind === 'catalog' && latest ? 'pending'
              : t.kind === 'schedule' && t.scheduled_for ? 'done'
              : 'open';
            const catalogDoc = t.kind === 'catalog' ? latest : null;
            const title = { done: t.kind === 'document' ? 'Approved' : 'Complete', pending: t.kind === 'document' ? 'Uploaded — awaiting review' : 'Started — not verified yet', open: 'Not started' }[state];
            return (
              <div key={t.id} className={`task ${state}`}>
                {t.kind === 'manual'
                  ? <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
                  : <span className={`circle ${state}`} title={title}>{state === 'done' ? '✓' : state === 'pending' ? '–' : ''}</span>}
                <div>
                  <div className="lbl">{t.label}{t.optional && <span className="opt">optional</span>}
                    {t.kind === 'document' && sign && <UploadButton accept=".pdf" onFile={(f) => upload(t, f, true)} label={tpl ? 'Replace unsigned PDF' : 'Upload for signature'} primary={!tpl} />}
                    {t.kind === 'document' && sign && tpl && <button className="viewdoc" onClick={() => viewDoc(tpl)}>View unsigned</button>}
                    {t.kind === 'document' && !sign && <UploadButton accept={acceptFor(t).ext} onFile={(f) => upload(t, f)} label={multi ? 'Upload PDF' : latest ? `Replace ${acceptFor(t).label}` : `Upload ${acceptFor(t).label}`} />}
                    {t.kind === 'document' && sign && tpl && !latest && <UploadButton accept=".pdf" onFile={(f) => upload(t, f)} label="Upload signed copy" />}
                    {t.kind === 'catalog' && <button className={`btn-xs ${skuCount ? '' : 'primary'}`} onClick={() => setCatalogOpen(true)}>{skuCount ? 'Upload CSV again' : 'Upload CSV'}</button>}
                    {t.kind === 'schedule' && <input type="date" className="inlinedate sm" value={t.scheduled_for || ''} min={new Date().toISOString().slice(0, 10)} onChange={(e) => schedule(t, e.target.value)} />}
                    {t.kind === 'billing' && <button className="btn-xs" onClick={() => setBillingOpen(true)}>{org.billing_method ? 'Change billing method' : 'Add billing method'}</button>}
                    {t.kind === 'portal' && <button className={`btn-xs ${org.portal_user_id ? '' : 'primary'}`} onClick={() => setPortalOpen(true)}>{org.portal_user_id ? 'Reset & resend' : 'Create'}</button>}
                    {t.kind === 'integration' && <button className="btn-xs primary" onClick={() => setConnectOpen(t.key)}>Connect</button>}
                  </div>
                  {t.kind === 'document' && sign && !latest && <div className="note">{tpl ? <>Sent for signature {fmt(tpl.created_at)} — waiting on the client’s signed copy</> : <>Upload the unsigned PDF; the client signs it from their portal and sends it back.</>}</div>}
                  {t.kind === 'document' && !multi && latest && <div className="note">{latest.status === 'approved' ? 'Approved' : latest.status === 'rejected' ? 'Rejected — upload a corrected copy' : sign ? 'Signed copy received, awaiting review' : 'Uploaded, awaiting review'} · {fmt(latest.created_at)}{latest.review_note ? ` · ${latest.review_note}` : ''}</div>}
                  {multi && (mine.length ? (
                    <ul className="doclist">
                      {mine.map((d) => <li key={d.id}><span className={`dot2 ${d.status}`} />{d.title.replace(` — ${org.name}`, '')} <small>· {d.status === 'approved' ? 'approved' : d.status === 'rejected' ? 'rejected' : 'awaiting review'} · {fmt(d.created_at)}</small><button className="viewdoc" onClick={() => viewDoc(d)}>View</button></li>)}
                    </ul>
                  ) : <div className="note">Anything else the client sends over — insurance certificate, resale certificate, brand guidelines, prior 3PL reports.</div>)}
                  {t.kind === 'billing' && org.billing_method && <div className="note">{BILLING.find((b) => b[0] === org.billing_method)?.[1]}{org.billing_details?.summary ? ` · ${org.billing_details.summary}` : ''}</div>}
                  {t.kind === 'catalog' && <div className="note">{skuCount
                    ? <><b>{skuCount.toLocaleString()} active SKUs</b>{catalogDoc ? <> · last file {fmt(catalogDoc.created_at)}</> : null} · re-uploading updates matching SKUs and adds new ones</>
                    : <>CSV with one row per SKU — Shopify / WooCommerce product exports work as-is. Columns are matched on the next screen.</>}</div>}
                  {t.kind === 'schedule' && <div className="note">{t.scheduled_for
                    ? <>First inbound expected <b>{new Date(t.scheduled_for + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</b> · receiving will count against this transfer</>
                    : <>Pick the date the client’s first inventory lands at 115 Stryker Ln.</>}</div>}
                  {t.kind === 'portal' && <div className="note">{org.portal_user_id
                    ? <>Login created {fmt(org.portal_created_at)} for <b>{org.contact_email}</b>{org.portal_invited_at ? <> · welcome email sent {fmt(org.portal_invited_at)}</> : <> · <span className="warn">welcome email not sent yet</span></>}</>
                    : <>Creates the client’s shipbay.dashboard login from <b>{org.contact_email || 'their contact email'}</b> and emails them their details.</>}</div>}
                  {t.kind === 'integration' && (list.length ? (
                    <ul className="connlist">
                      {list.map((c) => (
                        <li key={c.id}>
                          <span className={`pill ${c.status}`}>{c.status}</span>
                          <b>{providerName(c.provider)}</b>{c.label && <span className="muted"> · {c.label}</span>}
                          {c.status === 'error' && c.error && <span className="errtxt"> — {c.error}</span>}
                          {c.meta?.carriers?.length > 0 && <span className="muted"> · {c.meta.carriers.slice(0, 4).join(', ')}{c.meta.carriers.length > 4 ? ` +${c.meta.carriers.length - 4}` : ''}</span>}
                          <span className="acts">
                            {c.auth_type === 'api_key' && <button className="edit" disabled={busyId === c.id} onClick={() => connAction(c, 'test')}>{busyId === c.id ? 'testing…' : 'test'}</button>}
                            <button className="edit" disabled={busyId === c.id} onClick={() => connAction(c, 'disconnect')}>disconnect</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="note">{t.key === 'label_access' ? 'Pick the client’s label service (ShipStation, Shippo, UPS, FedEx, USPS…) and sign in — verified live.' : 'Pick the client’s store or marketplace (Shopify, WooCommerce, Amazon, TikTok Shop…) and sign in — verified live.'}</div>)}
                  {t.kind === 'manual' && (editing === t.id ? (
                    <input className="noteedit" autoFocus defaultValue={t.note || ''} placeholder="Add a note — who, what, when" onBlur={(e) => saveNote(t, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveNote(t, e.target.value); if (e.key === 'Escape') setEditing(null); }} />
                  ) : (
                    <div className="note">{t.note || <button className="edit" onClick={() => setEditing(t.id)}>+ note</button>}{t.note && <> · <button className="edit" onClick={() => setEditing(t.id)}>edit</button></>}</div>
                  ))}
                </div>
                <div className="when">
                  {(t.kind === 'document' && !multi && latest) || catalogDoc ? <button className="viewdoc" onClick={() => viewDoc(latest)}>{catalogDoc ? 'View CSV' : sign ? 'View signed' : 'View document'}</button> : (t.done && t.done_at ? fmt(t.done_at) : '')}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {billingOpen && <BillingModal org={org} onClose={() => setBillingOpen(false)} onSaved={() => { setBillingOpen(false); load(); onChange(); }} />}
      {portalOpen && <PortalModal org={org} onClose={() => { setPortalOpen(false); load(); onChange(); }} />}
      {catalogOpen && <CatalogModal org={org} me={me} onClose={() => setCatalogOpen(false)} onDone={(f) => { setCatalogOpen(false); setFlash(f); load(); onChange(); }} />}
      {connectOpen && <ConnectModal org={org} taskKey={connectOpen} onClose={() => setConnectOpen(null)} onDone={(f) => { setConnectOpen(null); if (f) setFlash(f); load(); onChange(); }} />}
    </div>
  );
}

export function UploadButton({ onFile, label, accept = '.pdf', primary }) {
  const ref = useRef(null);
  return (
    <>
      <button className={`btn-xs ${primary ? 'primary' : ''}`} onClick={() => ref.current?.click()}>{label}</button>
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </>
  );
}

/* ---------- SKU catalog: CSV → map columns → import into skus ---------- */
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
const SKU_FIELDS = [
  ['sku', 'SKU', true, /^(variant )?sku$|^sku ?(code|id)?$|^item ?(number|no|#)$|^part ?(number|no)$/i],
  ['name', 'Product name', false, /^(product )?(title|name)$|^item ?name$|^description$/i],
  ['variant', 'Variant', false, /^variant( name| title)?$|^option1 value$|^size$|^color$/i],
  ['barcode', 'Barcode / UPC', false, /barcode|^upc$|^ean$|^gtin$/i],
  ['weight_oz', 'Weight', false, /weight|grams/i],
  ['dims_in', 'Dimensions (in)', false, /dimension|dims|^l ?x ?w ?x ?h$/i],
  ['declared_value', 'Price / declared value', false, /^(variant )?price$|^value$|^retail/i],
  ['low_stock_threshold', 'Low-stock alert qty', false, /low ?stock|reorder/i],
];
function CatalogModal({ org, me, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [map, setMap] = useState({});
  const [weightUnit, setWeightUnit] = useState('oz');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  const onFile = async (f) => {
    if (!f) return; setErr(null);
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') return setErr('Please upload a .csv file (export from Shopify, WooCommerce, or a spreadsheet as CSV).');
    const text = await f.text();
    const parsed = parseCSV(text);
    if (parsed.length < 2) return setErr('That CSV has no data rows.');
    const headers = parsed[0].map((h) => h.trim());
    const m = {};
    for (const [key, , , re] of SKU_FIELDS) { const idx = headers.findIndex((h) => re.test(h)); if (idx >= 0) m[key] = idx; }
    if (headers.some((h) => /grams/i.test(h) && m.weight_oz === headers.indexOf(h))) setWeightUnit('g');
    setFile(f); setRows(parsed); setMap(m);
  };
  const headers = rows ? rows[0] : [];
  const data = rows ? rows.slice(1) : [];
  const toOz = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); if (!isFinite(n)) return ''; return weightUnit === 'g' ? (n / 28.3495).toFixed(2) : weightUnit === 'lb' ? (n * 16).toFixed(2) : String(n); };
  const build = () => data.map((r) => {
    const o = {}; for (const [key] of SKU_FIELDS) if (map[key] != null) o[key] = r[map[key]] ?? '';
    if (o.weight_oz != null) o.weight_oz = toOz(o.weight_oz);
    return o;
  }).filter((o) => (o.sku || '').trim());
  const preview = build().slice(0, 5);
  const total = build().length;

  const run = async () => {
    setBusy(true); setErr(null);
    const path = `${org.id}/sku_catalog/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: 'text/csv' });
    if (upErr) { setBusy(false); return setErr(upErr.message); }
    await supabase.from('documents').insert({ org_id: org.id, kind: 'sku_catalog', title: `SKU Catalog — ${org.name}`, storage_path: path, mime: 'text/csv', size_bytes: file.size, task_key: 'sku_catalog', status: 'approved', reviewed_by: me.id, reviewed_at: new Date().toISOString(), uploaded_by: me.id });
    const { data: res, error } = await supabase.rpc('import_sku_catalog', { p_org_id: org.id, p_rows: build() });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone({ kind: 'ok', text: `SKU catalog imported — ${res.inserted} new, ${res.updated} updated, ${res.total} active SKUs.` });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>SKU Catalog<span className="dot">.</span></h3>
        {!rows ? <>
          <p className="lead">Upload {org.name}’s product list as a CSV. One row per SKU — Shopify’s product export and WooCommerce’s CSV work without changes.</p>
          <div className="drop" onClick={() => ref.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
            <b>Drop a .csv here</b><span>or click to choose · needs at least a SKU column; name, variant, barcode, weight, dimensions and price are picked up when present</span>
          </div>
          <input ref={ref} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          {err && <div className="msg err" style={{ marginTop: 12 }}>{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button></div>
        </> : <>
          <p className="lead"><b>{file.name}</b> · {data.length.toLocaleString()} rows · <button className="linkbtn" onClick={() => { setRows(null); setFile(null); }}>choose a different file</button></p>
          <div className="mapgrid">
            {SKU_FIELDS.map(([key, label, required]) => (
              <label key={key}><span>{label}{required && <i> *</i>}</span>
                <select value={map[key] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [key]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                  <option value="">— skip —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                </select>
                {key === 'weight_oz' && map.weight_oz != null && <select className="unit" value={weightUnit} onChange={(e) => setWeightUnit(e.target.value)}><option value="oz">oz</option><option value="g">g</option><option value="lb">lb</option></select>}
              </label>
            ))}
          </div>
          {map.sku == null ? <div className="msg err">Pick which column holds the SKU.</div> : (
            <div className="previewwrap"><table className="preview"><thead><tr>{SKU_FIELDS.filter(([k]) => map[k] != null).map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
              <tbody>{preview.map((o, i) => <tr key={i}>{SKU_FIELDS.filter(([k]) => map[k] != null).map(([k]) => <td key={k}>{o[k]}</td>)}</tr>)}</tbody></table>
              <div className="note">Showing {preview.length} of {total.toLocaleString()} SKUs. Existing SKUs with the same code are updated, not duplicated.</div></div>
          )}
          {err && <div className="msg err">{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy || map.sku == null || !total} onClick={run}>{busy ? 'Importing…' : `Import ${total.toLocaleString()} SKUs`}</button></div>
        </>}
      </div>
    </div>
  );
}

function BillingModal({ org, onClose, onSaved }) {
  const [method, setMethod] = useState(org.billing_method || 'ach');
  const [summary, setSummary] = useState(org.billing_details?.summary || '');
  const [err, setErr] = useState(null);
  const save = async () => {
    const { error } = await supabase.from('orgs').update({ billing_method: method, billing_details: { summary: summary.trim() || null, set_at: new Date().toISOString() } }).eq('id', org.id);
    if (error) setErr(error.message); else onSaved();
  };
  const hint = { ach: 'e.g. Chase ·· 4821 — authorization form on file', card: 'e.g. Visa ·· 6411, exp 09/28', wire: 'e.g. remittance details sent to AP', check: 'e.g. AP contact / mailing cadence', net_terms: 'e.g. Net 15, invoice to ap@brand.com' }[method];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Billing method<span className="dot">.</span></h3>
        <p className="lead">How {org.name} pays their monthly statement.</p>
        <div className="options">
          {BILLING.map(([v, l, d]) => (
            <label key={v} className={`option ${method === v ? 'on' : ''}`}>
              <input type="radio" name="billing" value={v} checked={method === v} onChange={() => setMethod(v)} />
              <div><b>{l}</b><div className="small">{d}</div></div>
            </label>
          ))}
        </div>
        <div className="field" style={{ marginTop: 14 }}><label>Reference (optional — never full account or card numbers)</label><input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={hint} /></div>
        {err && <div className="msg err">{err}</div>}
        <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" onClick={save}>Save billing method</button></div>
      </div>
    </div>
  );
}

/* ---------- Client Portal: confirm → generate login → email ---------- */
function PortalModal({ org, onClose }) {
  const reset = !!org.portal_user_id;
  const [step, setStep] = useState('confirm'); // confirm | ready | sent
  const [name, setName] = useState(org.contact_name || '');
  const [email, setEmail] = useState(org.contact_email || '');
  const [cred, setCred] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true); setErr(null);
    const r = await fn('portal-access', { action: 'create', org_id: org.id, email: email.trim(), full_name: name.trim() });
    setBusy(false);
    if (r.error) return setErr(r.error);
    setCred({ email: r.email, password: r.password }); setStep('ready');
  };
  const send = async () => {
    setBusy(true); setErr(null);
    const r = await fn('portal-access', { action: 'send_welcome', org_id: org.id, email: cred.email, password: cred.password });
    setBusy(false);
    if (r.error) return setErr(r.error);
    setStep('sent');
  };
  const copy = async () => { try { await navigator.clipboard.writeText(`shipbay.dashboard login\nSign in: https://auth.shipbay3pl.com\nEmail: ${cred.email}\nTemporary password: ${cred.password}`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ } };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {step === 'confirm' && <>
          <h3>{reset ? 'Reset portal login' : 'Create client portal'}<span className="dot">.</span></h3>
          <p className="lead">{reset ? `Generates a new temporary password for ${org.name}’s existing login.` : `Confirm who gets the login for ${org.name}. Their email becomes their username; a temporary password is generated for them.`}</p>
          <div className="confirm">
            <div><small>Brand</small><b>{org.name}</b>{org.founding_account && <span className="tag founding solid" style={{ marginLeft: 8, marginTop: 0 }}>Founding</span>}</div>
            <div className="field"><label>Contact name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last" /></div>
            <div className="field"><label>Login email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@brand.com" disabled={reset} /></div>
            <div><small>Role</small><b>Client admin</b> <span className="muted">— sees only {org.name}’s inventory, orders, shipments and billing</span></div>
            <div><small>Signs in at</small><b>auth.shipbay3pl.com</b></div>
          </div>
          {err && <div className="msg err">{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy || !email.trim()} onClick={create}>{busy ? 'Generating…' : reset ? 'Confirm & reset password' : 'Confirm & generate login'}</button></div>
        </>}
        {step !== 'confirm' && <>
          <h3>{step === 'sent' ? 'Welcome email sent' : 'Portal login ready'}<span className="dot">.</span></h3>
          <p className="lead">{step === 'sent' ? <>Sent to <b>{cred.email}</b> — “Good news, your portal is ready.” The login step is checked off.</> : <>Shown once — email it to the client now, or copy it. It isn’t stored anywhere in plain text.</>}</p>
          <div className="cred">
            <div><small>Sign in at</small><code>auth.shipbay3pl.com</code></div>
            <div><small>Email</small><code>{cred.email}</code></div>
            <div><small>Temporary password</small><code>{cred.password}</code></div>
          </div>
          {err && <div className="msg err">{err}</div>}
          <div className="row">
            <button className="btn-sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy details'}</button>
            <div className="spacer" />
            {step === 'sent' ? <button className="btn-sm primary" onClick={onClose}>Done</button> : <><button className="btn-sm" onClick={onClose}>Close</button><button className="btn-sm primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Email login details'}</button></>}
          </div>
        </>}
      </div>
    </div>
  );
}

/* ---------- Connect a shipping-label service or commerce channel ---------- */
export function ConnectModal({ org, taskKey, onClose, onDone }) {
  const cat = CATEGORY[taskKey];
  const [prov, setProv] = useState(null);
  const [mode, setMode] = useState('oauth'); // for providers that offer both: oauth | api_key
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pick = (p) => { setProv(p); setMode(p.auth); setVals({}); setErr(null); };
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const fields = prov ? (mode === 'oauth' ? prov.oauthFields || [] : prov.fields || []) : [];
  const ready = fields.every((f) => f.optional || (vals[f.key] || '').trim());

  const go = async () => {
    setBusy(true); setErr(null);
    if (mode === 'oauth') {
      const r = await fn('integrations', { action: 'oauth_start', org_id: org.id, category: cat.key, provider: prov.id, params: vals });
      setBusy(false);
      if (r.error) return setErr(r.error);
      window.location.assign(r.url); // provider sign-in → back to the dashboard with the result
      return;
    }
    const r = await fn('integrations', { action: 'connect', org_id: org.id, category: cat.key, provider: prov.id, credentials: vals });
    setBusy(false);
    if (r.error) return setErr(r.error);
    onDone({ kind: 'ok', text: `${prov.name} connected${r.integration?.label ? ` — ${r.integration.label}` : ''}.` });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>{cat.title}<span className="dot">.</span></h3>
        <p className="lead">{prov ? <><button className="linkbtn" onClick={() => setProv(null)}>← all {cat.key === 'shipping' ? 'services' : 'channels'}</button></> : `Choose what ${org.name} uses, then sign in. Credentials are verified live and kept server-side — never in the browser.`}</p>
        {!prov && (
          <div className="provgrid">
            {cat.list.map((p) => (
              <button key={p.id} className="prov" onClick={() => pick(p)}>
                <b>{p.name}</b>
                <small>{p.auth === 'oauth' ? 'Sign in with ' + p.name : p.auth === 'manual' ? 'Record account' : 'API keys'}</small>
              </button>
            ))}
          </div>
        )}
        {prov && <>
          <div className="provhead"><b>{prov.name}</b><span className="muted">{prov.help}</span></div>
          {prov.auth === 'oauth' && prov.altAuth && (
            <div className="seg"><button className={mode === 'oauth' ? 'on' : ''} onClick={() => setMode('oauth')}>Client signs in</button><button className={mode === 'api_key' ? 'on' : ''} onClick={() => setMode('api_key')}>Paste API token</button></div>
          )}
          {fields.map((f) => (
            <div className="field" key={f.key}><label>{f.label}{f.optional && <span className="muted"> (optional)</span>}</label>
              <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={vals[f.key] || ''} placeholder={f.placeholder || ''} onChange={(e) => set(f.key, e.target.value)} />
            </div>
          ))}
          {mode === 'oauth' && <div className="note" style={{ marginBottom: 12 }}>You’ll be sent to {prov.name} to approve ShipBay’s access, then returned here. {prov.needs?.length ? <>Needs ShipBay’s {prov.name} developer app registered (secrets: <code>{prov.needs.join(', ')}</code>).</> : null}</div>}
          {prov.auth === 'manual' && <div className="note" style={{ marginBottom: 12 }}>{prov.name} has no public API, so this records the account (never a password) and marks the step connected.</div>}
          {err && <div className="msg err">{err}</div>}
          <div className="row"><button className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy || !ready} onClick={go}>{busy ? (mode === 'oauth' ? 'Opening…' : 'Verifying…') : mode === 'oauth' ? `Continue to ${prov.name} →` : prov.auth === 'manual' ? 'Save & connect' : 'Verify & connect'}</button></div>
        </>}
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
