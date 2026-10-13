/**
 * AI Publisher — проверка свободного текста на контакты (P-A1, проектный
 * документ §6.1, §11.4; аудит P-A1 P2-2/P2-3). Причины журнала аудита,
 * решения задач проверки, основания решений по параметрам, комментарии,
 * строковые значения `meta` и UTM — открытый текст; менеджер естественно
 * напишет в нём имя и телефон. Похожее на контакт — отказ `PUB_VALIDATION
 * {field, code:'pii'}` с подсказкой в UI (UTM — `[redacted]`); заметки по
 * заявкам — только шифром (`contact-crypto`).
 *
 * ОДНО правило для TS и SQL (`pub_looks_contact` миграции P-A0): шаблоны
 * ниже вставлены в функцию миграции дословно (тест сверяет текст), а
 * общая таблица векторов (`testing/pii-vectors.testing.ts`) прогоняется и
 * здесь, и в базе. Шаги:
 *  1. NFKC (полноширинные цифры и `＠` → ASCII, NBSP и узкие пробелы → ` `,
 *     `№` → `No`);
 *  2. `@` — email; `t.me/`, `telegram.me/`, `wa.me/`, `viber://`, `tg://`,
 *     `whatsapp://` — мессенджер;
 *  3. вырезаются токены дат, времени, сумм с валютой и номеров с меткой
 *     (`ID`, `No`, `#`) — они не контакт (ложные срабатывания P2-3);
 *  4. телефон — ≥ 7 цифр, между ними только разделители
 *     `пробел \t \n \r ( ) . , / _ : – — -`. Порог 7 оставлен: городские
 *     семизначные номера — реальные контакты.
 * Цифры других письменностей (не ASCII после NFKC) правилом не ловятся —
 * осознанная граница: регулярные выражения PostgreSQL не знают `\p{Nd}`.
 *
 * Чистый модуль.
 */
import type { FieldIssue } from '../contracts/errors';

/** Границы числового токена: не продолжение числа (`067.16.10…`). */
const L = '(?<![0-9])(?<![0-9][.:/])';
const R = '(?![0-9])(?![.:/][0-9])';
const L_ISO = '(?<![0-9])(?<![0-9][-.:/])';
const R_ISO = '(?![0-9])(?![-.:/][0-9])';
const AMOUNT =
  '([0-9]{1,3}([ ,.][0-9]{3})+([.,][0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?)';
const CURRENCY =
  '([гГ][рР][нН]|[кК][оО][пП]|[uU][aA][hH]|[uU][sS][dD]|[eE][uU][rR]|[$€₴])';

/**
 * Шаблоны правила. Синтаксис — общий для JS и ARE PostgreSQL (без `\d`,
 * `\s`, `\p`, без флагов; регистр — явными классами); строки вставлены в
 * `pub_looks_contact` дословно.
 */
export const PII_RULE = {
  email: '@',
  messenger:
    '(^|[^A-Za-z0-9_])([tT]|[tT][eE][lL][eE][gG][rR][aA][mM]|[wW][aA])[.][mM][eE]/' +
    '|([vV][iI][bB][eE][rR]|[tT][gG]|[wW][hH][aA][tT][sS][aA][pP][pP])://',
  /** Вырезаются по порядку (замена на пробел). */
  strip: [
    // 2026-10-16 (время после `T` уйдёт следующим шагом)
    L_ISO + '(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])' + R_ISO,
    // 16.10.2026, 1.10.26
    L +
      '(0?[1-9]|[12][0-9]|3[01])[.](0?[1-9]|1[0-2])[.]((19|20)[0-9]{2}|[0-9]{2})' +
      R,
    // 16/10/2026
    L + '(0?[1-9]|[12][0-9]|3[01])/(0?[1-9]|1[0-2])/(19|20)[0-9]{2}' + R,
    // 10:00, 10:00:00.000
    L + '([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]{1,6})?)?' + R,
    // 1 200 000 грн, 12 000,50 UAH, 300 тис. грн
    L + AMOUNT + '[ ]?([тТ][иИ][сС][.]?[ ]?|[мМ][лЛ][нН][.]?[ ]?)?' + CURRENCY,
    // $12,000, UAH 1500
    '([$€₴]|[uU][aA][hH]|[uU][sS][dD]|[eE][uU][rR])[ ]?' + AMOUNT + '(?![0-9])',
    // ID 12345678, No 15, #42
    '(?<![A-Za-z])([iI][dD]|[nN][oO]|#)[ ]?[:=.]?[ ]?[0-9]+',
  ],
  phone: '[0-9]([ \\t\\n\\r().,/_:–—-]*[0-9]){6,}',
} as const;

