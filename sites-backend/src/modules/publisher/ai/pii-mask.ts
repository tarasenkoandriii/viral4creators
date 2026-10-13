/**
 * AI Publisher — маскировка контактов перед отправкой провайдеру модели и
 * перед записью ответа в журнал (P-B2, аудит S1-3; ТЗ: «в AI … контакты не
 * передаются»; принцип 7 §1).
 *
 * Правило «похоже на контакт» — ОДНО на весь Publisher: `PII_RULE` P-A1
 * (`core/pii-guard.ts`, тот же текст в SQL `pub_looks_contact`). Здесь оно
 * применяется не «да/нет», а с заменой фрагмента:
 *  - email — токен вокруг `@`;
 *  - мессенджер (`t.me/…`, `wa.me/…`, `viber://…`) — ссылка целиком;
 *  - телефон — цепочка цифр по `PII_RULE.phone` (с ведущим `+`), если
 *    окно вокруг неё после вырезания дат/времени/сумм/номеров
 *    (`piiStripTokens`) всё ещё похоже на телефон: «1 200 000 грн»,
 *    «16.10.2026», «ID 12345678» не маскируются.
 * Маска — `[контакт приховано]`; число замен пишется в журнал вызова.
 *
 * Чистый модуль.
 */
import { PII_RULE, piiStripTokens } from '../core/pii-guard';

export const PII_MASK = '[контакт приховано]';

const EMAIL_TOKEN = /[^\s<>()[\]{}"'«»,;]*@[^\s<>()[\]{}"'«»,;]*/g;
const MESSENGER_TOKEN = new RegExp(
  `(?:${PII_RULE.messenger})[^\\s<>"'«»]*`,
  'g',
);
const PHONE_CANDIDATE = new RegExp(`[+]?${PII_RULE.phone}`, 'g');
const PHONE_RE = new RegExp(PII_RULE.phone);
/** Окно контекста вокруг кандидата (валюта, «ID», дата рядом). */
const WINDOW = 12;
/**
 * Исключение — только ТОЧНЫЕ id, переданные вызывающим (предаудит D2-02,
 * вместо класса «слово_цифры» Р-PUB-Z2-11): id источников, фактов и
 * оффера контекста вызова, метка версии адаптации. Цифры внутри токена,
 * совпадающего с таким id, телефоном не считаются (флейк Z2-11: cuid
 * источника в `used_source_ids`); любой другой токен с цифрами — по
 * единому правилу (`tel_380…`, `phone_…`, `viber_…`, «cuid-образные»
 * строки, которых нет в контексте, — маскируются).
 */
export interface MaskOptions {
  /** Точные токены, которые не маскируются (id контекста, метки). */
  keep?: ReadonlySet<string>;
}

/** Токен вокруг [from, to) из символов `chars` (без выхода за строку). */
function tokenAround(
  whole: string,
  from: number,
  to: number,
  chars: RegExp,
): string {
  let l = from;
  let r = to;
  while (l > 0 && chars.test(whole[l - 1])) l--;
  while (r < whole.length && chars.test(whole[r])) r++;
  return whole.slice(l, r);
}

function keptToken(
  keep: ReadonlySet<string> | undefined,
  whole: string,
  from: number,
  to: number,
): boolean {
  if (!keep || keep.size === 0) return false;
  return [/[A-Za-z0-9_]/, /[A-Za-z0-9_-]/, /[A-Za-z0-9_.@-]/].some((re) =>
    keep.has(tokenAround(whole, from, to, re)),
  );
}

export interface Masked {
  text: string;
  masked: number;
}

export function maskContacts(input: string, opts: MaskOptions = {}): Masked {
  let masked = 0;
  const keep = opts.keep;
  // Только то, что NFKC правила P-A1 сводит к ASCII в контактах:
  // полноширинные знаки и узкие/неразрывные пробелы. Остальной текст
  // («…», апострофы) не трогаем — промпт не должен меняться без нужды.
  let t = input
    .replace(/[\uFF01-\uFF5E]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[\u00A0\u2007\u2009\u202F]/g, ' ');
  t = t.replace(EMAIL_TOKEN, (m) => {
    if (keep?.has(m)) return m;
    masked++;
    return PII_MASK;
  });
  t = t.replace(MESSENGER_TOKEN, (m) => {
    // Шаблон мессенджера может начинаться с символа-границы — его сохраняем.
    const lead = /^[^A-Za-z0-9_]/.test(m) ? m[0] : '';
    masked++;
    return `${lead}${PII_MASK}`;
  });
  t = t.replace(PHONE_CANDIDATE, (m, ...args) => {
    const offset = args[args.length - 2] as number;
    const whole = args[args.length - 1] as string;
    if (keptToken(keep, whole, offset, offset + m.length)) return m;
    const window = whole.slice(
      Math.max(0, offset - WINDOW),
      offset + m.length + WINDOW,
    );
    if (!PHONE_RE.test(piiStripTokens(window))) return m;
    masked++;
    return PII_MASK;
  });
  return { text: t, masked };
}

/** Маска во всех строках JSON-значения (ответ модели перед записью). */
export function maskDeep<T>(
  value: T,
  opts: MaskOptions = {},
): { value: T; masked: number } {
  let masked = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = maskContacts(v, opts);
      masked += r.masked;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          walk(x),
        ]),
      );
    }
    return v;
  };
  return { value: walk(value) as T, masked };
}
