import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 0.0.0.0 so the dev server is reachable from outside a Docker
    // container (Vite's default host, 127.0.0.1, is unreachable through a
    // published container port). Harmless for native (non-Docker) dev too.
    host: '0.0.0.0',
    // Some Docker Desktop setups (macOS/Windows bind-mounts) don't deliver
    // native filesystem-change events into the container, so HMR silently
    // stops picking up edits. Toggle with VITE_USE_POLLING=true in that
    // case (set automatically for the docker-compose service); leave unset
    // for native dev, where polling only adds needless CPU usage.
    watch: {
      usePolling: process.env.VITE_USE_POLLING === 'true',
    },
    proxy: {
      // Currently unused — the API client (services/api.ts) calls
      // VITE_API_BASE_URL directly rather than relative '/api' paths — but
      // harmless to keep for anything that does hit a relative path.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
