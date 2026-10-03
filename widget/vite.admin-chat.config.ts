import { defineConfig } from 'vite';

// Э7: чат сотрудника в iframe на отдельном origin `wa.` — `dist/v1/admin-chat.js`
// + `dist/v1/admin-chat.css`. Пути стабильные — их называет HTML iframe,
// который отдаёт sites-backend (`GET /wa/v1/frame`, assist-admin-chat/
// admin-frame.ts). Ванильный TS без фреймворка (бюджет — size-budget.mjs).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/admin-chat/main.ts',
      formats: ['iife'],
      name: 'v4cAdminChat',
      fileName: () => 'v1/admin-chat.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (a) =>
          a.name && a.name.endsWith('.css')
            ? 'v1/admin-chat.css'
            : 'v1/assets/[name]-[hash][extname]',
      },
    },
  },
});
