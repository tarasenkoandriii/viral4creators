import { defineConfig } from 'vite';

// Э6-тер: панель редактора голосовой карты в iframe на отдельном origin
// `we.` — `dist/v1/editor-panel.js` + `dist/v1/editor-panel.css`. Пути
// стабильные — их называет HTML iframe (`GET /we/v1/frame`,
// sites-backend assist-site-voice-map/editor/editor-frame.ts). Ванильный TS.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2019',
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
