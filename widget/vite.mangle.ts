import { transform, type TransformOptions } from 'esbuild';
import type { Plugin } from 'vite';

/**
 * Сжатие имён свойств ВНУТРИ чанка (аудит C, бюджеты size-budget.mjs не
 * растут): esbuild `mangleProps` на ИТОГОВОМ бандле — одно отображение имён
 * на весь файл, поэтому обращения из разных модулей чанка сходятся.
 *
 * Сжимаются только имена с `_` и буквой (`_halt`, `_refusal`; не `__x`):
 * закрытые поля/методы классов `Runner` (act/exec.ts), `Loader` и `WidgetUi`
 * (loader/). Такие имена НЕ попадают ни в сообщения postMessage (строковые
 * поля протокола — `shared/protocol.ts`, `editor-protocol.ts`), ни в объекты,
 * которые читает другой чанк или страница (`ActHost`, `ActNatives`,
 * `EngageHost`, `mem`) — сверку держит `scripts/mangle.test.ts`. Обращение
 * по строке (`this['_x']`, `this[k]`) не сжимается — такие поля без `_`.
 */
export const MANGLE_PROPS = /^_[A-Za-z]/;

/** Пост-плагин: минификация чанка с `mangleProps` (опции — формат/цель чанка). */
export function minifyChunk(opts: TransformOptions): Plugin {
  return {
    name: 'v4c-minify-chunk',
    enforce: 'post',
    async generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type !== 'chunk') continue;
        f.code = (
          await transform(f.code, {
            minify: true,
            mangleProps: MANGLE_PROPS,
            ...opts,
          })
        ).code;
      }
    },
  };
}
