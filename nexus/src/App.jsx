// Sign-in shell. The screens live in Nexus.jsx and take the signed-in profile.
import { useEffect, useState } from 'react';
import { supabase, NEXUS_ROLES, EMBED, WMS_ORIGINS, setToken } from './lib.js';
import Nexus from './Nexus.jsx';

// Inside a WMS: no sign-in here. Ask the parent for the signed-in user's access token; accept it only from a known WMS origin.
function Embedded() {
  const [me, setMe] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    const on = (e) => {
      if (!WMS_ORIGINS.includes(e.origin) || e.data?.type !== 'nexus-token' || typeof e.data.token !== 'string') return;
      setToken(e.data.token);
      if (!me) supabase.from('profiles').select('id, role, full_name, email, active').eq('id', e.data.user).maybeSingle().then(({ data, error }) => (data?.active && NEXUS_ROLES.includes(data.role) ? setMe(data) : setErr(error?.message || 'This login cannot use Nexus.')));
    };
    window.addEventListener('message', on); window.parent.postMessage({ type: 'nexus-ready' }, '*');
    return () => window.removeEventListener('message', on);
  }, [me]);
  if (err) return <div className="center">{err}</div>;
  return me ? <Nexus me={me} embed /> : <div className="center">Connecting to the WMS…</div>;
}

export default function App() {
  if (EMBED) return <Embedded />;
  return <Standalone />;
}
function Standalone() {
  const [session, setSession] = useState(undefined); const [me, setMe] = useState(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) { setMe(null); return; }
    supabase.from('profiles').select('id, role, full_name, email, active, employee_no').eq('id', session.user.id).maybeSingle().then(({ data }) => setMe(data || { role: null }));
  }, [session]);
  if (session === undefined || (session && !me)) return <div className="center">Loading…</div>;
  if (!session) return <SignIn />;
  if (!me.active || !NEXUS_ROLES.includes(me.role)) return <div className="center"><p>This login cannot use Nexus.</p><button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button></div>;
  return <Nexus me={me} onSignOut={() => supabase.auth.signOut()} />;
}

function SignIn() {
  const [mode, setMode] = useState('pin'); const [no, setNo] = useState(''); const [pin, setPin] = useState(''); const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    if (mode === 'pin') {   // the same employee number + PIN the WMS floor uses
      const { data, error } = await supabase.functions.invoke('wms-login', { body: { employee_no: Number(no), pin } });
      if (error || !data?.access_token) { setBusy(false); return setErr('Employee number or PIN not recognised.'); }
      const { error: e2 } = await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      setBusy(false); if (e2) setErr(e2.message);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
      setBusy(false); if (error) setErr(error.message);
    }
  };
  return (
    <form className="signin" onSubmit={go}>
      <img src="/brand/nexus-logo.png" alt="Nexus" />
      <div className="seg"><button type="button" className={mode === 'pin' ? 'on' : ''} onClick={() => setMode('pin')}>Employee PIN</button><button type="button" className={mode === 'email' ? 'on' : ''} onClick={() => setMode('email')}>Email</button></div>
      {mode === 'pin' ? <><label>Employee number<input inputMode="numeric" value={no} onChange={(e) => setNo(e.target.value)} autoFocus /></label><label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></label></>
        : <><label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label><label>Password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label></>}
      {err && <div className="strip bad">{err}</div>}
      <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
