// Панель темпа обучалки в админке — чистые помощники, чтобы их проверял
// tutorial-tempo.test.ts без браузера.

import type { TutorialVersionRow } from './types';

/**
 * Есть ли у ролика исходный «обычный» файл. Нет — ролик собран сразу с
 * темпом пары (заход 7): «вернуть обычный» у него — отдельная платная
 * сборка ×1, и кнопка обязана это сказать.
 */
export function hasSourceFile(versions: readonly Pick<TutorialVersionRow, 'kind'>[]): boolean {
  return versions.length === 0 || versions.some((v) => v.kind === 'source');
}
