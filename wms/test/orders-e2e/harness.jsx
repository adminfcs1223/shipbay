// The real WMS Orders screen (wave pick -> pack), signed in as the synthetic floor login.
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '../../src/wms.css'; import Orders from '../../src/Orders.jsx';
createRoot(document.getElementById('root')).render(<StrictMode><Orders me={JSON.parse(import.meta.env.VITE_ME)} startBrand={null} clearStart={() => {}} /></StrictMode>);
