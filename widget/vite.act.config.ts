import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис: голосовое управление — ленивый ES-модуль `dist/v1/act.js` (снимок
// страницы и исполнитель шагов; бюджет — size-budget.mjs). Загрузчик берёт
// его `import()` только по команде своего iframe (после речи или набора
// посетителя): бюджет загрузчика 12 КБ (§4.12) не поднимается. ES-модуль, а
// не IIFE со вставкой <script>: динамический импорт работает под
// `require-trusted-types-for 'script'`.
//
// Библиотечный ES-формат Vite не сжимает пробелы и имена сам; чанк
// исполняется на чужой странице и считается в gzip-бюджете — сжимаем
// esbuild'ом на выходе (экспорт `start` при этом сохраняется).
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
              target: 'es2019',
            })
          ).code;
        }
      },
    },
  ],
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/act/index.ts',
      formats: ['es'],
      fileName: () => 'act.js',
    },
  },
});
