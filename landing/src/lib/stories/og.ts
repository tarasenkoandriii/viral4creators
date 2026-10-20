import { createHash } from 'node:crypto';
import type { StoriesCopy } from './copy';

/**
 * OG-карточки Story‑Tales (`public/og/stories-<locale>.jpg`, генератор
 * `scripts/og-stories-cards.tsx`). Здесь — общее для генератора и теста:
 * бюджет веса и отпечаток строк, из которых карточка нарисована.
 *
 * Модуль только для сборочных скриптов и тестов (`node:crypto`), страница
 * его не импортирует.
 */
export const OG_CARD_BYTES_MAX = 95 * 1024;

/**
 * Бейдж карточки — пилотный (`access.pilot.badge`): карточки отдаются
 * только в режимах лендинга `pilot`/`public` (`landing-mode.ts`).
 */
export function ogCardFingerprint(t: StoriesCopy): string {
  return createHash('sha256')
    .update(`${t.tagline}\n${t.hero.title}\n${t.access.pilot.badge}\n${t.hero.illustrationCaption}`)
    .digest('hex')
    .slice(0, 16);
}
