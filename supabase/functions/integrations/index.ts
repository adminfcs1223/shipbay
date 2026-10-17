// integrations — connects a client's shipping-label service or commerce channel. Staff for any account, clients for their own org (OAuth callback excepted).
//   POST { action:'connect',     org_id, category, provider, credentials:{…}, label? } → verifies live, stores secrets server-side
//   POST { action:'oauth_start', org_id, category, provider, params:{shop?} }        → { url } for the client/staff to approve on the provider
//   POST { action:'test',        integration_id }                                      → re-verifies stored credentials
//   POST { action:'disconnect',  integration_id }
//   GET  /integrations/callback?provider=…&state=…&code=…                              → OAuth return leg → redirects to the dashboard
// Credentials live only in integration_secrets (no RLS policies → service role only). The browser never sees them again.
// OAuth providers need ShipBay's own developer app registered: SHOPIFY_CLIENT_ID/SECRET, AMAZON_SP_APP_ID + AMAZON_LWA_CLIENT_ID/SECRET,
// EBAY_CLIENT_ID/SECRET/RUNAME, ETSY_CLIENT_ID, TIKTOK_APP_KEY/SECRET/SERVICE_ID — set as Edge Function secrets.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const DASH = 'https://dashboard.shipbay3pl.com/';
const REDIRECT = `${SB_URL}/functions/v1/integrations/callback`;
const env = (k: string) => Deno.env.get(k) ?? '';
const b64 = (s: string) => btoa(s);
const basic = (u: string, p: string) => `Basic ${b64(`${u}:${p}`)}`;
const host = (u: string) => String(u || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const url = (u: string) => `https://${host(u)}`;
type C = Record<string, string>;
type V = { ok: boolean; error?: string; label?: string; meta?: Record<string, unknown>; secrets?: C };

async function call(u: string, init: RequestInit = {}) {
  try {
    const r = await fetch(u, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, data, text };
  } catch (e) { return { ok: false, status: 0, data: null, text: String(e) }; }
}
const fail = (r: { status: number; text: string }, what: string): V =>
  ({ ok: false, error: r.status === 0 ? `Couldn't reach ${what}: ${r.text}` : r.status === 401 || r.status === 403 ? `${what} rejected those credentials (HTTP ${r.status}).` : `${what} returned HTTP ${r.status}: ${r.text.slice(0, 200)}` });
async function clientCreds(tokenUrl: string, id: string, secret: string, what: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<V> {
  const r = await call(tokenUrl, { method: 'POST', headers: { Authorization: basic(id, secret), 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ grant_type: 'client_credentials', ...extra }) });
  return r.ok && (r.data?.access_token) ? { ok: true } : fail(r, what);
}

// ---------- API-key verifiers: one request that only succeeds with valid credentials ----------
const VERIFY: Record<string, (c: C) => Promise<V>> = {
  // shipping
  shipstation: async (c) => { const r = await call('https://ssapi.shipstation.com/carriers', { headers: { Authorization: basic(c.api_key, c.api_secret) } }); return r.ok ? { ok: true, meta: { carriers: (r.data ?? []).map((x: any) => x.name) } } : fail(r, 'ShipStation'); },
  shipengine: async (c) => { const r = await call('https://api.shipengine.com/v1/carriers', { headers: { 'API-Key': c.api_key } }); return r.ok ? { ok: true, meta: { carriers: (r.data?.carriers ?? []).map((x: any) => x.friendly_name) } } : fail(r, 'ShipEngine'); },
  shippo: async (c) => { const r = await call('https://api.goshippo.com/carrier_accounts?results=25', { headers: { Authorization: `ShippoToken ${c.api_key}` } }); return r.ok ? { ok: true, meta: { carriers: (r.data?.results ?? []).map((x: any) => x.carrier) } } : fail(r, 'Shippo'); },
  easypost: async (c) => { const r = await call('https://api.easypost.com/v2/carrier_accounts', { headers: { Authorization: basic(c.api_key, '') } }); return r.ok ? { ok: true, meta: { carriers: (r.data ?? []).map((x: any) => x.readable) } } : fail(r, 'EasyPost'); },
  pitney_bowes: (c) => clientCreds('https://api.pitneybowes.com/oauth/token', c.api_key, c.api_secret, 'Pitney Bowes'),
  sendle: async (c) => { const r = await call('https://api.sendle.com/api/ping', { headers: { Authorization: basic(c.sendle_id, c.api_key) } }); return r.ok ? { ok: true } : fail(r, 'Sendle'); },
  easyship: async (c) => { const r = await call('https://public-api.easyship.com/2024-09/account', { headers: { Authorization: `Bearer ${c.api_key}` } }); return r.ok ? { ok: true, label: r.data?.account?.name } : fail(r, 'Easyship'); },
  veeqo: async (c) => { const r = await call('https://api.veeqo.com/current_user', { headers: { 'x-api-key': c.api_key } }); return r.ok ? { ok: true, label: r.data?.email } : fail(r, 'Veeqo'); },
  ups: (c) => clientCreds('https://onlinetools.ups.com/security/v1/oauth/token', c.client_id, c.client_secret, 'UPS', {}, { 'x-merchant-id': c.account_number ?? '' }),
  fedex: async (c) => { const r = await call('https://apis.fedex.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret }) }); return r.ok ? { ok: true } : fail(r, 'FedEx'); },
  usps: async (c) => { const r = await call('https://apis.usps.com/oauth2/v3/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret }) }); return r.ok ? { ok: true } : fail(r, 'USPS'); },
  dhl_express: async (c) => { const r = await call('https://express.api.dhl.com/mydhlapi/address-validate?type=delivery&countryCode=US&postalCode=08844', { headers: { Authorization: basic(c.api_key, c.api_secret) } }); return r.ok ? { ok: true } : fail(r, 'DHL Express'); },
  // commerce
  shopify: async (c) => {
    const shop = host(c.shop); if (!/\.myshopify\.com$/.test(shop)) return { ok: false, error: 'Store domain must look like brand.myshopify.com' };
    const r = await call(`https://${shop}/admin/api/2025-07/shop.json`, { headers: { 'X-Shopify-Access-Token': c.access_token } });
    return r.ok ? { ok: true, label: r.data?.shop?.name ?? shop, meta: { shop, shop_name: r.data?.shop?.name, plan: r.data?.shop?.plan_name, currency: r.data?.shop?.currency } } : fail(r, 'Shopify');
  },
  woocommerce: async (c) => { const r = await call(`${url(c.store_url)}/wp-json/wc/v3/system_status`, { headers: { Authorization: basic(c.consumer_key, c.consumer_secret) } }); return r.ok ? { ok: true, label: host(c.store_url), meta: { store_url: url(c.store_url), wc_version: r.data?.environment?.version } } : fail(r, 'WooCommerce'); },
  bigcommerce: async (c) => { const r = await call(`https://api.bigcommerce.com/stores/${c.store_hash}/v2/store`, { headers: { 'X-Auth-Token': c.access_token, Accept: 'application/json' } }); return r.ok ? { ok: true, label: r.data?.name, meta: { store_hash: c.store_hash, domain: r.data?.domain } } : fail(r, 'BigCommerce'); },
  walmart: (c) => clientCreds('https://marketplace.walmartapis.com/v3/token', c.client_id, c.client_secret, 'Walmart', {}, { 'WM_SVC.NAME': 'ShipBay', 'WM_QOS.CORRELATION_ID': crypto.randomUUID(), Accept: 'application/json' }),
  squarespace: async (c) => { const r = await call('https://api.squarespace.com/1.0/authorization/website', { headers: { Authorization: `Bearer ${c.api_key}`, 'User-Agent': 'ShipBay 3PL (derekh@shipbay3pl.com)' } }); return r.ok ? { ok: true, label: r.data?.title ?? r.data?.url, meta: { site: r.data?.url } } : fail(r, 'Squarespace'); },
  wix: async (c) => { const r = await call('https://www.wixapis.com/site-properties/v4/properties', { headers: { Authorization: c.api_key, 'wix-site-id': c.site_id } }); return r.ok ? { ok: true, label: r.data?.properties?.siteDisplayName, meta: { site_id: c.site_id } } : fail(r, 'Wix'); },
  square: async (c) => { const r = await call('https://connect.squareup.com/v2/locations', { headers: { Authorization: `Bearer ${c.access_token}`, 'Square-Version': '2025-01-23' } }); return r.ok ? { ok: true, label: r.data?.locations?.[0]?.business_name, meta: { locations: (r.data?.locations ?? []).length } } : fail(r, 'Square'); },
  faire: async (c) => { const r = await call('https://www.faire.com/external-api/v2/orders?limit=1', { headers: { 'X-FAIRE-ACCESS-TOKEN': c.access_token } }); return r.ok ? { ok: true } : fail(r, 'Faire'); },
  magento: async (c) => { const r = await call(`${url(c.store_url)}/rest/V1/store/storeConfigs`, { headers: { Authorization: `Bearer ${c.access_token}` } }); return r.ok ? { ok: true, label: host(c.store_url), meta: { store_url: url(c.store_url) } } : fail(r, 'Magento'); },
  ecwid: async (c) => { const r = await call(`https://app.ecwid.com/api/v3/${c.store_id}/profile`, { headers: { Authorization: `Bearer ${c.access_token}` } }); return r.ok ? { ok: true, label: r.data?.generalInfo?.storeUrl, meta: { store_id: c.store_id } } : fail(r, 'Ecwid'); },
  prestashop: async (c) => { const r = await call(`${url(c.store_url)}/api/?output_format=JSON`, { headers: { Authorization: basic(c.api_key, '') } }); return r.ok ? { ok: true, label: host(c.store_url), meta: { store_url: url(c.store_url) } } : fail(r, 'PrestaShop'); },
  webflow: async (c) => { const r = await call('https://api.webflow.com/v2/token/authorized_by', { headers: { Authorization: `Bearer ${c.access_token}` } }); return r.ok ? { ok: true, label: r.data?.email } : fail(r, 'Webflow'); },
  wayfair: (c) => clientCreds('https://sso.auth.wayfair.com/oauth/token', c.client_id, c.client_secret, 'Wayfair', { audience: 'https://api.wayfair.com/' }),
};
const MANUAL = new Set(['stamps', 'pirate_ship']);

// ---------- OAuth providers ----------
type OAuth = { needs: string[]; authorize: (state: string, p: C, extra: C) => string; exchange: (q: URLSearchParams, meta: C) => Promise<V> };
async function pkce() {
  const v = crypto.randomUUID() + crypto.randomUUID();
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const ch = btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier: v, challenge: ch };
}
const OAUTH: Record<string, OAuth> = {
  shopify: {
    needs: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
    authorize: (state, p) => `https://${host(p.shop)}/admin/oauth/authorize?${new URLSearchParams({ client_id: env('SHOPIFY_CLIENT_ID'), scope: 'read_orders,write_orders,read_products,read_inventory,write_inventory,read_fulfillments,write_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_locations,read_customers', redirect_uri: REDIRECT, state })}`,
    exchange: async (q, meta) => {
      const shop = host(q.get('shop') ?? meta.shop);
      const r = await call(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env('SHOPIFY_CLIENT_ID'), client_secret: env('SHOPIFY_CLIENT_SECRET'), code: q.get('code') }) });
      if (!r.ok || !r.data?.access_token) return fail(r, 'Shopify');
      const v = await VERIFY.shopify({ shop, access_token: r.data.access_token });
      return { ...v, secrets: { shop, access_token: r.data.access_token, scope: r.data.scope } };
    },
  },
  amazon: {
    needs: ['AMAZON_SP_APP_ID', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET'],
    authorize: (state) => `https://sellercentral.amazon.com/apps/authorize/consent?${new URLSearchParams({ application_id: env('AMAZON_SP_APP_ID'), state, redirect_uri: REDIRECT })}`,
    exchange: async (q) => {
      const r = await call('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('spapi_oauth_code') ?? '', client_id: env('AMAZON_LWA_CLIENT_ID'), client_secret: env('AMAZON_LWA_CLIENT_SECRET') }) });
      if (!r.ok || !r.data?.refresh_token) return fail(r, 'Amazon');
      return { ok: true, label: `Seller ${q.get('selling_partner_id') ?? ''}`.trim(), meta: { selling_partner_id: q.get('selling_partner_id') }, secrets: { refresh_token: r.data.refresh_token } };
    },
  },
  ebay: {
    needs: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'],
    authorize: (state) => `https://auth.ebay.com/oauth2/authorize?${new URLSearchParams({ client_id: env('EBAY_CLIENT_ID'), redirect_uri: env('EBAY_RUNAME'), response_type: 'code', state, scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.inventory' })}`,
    exchange: async (q) => {
      const r = await call('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { Authorization: basic(env('EBAY_CLIENT_ID'), env('EBAY_CLIENT_SECRET')), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code') ?? '', redirect_uri: env('EBAY_RUNAME') }) });
      if (!r.ok || !r.data?.refresh_token) return fail(r, 'eBay');
      return { ok: true, secrets: { refresh_token: r.data.refresh_token, access_token: r.data.access_token } };
    },
  },
  etsy: {
    needs: ['ETSY_CLIENT_ID'],
    authorize: (state, _p, extra) => `https://www.etsy.com/oauth/connect?${new URLSearchParams({ response_type: 'code', client_id: env('ETSY_CLIENT_ID'), redirect_uri: REDIRECT, scope: 'transactions_r transactions_w listings_r shops_r', state, code_challenge: extra.challenge, code_challenge_method: 'S256' })}`,
    exchange: async (q, meta) => {
      const r = await call('https://api.etsy.com/v3/public/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: env('ETSY_CLIENT_ID'), redirect_uri: REDIRECT, code: q.get('code'), code_verifier: meta.verifier }) });
      if (!r.ok || !r.data?.refresh_token) return fail(r, 'Etsy');
      return { ok: true, meta: { user_id: String(r.data.access_token).split('.')[0] }, secrets: { refresh_token: r.data.refresh_token, access_token: r.data.access_token } };
    },
  },
  tiktok_shop: {
    needs: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SERVICE_ID'],
    authorize: (state) => `https://services.tiktokshop.com/open/authorize?${new URLSearchParams({ service_id: env('TIKTOK_SERVICE_ID'), state })}`,
    exchange: async (q) => {
      const r = await call(`https://auth.tiktok-shops.com/api/v2/token/get?${new URLSearchParams({ app_key: env('TIKTOK_APP_KEY'), app_secret: env('TIKTOK_APP_SECRET'), auth_code: q.get('code') ?? '', grant_type: 'authorized_code' })}`);
      const d = r.data?.data; if (!r.ok || !d?.access_token) return fail(r, 'TikTok Shop');
      return { ok: true, label: d.seller_name, meta: { seller_name: d.seller_name, open_id: d.open_id }, secrets: { access_token: d.access_token, refresh_token: d.refresh_token } };
    },
  },
};

