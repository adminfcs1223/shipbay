// Put-away browser test: builds only the Put-away screen, pointed at a stand-in bridge on 127.0.0.1. Reads no .env file.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig(() => {
  if (process.env.VITE_NEXUS_BRIDGE !== 'on' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.VITE_SUPABASE_URL || '')) throw new Error('REFUSED: this harness only builds against a stand-in bridge on 127.0.0.1');
  return { root: __dirname, envDir: path.resolve(__dirname, 'empty-env'), resolve: { dedupe: ['react', 'react-dom'] }, plugins: [react()],
    build: { outDir: process.env.OUT, emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'putaway.html') } } };
});
