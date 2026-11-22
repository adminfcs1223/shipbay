// The real WMS Calendar screen on its own, with the demonstration data source. It never imports the Supabase client.
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/archivo/400.css'; import '@fontsource/archivo/600.css'; import '@fontsource/archivo/700.css'; import '@fontsource/archivo/800.css';
import '../../src/wms.css'; import SharedCalendar from '../../src/SharedCalendar.jsx';
createRoot(document.getElementById('root')).render(<StrictMode><div style={{ padding: '28px 36px', maxWidth: 1240, margin: '0 auto' }}><SharedCalendar go={(k) => { document.body.dataset.went = k; }} /></div></StrictMode>);
