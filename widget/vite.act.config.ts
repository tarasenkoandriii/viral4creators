import { defineConfig } from 'vite';
import { minifyChunk } from './vite.mangle';

// Э6-бис: голосовое управление — ленивый ES-модуль `dist/v1/act.js` (снимок
// страницы и исполнитель шагов; бюджет — size-budget.mjs). Загрузчик берёт
// его `import()` только по команде своего iframe (после речи или набора
// посетителя): бюджет загрузчика 12 КБ (§4.12) не поднимается. ES-модуль, а
// не IIFE со вставкой <script>: динамический импорт работает под
// `require-trusted-types-for 'script'`.
//
// Библиотечный ES-формат Vite не сжимает пробелы и имена сам; чанк
// исполняется на чужой странице и считается в gzip-бюджете — сжимаем
// esbuild'ом на выходе (экспорт `start` при этом сохраняется), с
// `mangleProps` для имён `_x` внутри чанка (vite.mangle.ts).
// (д) es2020: чанку нужен `import.meta.url` — путь своего выпуска для
// ленивого `undo.js` (рядом, тот же выпуск канарейки).
// `charset: 'utf8'`: кириллица подписей — байтами UTF-8, а не `\uXXXX`
// (втрое короче). Безопасно ТОЛЬКО для ES-модуля: `import()` всегда
// декодирует модуль как UTF-8, независимо от кодировки страницы заказчика
// (классический загрузчик так не сжимаем — страница в windows-1251).
export default defineConfig({
  publicDir: false,
  plugins: [minifyChunk({ format: 'esm', target: 'es2020', charset: 'utf8' })],
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    lib: {
      entry: 'src/act/index.ts',
      formats: ['es'],
      fileName: () => 'act.js',
    },
  },
});
