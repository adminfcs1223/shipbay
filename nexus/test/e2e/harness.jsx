// The real Nexus screens with a synthetic signed login (no GoTrue locally): the sign-in shell is skipped, nothing else.
import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/archivo/400.css'; import '@fontsource/archivo/600.css'; import '@fontsource/archivo/800.css';
import '../../src/nexus.css'; import Nexus from '../../src/Nexus.jsx';
createRoot(document.getElementById('root')).render(<StrictMode><Nexus me={JSON.parse(import.meta.env.VITE_ME)} /></StrictMode>);
