import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// The core (apps/core) listens on config/arianna.toml [server]; in development
// Vite serves the page and forwards /api, WebSocket included. The core accepts
// only its own origin (D-039), so the proxy presents the requests as its own.
const CORE = process.env.ARIANNA_CORE_URL ?? 'http://127.0.0.1:7420';
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://${DEV_HOST}:${String(DEV_PORT)}`;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: CORE,
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          // Only the dev page itself is presented as the core's origin. Any other
          // Origin passes through unchanged and the core refuses it: otherwise any
          // site open in the browser could read the socket through this proxy.
          proxy.on('proxyReq', (request) => {
            if (request.getHeader('origin') === DEV_ORIGIN) request.setHeader('origin', CORE);
          });
          proxy.on('proxyReqWs', (request) => {
            if (request.getHeader('origin') === DEV_ORIGIN) request.setHeader('origin', CORE);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No inline scripts or styles: the core's Content-Security-Policy allows 'self' only.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
