// Shipping-label services and commerce channels a client can connect during Systems onboarding.
// auth: 'api_key' → staff pastes the client's credentials, the edge function verifies them live and stores them server-side.
//       'oauth'   → the client signs in on the provider's site; needs ShipBay's developer app registered with that provider
//                   (env secrets listed in `needs`) before Connect can work.
//       'manual'  → no public API: we record the account (never a password) and mark it connected.
const f = (key, label, extra = {}) => ({ key, label, ...extra });
const SECRET = { secret: true };

export const SHIPPING = [
  { id: 'shipstation', name: 'ShipStation', auth: 'api_key', fields: [f('api_key', 'API key'), f('api_secret', 'API secret', SECRET)], help: 'ShipStation → Account → API Settings.' },
  { id: 'shipengine', name: 'ShipEngine', auth: 'api_key', fields: [f('api_key', 'API key', SECRET)], help: 'ShipEngine dashboard → API Management.' },
  { id: 'shippo', name: 'Shippo', auth: 'api_key', fields: [f('api_key', 'Live API token', SECRET)], help: 'Shippo → Settings → API → Live token.' },
  { id: 'easypost', name: 'EasyPost', auth: 'api_key', fields: [f('api_key', 'Production API key', SECRET)], help: 'EasyPost → Account Settings → API Keys.' },
  { id: 'pitney_bowes', name: 'Pitney Bowes', auth: 'api_key', fields: [f('api_key', 'API key'), f('api_secret', 'API secret', SECRET), f('developer_id', 'Developer ID')], help: 'PB Shipping APIs developer hub.' },
  { id: 'sendle', name: 'Sendle', auth: 'api_key', fields: [f('sendle_id', 'Sendle ID'), f('api_key', 'API key', SECRET)], help: 'Sendle dashboard → Settings → Integrations.' },
  { id: 'easyship', name: 'Easyship', auth: 'api_key', fields: [f('api_key', 'Access token', SECRET)], help: 'Easyship → Connect → API Integration.' },
  { id: 'veeqo', name: 'Veeqo', auth: 'api_key', fields: [f('api_key', 'API key', SECRET)], help: 'Veeqo → Settings → Users → API key.' },
  { id: 'ups', name: 'UPS', auth: 'api_key', fields: [f('client_id', 'Client ID'), f('client_secret', 'Client secret', SECRET), f('account_number', 'UPS account number')], help: 'developer.ups.com → My Apps (client’s own app, production).' },
  { id: 'fedex', name: 'FedEx', auth: 'api_key', fields: [f('client_id', 'API key'), f('client_secret', 'Secret key', SECRET), f('account_number', 'FedEx account number')], help: 'developer.fedex.com → My Projects (production keys).' },
  { id: 'usps', name: 'USPS', auth: 'api_key', fields: [f('client_id', 'Consumer key'), f('client_secret', 'Consumer secret', SECRET), f('crid', 'CRID', { optional: true })], help: 'developers.usps.com → Apps.' },
  { id: 'dhl_express', name: 'DHL Express', auth: 'api_key', fields: [f('api_key', 'API key'), f('api_secret', 'API secret', SECRET), f('account_number', 'DHL account number')], help: 'developer.dhl.com → MyDHL API app.' },
  { id: 'stamps', name: 'Stamps.com', auth: 'manual', fields: [f('account', 'Account username')], help: 'No self-serve public API — we record the account and set up labels from it.' },
  { id: 'pirate_ship', name: 'Pirate Ship', auth: 'manual', fields: [f('account', 'Account email')], help: 'No public API — we record the account and print from it.' },
];

