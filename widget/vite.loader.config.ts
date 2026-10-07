import { defineConfig } from 'vite';
import { minifyChunk } from './vite.mangle';

// Загрузчик: ОДИН файл IIFE `dist/v1/loader.js` (≤ 12 КБ gzip, §4.12) —
// без чанков и динамических импортов (на чужой странице только один тег),
// без CSS-файла (стили — adoptedStyleSheets в Shadow DOM).
// Поверх минификации Vite — ещё проход esbuild с `mangleProps` для закрытых
// имён `_x` классов загрузчика (vite.mangle.ts); кодировка по умолчанию —
// ASCII (`\uXXXX`): классический скрипт, страница бывает в windows-1251.
export default defineConfig({
  publicDir: false,
  plugins: [minifyChunk({ target: 'es2019' })],
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
