import { defineConfig } from 'vite';

// Загрузчик: ОДИН файл IIFE `dist/v1/loader.js` (≤ 12 КБ gzip, §4.12) —
// без чанков и динамических импортов (на чужой странице только один тег),
// без CSS-файла (стили — adoptedStyleSheets в Shadow DOM).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: true,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/loader/index.ts',
      formats: ['iife'],
      name: 'v4cWidgetLoader',
      fileName: () => 'loader.js',
    },
  },
});
