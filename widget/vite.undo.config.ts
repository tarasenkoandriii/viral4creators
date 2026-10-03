import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис (д): «Вернуть как было» для полей — ленивый ES-модуль
// `dist/v1/undo.js` (бюджет — size-budget.mjs). Его берёт act.js
// `import(new URL('undo.js', import.meta.url))` — рядом, тот же выпуск
// канарейки; только после «Вернуть»/«отмени последнее» посетителя.
// Исполняется в origin заказчика: правила загрузчика (без HTML-приёмников).
// es2020 — как check.js (ES-модуль, динамический импорт).
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
      entry: 'src/undo/index.ts',
      formats: ['es'],
      fileName: () => 'undo.js',
    },
  },
});
