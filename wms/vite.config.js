import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Every build carries an id (the commit on Netlify). It is baked into the app and written to /version.json, so an open
// tab can tell that a newer build is live and reload itself (src/VersionWatch.jsx).
const build = process.env.COMMIT_REF || `local-${Date.now()}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'shipbay-version',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build }) }) },
  }],
  define: { __SHIPBAY_BUILD__: JSON.stringify(build) },
})
