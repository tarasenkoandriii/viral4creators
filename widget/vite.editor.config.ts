import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-тер: пикер редактора голосовой карты — ленивый ES-модуль
// `dist/v1/editor.js` (наведение, дескриптор, покрытие, снимок для
// «Сказать сейчас»; бюджет — size-budget.mjs, ≤ 40 КБ по ТЗ §5-кватер.3).
// Загрузчик берёт его `import()` только по одноразовой ссылке владельца
// `?v4c_edit=` — у посетителей его нет; act.js (9 КБ) не растёт: код снимка
// входит в этот чанк отдельной копией. ES-модуль — динамический импорт
// работает под `require-trusted-types-for 'script'`; сжатие — esbuild на
// выходе (как check.js).
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
      entry: 'src/editor/index.ts',
      formats: ['es'],
      fileName: () => 'editor.js',
    },
  },
});
