import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис (б): голосовое управление «Админкой» — ленивый ES-модуль
// `dist/v1/admin-act.js` на странице админки заказчика (снимок с фильтром
// строк таблиц, исполнитель, регистратор мастера; бюджет — size-budget.mjs).
// admin.js берёт его `import()` только по команде своего iframe `wa.`.
// Как act.js: ES-модуль (динамический импорт работает под
// `require-trusted-types-for 'script'`), сжатие esbuild'ом на выходе,
// es2020 — для `import.meta.url` (рядом лежащие check.js и undo.js).
export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: 'v4c-minify-es-chunk',
      enforce: 'post',
      async generateBundle(_opts, bundle) {
        for (const f of Object.values(bundle)) {
          if (f.type !== 'chunk') continue;
          f.code = (
            await transform(f.code, {
              minify: true,
              format: 'esm',
              target: 'es2020',
            })
          ).code;
        }
      },
    },
  ],
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
