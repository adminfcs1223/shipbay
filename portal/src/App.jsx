import { useEffect, useState } from 'react';
import { supabase } from './lib';
import Home from './pages/Home';
import Orders from './pages/Orders';
import Inventory from './pages/Inventory';
import Billing from './pages/Billing';
import Returns from './pages/Returns';

const NAV = [['home', 'Overview', '◫'], ['orders', 'Orders', '▤'], ['inventory', 'Inventory', '▦'], ['billing', 'Billing', '▧'], ['support', 'Returns & support', '◌']];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);
  const [org, setOrg] = useState(null);
  const [page, setPage] = useState('home');
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setMe(null); setOrg(null); return; }
    (async () => {
      const { data: p } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
      const isStaff = ['shipbay_admin', 'shipbay_staff'].includes(p?.role);
      const { data: orgs } = await supabase.from('orgs').select('*').order('name');
      const orgNames = Object.fromEntries((orgs || []).map((o) => [o.id, o.name]));
      setMe({ ...p, isStaff, orgs: orgs || [], orgNames });
      if (!isStaff) setOrg((orgs || [])[0] || null);
    })();
  }, [session]);

  useEffect(() => {
    if (!me) return;
    let q = supabase.from('orders').select('id', { count: 'exact', head: true }).in('status', ['new', 'on_hold', 'backordered', 'picked', 'packed']);
    if (org) q = q.eq('org_id', org.id);
    q.then(({ count }) => setOpenCount(count || 0));
  }, [me, org, page]);

  if (session === undefined) return null;
  if (!session) return <Login />;
  if (!me) return <div className="empty">Loading your account…</div>;
  if (!me.isStaff && !org) return <div className="login"><div className="card"><h2>No client assigned</h2><p className="muted">Your login isn't linked to a client account yet. Email ops@shipbay3pl.com and we'll fix it.</p><button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button></div></div>;

  const go = (p) => { setPage(p); window.scrollTo(0, 0); };
  const props = { me, org, go, setOrg: (o) => { setOrg(o); go('home'); } };
  const Page = { home: Home, orders: Orders, inventory: Inventory, billing: Billing, support: Returns }[page];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="dot">SB</span> ShipBay</div>
        <div className="org">{org ? org.name : 'All clients'}</div>
        {me.isStaff && org && <button className="nav" onClick={() => { setOrg(null); go('home'); }}>← All clients</button>}
        {NAV.map(([k, l, ic]) => (
          <button key={k} className={`nav ${page === k ? 'active' : ''}`} onClick={() => go(k)}>
            <span style={{ opacity: 0.7, width: 14 }}>{ic}</span>{l}{k === 'orders' && openCount > 0 && <span className="n">{openCount}</span>}
          </button>
        ))}
        <div className="foot"><b>{me.full_name || me.email}</b>{me.isStaff ? 'ShipBay staff' : org?.name}<br /><button onClick={() => supabase.auth.signOut()}>Sign out</button></div>
      </aside>
      <main className="main"><Page {...props} /></main>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    setBusy(false); if (error) setMsg(['bad', error.message]);
  };
  const reset = async () => {
    if (!email) return setMsg(['bad', 'Enter your email first.']);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    setMsg(error ? ['bad', error.message] : ['ok', 'Check your email for a reset link.']);
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand"><span className="dot">SB</span> ShipBay Portal</div>
        <p className="muted small" style={{ marginTop: 0 }}>Orders, inventory, billing and support for your fulfillment account.</p>
        <div className="field"><label>Email</label><input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field"><label>Password</label><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required /></div>
        {msg && <div className={`alert ${msg[0]}`} style={{ marginBottom: 10 }}>{msg[1]}</div>}
        <button className="btn primary" style={{ width: '100%', padding: 10 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}><button type="button" className="btn sm" onClick={reset} style={{ border: 0 }}>Forgot password</button><span className="small muted">ops@shipbay3pl.com</span></div>
      </form>
    </div>
  );
}
