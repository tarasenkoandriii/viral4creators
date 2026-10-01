import { defineConfig } from 'vite';

// Дев-стенд: dev/*.html — «сайт заказчика» с тегом загрузчика. Зеркало
// rewrite из vercel.json: `/widget/v1/*` и `/w/v1/*` → sites-backend
// (localhost:3010), чтобы iframe и API были одним origin, как в проде.
export default defineConfig({
  root: '.',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: {
    port: 5176,
    host: '0.0.0.0',
    proxy: {
      '/widget/v1': { target: 'http://localhost:3010', changeOrigin: false },
      '/w/v1': { target: 'http://localhost:3010', changeOrigin: false },
    },
  },
});
