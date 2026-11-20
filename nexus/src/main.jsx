import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
import '@fontsource/archivo/400.css'; import '@fontsource/archivo/600.css'; import '@fontsource/archivo/800.css';
import './nexus.css'; import App from './App.jsx';
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
