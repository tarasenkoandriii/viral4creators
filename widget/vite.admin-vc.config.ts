import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Э6-бис (б): голосовое управление «Админкой» — сторона iframe `wa.`,
// ленивый ES-модуль `dist/v1/admin-vc.js` (контроллер плана «Сайта» с
// адаптером маршрутов `/assist-admin/v1/*`, микрофон, карточка с перечнем
// полей, мастер проверки; бюджет — size-budget.mjs). admin-chat.js берёт его
// `import()` только когда режим включён или открыта ссылка мастера — чат
// сотрудника без режима не растёт. Сжатие esbuild'ом на выходе, как у act.js.
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
      entry: 'src/admin-vc/index.ts',
      formats: ['es'],
      fileName: () => 'admin-vc.js',
    },
  },
});
