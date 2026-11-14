// ShipBay WMS (wms.shipbay3pl.com). Same database as the dashboard. The floor signs in with an employee number + PIN
// (created in the dashboard's Admin settings); admins can also use their dashboard email login.
// Step 1: the receiving station (a pallet comes in for a brand → PSKU# → 4x6 label) and the pallet register.
import { useEffect, useRef, useState } from 'react';
import { supabase, WMS_ROLES } from './lib';
import Receive from './Receive.jsx';
import Pallets from './Pallets.jsx';
import VersionWatch from './VersionWatch.jsx';

const NAV = [
  ['receive', 'Receiving', 'M3 7h13l5 5v7H3zM16 7v5h5M7 19v-5h6v5'],
  ['pallets', 'Pallets', 'M3 6h18v5H3zM5 11v7M19 11v7M12 11v7M3 18h18'],
];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) { setMe(null); return; }
    supabase.from('profiles').select('id, full_name, email, role, employee_no').eq('id', session.user.id).single()
      .then(({ data }) => setMe(data || { id: session.user.id, email: session.user.email, role: null }));
  }, [session?.user?.id]);

  if (session === undefined) return null;
  if (!session) return <SignIn />;
  if (!me) return null;
  if (!WMS_ROLES.includes(me.role)) return <NoAccess me={me} />;
  return <Shell me={me} />;
}

function Shell({ me }) {
  const [page, setPage] = useState(() => (window.location.hash === '#pallets' ? 'pallets' : 'receive'));
  const [orgs, setOrgs] = useState(null);
  const [pallets, setPallets] = useState(null);
  const [err, setErr] = useState(null);
  const [find, setFind] = useState('');   // a PSKU handed from one screen to the register

  const load = async () => {
    const [o, p] = await Promise.all([
      supabase.rpc('wms_brands'),
      supabase.from('wms_pallets').select('*').order('received_at', { ascending: false }).order('batch_pos', { ascending: false }).limit(1000),
    ]);
    if (o.error || p.error) setErr((o.error || p.error).message); else setErr(null);
    setOrgs(o.data || []); setPallets(p.data || []);
  };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  useEffect(() => { history.replaceState(null, '', page === 'pallets' ? '#pallets' : '#'); }, [page]);

  const brandName = (id) => (orgs || []).find((o) => o.id === id)?.name || 'Unknown brand';
  const merge = (rows) => setPallets((cur) => { const m = new Map((cur || []).map((r) => [r.id, r])); rows.forEach((r) => m.set(r.id, { ...m.get(r.id), ...r })); return [...m.values()].sort((a, b) => (b.received_at > a.received_at ? 1 : b.received_at < a.received_at ? -1 : b.batch_pos - a.batch_pos)); });
  const open = (psku) => { setFind(psku); setPage('pallets'); };

  return (
    <div className="wms">
      <aside className="rail">
        <div className="mark"><img src="/brand/13-mono-horizontal-white.svg" alt="shipbay." /><span>WMS</span></div>
        <nav>{NAV.map(([k, label, d]) => (
          <button key={k} className={page === k ? 'on' : ''} onClick={() => setPage(k)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>{label}
          </button>
        ))}</nav>
        <div className="railfoot">
          <Clock />
          <div className="who"><b>{me.full_name || me.email}</b>{me.employee_no && <span>Employee {me.employee_no}</span>}<button onClick={() => supabase.auth.signOut()}>{me.employee_no ? 'Switch employee' : 'Sign out'}</button></div>
        </div>
      </aside>
      <main className="work">
        <VersionWatch />
        {err && <div className="strip bad"><b>Can’t reach the database.</b><span>{err}</span><button onClick={load}>Try again</button></div>}
        {page === 'receive'
          ? <Receive me={me} orgs={orgs} pallets={pallets} brandName={brandName} merge={merge} open={open} />
          : <Pallets me={me} orgs={orgs} pallets={pallets} brandName={brandName} merge={merge} find={find} setFind={setFind} />}
      </main>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return <div className="clock"><b>{now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b><span>{now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>;
}

function SignIn() {
  const [mode, setMode] = useState('pin');    // 'pin' = employee number + PIN (the floor) · 'email' = an admin's dashboard login
  const [no, setNo] = useState(''); const [pin, setPin] = useState('');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const pinRef = useRef(null);
  const digits = (v, n) => v.replace(/\D/g, '').slice(0, n);

  const byPin = async (e) => {
    e.preventDefault(); if (busy) return;
    if (!no || pin.length !== 6) return setMsg('Enter your employee number and your 6-digit PIN.');
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.functions.invoke('wms-login', { body: { employee_no: Number(no), pin } });
    if (error || !data?.access_token) {
      let text = 'Can’t reach sign-in. Check the connection and try again.';
      try { const j = await error?.context?.json?.(); if (j?.error) text = j.error; } catch { /* keep */ }
      setBusy(false); setPin(''); pinRef.current?.focus(); return setMsg(text);
    }
    const { error: e2 } = await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
    setBusy(false); if (e2) setMsg(e2.message);
  };
  const byEmail = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    setBusy(false); if (error) setMsg(error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message);
  };
  return (
    <div className="signin">
      <aside>
        <div className="mark"><img src="/brand/13-mono-horizontal-white.svg" alt="shipbay." /><span>WMS</span></div>
        <h1>Every pallet has a number<span className="dot">.</span></h1>
        <div className="foot">Warehouse management</div>
      </aside>
      {mode === 'pin' ? (
        <form onSubmit={byPin} autoComplete="off">
          <h2>Sign in</h2>
          {msg && <div className="strip bad"><span>{msg}</span></div>}
          <label>Employee number<input className="bigin" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={no} onChange={(e) => setNo(digits(e.target.value, 6))} onKeyDown={(e) => { if (e.key === 'Enter' && no && !pin) { e.preventDefault(); pinRef.current?.focus(); } }} autoFocus /></label>
          <label>PIN<input ref={pinRef} className="bigin pin" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(digits(e.target.value, 6))} /></label>
          <button className="btn go" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="swap" onClick={() => { setMode('email'); setMsg(null); }}>Admin sign-in with email</button>
        </form>
      ) : (
        <form onSubmit={byEmail}>
          <h2>Admin sign-in</h2>
          {msg && <div className="strip bad"><span>{msg}</span></div>}
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label>Password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
          <button className="btn go" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="swap" onClick={() => { setMode('pin'); setMsg(null); }}>Sign in with employee number</button>
        </form>
      )}
    </div>
  );
}

function NoAccess({ me }) {
  return (
    <div className="noaccess">
      <h2>This login isn’t set up for the WMS<span className="dot">.</span></h2>
      <p>{me.email} is signed in, but the WMS is for warehouse staff.</p>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  );
}
