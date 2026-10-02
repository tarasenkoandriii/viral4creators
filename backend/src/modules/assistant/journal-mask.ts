/**
 * Маскирование для журнала консультанта лендинга — вопрос И ответ
 * (Ш0.7 аудита docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md,
 * риск В-4).
 *
 * До Ш0.7 в `AssistantExchange.question` вопрос посетителя писался как
 * есть и жил 30 дней: «мой телефон +380…, перезвоните» оставался в базе
 * открытым текстом, хотя ответ рядом маскировался.
 *
 * Правило — ТО ЖЕ, что у журнала помощника платформы
 * (`sites-backend/src/modules/assist-site-chat/answer-checks.ts`,
 * `maskForJournal`, приёмка Э2 п.6): `maskSensitiveEcho` ядра плюс номера
 * карт (по Луну) и IBAN-подобные строки, плюс телефон в «свободной»
 * записи. Здесь копия, а не импорт: sites-backend — отдельный деплой, и
 * функция живёт в его модуле, а не в общем `assist-chat-core`. Перенос
 * в ядро (и удаление этой копии) — при переезде консультанта на
 * платформу (Ш5); векторы теста — те же, что у оригинала.
 */

import {
  DEFAULT_MASK_LABELS,
  maskSensitiveEcho,
} from '../../common/assist-chat-core';

export const JOURNAL_MASK = {
  card: '[номер карты скрыт]',
  iban: '[счёт скрыт]',
} as const;

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
/**
 * Телефон в «свободной» записи: `+380 (67) 123-45-67` — шаблон ядра не
 * берёт два разделителя подряд («) (»). 9–15 цифр: время «9:00», цены
 * «1 500» и даты без разделителей сюда не попадают.
 */
const PHONE_LOOSE = /\+?\d[\d\s().-]{7,22}\d/g;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Проверка Луна: отличает номер карты от просто длинного числа. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/** Порядок: IBAN и карта — раньше телефона, иначе их съел бы шаблон
 * телефона (тоже скрыто, но с неверной подписью). */
export function maskForJournal(text: string): string {
  return maskSensitiveEcho(
    text
      .replace(IBAN, (m) =>
        /\d{8,}/.test(m.replace(/\s/g, '')) ? JOURNAL_MASK.iban : m,
      )
      .replace(CARD_CANDIDATE, (m) =>
        luhnValid(m.replace(/\D/g, '')) ? JOURNAL_MASK.card : m,
      )
      .replace(PHONE_LOOSE, (m) => {
        const digits = m.replace(/\D/g, '').length;
        return digits >= 9 && digits <= 15 ? DEFAULT_MASK_LABELS.phone : m;
      }),
  );
}
