import { defineConfig } from 'vite';

// Э6: «показать на экране» — ленивый ES-модуль `dist/v1/highlight.js`
// (бюджет — size-budget.mjs). Загрузчик берёт его `import()` только по
// клику посетителя на «Показать на странице»: бюджет загрузчика 12 КБ
// (§4.12) не поднимается. ES-модуль, а не IIFE со вставкой <script>:
// динамический импорт работает под `require-trusted-types-for 'script'`.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/highlight/index.ts',
      formats: ['es'],
      fileName: () => 'highlight.js',
    },
  },
});
