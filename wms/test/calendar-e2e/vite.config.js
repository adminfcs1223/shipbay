// Shared-calendar browser test: builds only the Calendar screen with the demonstration data. No backend at all; reads no .env file.
import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; import path from 'node:path';
export default defineConfig(() => {
  if (process.env.VITE_NEXUS_CALENDAR !== 'demo') throw new Error('REFUSED: this harness only builds the demonstration calendar');
  return { root: __dirname, envDir: path.resolve(__dirname, 'empty-env'), resolve: { dedupe: ['react', 'react-dom'] }, plugins: [react()],
    build: { outDir: process.env.OUT, emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'calendar.html') } } };
});
