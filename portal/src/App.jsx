import { useEffect, useState } from 'react';
import { supabase } from './lib';
import { isAuthHost, isAppHost, splitMode, authUrl, handoffToApp, takeHandoff } from './hosts';

const STAFF = ['shipbay_admin', 'shipbay_staff'];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);

  useEffect(() => {
    (async () => {
      const t = isAppHost ? takeHandoff() : null;
      if (t) await supabase.auth.setSession(t);
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setMe(null); return; }
    (async () => {
      const { data: p } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
      let orgName = null;
      if (p?.org_id) { const { data: o } = await supabase.from('orgs').select('name').eq('id', p.org_id).single(); orgName = o?.name ?? null; }
      setMe({ ...p, isStaff: STAFF.includes(p?.role), orgName });
    })();
  }, [session]);

  if (session === undefined) return null;
  if (isAuthHost) {
    // auth. never shows the app: with a session, pass it along; without, show sign-in
    if (session) { handoffToApp(session); return null; }
    return <SignIn />;
  }
  if (!session) {
    if (isAppHost) { window.location.replace(authUrl()); return null; }
    return <SignIn />;
  }
  return <Shell me={me} />;
}

/* ---------- Sign-in (ported from site/portal.html) ---------- */
function SignIn() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (!error && splitMode && data?.session) return handoffToApp(data.session);
    setBusy(false);
    if (error) setMsg({ kind: 'err', text: error.message === 'Invalid login credentials' ? 'That email and password don’t match. Try again or reset your password.' : error.message });
  };
  const reset = async () => {
    if (!email.trim()) return setMsg({ kind: 'err', text: 'Enter your work email first, then tap “Forgot password?”' });
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: authUrl() });
    setMsg(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Check your inbox — a reset link is on its way.' });
  };

  return (
    <div className="split">
      <aside className="brandside">
        <div>
          <a className="logo" href="https://www.shipbay3pl.com"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
          <div className="tagline">shipbay.dashboard — client portal</div>
        </div>
        <h1>Your whole operation,<br />one dashboard<em>.</em></h1>
        <p className="sub">Live inventory, orders, and itemized billing across your shipbay warehouse — synced straight from your store.</p>
        <div className="mock" aria-hidden="true">
          <div className="mh"><b>shipbay.dashboard</b><span className="pill">PRODUCT PREVIEW</span></div>
          <div className="mstats">
            <div className="ms"><b>2,847</b><small>Orders today</small></div>
            <div className="ms"><b>14,208</b><small>Units on hand</small></div>
            <div className="ms"><b>99.8%</b><small>Accuracy — 30d</small></div>
          </div>
        </div>
        <div className="foot">© 2026 shipbay. · 115 Stryker Ln, Hillsborough Township, NJ</div>
      </aside>

      <section className="formside">
        <div className="top">New to shipbay?&nbsp;<a href="https://www.shipbay3pl.com/book">Book a free consultation →</a></div>
        <form className="formbox" onSubmit={submit}>
          <h2>Sign in to your portal<span className="dot">.</span></h2>
          <p className="lead">Track orders, inventory, and billing for your brand.</p>
          {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
          <div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" placeholder="you@yourbrand.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" placeholder="••••••••••" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></div>
          <div className="row-between">
            <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in</label>
            <button type="button" className="linkbtn" onClick={reset}>Forgot password?</button>
          </div>
          <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to shipbay.dashboard'}</button>
          <div className="signup-note"><b>Don’t have a login yet?</b> Portal access is created by your onboarding manager when your brand goes live with shipbay — or <a href="https://www.shipbay3pl.com/book" style={{ color: 'var(--orange-soft)', fontWeight: 600 }}>book a consultation</a> to get started.</div>
        </form>
        <div className="legal">Trouble signing in? <a href="mailto:derekh@shipbay3pl.com">Contact us</a> · <a href="https://www.shipbay3pl.com">shipbay</a></div>
      </section>
    </div>
  );
}

/* ---------- Signed-in shell — intentionally empty; screens are built one at a time ---------- */
function Shell({ me }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="logo" href="/"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
        <div className="who">
          {me && <><span className="role">{me.isStaff ? 'shipbay staff' : 'client'}</span><b>{me.orgName || me.full_name || me.email}</b></>}
          <button className="out" onClick={async () => { await supabase.auth.signOut(); if (splitMode) window.location.replace(authUrl()); }}>Sign out</button>
        </div>
      </header>
      <main className="stage">
        <div className="blank">
          <img className="mark" src="/brand/09-mark.svg" alt="" />
          <h2>Your dashboard is being set up<span className="dot">.</span></h2>
          <p>{me?.isStaff ? 'Ops screens are coming online here, starting with client onboarding.' : 'Your onboarding manager will light this up as your brand goes live with shipbay.'}</p>
        </div>
      </main>
    </div>
  );
}
