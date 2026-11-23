// Corrections e2e: builds the WHOLE WMS app (the Pallets screen switched on for this build only) against the local gateway.
// Refuses any other backend; reads no .env file. Never used for a deployed build.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig(() => {
  if (process.env.VITE_SUPABASE_URL !== 'http://127.0.0.1:54331' || process.env.VITE_PALLET_SCREEN !== '1') throw new Error('REFUSED: backend must be http://127.0.0.1:54331, with VITE_PALLET_SCREEN=1');
  return { root: __dirname, envDir: path.resolve(__dirname, 'empty-env'), resolve: { dedupe: ['react', 'react-dom', '@supabase/supabase-js'] }, plugins: [react()], define: { __SHIPBAY_BUILD__: '"corrections-e2e"' },
    build: { outDir: process.env.OUT, emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'app.html') } } };
});
