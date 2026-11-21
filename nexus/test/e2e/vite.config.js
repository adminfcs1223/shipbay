// Nexus e2e: builds the harness against the local gateway only. Refuses any other backend; reads no .env file.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig(() => {
  if (process.env.VITE_SUPABASE_URL !== 'http://127.0.0.1:54331') throw new Error('REFUSED: backend must be http://127.0.0.1:54331');
  return { root: __dirname, envDir: path.resolve(__dirname, 'empty-env'), publicDir: path.resolve(__dirname, '../../public'), resolve: { dedupe: ['react', 'react-dom', '@supabase/supabase-js'] }, plugins: [react()],
    define: { __SHIPBAY_BUILD__: '"nexus-e2e"' }, build: { outDir: process.env.OUT, emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'index.html') } } };
});
