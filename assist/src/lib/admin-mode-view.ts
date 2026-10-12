/** Э7: права и тексты экранов «Админки» (общие для экранов и кнопки входа). */
import { ApiError, useKit } from '../kit';
import { getAppDictionary } from '../i18n';
import { useErrorText } from './use-error-text';
import type { AdminModeTexts } from '../i18n/admin-mode-uk';
import type { CrawlBlockedWrites } from './admin-mode-api';
import {
  ADMIN_ACTIONS_TEXTS,
  type AdminActionsTexts,
} from '../i18n/admin-actions';

/** Владелец «Админки»: роль кабинета owner или `assistAdmin: owner` (§3.2). */
export function isAdminOwner(me: {
  role: string;
  productRoles: { assistAdmin: string };
}): boolean {
  return me.role === 'owner' || me.productRoles.assistAdmin === 'owner';
}

/** Тексты «Админки» — из AppDictionary (`adminMode`, заход 10, №63). */
export function useAdminTexts(): AdminModeTexts {
  const { locale } = useKit();
  return getAppDictionary(locale).adminMode;
}

/** Э8: тексты «Админки: действия». */
export function useActionsTexts(): AdminActionsTexts {
  const { locale } = useKit();
  return ADMIN_ACTIONS_TEXTS[locale];
}

type AdminZ10Code = keyof AdminModeTexts['errors'];

/**
 * Аудит захода 10 (P3 (6)): текст отказа экранов «Админки» — коды захода 10
 * переводятся словарём «Админки», остальное — как раньше (`fallback`).
 */
export function adminErrorText(
  e: unknown,
  t: AdminModeTexts,
  fallback: (e: unknown) => string
): string {
  if (
    e instanceof ApiError &&
    typeof e.code === 'string' &&
    e.code in t.errors
  ) {
    return t.errors[e.code as AdminZ10Code];
  }
  return fallback(e);
}

/** Текст отказа экранов «Админки»: коды захода 10 + общий `useErrorText`. */
export function useAdminErrorText(): (e: unknown) => string {
  const t = useAdminTexts();
  const base = useErrorText();
  return (e) => adminErrorText(e, t, base);
}

/**
 * Заход 13 (Р-З13-Г1): строка отчёта обхода «Админки» — запись, оборванная
 * «только чтением» воркера: «лише читання — заблоковано записів: 5 (запити
 * запису: 3, вихід: 2)». Причины — в порядке словаря; причина, которой TMA
 * не знает, — в «інше». Ноль или нет данных (старый воркер) — пусто.
 */
export function crawlBlockedText(
  bw: CrawlBlockedWrites | null,
  t: Pick<AdminModeTexts['settings'], 'crawlBlocked' | 'crawlBlockedReasons'>
): string {
  if (!bw || bw.total <= 0) return '';
  const names = t.crawlBlockedReasons;
  const known = (k: string) => Object.prototype.hasOwnProperty.call(names, k);
  const sums = new Map<string, number>();
  for (const [k, n] of Object.entries(bw.reasons)) {
    const key = known(k) ? k : 'other';
    sums.set(key, (sums.get(key) ?? 0) + n);
  }
  const parts = Object.keys(names)
    .filter((k) => sums.has(k))
    .map((k) => `${names[k]}: ${sums.get(k)}`);
  const head = t.crawlBlocked.replace('{n}', String(bw.total));
  return parts.length ? `${head} (${parts.join(', ')})` : head;
}