async function save(org_id: string, category: string, provider: string, auth_type: string, v: V, secrets: C, created_by: string | null, label?: string) {
  const row = { org_id, category, provider, auth_type, label: label ?? v.label ?? null, status: v.ok ? 'connected' : 'error', verified: v.ok, error: v.ok ? null : v.error ?? 'failed', meta: v.meta ?? {}, connected_at: v.ok ? new Date().toISOString() : null, created_by };
  const { data: integ, error } = await admin.from('integrations').upsert(row, { onConflict: 'org_id,category,provider' }).select('*').single();
  if (error || !integ) return { error: error?.message ?? 'save failed' };
  if (v.ok) {
    await admin.from('integration_secrets').upsert({ integration_id: integ.id, secrets, updated_at: new Date().toISOString() });
    if (provider === 'shopify') { // keep the existing Shopify webhook/fulfillment functions working
      const shop = host(secrets.shop);
      await admin.from('orgs').update({ shopify_domain: shop }).eq('id', org_id);
      await admin.from('org_integrations').upsert({ org_id, shopify_access_token: secrets.access_token, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
    }
  }
  return { integration: integ };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const u = new URL(req.url);

  // ---- OAuth return leg (no user session: the provider redirects here) ----
  if (req.method === 'GET' && u.pathname.endsWith('/callback')) {
    const q = u.searchParams;
    const state = q.get('state') ?? '';
    const { data: st } = await admin.from('oauth_states').select('*').eq('state', state).maybeSingle();
    const back = (provider: string, ok: boolean, msg: string, org = '') => Response.redirect(`${DASH}?org=${org}#conn=${encodeURIComponent(`${provider}|${ok ? 'ok' : 'error'}|${msg}`)}`, 302);
    if (!st || Date.now() - new Date(st.created_at).getTime() > 30 * 60 * 1000) return back(q.get('provider') ?? 'unknown', false, 'This connect link expired — start again from the dashboard.');
    await admin.from('oauth_states').update({ meta: { ...st.meta, used_at: new Date().toISOString() } }).eq('state', state);
    const o = OAUTH[st.provider]; if (!o) return back(st.provider, false, 'Unknown provider', st.org_id);
    if (q.get('error')) return back(st.provider, false, q.get('error_description') ?? q.get('error')!, st.org_id);
    const v = await o.exchange(q, st.meta ?? {});
    const r = await save(st.org_id, st.category, st.provider, 'oauth', v, v.secrets ?? {}, st.created_by);
    return back(st.provider, v.ok && !r.error, r.error ?? v.error ?? 'Connected', st.org_id);
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ---- staff actions ----
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  // staff may act on any account; a client may act only on their own org
  const { data: { user: staff } } = await userClient.auth.getUser();
  if (!staff) return json({ error: 'not authorized' }, 403);
  const { data: isStaff } = await userClient.rpc('is_shipbay');
  let myOrg: string | null = null;
  if (!isStaff) { const { data: prof } = await userClient.from('profiles').select('org_id').eq('id', staff.id).maybeSingle(); myOrg = prof?.org_id ?? null; if (!myOrg) return json({ error: 'not authorized' }, 403); }
  const allowed = (org_id: string) => !!isStaff || org_id === myOrg;
  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const { action } = body;

  if (action === 'connect') {
    const { org_id, category, provider } = body; let creds: C = body.credentials ?? {};
    if (!org_id || !['shipping', 'commerce'].includes(category) || !provider) return json({ error: 'missing fields' }, 400);
    if (!allowed(org_id)) return json({ error: 'not authorized' }, 403);
    let v: V; let auth_type = 'api_key';
    if (MANUAL.has(provider)) { v = { ok: true, label: creds.account, meta: { account: creds.account, note: 'No public API — recorded manually' } }; auth_type = 'manual'; creds = {} as C; }
    else if (VERIFY[provider]) v = await VERIFY[provider](creds);
    else return json({ error: `${provider} connects through its own sign-in — use Connect.` }, 400);
    const r = await save(org_id, category, provider, auth_type, v, creds, staff?.id ?? null, body.label);
    if (r.error) return json({ error: r.error }, 500);
    return json({ ok: v.ok, error: v.error ?? null, integration: r.integration }, v.ok ? 200 : 422);
  }

  if (action === 'oauth_start') {
    const { org_id, category, provider } = body; const params: C = body.params ?? {};
    const o = OAUTH[provider]; if (!o) return json({ error: 'not an OAuth provider' }, 400);
    if (!org_id || !allowed(org_id)) return json({ error: 'not authorized' }, 403);
    const missing = o.needs.filter((k) => !env(k));
    if (missing.length) return json({ error: `ShipBay's ${provider} developer app isn't registered yet. Add ${missing.join(', ')} under Edge Functions → Secrets (redirect URL: ${REDIRECT}).`, needs: missing, redirect_uri: REDIRECT }, 412);
    if (provider === 'shopify' && !/\.myshopify\.com$/.test(host(params.shop))) return json({ error: 'Enter the store domain (brand.myshopify.com).' }, 400);
    const state = crypto.randomUUID().replace(/-/g, '');
    const extra: C = {}; const meta: C = { ...params };
    if (provider === 'etsy') { const p = await pkce(); extra.challenge = p.challenge; meta.verifier = p.verifier; }
    await admin.from('oauth_states').insert({ state, org_id, provider, category, meta, created_by: staff?.id ?? null });
    await admin.from('integrations').upsert({ org_id, category, provider, auth_type: 'oauth', status: 'pending', verified: false, error: null, label: params.shop ? host(params.shop) : null, created_by: staff?.id ?? null }, { onConflict: 'org_id,category,provider' });
    return json({ url: o.authorize(state, params, extra) });
  }

  if (action === 'test' || action === 'disconnect') {
    const { data: integ } = await admin.from('integrations').select('*').eq('id', body.integration_id).single();
    if (!integ) return json({ error: 'not found' }, 404);
    if (!allowed(integ.org_id)) return json({ error: 'not authorized' }, 403);
    if (action === 'disconnect') {
      await admin.from('integration_secrets').update({ secrets: {}, updated_at: new Date().toISOString() }).eq('integration_id', integ.id);
      await admin.from('integrations').update({ status: 'disconnected', verified: false, connected_at: null }).eq('id', integ.id);
      if (integ.provider === 'shopify') await admin.from('org_integrations').update({ shopify_access_token: null }).eq('org_id', integ.org_id);
      return json({ ok: true });
    }
    const { data: s } = await admin.from('integration_secrets').select('secrets').eq('integration_id', integ.id).maybeSingle();
    const fn = VERIFY[integ.provider];
    if (!fn || !s?.secrets) return json({ ok: integ.status === 'connected', note: 'No live check available for this provider.' });
    const v = await fn(s.secrets as C);
    await admin.from('integrations').update({ status: v.ok ? 'connected' : 'error', verified: v.ok, error: v.ok ? null : v.error, meta: { ...integ.meta, ...(v.meta ?? {}) } }).eq('id', integ.id);
    return json({ ok: v.ok, error: v.error ?? null });
  }

  return json({ error: 'unknown action' }, 400);
});
