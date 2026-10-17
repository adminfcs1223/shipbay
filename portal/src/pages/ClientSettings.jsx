// Staff: per-client settings — brand, contacts, team, operations, addresses, notes.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';

const STATUS = [['onboarding', 'Onboarding'], ['active', 'Live'], ['paused', 'Paused'], ['churned', 'Churned']];
const GO_LIVE = [['on_time', 'On time'], ['at_risk', 'At risk'], ['delayed', 'Delayed'], ['on_hold', 'On hold'], ['complete', 'Complete']];
const TZ = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
const ADDR = ['name', 'line1', 'line2', 'city', 'state', 'zip', 'country', 'phone'];
const FIELDS = ['name', 'slug', 'status', 'founding_account', 'go_live_date', 'go_live_status', 'contact_name', 'contact_email', 'contact_phone', 'billing_email', 'ops_email', 'notify_low_stock', 'notify_daily_summary', 'cutoff_time', 'timezone', 'ships_saturday', 'packaging_rules', 'notes', 'sales_rep', 'sales_rep_phone', 'sales_rep_email', 'ops_manager', 'ops_manager_phone', 'ops_manager_email', 'ship_from_address', 'return_address'];
const Text = ({ f, set, k, label, type = 'text', placeholder }) => (
  <div className="field"><label>{label}</label><input type={type} value={f[k] ?? ''} placeholder={placeholder || ''} onChange={(e) => set(k, e.target.value)} /></div>
);
const Addr = ({ f, setAddr, which, title }) => (
  <div className="addr">
    <div className="grouplabel">{title}</div>
    <div className="grid2">
      <div className="field"><label>Name / company</label><input value={f[which]?.name || ''} onChange={(e) => setAddr(which, 'name', e.target.value)} /></div>
      <div className="field"><label>Phone</label><input value={f[which]?.phone || ''} onChange={(e) => setAddr(which, 'phone', e.target.value)} /></div>
      <div className="field"><label>Address line 1</label><input value={f[which]?.line1 || ''} onChange={(e) => setAddr(which, 'line1', e.target.value)} /></div>
      <div className="field"><label>Line 2</label><input value={f[which]?.line2 || ''} onChange={(e) => setAddr(which, 'line2', e.target.value)} /></div>
      <div className="field"><label>City</label><input value={f[which]?.city || ''} onChange={(e) => setAddr(which, 'city', e.target.value)} /></div>
      <div className="grid3">
        <div className="field"><label>State</label><input value={f[which]?.state || ''} onChange={(e) => setAddr(which, 'state', e.target.value)} /></div>
        <div className="field"><label>ZIP</label><input value={f[which]?.zip || ''} onChange={(e) => setAddr(which, 'zip', e.target.value)} /></div>
        <div className="field"><label>Country</label><input value={f[which]?.country || 'US'} onChange={(e) => setAddr(which, 'country', e.target.value)} /></div>
      </div>
    </div>
  </div>
);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export default function ClientSettings() {
  const [orgs, setOrgs] = useState(null);
  const [sel, setSel] = useState(null);
  const load = async () => {
    const { data } = await supabase.from('orgs').select('*').order('name');
    setOrgs(data || []);
    setSel((s) => s ?? data?.[0]?.id ?? null);
  };
  useEffect(() => { load(); }, []);
  const current = (orgs || []).find((o) => o.id === sel);

  return (
    <>
      <div className="pagehead"><div><h1>Client settings<span className="dot">.</span></h1><p className="sub">Everything about an account that isn’t a checklist step. Changes show up on the client’s side immediately.</p></div></div>
      <div className="onb">
        <div className="card">
          <div className="cardhead"><h3>Clients</h3><div className="spacer" /><span className="tag">{orgs?.length ?? 0}</span></div>
          {orgs === null ? <div className="empty">Loading…</div> : (
            <ul className="acctlist">
              {orgs.map((o) => (
                <li key={o.id}>
                  <button className={`acct ${o.id === sel ? 'active' : ''}`} onClick={() => setSel(o.id)}>
                    <div className="nm">{o.name}{o.founding_account && <span className="tag founding">founding</span>}{o.status === 'active' && <span className="tag live">live</span>}</div>
                    <div className="meta">{o.contact_name || '—'} · {o.contact_email || 'no email'}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {current ? <SettingsForm key={current.id} org={current} onSaved={load} /> : <div className="card"><div className="empty">Pick a client.</div></div>}
      </div>
    </>
  );
}

function SettingsForm({ org, onSaved }) {
  const pick = (o) => Object.fromEntries(FIELDS.map((k) => [k, o[k] ?? (k.endsWith('_address') ? {} : k.startsWith('notify') || k === 'ships_saturday' || k === 'founding_account' ? false : '')]));
  const [f, setF] = useState(() => pick(org));
  const [saved, setSaved] = useState(pick(org));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setAddr = (which, k, v) => setF((s) => ({ ...s, [which]: { ...(s[which] || {}), [k]: v } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    const patch = { ...f };
    for (const k of ['go_live_date', 'cutoff_time', 'contact_email', 'billing_email', 'ops_email', 'contact_phone', 'packaging_rules', 'notes']) if (patch[k] === '') patch[k] = null;
    if (!patch.name.trim()) { setBusy(false); return setMsg({ kind: 'err', text: 'The brand name can’t be empty.' }); }
    patch.slug = slugify(patch.slug || patch.name);
    const { error } = await supabase.from('orgs').update(patch).eq('id', org.id);
    setBusy(false);
    if (error) return setMsg({ kind: 'err', text: error.message.includes('orgs_slug_key') ? 'That URL slug is already used by another client.' : error.message });
    setSaved(f); setMsg({ kind: 'ok', text: 'Saved.' }); onSaved();
  };

  return (
    <div className="card settings">
      <div className="cardhead sticky">
        <h3>{saved.name}</h3>
        <div className="spacer" />
        {msg && <span className={`inlinemsg ${msg.kind}`}>{msg.text}</span>}
        {dirty && <button className="btn-sm" onClick={() => setF(saved)}>Discard</button>}
        <button className="btn-sm primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>

      <section>
        <h4>Brand</h4>
        <div className="grid2">
          <Text f={f} set={set} k="name" label="Brand name" />
          <div className="field"><label>Portal URL slug</label><input value={f.slug} onChange={(e) => set('slug', e.target.value)} onBlur={(e) => set('slug', slugify(e.target.value))} /></div>
          <div className="field"><label>Account status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}>{STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <label className="check"><input type="checkbox" checked={!!f.founding_account} onChange={(e) => set('founding_account', e.target.checked)} /> Founding account</label>
          <Text f={f} set={set} k="go_live_date" label="Est. go-live date" type="date" />
          <div className="field"><label>Go-live status</label><select value={f.go_live_status} onChange={(e) => set('go_live_status', e.target.value)}>{GO_LIVE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        </div>
      </section>

      <section>
        <h4>Primary contact</h4>
        <div className="grid3">
          <Text f={f} set={set} k="contact_name" label="Name" />
          <Text f={f} set={set} k="contact_email" label="Email (portal login)" type="email" />
          <Text f={f} set={set} k="contact_phone" label="Phone" />
        </div>
        <div className="grid2">
          <Text f={f} set={set} k="billing_email" label="Billing / AP email" type="email" placeholder="defaults to the contact email" />
          <Text f={f} set={set} k="ops_email" label="Operations email" type="email" placeholder="daily summaries and exceptions" />
        </div>
        <div className="checks">
          <label className="check"><input type="checkbox" checked={!!f.notify_low_stock} onChange={(e) => set('notify_low_stock', e.target.checked)} /> Low-stock alerts</label>
          <label className="check"><input type="checkbox" checked={!!f.notify_daily_summary} onChange={(e) => set('notify_daily_summary', e.target.checked)} /> Daily shipping summary</label>
        </div>
      </section>

      <section>
        <h4>shipbay team on this account</h4>
        <div className="grid3">
          <Text f={f} set={set} k="sales_rep" label="Sales rep" />
          <Text f={f} set={set} k="sales_rep_phone" label="Phone" />
          <Text f={f} set={set} k="sales_rep_email" label="Email" type="email" />
          <Text f={f} set={set} k="ops_manager" label="Account Operations Manager" />
          <Text f={f} set={set} k="ops_manager_phone" label="Phone" />
          <Text f={f} set={set} k="ops_manager_email" label="Email" type="email" />
        </div>
      </section>

      <section>
        <h4>Operations</h4>
        <div className="grid3">
          <Text f={f} set={set} k="cutoff_time" label="Same-day cutoff" type="time" />
          <div className="field"><label>Time zone</label><select value={f.timezone || 'America/New_York'} onChange={(e) => set('timezone', e.target.value)}>{TZ.map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')}</option>)}</select></div>
          <label className="check" style={{ alignSelf: 'end', marginBottom: 16 }}><input type="checkbox" checked={!!f.ships_saturday} onChange={(e) => set('ships_saturday', e.target.checked)} /> Ships Saturdays</label>
        </div>
        <div className="field"><label>Packaging rules (shown to packers)</label><textarea rows={3} value={f.packaging_rules || ''} onChange={(e) => set('packaging_rules', e.target.value)} placeholder="e.g. tissue wrap every item, include thank-you card, no branded tape on wholesale" /></div>
      </section>

      <section>
        <h4>Addresses</h4>
        <div className="grid2 addrs">
          <Addr f={f} setAddr={setAddr} which="ship_from_address" title="Ship-from (on labels)" />
          <Addr f={f} setAddr={setAddr} which="return_address" title="Returns go to" />
        </div>
      </section>

      <section>
        <h4>Internal notes</h4>
        <div className="field"><textarea rows={4} value={f.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Only shipbay staff see this." /></div>
      </section>
    </div>
  );
}
