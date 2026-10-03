import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис (г): мастер проверки голосового управления — ленивый ES-модуль
// `dist/v1/check.js` (окружение, разметка, два списка опасного; бюджет —
// size-budget.mjs). Загрузчик берёт его `import()` только по команде своего
// iframe в тестовой сессии владельца: ни загрузчик (12 КБ), ни act.js (9 КБ)
// не растут. ES-модуль — динамический импорт работает под
// `require-trusted-types-for 'script'`.
//
// es2020 (а не es2019, как act.js): чанку нужен `import.meta.url` — путь
// своего выпуска (act.js рядом); динамический `import()` — тоже ES2020,
// так что браузеры, где чанк вообще грузится, его понимают.
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
      entry: 'src/check/index.ts',
      formats: ['es'],
      fileName: () => 'check.js',
    },
  },
});
