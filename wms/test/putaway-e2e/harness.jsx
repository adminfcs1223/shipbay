// The real WMS Put-away screen (or, with ?screen=map, the Warehouse Map) on its own. The Supabase client points at 127.0.0.1
// with a stub key; the "signed-in user" is a fixed test token.
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/archivo/400.css'; import '@fontsource/archivo/600.css'; import '@fontsource/archivo/700.css'; import '@fontsource/archivo/800.css';
import '../../src/wms.css'; import PutAway from '../../src/PutAway.jsx'; import WarehouseMap from '../../src/WarehouseMap.jsx'; import { useBridgeToken } from '../../src/nexusBridge.js';
useBridgeToken(async () => 'TEST-USER-TOKEN');
const Screen = new URLSearchParams(location.search).get('screen') === 'map' ? WarehouseMap : PutAway;
createRoot(document.getElementById('root')).render(<StrictMode><div style={{ padding: '28px 36px', maxWidth: 1320, margin: '0 auto' }}><Screen go={(k) => { window.__went = k; }} /></div></StrictMode>);
