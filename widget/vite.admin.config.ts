import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э7: «Админка» — ленивый ES-модуль `dist/v1/admin.js` на странице админки
// заказчика (кнопка, iframe `wa.`, JWT сотрудника). Загрузчик с
// `data-mode="admin"` отдаёт ему управление `import()` — бюджет загрузчика
// 12 КБ (§4.12) не поднимается. ES-модуль — динамический импорт работает
// под `require-trusted-types-for 'script'`. Сжатие — esbuild на выходе.
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
      entry: 'src/admin/index.ts',
      formats: ['es'],
      fileName: () => 'admin.js',
    },
  },
});
