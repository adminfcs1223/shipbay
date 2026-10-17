// Client-facing Overview: where their account stands, what shipbay needs from them, who to reach.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';
import { providerName } from '../providers';
import { PHASES, PhaseIcon, fmt, acceptFor, DOC_KIND, BILLING, SIGN_KEYS, UploadButton, ConnectModal } from './Onboarding';
import Tutorial, { tourSeen } from '../Tutorial';

const GO_LIVE = { on_time: ['On track', 'ok'], at_risk: ['Needs attention', 'warn'], delayed: ['Delayed', 'bad'], on_hold: ['On hold', 'muted'], complete: ['Live', 'navy'] };
const longDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }) : null);
const fn = async (name, body) => {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) { let msg = error.message; try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ } return { error: msg }; }
  return data || {};
};

// What each step means from the client's side
const HELP = {
  intake_form: 'Your account details, ship-from address and order volume.',
  w9: 'Needed for billing setup.',
  formation_cert: 'Articles of organization / incorporation, or equivalent.',
  rate_card: 'The pricing you agreed to. Download, sign, and upload the signed copy.',
  agreement: 'Your shipbay account agreement. Download, sign, and upload the signed copy.',
  sla: 'Our service-level commitment to you. Download, sign, and upload the signed copy.',
  billing_method: 'How your monthly statement is paid.',
  additional_docs: 'Anything else useful — insurance or resale certificates, brand guidelines, prior 3PL reports.',
  portal_login: 'You’re looking at it.',
  label_access: 'Connect your shipping-label account (ShipStation, Shippo, UPS, FedEx, USPS…) so labels print under your rates.',
  shopify_connected: 'Connect your store or marketplace so orders flow to the warehouse automatically.',
  sku_catalog: 'Your product list — one row per SKU. A Shopify or WooCommerce export is perfect.',
  packaging_spec: 'How you want orders packed: materials, inserts, branding.',
  returns_rules: 'What we do with returns and exchanges when they arrive.',
  packing_sops: 'Any step-by-step instructions your packers should follow.',
  inbound_scheduled: 'When your first inventory arrives at the warehouse.',
  inbound_received: 'We count and verify everything against your list.',
  test_orders: 'A few real orders end to end before we flip the switch.',
  go_live_date: 'The day the warehouse starts shipping for you.',
  go_live: 'Your first live orders out the door.',
};
const initials = (n) => (n || 'S').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export default function ClientHome({ me }) {
  const [org, setOrg] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [docs, setDocs] = useState([]);
  const [conns, setConns] = useState([]);
  const [skuCount, setSkuCount] = useState(0);
  const [openPhase, setOpenPhase] = useState(null);
  const [connectOpen, setConnectOpen] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [tour, setTour] = useState(false);
  useEffect(() => { if (me?.id && !tourSeen(me.id)) setTour(true); }, [me?.id]);

  const load = async () => {
    if (!me?.org_id) return;
    const [{ data: o }, { data: t }, { data: d }, { data: c }, { count: n }] = await Promise.all([
      supabase.from('orgs').select('*').eq('id', me.org_id).single(),
      supabase.from('onboarding_tasks').select('*').eq('org_id', me.org_id).order('sort'),
      supabase.from('documents').select('*').eq('org_id', me.org_id).not('task_key', 'is', null).order('created_at', { ascending: false }),
      supabase.from('integrations').select('id, category, provider, label, status, error, auth_type').eq('org_id', me.org_id).neq('status', 'disconnected').order('created_at'),
      supabase.from('skus').select('id', { count: 'exact', head: true }).eq('org_id', me.org_id).eq('active', true),
    ]);
    setOrg(o); setTasks(t || []); setDocs(d || []); setConns(c || []); setSkuCount(n || 0);
  };
  useEffect(() => { load(); }, [me?.org_id]);

  // back from a provider's sign-in: #conn=<provider>|ok|<message>
  useEffect(() => {
    const m = /conn=([^&]+)/.exec(window.location.hash);
    if (!m) return;
    const [provider, ok, text] = decodeURIComponent(m[1]).split('|');
    setMsg({ kind: ok === 'ok' ? 'ok' : 'err', text: ok === 'ok' ? `${providerName(provider)} connected.` : `${providerName(provider)}: ${text}` });
    setOpenPhase('systems');
    history.replaceState(null, '', window.location.pathname);
  }, []);

  const upload = async (t, file) => {
    if (!file) return; setMsg(null);
    const acc = acceptFor(t);
    if (!acc.mimes.includes(file.type) && !acc.ext.split(',').some((e) => file.name.toLowerCase().endsWith(e))) return setMsg({ kind: 'err', text: acc.label === 'PDF' ? 'Please upload a PDF.' : 'Please upload a PDF, Word, Excel or image file.' });
    const path = `${org.id}/${t.key}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (upErr) return setMsg({ kind: 'err', text: upErr.message });
    const { error } = await supabase.from('documents').insert({ org_id: org.id, kind: DOC_KIND[t.key] || 'other', title: `${t.label} — ${org.name}`, storage_path: path, mime: file.type || null, size_bytes: file.size, task_key: t.key, status: 'pending', uploaded_by: me.id, visible_to_client: true });
    if (error) return setMsg({ kind: 'err', text: error.message });
    setMsg({ kind: 'ok', text: `${t.label} received — shipbay will review it.` });
    load();
  };
  const viewDoc = async (d) => {
    const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(d.storage_path, 600);
    if (error) return setMsg({ kind: 'err', text: error.message });
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  const disconnect = async (c) => {
    if (!confirm(`Disconnect ${providerName(c.provider)}?`)) return;
    setBusyId(c.id);
    const r = await fn('integrations', { action: 'disconnect', integration_id: c.id });
    setBusyId(null);
    if (r.error) setMsg({ kind: 'err', text: r.error });
    load();
  };

  if (!me) return null;
  if (!me.org_id || !org) return <div className="stage"><div className="blank"><img className="mark" src="/brand/09-mark.svg" alt="" /><h2>Setting up your account<span className="dot">.</span></h2><p>Your onboarding manager will light this up shortly.</p></div></div>;

  const required = tasks.filter((t) => !t.optional);
  const done = required.filter((t) => t.done).length;
  const pct = required.length ? Math.round((100 * done) / required.length) : 0;
  const live = org.status === 'active';
  const first = (me.full_name || '').split(/\s+/)[0] || 'there';
  const gl = GO_LIVE[org.go_live_status] || GO_LIVE.on_time;
  const catOf = (t) => (t.key === 'label_access' ? 'shipping' : 'commerce');
  const tplOf = (t) => (SIGN_KEYS.includes(t.key) ? docs.find((d) => d.task_key === t.key && d.for_signature) : null);
  const signedOf = (t) => docs.filter((d) => d.task_key === t.key && !d.for_signature);

  const stateOf = (t) => {
    const latest = signedOf(t)[0];
    if (t.done) return 'done';
    if (t.kind === 'document' && SIGN_KEYS.includes(t.key) && !tplOf(t)) return 'locked';
    if ((t.kind === 'document' || t.kind === 'catalog') && latest && latest.status !== 'rejected') return 'pending';
    if (t.kind === 'billing' && org.billing_method) return 'done';
    if (t.kind === 'portal') return 'done';
    if (t.kind === 'integration' && conns.some((c) => c.category === catOf(t) && c.status === 'connected')) return 'done';
    if (t.kind === 'integration' && conns.some((c) => c.category === catOf(t))) return 'pending';
    if (t.kind === 'catalog' && skuCount) return 'done';
    if (t.kind === 'schedule' && t.scheduled_for) return 'done';
    return 'open';
  };

  const uploadBtn = (t, primary) => {
    const sign = SIGN_KEYS.includes(t.key);
    const latest = signedOf(t)[0];
    return <UploadButton accept={t.kind === 'catalog' ? '.csv,.xlsx' : acceptFor(t).ext} onFile={(f) => upload(t, f)} primary={primary}
      label={sign ? (latest ? 'Upload signed copy again' : 'Upload signed copy') : latest ? 'Upload again' : t.kind === 'catalog' ? 'Upload product list' : `Upload ${acceptFor(t).label}`} />;
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">{org.name}{org.founding_account && <span className="tag founding solid" style={{ marginLeft: 10 }}>Founding account</span>}</div>
          <h1>{live ? `Welcome back, ${first}` : `Welcome, ${first}`}<span className="dot">.</span></h1>
        </div>
        <div className="glance">
          <button className="tourbtn" onClick={() => setTour(true)}>? Quick tour</button>
          <div><small>Status</small><b>{live ? 'Live' : 'Onboarding'}</b></div>
          {org.go_live_date && <div><small>Est. go-live</small><b>{longDate(org.go_live_date)}</b></div>}
          <div><small>Timeline</small><span className={`statuspill ${gl[1]}`}>{gl[0]}</span></div>
        </div>
      </div>

      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="clienthome">
        <div className="main">
          <div className="card detail">
            <div className="cardhead headline">
              <h2>{live ? 'Onboarding complete' : 'Your onboarding'}</h2>
              <div className="progress">
                <div className="bar big"><i style={{ width: `${pct}%` }} /></div>
                <div className="next"><span className="pct">{pct}%</span> · {done} of {required.length} steps{!live && required.find((t) => !t.done) ? <> · next: <b>{required.find((t) => !t.done).label}</b></> : null}</div>
              </div>
            </div>

            <div className="phases">
              {PHASES.map((p) => {
                const list = required.filter((t) => t.phase === p.key);
                const d = list.filter((t) => t.done).length;
                const complete = list.length > 0 && d === list.length;
                return (
                  <button key={p.key} className={`phasetile ${openPhase === p.key ? 'open' : ''} ${complete ? 'complete' : ''}`} onClick={() => setOpenPhase(openPhase === p.key ? null : p.key)}>
                    <div className="tile"><PhaseIcon kind={p.icon} /></div>
                    <div className="plabel">{p.label}</div>
                    <div className="pcount">{d}/{list.length}</div>
                    <div className="bar"><i style={{ width: `${list.length ? (100 * d) / list.length : 0}%` }} /></div>
                  </button>
                );
              })}
            </div>

            {openPhase && (
              <div className="phase open">
                {tasks.filter((t) => t.phase === openPhase).map((t) => {
                  const state = stateOf(t);
                  const sign = SIGN_KEYS.includes(t.key);
                  const tpl = tplOf(t);
                  const latest = signedOf(t)[0];
                  const canUpload = (t.kind === 'document' || t.kind === 'catalog') && state !== 'done' && state !== 'locked';
                  const list = t.kind === 'integration' ? conns.filter((c) => c.category === catOf(t)) : [];
                  return (
                    <div key={t.id} className={`task ${state}`}>
                      <span className={`circle ${state === 'locked' ? 'open' : state}`}>{state === 'done' ? '✓' : state === 'pending' ? '–' : ''}</span>
                      <div>
                        <div className="lbl">{t.label}{t.optional && <span className="opt">optional</span>}
                          {sign && tpl && state !== 'done' && <button className="btn-xs" onClick={() => viewDoc(tpl)}>Download &amp; sign</button>}
                          {canUpload && uploadBtn(t, state === 'open' && !t.optional)}
                          {t.kind === 'integration' && <button className="btn-xs primary" onClick={() => setConnectOpen(t.key)}>{list.length ? 'Connect another' : 'Connect'}</button>}
                        </div>
                        <div className="note">
                          {state === 'locked' && <span className="muted">Not yet uploaded by admin — shipbay will send this for your signature.</span>}
                          {state === 'done' && t.kind === 'document' && (sign ? 'Signed and approved' : 'Approved')}
                          {state === 'done' && t.kind === 'catalog' && <>{skuCount.toLocaleString()} SKUs on file</>}
                          {state === 'done' && t.kind === 'schedule' && <>Arriving {longDate(t.scheduled_for)}</>}
                          {state === 'done' && t.kind === 'billing' && <>{BILLING.find((b) => b[0] === org.billing_method)?.[1]}</>}
                          {state === 'done' && ['manual', 'portal'].includes(t.kind) && (t.done_at ? `Completed ${fmt(t.done_at)}` : 'Complete')}
                          {state === 'pending' && t.kind !== 'integration' && <>Received {fmt(latest.created_at)} — being reviewed by shipbay</>}
                          {state === 'open' && (latest?.status === 'rejected' ? <span className="warn">We need a corrected copy{latest.review_note ? ` — ${latest.review_note}` : ''}</span> : HELP[t.key])}
                          {t.kind === 'integration' && list.length > 0 && (
                            <ul className="connlist">
                              {list.map((c) => (
                                <li key={c.id}>
                                  <span className={`pill ${c.status}`}>{c.status}</span>
                                  <b>{providerName(c.provider)}</b>{c.label && <span className="muted"> · {c.label}</span>}
                                  {c.status === 'error' && c.error && <span className="errtxt"> — {c.error}</span>}
                                  <span className="acts"><button className="edit" disabled={busyId === c.id} onClick={() => disconnect(c)}>disconnect</button></span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      <div className="when">{latest && t.kind !== 'catalog' ? <button className="viewdoc" onClick={() => viewDoc(latest)}>View</button> : (t.done && t.done_at ? fmt(t.done_at) : '')}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>

        <aside className="side">
          <div className="card team">
            <div className="cardhead"><h3>Your shipbay team</h3></div>
            <div className="person">
              <div className="avatar">{initials(org.sales_rep)}</div>
              <div><b>{org.sales_rep}</b><div className="small">Sales &amp; onboarding</div>
                <div className="contact"><a href={`tel:${(org.sales_rep_phone || '').replace(/\D/g, '')}`}>{org.sales_rep_phone}</a><a href={`mailto:${org.sales_rep_email}`}>{org.sales_rep_email}</a></div></div>
            </div>
            <div className="person">
              <div className="avatar ops">{initials(org.ops_manager)}</div>
              <div><b>{org.ops_manager}</b><div className="small">Account Operations Manager</div>
                <div className="contact"><a href={`tel:${(org.ops_manager_phone || '').replace(/\D/g, '')}`}>{org.ops_manager_phone}</a><a href={`mailto:${org.ops_manager_email}`}>{org.ops_manager_email}</a></div></div>
            </div>
          </div>
          <div className="card">
            <div className="cardhead"><h3>Send inventory to</h3></div>
            <address>
              <b>shipbay — {org.name}</b><br />115 Stryker Ln, Unit 10<br />Hillsborough Township, NJ 08844
            </address>
            <div className="small">Label every carton with your SKU and quantity; send your packing list ahead of time so receiving is same-day.</div>
          </div>
          <div className="card">
            <div className="cardhead"><h3>Good to know</h3></div>
            <ul className="facts2">
              <li><b>2:00 pm ET</b> order cutoff for same-day shipping</li>
              <li><b>Month-to-month</b> — no lock-in, no offboarding fee</li>
              <li><b>Postage at cost</b> — carrier rates, itemized on every invoice</li>
            </ul>
          </div>
        </aside>
      </div>
      {tour && <Tutorial me={me} org={org} onClose={() => setTour(false)} />}
      {connectOpen && <ConnectModal org={org} taskKey={connectOpen} onClose={() => setConnectOpen(null)} onDone={(f) => { setConnectOpen(null); if (f) setMsg(f); load(); }} />}
    </>
  );
}
