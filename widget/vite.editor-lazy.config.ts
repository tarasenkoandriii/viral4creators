import { transform } from 'esbuild';
import { defineConfig } from 'vite';

// Заход 10 — ленивые ES-модули панели редактора (iframe `we.`, свой origin;
// CSP `script-src 'self'`, `import()` — не приёмник Trusted Types):
//  - `editor-panel-ru.js`, `editor-panel-en.js` — словари панели (разгрузка
//    бюджета `editor-panel`: в самом чанке панели — только `uk`);
//  - `editor-assist.js` — №113: «Промахи», «Пропозиції», ИИ-синонимы
//    (`src/editor-panel/assist.ts`), только по вкладке или кнопке.
// Каждый вход самодостаточен (только `import type`), общих чанков нет.
// Сжатие esbuild'ом на выходе (библиотечный ES-формат Vite не сжимает),
// `charset: 'utf8'` — ES-модуль всегда декодируется как UTF-8; без
// `mangleProps` (имён `_x` здесь нет; сжатие имён — loader/act/admin-act).
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
              charset: 'utf8',
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
      entry: {
        'editor-panel-ru': 'src/editor-panel/lang-ru.ts',
        'editor-panel-en': 'src/editor-panel/lang-en.ts',
        'editor-assist': 'src/editor-panel/assist.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
