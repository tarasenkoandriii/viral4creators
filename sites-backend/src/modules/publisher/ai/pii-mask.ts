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
 * Сверх P-A1 (внутренний аудит IA-D2-02, Р-IA-FXB-2): правило «да/нет»
 * P-A1 в SQL не меняется, а маска ПЕРЕД ПРОВАЙДЕРОМ закрывает ещё:
 *  - обфусцированный email: `имя [at] домен [dot] зона`, `(at)`, `{at}`,
 *    ` at `, ` @ `, `собака`/`равлик`, `[dot]`/`(dot)`/` dot `/`крапка`/
 *    `точка` — ru/uk/en, любой регистр, вся конструкция целиком;
 *  - ссылку на профиль соцсети (instagram, facebook/fb/m.me, linkedin
 *    `/in/`, tiktok `/@`, x.com/twitter, threads, youtube `/@|/c/|
 *    /channel/|/user/`, vk, ok.ru, snapchat, pinterest, signal.me,
 *    reddit `/u/|/user/`) — ссылка целиком; ссылки на треды/страницы
 *    (reddit `/r/…`) и любые другие домены (в т. ч. сайт продукта) — нет;
 *  - ник после метки мессенджера/соцсети (`Telegram: ivan_k`,
 *    `Інстаграм — demo.brand`) — ник, метка остаётся.
 * Любой токен с `@` (в т. ч. `@username`) маскируется, как и раньше
 * (P-A1: `@` — контакт). Белого списка «профилей бренда» нет: в `ctx@1`
 * нет доверенного перечня профилей продукта, а публичный источник может
 * цитировать третье лицо — приоритет «контакт не уходит провайдеру».
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

// ── IA-D2-02: обфусцированный email ─────────────────────────────────────
const BR_OPEN = '[\\[({<]';
const BR_CLOSE = '[\\])}>]';
/** Сильный «@»: `[at]`, `(at)`, `{at}`, `<at>`, `[@]`, `@` с пробелами. */
/**
 * `@` в кодировках (IA-D1-04): URL `%40`, HTML `&#64;`/`&#x40;`/`&commat;`.
 */
const AT_ENCODED = '%40|&#0*64;|&#x0*40;|&commat;';
const AT_STRONG = `\\s*(?:${BR_OPEN}\\s*(?:at|@|собака|равлик)\\s*${BR_CLOSE}|@|${AT_ENCODED})\\s*`;
/** Словом: ` собака `, ` равлик ` (ru/uk названия знака). */
const AT_WORDY = '\\s+(?:собака|равлик)\\s+';
/** Английское ` at ` — только с признаками адреса (см. `obfuscatedEmail`). */
const AT_PLAIN = '\\s+at\\s+';
const DOT_WORDS = '(?:dot|точка|крапка)';
/** Точка без пробелов, `[dot]`/`(.)`, ` dot `/` крапка `/` точка `. */
const DOT_STRICT = `(?:\\s*${BR_OPEN}\\s*(?:${DOT_WORDS}|\\.)\\s*${BR_CLOSE}\\s*|\\s+${DOT_WORDS}\\s+|\\.|%2e|&#0*46;|&#x0*2e;|&period;)`;
/** + ` . ` с пробелами с обеих сторон (только после сильного «@»). */
const DOT_LOOSE = `(?:${DOT_STRICT}|\\s+\\.\\s+)`;
const MAIL_LOCAL = '[\\p{L}\\p{N}_%+-]+(?:[.][\\p{L}\\p{N}_%+-]+)*';
const MAIL_PART = '[\\p{L}\\p{N}-]+';
/** Зона: латиница 2–24 или кириллические зоны. */
const MAIL_TLD =
  '(?:xn--[a-z0-9-]{2,59}|[A-Za-z]{2,24}|укр|рф|бел|срб|мкд|мон|қаз|бг|ею|онлайн|сайт|рус|москва)';
