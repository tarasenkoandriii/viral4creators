import { defineConfig } from 'vite';

// Э3: режим выбора цели (§5-тер.1) — отдельный IIFE `dist/v1/picker.js`,
// грузится загрузчиком только при `?v4c_goal=` (бюджет — size-budget.mjs).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/v1',
    emptyOutDir: false,
    target: 'es2019',
    sourcemap: false,
    lib: {
      entry: 'src/picker/index.ts',
      formats: ['iife'],
      name: 'v4cWidgetPicker',
      fileName: () => 'picker.js',
    },
  },
});
