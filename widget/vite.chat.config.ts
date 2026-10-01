import { defineConfig } from 'vite';

// Чат в iframe: `dist/v1/chat.js` + `dist/v1/chat.css` (≤ 60 КБ gzip вместе,
// §4.12). Пути стабильные — их называет HTML iframe, который отдаёт
// sites-backend (`GET /w/v1/frame`, assist-widget/frame-html.ts); кэш —
// короткий (vercel.json). Preact без плагина — JSX через esbuild.
export default defineConfig({
  publicDir: 'public',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/chat/main.tsx',
      formats: ['iife'],
      name: 'v4cWidgetChat',
      fileName: () => 'v1/chat.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (a) =>
          a.name && a.name.endsWith('.css')
            ? 'v1/chat.css'
            : 'v1/assets/[name]-[hash][extname]',
      },
    },
  },
});