/** Email целиком (для склеенного «по буквам», IA-D1-04). */
const EMAIL_SHAPE = new RegExp(
  `^[\\p{L}\\p{N}_%+-]+(?:[.][\\p{L}\\p{N}_%+-]+)*@${MAIL_PART}(?:[.]${MAIL_PART})*[.]${MAIL_TLD}$`,
  'iu',
);
const obfEmailRe = (at: string, dot: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_.%+-])(${MAIL_LOCAL})(?:${at})` +
      `(${MAIL_PART}(?:${dot}${MAIL_PART})*)${dot}${MAIL_TLD}` +
      `(?![\\p{L}\\p{N}_-])`,
    'giu',
  );
const OBF_EMAIL_STRONG = obfEmailRe(AT_STRONG, DOT_LOOSE);
const OBF_EMAIL_WORDY = obfEmailRe(AT_WORDY, DOT_STRICT);
const OBF_EMAIL_PLAIN = obfEmailRe(AT_PLAIN, DOT_STRICT);
/** Почтовые домены — ` at ` перед ними считается адресом и без других признаков. */
const MAIL_PROVIDERS =
  /^(?:gmail|googlemail|ukr|i|meta|bigmir|online|yahoo|outlook|hotmail|live|proton|protonmail|icloud|me|yandex|mail|gmx|aol|zoho)$/i;
const OBF_DOT_MARK = new RegExp(`${BR_OPEN}|\\s${DOT_WORDS}\\s`, 'iu');

/**
 * Обфусцированный email (IA-D2-02) — вся конструкция. ` at ` в обычном
 * английском тексте («sign up at example.com», «meet at noon. Then») —
 * адрес, только если точка обфусцирована, или в имени есть `. _ % + -`/цифры,
 * или домен — почтовый сервис.
 */
function maskObfuscatedEmails(
  t: string,
  keep: ReadonlySet<string> | undefined,
  count: () => void,
): string {
  const sub = (m: string): string => {
    if (keep?.has(m)) return m;
    count();
    return PII_MASK;
  };
  let out = t.replace(OBF_EMAIL_STRONG, sub).replace(OBF_EMAIL_WORDY, sub);
  out = out.replace(OBF_EMAIL_PLAIN, (m: string, local: string, dom: string) =>
    OBF_DOT_MARK.test(m) ||
    /[._%+\-0-9]/.test(local) ||
    MAIL_PROVIDERS.test(dom.split(/[\s.[\](){}<>]/)[0] ?? '')
      ? sub(m)
      : m,
  );
  return out;
}

// ── IA-D2-02: ссылка на профиль соцсети ─────────────────────────────────
const SOCIAL_HOSTS = [
  'instagram\\.com/',
  'instagr\\.am/',
  'facebook\\.com/',
  'fb\\.com/',
  'fb\\.me/',
  'm\\.me/',
  'messenger\\.com/t/',
  'linkedin\\.com/(?:in|pub|company)/',
  'tiktok\\.com/@',
  'vm\\.tiktok\\.com/',
  'x\\.com/',
  'twitter\\.com/',
  'threads\\.net/',
  'threads\\.com/',
  'youtube\\.com/(?:@|c/|channel/|user/)',
  'vk\\.com/',
  'ok\\.ru/',
  'snapchat\\.com/add/',
  'pinterest\\.com/',
  'signal\\.me/',
  'reddit\\.com/(?:u|user)/',
];
const SOCIAL_LINK = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:https?://)?(?:(?:www|m|mobile|mbasic|web|uk-ua|ua|ru-ru)\\.)?` +
    `(?:${SOCIAL_HOSTS.join('|')})[^\\s<>"'«»)\\]]+`,
  'gi',
);

// ── IA-D2-02: ник после метки мессенджера/соцсети ───────────────────────
const HANDLE_LABEL =
  '(?:telegram|телеграм|телеграмм|tg|тг|instagram|інстаграм|инстаграм|insta|інста|инста|ig|' +
  'facebook|фейсбук|fb|фб|viber|вайбер|whatsapp|ватсап|вотсап|signal|сигнал|skype|скайп|' +
  'tiktok|тікток|тикток|linkedin|лінкедін|линкедин|threads|discord|дискорд|snapchat|снепчат|' +
  'twitter|твіттер|твиттер|нік|ник|nickname|username|логін|логин)';
