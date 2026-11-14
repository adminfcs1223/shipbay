// Two admin-only blocks on Admin settings:
//   Orders connector — each brand's client code and the keys its own program uses to post orders to the WMS
//                      (POST /api/orders). A key is shown once, when it is made; only its last 4 characters are kept.
//   Cameras          — live feeds as tiles. A camera is a name and the https page that plays its feed.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';

const WMS_HOST = 'https://wmsshipbay.netlify.app';

export function Connector({ orgs, say }) {
  const [keys, setKeys] = useState(null); const [brands, setBrands] = useState(null);
  const [shown, setShown] = useState(null); const [busy, setBusy] = useState(null);
  const load = async () => {
    const [k, b] = await Promise.all([supabase.rpc('wms_list_api_keys'), supabase.from('orgs').select('id, name, client_code, status').neq('status', 'churned').order('name')]);
    if (k.error) say({ kind: 'err', text: k.error.message });
    setKeys(k.data || []); setBrands(b.data || []);
  };
  useEffect(() => { load(); }, [orgs]);

  const setCode = async (b) => {
    const code = window.prompt(`Client code for ${b.name} (what its program sends as "client"). Letters, numbers, dashes.`, b.client_code || b.name.split(' ')[0].toUpperCase());
    if (code == null) return;
    setBusy(b.id); const { error } = await supabase.rpc('wms_set_client_code', { p_org: b.id, p_code: code }); setBusy(null);
    if (error) return say({ kind: 'err', text: error.message.includes('orgs_client_code_uq') ? 'Another brand already uses that code.' : error.message }); load();
  };
  const newKey = async (b) => {
    const label = window.prompt(`Label for this key (for example "Veeqo program"). ${b.name}'s program will use it to post orders.`, 'Orders program');
    if (label == null) return;
    setBusy(b.id); const { data, error } = await supabase.rpc('wms_create_api_key', { p_org: b.id, p_label: label }); setBusy(null);
    if (error) return say({ kind: 'err', text: error.message }); setShown({ brand: b, key: data }); load();
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke the key ending ${k.hint} for ${k.brand}? Its program stops being able to post orders straight away.`)) return;
    setBusy(k.id); const { error } = await supabase.rpc('wms_revoke_api_key', { p_id: k.id }); setBusy(null);
    if (error) return say({ kind: 'err', text: error.message }); load();
  };

  return (
    <>
      <div className="opsbar" style={{ marginTop: 28 }}><h2 style={{ margin: 0 }}>Orders connector<span className="dot">.</span></h2></div>
      <div className="card">
        {brands === null ? <div className="empty">Loading…</div> : (
          <div className="tablewrap"><table className="ordertable users">
            <thead><tr><th>Brand</th><th>Client code</th><th>Keys</th><th /></tr></thead>
            <tbody>{brands.map((b) => {
              const mine = (keys || []).filter((k) => k.org_id === b.id);
              return (
                <tr key={b.id}>
                  <td><b>{b.name}</b></td>
                  <td>{b.client_code ? <b className="mono">{b.client_code}</b> : <span className="sm">Not set</span>}</td>
                  <td>{mine.length === 0 ? <span className="sm">None</span> : mine.map((k) => (
                    <div key={k.id} className={k.revoked_at ? 'muted' : ''} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
                      <span className="mono">…{k.hint}</span><span className="sm">{k.label || 'No label'} · {k.revoked_at ? 'revoked' : k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : 'never used'}</span>
                      {!k.revoked_at && <button className="btn-xs" disabled={busy === k.id} onClick={() => revoke(k)}>Revoke</button>}
                    </div>))}</td>
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-xs" disabled={busy === b.id} onClick={() => setCode(b)}>{b.client_code ? 'Change code' : 'Set code'}</button>{' '}
                    <button className="btn-xs" disabled={busy === b.id || !b.client_code} onClick={() => newKey(b)}>New key</button>
                  </td>
                </tr>);
            })}</tbody>
          </table></div>
        )}
      </div>
      {shown && (
        <div className="overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{shown.brand.name} key<span className="dot">.</span></h3>
            <p className="lead">Shown once. Put it in the program that sends {shown.brand.name}’s orders; it can’t be looked up later, only replaced.</p>
            <div className="credbox">
              <div><small>Post orders to</small><b style={{ wordBreak: 'break-all' }}>{WMS_HOST}/api/orders</b></div>
              <div><small>Client</small><b className="mono">{shown.brand.client_code}</b></div>
              <div><small>Authorization: Bearer</small><b className="mono" style={{ wordBreak: 'break-all' }}>{shown.key}</b></div>
            </div>
            <div className="actions"><button className="btn-sm" onClick={() => navigator.clipboard?.writeText(`WMS orders endpoint: ${WMS_HOST}/api/orders\nClose an order: ${WMS_HOST}/api/orders/{order_number}/close\nclient: ${shown.brand.client_code}\nAuthorization: Bearer ${shown.key}`)}>Copy</button><button className="btn-sm primary" onClick={() => setShown(null)}>Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}

export function Cameras({ say }) {
  const [cams, setCams] = useState(null); const [adding, setAdding] = useState(false);
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => { const { data, error } = await supabase.from('cameras').select('*').eq('active', true).order('sort').order('created_at'); if (error) say({ kind: 'err', text: error.message }); setCams(data || []); };
  useEffect(() => { load(); }, []);
  const add = async (e) => {
    e.preventDefault(); if (busy) return;
    if (!/^https:\/\//i.test(url.trim())) return say({ kind: 'err', text: 'The feed address has to start with https://' });
    setBusy(true); const { error } = await supabase.from('cameras').insert({ name: name.trim(), embed_url: url.trim(), sort: (cams || []).length }); setBusy(false);
    if (error) return say({ kind: 'err', text: error.message }); setName(''); setUrl(''); setAdding(false); load();
  };
  const remove = async (c) => {
    if (!window.confirm(`Take ${c.name} off this page?`)) return;
    const { error } = await supabase.from('cameras').update({ active: false }).eq('id', c.id); if (error) return say({ kind: 'err', text: error.message }); load();
  };
  return (
    <>
      <div className="opsbar" style={{ marginTop: 28 }}>
        <h2 style={{ margin: 0 }}>Cameras<span className="dot">.</span></h2><div className="spacer" />
        <button className="btn-sm primary" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : '+ Add camera'}</button>
      </div>
      {adding && (
        <form className="card" onSubmit={add} style={{ padding: 20, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto', gap: 14, alignItems: 'end', marginBottom: 14 }}>
          <div className="field" style={{ margin: 0 }}><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></div>
          <div className="field" style={{ margin: 0 }}><label>Feed address (https)</label><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required /></div>
          <button className="btn-sm primary" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        </form>
      )}
      {cams === null ? <div className="card"><div className="empty">Loading…</div></div> : cams.length === 0 ? <div className="card"><div className="empty">No cameras yet. Once a camera is installed, add its name and feed address here and it plays on this page.</div></div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 14 }}>
          {cams.map((c) => (
            <div className="card" key={c.id} style={{ overflow: 'hidden' }}>
              <div style={{ aspectRatio: '16 / 9', background: '#0F1B2A' }}><iframe title={c.name} src={c.embed_url} allow="autoplay; fullscreen" allowFullScreen referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} /></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}><b>{c.name}</b><div className="spacer" /><a className="btn-xs" href={c.embed_url} target="_blank" rel="noreferrer">Open</a><button className="btn-xs" onClick={() => remove(c)}>Remove</button></div>
            </div>))}
        </div>
      )}
    </>
  );
}
