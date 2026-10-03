import { defineConfig } from 'vite';

// Э5: голос — ленивый ES-модуль `dist/v1/voice.js` (бюджет — size-budget.mjs).
// Его грузит iframe-чат `import()` со своего origin, когда голос включён в
// конфиге сайта: ни загрузчик (12 КБ, §4.12), ни chat.js не растут на
// запись, детектор речи и плеер. ES-модуль, а не IIFE со вставкой <script>:
// динамический импорт работает под `require-trusted-types-for 'script'`.
// Э6-бис (Т-1, §5-бис.12 способ 2): `V4C_TEST_AUDIO=1` — тестовая сборка с
// хуком WebAudio в `dist-test/v1/voice.js` (только для e2e стенда). Боевая
// сборка — без хука: `__V4C_TEST_AUDIO__` = false, код вырезается.
const TEST_AUDIO = process.env.V4C_TEST_AUDIO === '1';

export default defineConfig({
  publicDir: false,
  define: { __V4C_TEST_AUDIO__: JSON.stringify(TEST_AUDIO) },
  build: {
    outDir: TEST_AUDIO ? 'dist-test/v1' : 'dist/v1',
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