const EMAIL_RE = new RegExp(PII_RULE.email);
const MESSENGER_RE = new RegExp(PII_RULE.messenger);
const STRIP_RES = PII_RULE.strip.map((p) => new RegExp(p, 'g'));
const PHONE_RE = new RegExp(PII_RULE.phone);

/** Текст без токенов дат, времени, сумм и номеров (шаг 3) — для тестов. */
export function piiStripTokens(v: string): string {
  return STRIP_RES.reduce((s, re) => s.replace(re, ' '), v.normalize('NFKC'));
}

export function looksLikeContact(v: string | null | undefined): boolean {
  if (typeof v !== 'string') return false;
  const n = v.normalize('NFKC');
  if (EMAIL_RE.test(n) || MESSENGER_RE.test(n)) return true;
  return PHONE_RE.test(piiStripTokens(n));
}

/** Поля с контактом → `{field, code:'pii'}`. */
export function piiIssues(
  fields: Record<string, string | null | undefined>,
): FieldIssue[] {
  return Object.entries(fields)
    .filter(([, v]) => looksLikeContact(v))
    .map(([field]) => ({ field, code: 'pii' }));
}

/**
 * Ключи ПД, которые запрещены в `pub_audit_events.meta` (триггер
 * `pub_audit_meta_guard`) и — без `email/phone/token/secret` — в
 * `pub_idempotency_keys.responseBody` (`pub_idempotency_guard`).
 */
export const AUDIT_META_FORBIDDEN_KEYS = [
  'contact',
  'email',
  'phone',
  'name',
  'task',
  'fieldsEnc',
  'contactEnc',
  'noteEnc',
  'token',
  'secret',
] as const;
export const RESPONSE_FORBIDDEN_KEYS = [
  'contact',
  'name',
  'task',
  'fieldsEnc',
  'contactEnc',
  'noteEnc',
  // Р-PUB-Z2-5 (запрос P-C S2-3): имя участника под ключом `displayName`
  // (нормализованный `displayname`, точное совпадение — как весь список).
  'displayName',
] as const;

/** Нормализованный ключ: нижний регистр, только `[a-z0-9]` (как SQL). */
export function normalizePiiKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PERSON_NAME_KEYS = new Set([
  'fullname',
  'firstname',
  'lastname',
  'middlename',
  'surname',
  'personname',
  'applicantname',
]);
const CONTACT_ALLOWED_KEYS = new Set(['contactmethod', 'contactdueat']);

/**
 * Ключ запрещён — то же правило, что `pub_json_has_keys` миграции P-A0
 * (аудит P-A0 P3-11, аудит P-A1 P3-4): нормализованный ключ из списка;
 * или с `email`/`phone`/`password`/`secret` внутри; или `contact…`
 * (кроме `contactMethod`/`contactDueAt`); или имя человека (`fullName`…).
 */
export function isForbiddenPiiKey(
  key: string,
  forbidden: readonly string[],
): boolean {
  const n = normalizePiiKey(key);
  return (
    forbidden.some((f) => normalizePiiKey(f) === n) ||
    /email|phone|password|secret/.test(n) ||
    (n.startsWith('contact') && !CONTACT_ALLOWED_KEYS.has(n)) ||
    PERSON_NAME_KEYS.has(n)
  );
}

/** Запрещённые ключи объекта на любой глубине (как SQL-триггер). */
export function forbiddenKeysIn(
  value: unknown,
  forbidden: readonly string[],
): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (isForbiddenPiiKey(k, forbidden)) found.add(k);
        walk(x);
      }
    }
  };
  walk(value);
  return [...found];
}

/**
 * Ключи-идентификаторы (`…Id`, `…Ids`, `…Hash`, `…Ref`): значения — id и
 * hash, в них бывают 7+ цифр подряд; правилом телефона не проверяются.
 */
const ID_VALUE_KEY_RE = /(id|ids|hash|ref|refs)$/;

/**
 * Строковые значения на любой глубине, похожие на контакт (аудит P3-4) —
 * пути вида `a.b[0].c`. Значения под ключами-идентификаторами пропускаются.
 */
export function contactValuesIn(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return looksLikeContact(value) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((x, i) => contactValuesIn(x, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, x]) =>
      ID_VALUE_KEY_RE.test(normalizePiiKey(k))
        ? []
        : contactValuesIn(x, path ? `${path}.${k}` : k),
    );
  }
  return [];
}
