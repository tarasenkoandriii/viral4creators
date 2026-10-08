import { defineConfig } from 'vite';

// Э6-тер: панель редактора голосовой карты в iframe на отдельном origin
// `we.` — `dist/v1/editor-panel.js` + `dist/v1/editor-panel.css`. Пути
// стабильные — их называет HTML iframe (`GET /we/v1/frame`,
// sites-backend assist-site-voice-map/editor/editor-frame.ts). Ванильный TS.
// Заход 9: цель сборки — es2020 (как act.js): панель открывает владелец в
// своём браузере, а `?.`/`??` без перевода в es2019 — ≈ 0,5 КБ gzip запаса
// бюджета 16 КБ.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/editor-panel/main.ts',
      formats: ['iife'],
      name: 'v4cEditorPanel',
      fileName: () => 'v1/editor-panel.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (a) =>
          a.name && a.name.endsWith('.css')
            ? 'v1/editor-panel.css'
            : 'v1/assets/[name]-[hash][extname]',
      },
    },
  },
});
