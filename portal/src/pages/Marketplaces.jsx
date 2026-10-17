// Staff: marketplace developer-app setup. OAuth marketplaces need ShipBay's own app registered once; after that every
// client can "Connect" with their marketplace sign-in. Status comes live from the integrations function (which secrets exist).
import { useEffect, useState } from 'react';
import { supabase } from '../lib';

const fn = async (body) => { const { data, error } = await supabase.functions.invoke('integrations', { body }); return error ? { error: error.message } : data; };

const MARKETS = [
  { id: 'shopify', name: 'Shopify', portal: 'https://partners.shopify.com', portalLabel: 'Shopify Partners',
    secrets: [['SHOPIFY_CLIENT_ID', 'Client ID'], ['SHOPIFY_CLIENT_SECRET', 'Client secret']],
    steps: ['Simplest path (recommended): the client creates a custom app in their own admin — Settings → Apps and sales channels → Develop apps → Create app → scopes: read_orders, write_orders, read_products, read_inventory, write_inventory, write_fulfillments, read_locations → Install → copy the Admin API access token. Then use “Paste API token” on Connect. No Partner app needed.', 'Partner-app path (sign-in button): partners.shopify.com → Apps → Create app manually → App URL https://dashboard.shipbay3pl.com, add the callback URL under Allowed redirection URLs.', 'Distribution: “Custom distribution” binds the app to ONE store (enter that client’s brand.myshopify.com). Public distribution works for any store but requires Shopify app review.', 'Paste the Client ID and Client secret below — they apply to the one store you named.'],
    note: 'Because a custom-distribution app is single-store, treat the Partner path as per-client; the token path scales with no setup.' },
  { id: 'amazon', name: 'Amazon Seller Central', portal: 'https://sellercentral.amazon.com/sellingpartner/developerconsole', portalLabel: 'Developer Console',
    secrets: [['AMAZON_SP_APP_ID', 'App ID (amzn1.sp.solution.…)'], ['AMAZON_LWA_CLIENT_ID', 'LWA client ID'], ['AMAZON_LWA_CLIENT_SECRET', 'LWA client secret'], ['AMAZON_APP_PUBLISHED', 'Set to 1 only after Amazon approves the listing (optional)']],
    steps: ['Register ShipBay as a developer: Seller Central → Apps & Services → Develop Apps (needs a Professional seller or Solution Provider account). Amazon reviews the developer profile — usually a few days.', 'Add new app client: name ShipBay, API type SP-API, roles: Inventory & Order Tracking, Direct-to-Consumer Shipping, Product Listing (read).', 'OAuth Login URI = https://dashboard.shipbay3pl.com · OAuth Redirect URI = the redirect URL below.', 'Copy the App ID, LWA client ID and secret into the secrets below. Leave AMAZON_APP_PUBLISHED unset while the app is in draft — clients can still authorize a draft app.'],
    note: 'Longest lead time of the five because of Amazon’s developer review.' },
  { id: 'ebay', name: 'eBay', portal: 'https://developer.ebay.com/my/keys', portalLabel: 'eBay Developer Program',
    secrets: [['EBAY_CLIENT_ID', 'Production App ID (Client ID)'], ['EBAY_CLIENT_SECRET', 'Production Cert ID (Client secret)'], ['EBAY_RUNAME', 'RuName']],
    steps: ['Join the eBay Developer Program (free) as ShipBay and create a Production keyset.', 'Under the keyset: “User Tokens” → “Get a Token from eBay via Your Application” → add an eBay Redirect URL (this creates the RuName). Set “Your auth accepted URL” to the redirect URL below.', 'Copy App ID, Cert ID and the RuName into the secrets below.'],
    note: 'Production keys may need eBay to enable them (“application growth check”) once call volume grows.' },
  { id: 'etsy', name: 'Etsy', portal: 'https://www.etsy.com/developers/your-apps', portalLabel: 'Etsy Developers',
    secrets: [['ETSY_CLIENT_ID', 'Keystring (API key)']],
    steps: ['Create an app at etsy.com/developers as ShipBay. Describe it as order fulfillment for brands you warehouse.', 'Etsy reviews new apps for “commercial” access before they can be authorized by other shops — request it in the app settings.', 'Add the redirect URL below under Callback URLs, then copy the Keystring into the secret below.'],
    note: 'Etsy uses PKCE — already handled.' },
  { id: 'tiktok_shop', name: 'TikTok Shop', portal: 'https://partner.us.tiktokshop.com', portalLabel: 'TikTok Shop Partner Center (US)',
    secrets: [['TIKTOK_APP_KEY', 'App key'], ['TIKTOK_APP_SECRET', 'App secret'], ['TIKTOK_SERVICE_ID', 'Service ID'], ['TIKTOK_REGION', 'us (default) — only set if not US']],
    steps: ['Register on the US Partner Center as a developer (business verification required).', 'Create an app: type “Order & Fulfillment / 3PL”, add the redirect URL below as the App Redirect URL, request order, fulfillment, logistics and product scopes.', 'Publish the app as a service to get its Service ID; copy App key, App secret and Service ID into the secrets below.'],
    note: 'Review typically takes a week or two.' },
];

