import { defineConfig } from 'vite';

// Э3-бис: поведенческие факторы — ленивый ES-модуль `dist/v1/bf.js`
// (≤ 4 КБ gzip, §5-тер.8). Его грузит ana.js ТОЛЬКО при согласии посетителя
// и включённом у сайта поведении; без согласия кода сбора на странице нет.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/bf/index.ts',
      formats: ['es'],
      fileName: () => 'bf.js',
    },
  },
});
