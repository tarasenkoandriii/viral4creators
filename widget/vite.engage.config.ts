import { defineConfig } from 'vite';

// Э3 (интеграция): вовлечение и цели — ленивый ES-модуль `dist/v1/engage.js`
// (бюджет — size-budget.mjs). Загрузчик берёт его `import()` после `load` +
// простоя или при первом взаимодействии и только при целях/триггерах в
// конфиге: бюджет загрузчика 12 КБ (§4.12) не поднимается. ES-модуль, а не
// IIFE со вставкой <script>: динамический импорт работает под
// `require-trusted-types-for 'script'` без политики.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/engage/index.ts',
      formats: ['es'],
      fileName: () => 'engage.js',
    },
  },
});
