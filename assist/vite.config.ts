import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Общий код site-tma-kit приходит копией в src/kit (см.
// scripts/sync-site-tma-kit.mjs) — поэтому ни alias, ни выхода за root
// здесь нет: Vercel с root = assist собирает только эту папку.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: '0.0.0.0',
    // Дев-зеркало rewrite из vercel.json: `/api/*` → sites-backend, чтобы
    // и на стенде API был same-origin (как в проде), без CORS и cookie
    // третьей стороны.
    proxy: {
      '/api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