export default function Marketplaces() {
  const [st, setSt] = useState(null);
  const [copied, setCopied] = useState(false);
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = async () => setSt(await fn({ action: 'status' }));
  useEffect(() => { load(); }, []);
  const save = async (id, keys) => {
    const secrets = Object.fromEntries(keys.filter((k) => vals[k] != null && vals[k] !== '').map((k) => [k, vals[k]]));
    if (!Object.keys(secrets).length) return setMsg({ kind: 'err', text: 'Paste at least one value first.' });
    setBusy(id); setMsg(null);
    const r = await fn({ action: 'set_secrets', secrets });
    setBusy(null);
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    setVals((v) => { const n = { ...v }; for (const k of Object.keys(secrets)) delete n[k]; return n; });
    setMsg({ kind: 'ok', text: `Saved ${r.saved.join(', ')}.` });
    load();
  };
  const clear = async (k) => {
    if (!confirm(`Remove ${k}?`)) return;
    const r = await fn({ action: 'set_secrets', secrets: { [k]: '' } });
    if (r.error) return setMsg({ kind: 'err', text: r.error });
    load();
  };
  const redirect = st?.redirect_uri || 'https://poxlczzkpztmoiixyrth.supabase.co/functions/v1/integrations/callback';
  const copy = async () => { try { await navigator.clipboard.writeText(redirect); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ } };
  const ready = MARKETS.filter((m) => st?.providers?.[m.id]?.ready).length;

  return (
    <>
      <div className="pagehead">
        <div><h1>Marketplaces<span className="dot">.</span></h1><p className="sub">One-time setup per marketplace. Once ShipBay’s app is registered, any client can sign in and connect from their portal.</p></div>
        <div className="glance"><div><small>Ready</small><b>{st ? `${ready} of ${MARKETS.length}` : '…'}</b></div></div>
      </div>

      <div className="card redirectcard">
        <div><small>Redirect / callback URL — paste this into every marketplace app</small><code>{redirect}</code></div>
        <button className="btn-sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <button className="btn-sm" onClick={load}>Refresh status</button>
      </div>
      <div className="hint">Paste each marketplace’s keys into its card and hit Save — they’re stored server-side and never shown again (only the last 4 characters). Takes effect immediately.</div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="markets">
        {MARKETS.map((m) => {
          const p = st?.providers?.[m.id];
          const ok = !!p?.ready;
          return (
            <div key={m.id} className={`card market ${ok ? 'ok' : ''}`}>
              <div className="cardhead">
                <h3>{m.name}</h3>
                <span className={`pill ${ok ? 'connected' : st ? 'pending' : ''}`}>{!st ? 'checking…' : ok ? 'Ready — clients can connect' : 'Needs app registration'}</span>
                <div className="spacer" />
                <a className="btn-sm" href={m.portal} target="_blank" rel="noopener">{m.portalLabel} ↗</a>
              </div>
              <div className="body">
                <ol>{m.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                <div className="secrets">
                  <div className="grouplabel">Keys</div>
                  {m.secrets.map(([k, l]) => {
                    const info = st?.keys?.[k];
                    const optional = !p?.needs?.includes(k);
                    return (
                      <div key={k} className={`secret ${info?.set ? 'set' : optional ? 'opt' : 'missing'}`}>
                        <span className="lbl">{l}{optional && <em> · optional</em>}</span>
                        <div className="in">
                          <input type={/SECRET|KEY$/.test(k) && k !== 'TIKTOK_APP_KEY' ? 'password' : 'text'} autoComplete="off" placeholder={info?.set ? `set${info.tail ? ` · ends in ${info.tail}` : ''} — paste to replace` : 'paste here'} value={vals[k] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} />
                          {info?.set && <button className="edit" title="Remove" onClick={() => clear(k)}>×</button>}
                        </div>
                        <i>{info?.set ? 'set ✓' : optional ? '' : 'missing'}</i>
                      </div>
                    );
                  })}
                  <button className="btn-sm primary" disabled={busy === m.id} onClick={() => save(m.id, m.secrets.map(([k]) => k))}>{busy === m.id ? 'Saving…' : 'Save keys'}</button>
                </div>
                {m.note && <div className="note">{m.note}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className={`card market ${st?.keys?.RESEND_API_KEY?.set ? 'ok' : ''}`} style={{ marginBottom: 14 }}>
        <div className="cardhead">
          <h3>Email sending (Resend)</h3>
          <span className={`pill ${st?.keys?.RESEND_API_KEY?.set ? 'connected' : 'pending'}`}>{st?.keys?.RESEND_API_KEY?.set ? 'Ready' : 'Key needed'}</span>
          <div className="spacer" />
          <a className="btn-sm" href="https://resend.com/api-keys" target="_blank" rel="noopener">Resend API keys ↗</a>
        </div>
        <div className="body">
          <ol><li>Sends the “Good news — your portal is ready” welcome email (and later client notifications) from derekh@shipbay3pl.com.</li><li>Resend → API Keys → Create (sending access, domain shipbay3pl.com) → paste here.</li></ol>
          <div className="secrets">
            <div className="grouplabel">Keys</div>
            <div className={`secret ${st?.keys?.RESEND_API_KEY?.set ? 'set' : 'missing'}`}>
              <span className="lbl">Resend API key</span>
              <div className="in"><input type="password" autoComplete="off" placeholder={st?.keys?.RESEND_API_KEY?.set ? `set · ends in ${st.keys.RESEND_API_KEY.tail} — paste to replace` : 're_…'} value={vals.RESEND_API_KEY ?? ''} onChange={(e) => setVals((v) => ({ ...v, RESEND_API_KEY: e.target.value }))} /></div>
              <i>{st?.keys?.RESEND_API_KEY?.set ? 'set ✓' : 'missing'}</i>
            </div>
            <button className="btn-sm primary" disabled={busy === 'resend'} onClick={() => save('resend', ['RESEND_API_KEY'])}>{busy === 'resend' ? 'Saving…' : 'Save key'}</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: '14px 18px' }}>
        <b>Already working without any registration:</b> <span className="muted">WooCommerce, BigCommerce, Walmart Marketplace, Squarespace, Wix, Square Online, Faire, Magento, Ecwid, PrestaShop, Webflow, Wayfair (API keys the client pastes), plus Shopify via a custom-app token. Shipping: ShipStation, ShipEngine, Shippo, EasyPost, Pitney Bowes, Sendle, Easyship, Veeqo, UPS, FedEx, USPS, DHL Express.</span>
      </div>
    </>
  );
}