const LABELED_HANDLE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${HANDLE_LABEL}\\s*(?:[:：]|\\s[-–—])\\s*)` +
    `([A-Za-z0-9_][A-Za-z0-9_.]{2,63})(?![A-Za-z0-9_@])`,
  'giu',
);
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

/**
 * Email «по буквам» (IA-D1-04): `i v a n @ g m a i l . c o m`, в т. ч. с
 * одним «целым» словом по краям (`ivan @ g m a i l . c o m`). Вокруг токена
 * с `@` (до 3 знаков) берутся соседние одиночные знаки, плюс по одному
 * многознаковому токену с краю; склейка без пробелов обязана быть email
 * целиком (`EMAIL_SHAPE`), и одиночных знаков должно быть ≥ 3 — иначе это
 * обычный текст («a b c», «ціна 2 000 грн») или форма, которую ловят
 * остальные правила.
 */
function maskSpelledEmails(t: string, count: () => void): string {
  const toks = [...t.matchAll(/\S+/g)].map((m) => ({
    s: m[0],
    from: m.index,
    to: m.index + m[0].length,
  }));
  const single = (i: number): boolean =>
    i >= 0 && i < toks.length && [...toks[i].s].length === 1;
  const gapOk = (i: number): boolean =>
    /^[ \t]+$/.test(t.slice(toks[i].to, toks[i + 1].from));
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i].s.includes('@') || [...toks[i].s].length > 3) continue;
    let l = i;
    let r = i;
    while (single(l - 1) && gapOk(l - 1)) l--;
    while (single(r + 1) && gapOk(r)) r++;
    const singles = r - l + 1 - (single(i) ? 0 : 1);
    if (singles < 3) continue;
    // по одному «целому» токену с края — перебор вариантов, самый длинный email
    let best: [number, number, number] | null = null;
    for (const dl of [1, 0])
      for (const dr of [1, 0]) {
        const a = l - dl;
        const b = r + dr;
        if (a < 0 || b >= toks.length) continue;
        if ((dl && !gapOk(a)) || (dr && !gapOk(b - 1))) continue;
        const raw = toks
          .slice(a, b + 1)
          .map((x) => x.s)
          .join('');
        const tail = /[,;:!?)»"']+$/u.exec(raw)?.[0].length ?? 0;
        if (!best && EMAIL_SHAPE.test(raw.slice(0, raw.length - tail)))
          best = [a, b, tail];
      }
    if (best) {
      spans.push([toks[best[0]].from, toks[best[1]].to - best[2]]);
      i = best[1];
    }
  }
  for (const [from, to] of spans.reverse()) {
    count();
    t = `${t.slice(0, from)}${PII_MASK}${t.slice(to)}`;
  }
  return t;
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
  // IA-D2-02: обфусцированный email — до токена `@` (иначе `a @ b.ua`
  // оставил бы имя и домен), ссылки профилей — до мессенджеров.
  t = maskSpelledEmails(t, () => masked++);
  t = maskObfuscatedEmails(t, keep, () => masked++);
  t = t.replace(SOCIAL_LINK, () => {
    masked++;
    return PII_MASK;
  });
  t = t.replace(
    LABELED_HANDLE,
    (m, label: string, handle: string, offset: number, whole: string) => {
      if (keep?.has(handle) || !/[A-Za-z]/.test(handle)) return m;
      // «Instagram: stories and reels» — фраза, а не ник: слово без `_ . цифр`,
      // за которым продолжается текст, не маскируем.
      const rest = whole.slice(offset + m.length);
      if (!/[_.0-9]/.test(handle) && /^\s+[\p{L}]/u.test(rest)) return m;
      masked++;
      return `${label}${PII_MASK}`;
    },
  );
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
