// The real WMS Put-away screen on its own. The Supabase client is created (the shared scanner parts pull it in) with a stub key and a
// 127.0.0.1 address and is never used; the "signed-in user" is a fixed test token.
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/archivo/400.css'; import '@fontsource/archivo/600.css'; import '@fontsource/archivo/700.css'; import '@fontsource/archivo/800.css';
import '../../src/wms.css'; import PutAway from '../../src/PutAway.jsx'; import { useBridgeToken } from '../../src/nexusBridge.js';
useBridgeToken(async () => 'TEST-USER-TOKEN');
createRoot(document.getElementById('root')).render(<StrictMode><div style={{ padding: '28px 36px', maxWidth: 1240, margin: '0 auto' }}><PutAway /></div></StrictMode>);
