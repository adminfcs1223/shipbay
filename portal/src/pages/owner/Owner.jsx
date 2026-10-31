// Owner — Derek's private area. Normal login + a second passphrase (checked by the `owner` edge function; the unlock
// token lives in sessionStorage so it goes away when the tab closes). Financials, Sales, Settings.
import { useEffect, useState } from 'react';
import { ownerFn, getToken, setToken } from './util';
import Financials from './Financials';
import Sales from './Sales';

const TABS = [['fin', 'Financials'], ['sales', 'Sales'], ['settings', 'Settings']];

export default function Owner({ me }) {
  const [status, setStatus] = useState(null);     // from action:status
  const [tab, setTab] = useState('fin');
  const [flash, setFlash] = useState(() => {       // QuickBooks round-trip lands with #owner=qbo|ok|msg
    const h = window.location.hash; if (!h.startsWith('#owner=qbo')) return null;
    const [, ok, msg] = h.slice(7).split('|'); history.replaceState(null, '', window.location.pathname);
    return { kind: ok === 'ok' ? 'ok' : 'err', text: decodeURIComponent(msg || '') };
  });

  const refresh = async () => { const s = await ownerFn({ action: 'status' }); if (s.error) { setStatus({ error: s.error }); return; } if (!s.unlocked) setToken(null); setStatus(s); };
  useEffect(() => { refresh(); }, []);

  if (!me?.is_owner) return <div className="card"><div className="empty">This area is for the owner only.</div></div>;
  if (!status) return <div className="card"><div className="empty">Checking…</div></div>;
  if (status.error) return <div className="card"><div className="msg err">{status.error}</div></div>;
  if (!status.passphrase_set) return <Gate mode="set" onDone={refresh} />;
  if (!status.unlocked || !getToken()) return <Gate mode="unlock" onDone={refresh} />;

  const lock = () => { setToken(null); refresh(); };
  return (
    <>
      <div className="pagehead">
        <div><h1>Owner<span className="dot">.</span></h1><p className="sub">Only you can open this. Money on the left side of your head, leads on the right.</p></div>
        <div className="glance">
          <div><small>QuickBooks</small><b>{status.qbo?.connected_at ? <span className="statuspill ok">Connected</span> : <span className="statuspill muted">Not connected</span>}</b></div>
          <div><small>Smartlead</small><b>{status.smartlead_key_set ? <span className="statuspill ok">Key saved</span> : <span className="statuspill muted">No key</span>}</b></div>
          <div><button className="btn-sm" onClick={lock}>Lock</button></div>
        </div>
      </div>
      {flash && <div className={`msg ${flash.kind} flash`}>{flash.text || (flash.kind === 'ok' ? 'QuickBooks connected.' : 'QuickBooks connection failed.')}<button onClick={() => setFlash(null)} aria-label="Dismiss">×</button></div>}
      <div className="card ownertabs"><div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      {tab === 'fin' && <Financials status={status} refreshStatus={refresh} />}
      {tab === 'sales' && <Sales me={me} status={status} refreshStatus={refresh} />}
      {tab === 'settings' && <Settings status={status} refreshStatus={refresh} />}
    </>
  );
}

/* ---------- Passphrase gate ---------- */
function Gate({ mode, onDone }) {
  const [p1, setP1] = useState(''); const [p2, setP2] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (mode === 'set' && p1 !== p2) return setErr('The two passphrases don’t match.');
    setBusy(true);
    const r = mode === 'set' ? await ownerFn({ action: 'set_passphrase', passphrase: p1 }) : await ownerFn({ action: 'unlock', passphrase: p1 });
    setBusy(false);
    if (r.error) return setErr(r.error);
    setToken(r.token); onDone();
  };
  return (
    <div className="ownergate">
      <form className="card" onSubmit={submit}>
        <h2>{mode === 'set' ? 'Set your owner passphrase' : 'Owner passphrase'}<span className="dot">.</span></h2>
        <p className="hint">{mode === 'set' ? 'First time here. This is a second lock on top of your login — anyone at your signed-in screen still can’t open Financials or Sales without it. At least 8 characters; make it different from your login password.' : 'Second lock. Five wrong tries locks it for 10 minutes.'}</p>
        {err && <div className="msg err">{err}</div>}
        <div className="field"><label>Passphrase</label><input type="password" autoFocus value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="off" /></div>
        {mode === 'set' && <div className="field"><label>Again</label><input type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="off" /></div>}
        <button className="btn primary" disabled={busy || p1.length < (mode === 'set' ? 8 : 1)}>{busy ? '…' : mode === 'set' ? 'Set passphrase' : 'Unlock'}</button>
      </form>
    </div>
  );
}

