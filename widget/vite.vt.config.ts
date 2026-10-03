import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис (г): мастер проверки голосового управления — ленивый ES-модуль
// iframe-чата `dist/v1/vt.js` (контроллер мастера и его тексты uk/ru/en;
// бюджет — size-budget.mjs). Чат берёт его `import()` только в тестовой
// сессии владельца — chat.js посетителей не растёт. ES-модуль, как голос:
// динамический импорт работает под `require-trusted-types-for 'script'`.
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
      entry: 'src/vt/index.ts',
      formats: ['es'],
      fileName: () => 'vt.js',
    },
  },
});
