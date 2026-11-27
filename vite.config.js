import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      // The manifest <link> (index.html), the apple-touch icon and the
      // service worker all use plain relative /api URLs, so in dev the
      // browser asks Vite, not PocketBase — and Vite answers with the SPA
      // fallback index.html, which the manifest parser rejects
      // ("Line: 1, column: 1, Syntax error"). The app's own API calls
      // never needed this: they use pbUrl (src/api/pocketbase.js) and go
      // straight to the backend. The manifest is the first relative /api
      // URL, so it is the first to hit the gap. Dev-only: the production
      // build never reads this.
      '/api': process.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090',
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ui: ['react-bootstrap', 'bootstrap'],
          icons: ['lucide-react'],
        }
      }
    }
  }
})