/* ---------- Settings: passphrase, QuickBooks app keys, Smartlead ---------- */
function Settings({ status, refreshStatus }) {
  const [msg, setMsg] = useState(null);
  const [cur, setCur] = useState(''); const [n1, setN1] = useState(''); const [n2, setN2] = useState('');
  const [qid, setQid] = useState(''); const [qsec, setQsec] = useState('');
  const [slk, setSlk] = useState(''); const [slc, setSlc] = useState(status.smartlead_campaigns || '');
  const [busy, setBusy] = useState(null);

  const say = (r, ok) => { if (r.error) setMsg({ kind: 'err', text: r.error }); else { setMsg({ kind: 'ok', text: ok }); refreshStatus(); } };
  const changePass = async (e) => { e.preventDefault(); if (n1 !== n2) return setMsg({ kind: 'err', text: 'New passphrases don’t match.' }); setBusy('pass'); const r = await ownerFn({ action: 'set_passphrase', passphrase: n1, current: cur }); setBusy(null); if (!r.error) { setToken(r.token); setCur(''); setN1(''); setN2(''); } say(r, 'Passphrase changed.'); };
  const saveSecret = async (key, value, label) => { if (!value.trim()) return; setBusy(key); const r = await ownerFn({ action: 'save_secret', key, value }); setBusy(null); say(r, `${label} saved.`); };

  return (
    <div className="ownergrid">
      {msg && <div className={`msg ${msg.kind} flash span2`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="card">
        <h3>QuickBooks app keys</h3>
        <p className="hint">One-time setup so the Financials tab can pull your real QuickBooks numbers. In the Intuit developer portal create an app (QuickBooks Online Accounting scope), set its redirect URI to <code className="mono">https://dashboard.shipbay3pl.com/oauth/qbo</code>, then paste its production Client ID and Client Secret here. Status: <b>{status.qbo_keys_set ? 'keys saved' : 'not set'}</b>.</p>
        <div className="field"><label>Client ID</label><input value={qid} onChange={(e) => setQid(e.target.value)} placeholder={status.qbo_keys_set ? '•••••••• (saved — paste to replace)' : ''} autoComplete="off" /></div>
        <div className="field"><label>Client Secret</label><input type="password" value={qsec} onChange={(e) => setQsec(e.target.value)} placeholder={status.qbo_keys_set ? '•••••••• (saved)' : ''} autoComplete="off" /></div>
        <div className="row"><button className="btn-sm primary" disabled={busy === 'QBO_CLIENT_ID' || (!qid && !qsec)} onClick={async () => { if (qid) await saveSecret('QBO_CLIENT_ID', qid, 'Client ID'); if (qsec) await saveSecret('QBO_CLIENT_SECRET', qsec, 'Client Secret'); setQid(''); setQsec(''); }}>Save keys</button></div>
      </div>
      <div className="card">
        <h3>Smartlead</h3>
        <p className="hint">API key from Smartlead → Settings → API. Campaign IDs comma-separated (the cold-email campaign is 4039101). Status: <b>{status.smartlead_key_set ? 'key saved' : 'no key'}</b>.</p>
        <div className="field"><label>API key</label><input type="password" value={slk} onChange={(e) => setSlk(e.target.value)} placeholder={status.smartlead_key_set ? '•••••••• (saved — paste to replace)' : ''} autoComplete="off" /></div>
        <div className="field"><label>Campaign IDs</label><input value={slc} onChange={(e) => setSlc(e.target.value)} placeholder="4039101" /></div>
        <div className="row"><button className="btn-sm primary" disabled={!!busy} onClick={async () => { if (slk) await saveSecret('SMARTLEAD_API_KEY', slk, 'Smartlead key'); if (slc && slc !== status.smartlead_campaigns) await saveSecret('SMARTLEAD_CAMPAIGNS', slc, 'Campaigns'); setSlk(''); }}>Save</button></div>
      </div>
      <form className="card" onSubmit={changePass}>
        <h3>Change passphrase</h3>
        <div className="field"><label>Current</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="off" /></div>
        <div className="field"><label>New (8+ characters)</label><input type="password" value={n1} onChange={(e) => setN1(e.target.value)} autoComplete="off" /></div>
        <div className="field"><label>New again</label><input type="password" value={n2} onChange={(e) => setN2(e.target.value)} autoComplete="off" /></div>
        <div className="row"><button className="btn-sm primary" disabled={busy === 'pass' || n1.length < 8 || !cur}>Change</button></div>
      </form>
      <div className="card">
        <h3>How this area is locked</h3>
        <ul className="plainlist">
          <li>Your login gets you into shipbay.dashboard; the passphrase gets you in here. Staff accounts (even admins) don’t see the Owner menu at all.</li>
          <li>The database itself only answers these tables for your user — so even if someone bypassed the screen, the data stays closed.</li>
          <li>The unlock lasts for the browser tab. Close the tab, or tap <b>Lock</b>, and the passphrase is asked again.</li>
          <li>Keys you paste here are stored server-side and never shown back.</li>
        </ul>
      </div>
    </div>
  );
}
