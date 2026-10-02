import { defineConfig } from 'vite';

// Э5: голос — ленивый ES-модуль `dist/v1/voice.js` (бюджет — size-budget.mjs).
// Его грузит iframe-чат `import()` со своего origin, когда голос включён в
// конфиге сайта: ни загрузчик (12 КБ, §4.12), ни chat.js не растут на
// запись, детектор речи и плеер. ES-модуль, а не IIFE со вставкой <script>:
// динамический импорт работает под `require-trusted-types-for 'script'`.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/voice/index.ts',
      formats: ['es'],
      fileName: () => 'voice.js',
    },
  },
});
