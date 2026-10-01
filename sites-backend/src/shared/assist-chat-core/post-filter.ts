// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/post-filter.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Пост-фильтр ответа модели (ТЗ лендинга §5.5) — на уже собранном полном
 * тексте. Стрим к этому моменту уже ушёл клиенту («осознанный компромисс
 * стриминга»), поэтому фильтр не блокирует ответ: он (1) маскирует
 * контакты/ключи в том, что пишется в журнал, и (2) даёт флаг для ревью.
 * Список стоп-фраз у каждого продукта свой (у Помощника — ещё и свой у
 * каждого заказчика, ТЗ помощника §4.7) — поэтому параметром.
 * Чистый модуль (см. шапку `protocol.ts`).
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Телефон — 7+ цифр подряд, с необязательными пробелами/дефисами/скобками
// между ними, чтобы не маскировать обычные числа («25 секунд», «100 МБ»).
const PHONE_PATTERN = /(?:\+?\d[\s().-]?){7,}\d/g;
const TOKEN_PATTERN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;

/** Подписи вместо замаскированного — то, что увидит оператор в журнале. */
export interface MaskLabels {
  email: string;
  phone: string;
  token: string;
}

/** Подписи лендинга — журнал и админка у нас русские. */
export const DEFAULT_MASK_LABELS: MaskLabels = {
  email: '[e-mail скрыт]',
  phone: '[телефон скрыт]',
  token: '[ключ скрыт]',
};

/**
 * Маскирует e-mail/телефоны/похожие на ключи строки. Порядок важен:
 * ключ — раньше телефона, иначе длинный ряд цифр внутри ключа съел бы
 * его как «телефон» и оставил видимым префикс ключа.
 */
export function maskSensitiveEcho(
  text: string,
  labels: MaskLabels = DEFAULT_MASK_LABELS,
): string {
  return text
    .replace(EMAIL_PATTERN, labels.email)
    .replace(TOKEN_PATTERN, labels.token)
    .replace(PHONE_PATTERN, labels.phone);
}

/**
 * true — в тексте есть хоть одна фраза из списка (без учёта регистра).
 * Не НЛП-анализ: признак для ревью, а не доказательство нарушения.
 * Фразы ожидаются в нижнем регистре — так их и пишут в списках.
 */
export function containsAnyPhrase(
  text: string,
  phrases: readonly string[],
): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}
