import { defineConfig } from 'vite';
import { minifyChunk } from './vite.mangle';

// Э6-бис (б): голосовое управление «Админкой» — ленивый ES-модуль
// `dist/v1/admin-act.js` на странице админки заказчика (снимок с фильтром
// строк таблиц, исполнитель, регистратор мастера; бюджет — size-budget.mjs).
// admin.js берёт его `import()` только по команде своего iframe `wa.`.
// Как act.js: ES-модуль (динамический импорт работает под
// `require-trusted-types-for 'script'`), сжатие esbuild'ом на выходе,
// es2020 — для `import.meta.url` (рядом лежащие check.js и undo.js).
export default defineConfig({
  publicDir: false,
  plugins: [minifyChunk({ format: 'esm', target: 'es2020' })],
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    lib: {
      entry: 'src/admin-act/index.ts',
      formats: ['es'],
      fileName: () => 'admin-act.js',
    },
  },
});
