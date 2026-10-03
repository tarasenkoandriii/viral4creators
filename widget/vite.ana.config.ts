import { defineConfig } from 'vite';

// Э3-бис: связанный режим по согласию посетителя — ленивый ES-модуль
// `dist/v1/ana.js` (бюджет — size-budget.mjs). Его грузит чанк engage.js,
// только если в конфиге сайта есть поле `analytics` (владелец включил
// связанный режим); загрузчик 12 КБ (§4.12) не растёт.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/ana/index.ts',
      formats: ['es'],
      fileName: () => 'ana.js',
    },
  },
});
