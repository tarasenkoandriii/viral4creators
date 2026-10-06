import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-тер (и): компенсация объявленной пары («убрать из корзины» строки того
// же товара) — ленивый ES-модуль `dist/v1/comp.js` (бюджет — size-budget.mjs).
// Его берёт undo.js `import(new URL('comp.js', import.meta.url))` — рядом,
// тот же выпуск канарейки; только после «Вернуть»/«отмени последнее»
// посетителя и отметки `dispatched` на сервере. Исполняется в origin
// заказчика: правила загрузчика (без HTML-приёмников). es2020 — как undo.js.
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
      entry: 'src/undo/compensate.ts',
      formats: ['es'],
      fileName: () => 'comp.js',
    },
  },
});