export const COMMERCE = [
  { id: 'shopify', name: 'Shopify', auth: 'oauth', altAuth: 'api_key', needs: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
    oauthFields: [f('shop', 'Store domain', { placeholder: 'brand.myshopify.com' })],
    fields: [f('shop', 'Store domain', { placeholder: 'brand.myshopify.com' }), f('access_token', 'Admin API access token', { ...SECRET, placeholder: 'shpat_…' })],
    help: 'Connect lets the client approve ShipBay in their Shopify admin. Or paste a custom-app Admin API token (Settings → Apps → Develop apps).' },
  { id: 'woocommerce', name: 'WooCommerce', auth: 'api_key', fields: [f('store_url', 'Store URL', { placeholder: 'https://brand.com' }), f('consumer_key', 'Consumer key'), f('consumer_secret', 'Consumer secret', SECRET)], help: 'WooCommerce → Settings → Advanced → REST API (Read/Write).' },
  { id: 'bigcommerce', name: 'BigCommerce', auth: 'api_key', fields: [f('store_hash', 'Store hash'), f('access_token', 'API access token', SECRET)], help: 'Settings → Store-level API accounts.' },
  { id: 'amazon', name: 'Amazon Seller Central', auth: 'oauth', needs: ['AMAZON_SP_APP_ID', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET'], help: 'Client authorizes ShipBay’s SP-API app in Seller Central.' },
  { id: 'walmart', name: 'Walmart Marketplace', auth: 'api_key', fields: [f('client_id', 'Client ID'), f('client_secret', 'Client secret', SECRET)], help: 'Seller Center → Developer Portal → API keys (Production).' },
  { id: 'ebay', name: 'eBay', auth: 'oauth', needs: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'], help: 'Client signs in to eBay and grants ShipBay order + fulfillment access.' },
  { id: 'etsy', name: 'Etsy', auth: 'oauth', needs: ['ETSY_CLIENT_ID'], help: 'Client signs in to Etsy and grants ShipBay shop access.' },
  { id: 'tiktok_shop', name: 'TikTok Shop', auth: 'oauth', needs: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SERVICE_ID'], help: 'Client authorizes ShipBay’s TikTok Shop partner app.' },
  { id: 'squarespace', name: 'Squarespace', auth: 'api_key', fields: [f('api_key', 'API key', SECRET)], help: 'Settings → Advanced → Developer API Keys (Orders + Inventory).' },
  { id: 'wix', name: 'Wix', auth: 'api_key', fields: [f('api_key', 'API key', SECRET), f('site_id', 'Site ID')], help: 'Wix account → API Keys (Wix Stores permissions) + Site ID from the dashboard URL.' },
  { id: 'square', name: 'Square Online', auth: 'api_key', fields: [f('access_token', 'Access token', SECRET)], help: 'developer.squareup.com → application → Production access token.' },
  { id: 'faire', name: 'Faire', auth: 'api_key', fields: [f('access_token', 'Brand API token', SECRET)], help: 'Faire brand portal → Integrations → API.' },
  { id: 'magento', name: 'Magento / Adobe Commerce', auth: 'api_key', fields: [f('store_url', 'Store URL', { placeholder: 'https://brand.com' }), f('access_token', 'Integration access token', SECRET)], help: 'System → Integrations → Access token.' },
  { id: 'ecwid', name: 'Ecwid', auth: 'api_key', fields: [f('store_id', 'Store ID'), f('access_token', 'Secret token', SECRET)], help: 'Ecwid → Apps → My apps → Access tokens.' },
  { id: 'prestashop', name: 'PrestaShop', auth: 'api_key', fields: [f('store_url', 'Store URL', { placeholder: 'https://brand.com' }), f('api_key', 'Webservice key', SECRET)], help: 'Advanced Parameters → Webservice.' },
  { id: 'webflow', name: 'Webflow', auth: 'api_key', fields: [f('access_token', 'Site API token', SECRET)], help: 'Site settings → Apps & integrations → API access.' },
  { id: 'wayfair', name: 'Wayfair', auth: 'api_key', fields: [f('client_id', 'Client ID'), f('client_secret', 'Client secret', SECRET)], help: 'Wayfair Partner Home → Developer → Application.' },
];

export const CATEGORY = {
  label_access: { key: 'shipping', title: 'Shipping label service', list: SHIPPING },
  shopify_connected: { key: 'commerce', title: 'Commerce channel', list: COMMERCE },
};
export const providerName = (id) => [...SHIPPING, ...COMMERCE].find((p) => p.id === id)?.name || id;
