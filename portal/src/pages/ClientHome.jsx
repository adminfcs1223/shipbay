// Client-facing Overview: where their account stands, what shipbay needs from them, who to reach.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';
import { providerName } from '../providers';
import { PHASES, PhaseIcon, fmt, acceptFor, DOC_KIND, BILLING, UploadButton } from './Onboarding';

const GO_LIVE = { on_time: ['On track', 'ok'], at_risk: ['Needs attention', 'warn'], delayed: ['Delayed', 'bad'], on_hold: ['On hold', 'muted'], complete: ['Live', 'navy'] };
const longDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }) : null);

// What each step means from the client's side
const HELP = {
  intake_form: 'Your account details, ship-from address and order volume. Your onboarding manager sends this.',
  w9: 'Needed for billing setup.',
  formation_cert: 'Articles of organization / incorporation, or equivalent.',
  rate_card: 'The pricing you agreed to, signed.',
  agreement: 'Your shipbay account agreement.',
  sla: 'Our service-level commitment to you.',
  billing_method: 'How your monthly statement is paid.',
  additional_docs: 'Anything else useful — insurance or resale certificates, brand guidelines, prior 3PL reports.',
  portal_login: 'You’re looking at it.',
  label_access: 'Your shipping-label account (ShipStation, Shippo, UPS, FedEx, USPS…) so labels print under your rates.',
  shopify_connected: 'Your store or marketplace, so orders flow to the warehouse automatically.',
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

export default function ClientHome({ me }) {
  const [org, setOrg] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [docs, setDocs] = useState([]);
  const [conns, setConns] = useState([]);
  const [skuCount, setSkuCount] = useState(0);
  const [openPhase, setOpenPhase] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    if (!me?.org_id) return;
    const [{ data: o }, { data: t }, { data: d }, { data: c }, { count: n }] = await Promise.all([
      supabase.from('orgs').select('*').eq('id', me.org_id).single(),
      supabase.from('onboarding_tasks').select('*').eq('org_id', me.org_id).order('sort'),
      supabase.from('documents').select('*').eq('org_id', me.org_id).not('task_key', 'is', null).order('created_at', { ascending: false }),
      supabase.from('integrations').select('id, category, provider, label, status').eq('org_id', me.org_id).eq('status', 'connected'),
      supabase.from('skus').select('id', { count: 'exact', head: true }).eq('org_id', me.org_id).eq('active', true),
    ]);
    setOrg(o); setTasks(t || []); setDocs(d || []); setConns(c || []); setSkuCount(n || 0);
  };
  useEffect(() => { load(); }, [me?.org_id]);

  const upload = async (t, file) => {
    if (!file) return; setMsg(null);
    const acc = acceptFor(t);
    if (!acc.mimes.includes(file.type) && !acc.ext.split(',').some((e) => file.name.toLowerCase().endsWith(e))) return setMsg({ kind: 'err', text: acc.label === 'PDF' ? 'Please upload a PDF.' : 'Please upload a PDF, Word, Excel or image file.' });
    const path = `${org.id}/${t.key}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('client-docs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (upErr) return setMsg({ kind: 'err', text: upErr.message });
    const { error } = await supabase.from('documents').insert({ org_id: org.id, kind: DOC_KIND[t.key] || 'other', title: `${t.label} — ${org.name}`, storage_path: path, mime: file.type || null, size_bytes: file.size, task_key: t.key, status: 'pending', uploaded_by: me.id, visible_to_client: true });
    if (error) return setMsg({ kind: 'err', text: error.message });
    setMsg({ kind: 'ok', text: `${t.label} received — your onboarding manager will review it.` });
    load();
  };
  const viewDoc = async (d) => {
    const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(d.storage_path, 600);
    if (error) return setMsg({ kind: 'err', text: error.message });
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  if (!me) return null;
  if (!me.org_id || !org) return <div className="stage"><div className="blank"><img className="mark" src="/brand/09-mark.svg" alt="" /><h2>Setting up your account<span className="dot">.</span></h2><p>Your onboarding manager will light this up shortly.</p></div></div>;

  const required = tasks.filter((t) => !t.optional);
  const done = required.filter((t) => t.done).length;
  const pct = required.length ? Math.round((100 * done) / required.length) : 0;
  const live = org.status === 'active';
  const first = (me.full_name || '').split(/\s+/)[0] || 'there';
  const gl = GO_LIVE[org.go_live_status] || GO_LIVE.on_time;
  // things the client can act on right now
  const needs = tasks.filter((t) => !t.done && (t.kind === 'document' || t.kind === 'catalog') && !docs.some((d) => d.task_key === t.key && d.status !== 'rejected') && !t.optional);

  const stateOf = (t) => {
    const mine = docs.filter((d) => d.task_key === t.key);
    const latest = mine[0];
    if (t.done) return 'done';
    if ((t.kind === 'document' || t.kind === 'catalog') && latest && latest.status !== 'rejected') return 'pending';
    if (t.kind === 'billing' && org.billing_method) return 'done';
    if (t.kind === 'portal') return 'done';
    if (t.kind === 'integration' && conns.some((c) => c.category === (t.key === 'label_access' ? 'shipping' : 'commerce'))) return 'done';
    if (t.kind === 'catalog' && skuCount) return 'done';
    if (t.kind === 'schedule' && t.scheduled_for) return 'done';
    return 'open';
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">{org.name}{org.founding_account && <span className="tag founding solid" style={{ marginLeft: 10 }}>Founding account</span>}</div>
          <h1>{live ? `Welcome back, ${first}` : `Welcome, ${first}`}<span className="dot">.</span></h1>
        </div>
        <div className="glance">
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
                  const mine = docs.filter((d) => d.task_key === t.key);
                  const latest = mine[0];
                  const canUpload = (t.kind === 'document' || t.kind === 'catalog') && state !== 'done';
                  const list = t.kind === 'integration' ? conns.filter((c) => c.category === (t.key === 'label_access' ? 'shipping' : 'commerce')) : [];
                  return (
                    <div key={t.id} className={`task ${state}`}>
                      <span className={`circle ${state}`}>{state === 'done' ? '✓' : state === 'pending' ? '–' : ''}</span>
                      <div>
                        <div className="lbl">{t.label}{t.optional && <span className="opt">optional</span>}
                          {canUpload && <UploadButton accept={t.kind === 'catalog' ? '.csv,.xlsx' : acceptFor(t).ext} onFile={(f) => upload(t, f)} label={latest ? 'Upload again' : t.kind === 'catalog' ? 'Upload product list' : `Upload ${acceptFor(t).label}`} primary={state === 'open' && !t.optional} />}
                        </div>
                        <div className="note">
                          {state === 'done' && t.kind === 'document' && 'Approved'}
                          {state === 'done' && t.kind === 'catalog' && <>{skuCount.toLocaleString()} SKUs on file</>}
                          {state === 'done' && t.kind === 'schedule' && <>Arriving {longDate(t.scheduled_for)}</>}
                          {state === 'done' && t.kind === 'billing' && <>{BILLING.find((b) => b[0] === org.billing_method)?.[1]}</>}
                          {state === 'done' && t.kind === 'integration' && list.map((c) => <span key={c.id} className="chip">{providerName(c.provider)}{c.label ? ` · ${c.label}` : ''}</span>)}
                          {state === 'done' && ['manual', 'portal'].includes(t.kind) && (t.done_at ? `Completed ${fmt(t.done_at)}` : 'Complete')}
                          {state === 'pending' && <>Received {fmt(latest.created_at)} — being reviewed by shipbay</>}
                          {state === 'open' && (latest?.status === 'rejected' ? <span className="warn">We need a corrected copy{latest.review_note ? ` — ${latest.review_note}` : ''}</span> : HELP[t.key])}
                          {state === 'open' && t.kind === 'integration' && <> Your onboarding manager connects this with you.</>}
                        </div>
                      </div>
                      <div className="when">{latest && t.kind !== 'catalog' ? <button className="viewdoc" onClick={() => viewDoc(latest)}>View</button> : (t.done && t.done_at ? fmt(t.done_at) : '')}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {!live && needs.length > 0 && (
            <div className="card">
              <div className="cardhead"><h3>What we need from you</h3><div className="spacer" /><span className="tag">{needs.length} item{needs.length > 1 ? 's' : ''}</span></div>
              <ul className="needlist">
                {needs.map((t) => (
                  <li key={t.id}>
                    <div><b>{t.label}</b><div className="small">{HELP[t.key]}</div></div>
                    <UploadButton accept={t.kind === 'catalog' ? '.csv,.xlsx' : acceptFor(t).ext} onFile={(f) => upload(t, f)} label={t.kind === 'catalog' ? 'Upload product list' : `Upload ${acceptFor(t).label}`} primary />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="side">
          <div className="card team">
            <div className="cardhead"><h3>Your shipbay team</h3></div>
            <div className="person">
              <div className="avatar">{(org.sales_rep || 'S').split(/\s+/).map((w) => w[0]).join('').slice(0, 2)}</div>
              <div><b>{org.sales_rep || 'shipbay'}</b><div className="small">Onboarding manager</div></div>
            </div>
            <a className="btn-sm" href="mailto:derekh@shipbay3pl.com">Email</a>
            <a className="btn-sm" href="tel:+16104785432">(610) 478-5432</a>
          </div>
          <div className="card">
            <div className="cardhead"><h3>Send inventory to</h3></div>
            <address>
              <b>shipbay — {org.name}</b><br />115 Stryker Ln<br />Hillsborough Township, NJ 08844
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
    </>
  );
}
