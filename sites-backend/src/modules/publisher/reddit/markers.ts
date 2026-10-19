/**
 * AI Publisher, P-R M2 — текстовые признаки Reddit-текста (reddit-manual-
 * mvp-adapted.md §M2.3 `postCheck`, §M2.4 `checks.ts`): ссылки, маркеры
 * личного опыта и «отзыва клиента», раскрытие аффилированности, гарантии и
 * числа результата, контакты, словарь оскорблений, похожесть текстов. ОДНИ
 * правила для находок генератора `pub.reddit.draft` (AI-слой может
 * импортировать только этот файл и `normalize|policy|score` — правило графа
 * `publisher-ai-no-authority`) и для детерминированной проверки
 * `reddit_policy`.
 *
 * `markers@3` (раунд 2 M2, повторный аудит S2-A…S2-D, S3; Р-RD-74…82).
 * Принцип Р-RD-74: детерминированная проверка БЛОКИРУЕТ только при высокой
 * уверенности; неоднозначное — WARN (подтверждает проверяющий), чтобы честный
 * текст не застревал в неснимаемом BLOCK.
 *  - Нормализация: HTML-сущности (`&#x200B;`, `&nbsp;`), NFKC, невидимые
 *    символы, апострофы, нижний регистр; ДВЕ свёртки двойников —
 *    «латинская» (смешанное слово → латиница) и «кириллическая» (смешанное
 *    слово → кириллица); словари сверяются с обеими (Р-RD-77). Короткое
 *    слово только из двойников рядом со словом другого письма (`І'м using`,
 *    `я працюю y Demo`) сворачивается в письмо соседа.
 *  - Детекторы нарушений (ссылки, личный опыт, числа, гарантии) — по
 *    ПОЛНОМУ тексту: спойлеры `>!…!<`, надстрочный `^(…)`, комментарии
 *    `<!-- -->` и зачёркнутое читатель видит (Р-RD-76). Раскрытие ищется
 *    только в «засчитываемом» тексте: спойлеры, комментарии, невидимые
 *    символы не считаются вовсе, надстрочный, зачёркнутый, код и цитата `>`
 *    занимают место в окне 300 знаков, но раскрытием не являются; у поста
 *    заголовок — начало видимого текста.
 *  - Раскрытие (Р-RD-75): маркер РОЛИ (основатель, команда, «I built»,
 *    «side project», «behind», розробник, з команди, из команды, мы делаем…)
 *    без отрицания; бренд — целым словом; отрицание или чужая роль («not
 *    affiliated», «just a customer», «не працюю») → `negated`; бренд есть,
 *    роли нет или роль вместе с отрицанием → `unclear` (WARN).
 *  - Ссылки (Р-RD-79): схема, `www.`, markdown, домен с путём, обходы
 *    (`[.]`, `(dot)`, ` . `, `d0t`, `。`, `\.`, `h t t p`) — ссылка; голый
 *    `слово.зона` известной зоны — «похоже на ссылку» (WARN); код
 *    (`Object.keys`, `ASP.NET`, `main.go`, `works.Then`, `foo.bar(`) — нет.
 *  - Числа результата (Р-RD-78): проценты, деньги, множители (`3x`, «в 3
 *    рази», `triple`, «вдвічі») и числа рядом со словами результата (ROI,
 *    revenue, save, зростання, экономия…); версии, годы, время, `B2B`,
 *    `GPT-4`, `24/7`, коды и маркеры списков — не числа результата.
 *  - Гарантии (Р-RD-80): узкий словарь (без `Promise.`, «As promised»,
 *    «guarantees memory safety»), отрицание — непосредственно перед словом.
 *  - Контакт в Reddit-тексте (Р-RD-81): e-mail с доменной зоной, телефон и
 *    мессенджер по `PII_RULE`, `@handle`; `@scope/pkg`, `pkg@1.2.3`,
 *    `git@host:repo` — не контакт.
 *
 *
 * `markers@4` (аудит Reddit-подсистемы 15.10.2026, зона m2; §13 ТЗ «Аудит
 * 15.10.2026»): роль в раскрытии — только «о себе» (`roleLinked`,
 * `ownedLinked`); личный опыт связан с брендом, только если бренд — объект
 * или подлежащее опыта (`markerTied`), «we use Acme ourselves» — `own_use`;
 * цитаты клиента — слова целиком, без апострофа, оба порядка
 * (`customerQuotes`); социальное доказательство (`socialProofIn`); «2x
 * longer», «every 30 seconds» — не числа результата; `numberValuesIn` —
 * числа источника пункта claimMap.
 *
 * Словари — стартовые списки кода (§12 п.4: утверждает владелец или ED);
 * версия словаря — `REDDIT_MARKERS_VERSION`; пишется в строку проверки
 * `pub_qa_checks.rulesVersion` (IA-AB-08, миграция
 * `20261026100000_publisher_reddit_policy_version`): по строке видно, какими
 * словарями получен BLOCK/WARN. Новые словари действуют со следующей
 * проверки; меняя словари — поднимайте версию.
 *
 * Чистый модуль: без базы, сети и LLM.
 */
import { PII_RULE, piiStripTokens } from '../core/pii-guard';

/** Версия словарей маркеров (личный опыт, раскрытие, числа, ссылки). */
export const REDDIT_MARKERS_VERSION = 'markers@4';

/** Предел, в котором раскрытие должно начаться (A08). */
export const DISCLOSURE_WINDOW = 300;
/** Минимальная длина раскрытия (знаков, после схлопывания пробелов). */
export const DISCLOSURE_MIN = 20;

/** Аффилированность автора (как `contracts/states` `RedditAffiliation`). */
type Affiliation = 'none' | 'customer' | 'founder' | 'employee' | 'agency';

// ── Нормализация ─────────────────────────────────────────────────────────

const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ︀-️﻿ﾠ]/gu;
const APOSTROPHE_RE = /[’‘ʼʻʹ′ˈ´ꞌ＇]/gu;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  zwsp: '​',
  zerowidthspace: '​',
  shy: '­',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
};

/** HTML-сущности (редактор Reddit вставляет `&#x200B;` в пустые строки). */
export function decodeEntities(t: string): string {
  return t.replace(
    /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,20}));/giu,
    (m, hex?: string, dec?: string, name?: string) => {
      if (hex || dec) {
        const cp = parseInt((hex ?? dec)!, hex ? 16 : 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return NAMED_ENTITIES[name!.toLowerCase()] ?? m;
    },
  );
}

/** Сущности, NFKC, без невидимых символов (регистр и разметка — как были). */
function base(t: string): string {
  return decodeEntities(t).normalize('NFKC').replace(INVISIBLE_RE, '');
}

/**
 * Разметка Reddit, которая не меняет видимых слов: маркеры спойлера,
 * надстрочного, зачёркнутого, жирного и курсива, кода, экранирование,
 * HTML-комментарии (содержимое остаётся — его видит модератор).
 */
function plainMarkdown(t: string): string {
  return t
    .replace(/<!--|-->/g, ' ')
    .replace(/>!|!</g, ' ')
    .replace(/(?<=\p{L})`(?=\p{L})/gu, "'")
    .replace(/\\(?=\S)/g, '')
    .replace(/[*~^`]/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
}

/** Кириллица/греческий/армянский, похожие на латиницу (нижний регистр). */
const TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ӏ: 'l',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϲ: 'c',
  ս: 'u',
  օ: 'o',
  հ: 'h',
  ո: 'n',
  ց: 'g',
};
/** Латиница и греческий, похожие на кириллицу (нижний регистр). */
const TO_CYRILLIC: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'в',
  c: 'с',
  e: 'е',
  h: 'н',
  i: 'і',
  k: 'к',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
  y: 'у',
  ï: 'ї',
  ο: 'о',
  α: 'а',
  ε: 'е',
  ι: 'і',
  κ: 'к',
  ρ: 'р',
  τ: 'т',
  χ: 'х',
  օ: 'о',
};
const LATIN_LETTER_RE = /[a-z]/u;
const CYRILLIC_RE = /[Ѐ-ӿ]/u;
const OTHER_SCRIPT_RE = /[Ͱ-ϿЀ-ӿ԰-֏]/u;
const NON_CYR_CONFUSABLE_RE = /[Ͱ-Ͽ԰-֏]/u;
const LETTER_RE = /\p{L}/u;

const lettersOf = (w: string): string[] =>
  [...w].filter((c) => LETTER_RE.test(c));

function scriptOf(w: string | undefined): 'lat' | 'cyr' | 'other' {
  const l = lettersOf(w ?? '');
  const lat = l.some((c) => LATIN_LETTER_RE.test(c));
  const oth = l.some((c) => OTHER_SCRIPT_RE.test(c));
  if (lat && !oth) return 'lat';
  if (!lat && l.some((c) => CYRILLIC_RE.test(c))) return 'cyr';
  return 'other';
}

/**
 * Свёртка двойников: смешанное слово → целиком в письмо `to`; короткое
 * (≤ 4 букв) слово только из двойников рядом со словом письма `to` — тоже.
 * Замена посимвольная 1:1: обе свёртки той же длины, позиции совпадают.
 */
function foldTo(t: string, to: 'lat' | 'cyr'): string {
  const parts = t.split(/(\s+)/u);
  const map = to === 'lat' ? TO_LATIN : TO_CYRILLIC;
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i];
    const l = lettersOf(w);
    if (!l.length) continue;
    const lat = l.some((c) => LATIN_LETTER_RE.test(c));
    const cyr = l.some((c) => CYRILLIC_RE.test(c));
    const oth = l.some((c) => OTHER_SCRIPT_RE.test(c));
    const mixed =
      to === 'lat'
        ? lat && oth
        : cyr && (lat || l.some((c) => NON_CYR_CONFUSABLE_RE.test(c)));
    const own = to === 'lat' ? lat : cyr;
    const near =
      !own &&
      l.length <= 4 &&
      l.every((c) => c in map) &&
      (scriptOf(parts[i - 2]) === to || scriptOf(parts[i + 2]) === to);
    if (mixed || near) parts[i] = [...w].map((c) => map[c] ?? c).join('');
  }
  return parts.join('');
}

/** Две свёртки одного текста (одинаковой длины). */
export interface TextForms {
  lat: string;
  cyr: string;
}

/** Текст для сопоставления: без разметки, нижний регистр, апострофы. */
function prepared(t: string): string {
  return plainMarkdown(base(t)).replace(APOSTROPHE_RE, "'").toLowerCase();
}

export function formsOf(t: string): TextForms {
  const p = prepared(t);
  return { lat: foldTo(p, 'lat'), cyr: foldTo(p, 'cyr') };
}

/**
 * Нормальная форма для сопоставления (латинская свёртка): сущности, NFKC,
 * без невидимых символов и разметки, апострофы → `'`, нижний регистр,
 * двойники в смешанных словах → латиница.
 */
export function normText(t: string): string {
  return formsOf(t).lat;
}

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** Совпадения регулярного выражения (флаг `g`) в обеих свёртках. */
function matchesIn(re: RegExp, f: TextForms): RegExpMatchArray[] {
  const seen = new Set<number>();
  const out: RegExpMatchArray[] = [];
  for (const t of [f.lat, f.cyr])
    for (const m of t.matchAll(re)) {
      if (seen.has(m.index!)) continue;
      seen.add(m.index!);
      out.push(m);
    }
  return out.sort((a, b) => a.index! - b.index!);
}

const testIn = (re: RegExp, f: TextForms): boolean =>
  matchesIn(re, f).length > 0;

/** Слово (или фраза) целиком: `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`. */
const W = (p: string): string =>
  String.raw`(?<![\p{L}\p{N}])(?:${p})(?![\p{L}\p{N}])`;
const rx = (parts: readonly string[]): RegExp =>
  new RegExp(parts.map(W).join('|'), 'gu');

/** Предложения текста (полного: спойлеры и надстрочный — тоже). */
export function sentencesOf(text: string): string[] {
  return plainMarkdown(base(text))
    .replace(/^\s*(?:\d{1,2}[.)]|[-*+•])\s+/gmu, '')
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ── Бренд ────────────────────────────────────────────────────────────────

const BRAND_STOP = new Set([
  'the',
  'and',
  'app',
  'our',
  'for',
  'you',
  'are',
  'tool',
  'one',
  'this',
  'that',
  'its',
  'with',
  'not',
  'site',
  'наш',
  'мій',
  'мой',
  'это',
  'для',
]);

/** Бренд слишком слабый для поиска целым словом (< 3 знаков, стоп-слово). */
export function weakBrand(brand: string | null | undefined): boolean {
  const b = squash(normText(brand ?? ''));
  return [...b].length < 3 || BRAND_STOP.has(b);
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`);

/** Транслитерация кириллицы для «скелета» бренда (Demo ↔ Демо). */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'u',
  я: 'a',
};
/** Цифры-двойники букв в бренде (`Dem0`, `C1ip`, `D3mo`), раунд 3. */
const DIGIT_LETTER: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
};
/**
 * «Скелет» для сравнения бренда: латиница (транслитерация кириллицы),
 * цифры-двойники → буквы, дефис/точка/подчёркивание внутри слова убраны
 * (`D-emo`), y→i, w→v, i→l, без повторов букв.
 */
function skeleton(t: string): string {
  return [...t]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/(?<=\p{L})[0-9]|[0-9](?=\p{L})/gu, (d) => DIGIT_LETTER[d] ?? d)
    .replace(/(?<=[\p{L}\p{N}])[-.·_](?=[\p{L}\p{N}])/gu, '')
    .replace(/y/g, 'i')
    .replace(/w/g, 'v')
    .replace(/i/g, 'l')
    .replace(/(\p{L})\1+/gu, '$1');
}

/** Бренд целым словом (обе свёртки и «скелет» транслитерации). */
export function brandIn(text: string, brand: string | null): boolean {
  if (!brand || !squash(brand)) return false;
  const bf = formsOf(brand);
  const tf = formsOf(text);
  const hit = (b: string, t: string) =>
    !!squash(b) && new RegExp(W(escapeRe(squash(b))), 'u').test(t);
  return (
    hit(bf.lat, tf.lat) ||
    hit(bf.cyr, tf.cyr) ||
    hit(skeleton(bf.lat), skeleton(tf.lat))
  );
}

// ── Ссылки ───────────────────────────────────────────────────────────────

/** Частые зоны (для обфускации ` dot com`). */
const COMMON_TLD =
  'com|net|org|io|co|ua|app|dev|ai|me|info|biz|shop|store|site|online|xyz|eu|uk|us|de|fr|pl|ru|ca|in|to|cc|gg|tv|ly|link|page|tech|cloud';
/** Известные родовые зоны (кроме двухбуквенных — те все считаются). */
const GENERIC_TLD = new Set(
  (
    COMMON_TLD +
    '|pro|blog|news|space|website|world|today|club|agency|digital|media|studio|design|tools|software|solutions|services|email|team|work|network|systems|academy|education|school|health|finance|money|market|marketing|sale|deals|top|vip|fun|art|life|one|land|global|group|company|ltd|inc|llc|gov|edu|mil|int|name|mobi|live|social|chat|games|host|hosting|codes|guru|expert|consulting|events|photo|photos|video|reviews|review|wiki|zone|center|support|help|tips|run|bot|so|ws|fm|im|is|gl'
  ).split('|'),
);
/** Кириллические и прочие IDN-зоны (после нижнего регистра). */
const IDN_TLD = 'рф|укр|рус|бел|срб|мкд|қаз|онлайн|сайт|орг|ком|москва|дети';
/** Двухбуквенные суффиксы — расширения файлов и языков, а не зоны. */
const NOT_TLD = new Set([
  'js',
  'ts',
  'py',
  'rb',
  'md',
  'sh',
  'go',
  'rs',
  'cs',
  'fs',
  'kt',
  'db',
  'gz',
  'xz',
  'bz',
  'mk',
  'pm',
  'hs',
  'ml',
  'el',
  'ex',
  'jl',
  'nb',
  'ps',
  'vb',
]);
/** Технологии с точкой в имени — не ссылки. */
const CODE_NAMES = new Set(['asp.net', 'vb.net', 'ado.net', 'node.js']);
/** Упоминание Reddit без пути — название площадки, не ссылка. */
const REDDIT_MENTION = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
]);

const knownTld = (tld: string): boolean => {
  const t = tld.toLowerCase();
  if (NOT_TLD.has(t)) return false;
  return (
    /^[a-z]{2}$/.test(t) ||
    GENERIC_TLD.has(t) ||
    /^xn--[a-z0-9-]+$/.test(t) ||
    new RegExp(`^(?:${IDN_TLD})$`, 'u').test(t)
  );
};

const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?`;
const SCHEME_RE = /\b(?:https?|ftp):\/\/[^\s)>\]]+/giu;
const SPACED_SCHEME_RE =
  /\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\/|\b(?:https?|ftp)\s+:\s*\/\s*\/|\b(?:https?|ftp):\s+\/\s*\//giu;
const WWW_RE = /\bwww\.[^\s)>\]]+/giu;
const MD_LINK_RE = /\]\(\s*[^)\s]+\s*\)/gu;
const DOMAIN_RE = new RegExp(
  String.raw`(?<![@\p{L}\p{N}._/-])((?:${LABEL}\.)+)(${LABEL})(?![\p{L}\p{N}-])(\/[^\s)>\]]*)?`,
  'gu',
);
/** Обход точки: `[.]`, `(dot)`, ` dot `, ` d0t `, ` . `, `\.`, `。`, `·`. */
const OBF_DOT = String.raw`(?:\s*[\[({<]\s*(?:\.|dot|d0t|точка|крапка)\s*[\])}>]\s*|\s+(?:dot|d0t|точка|крапка)\s+|\s+\.\s+|\\\.|\s*[。｡．․‧·•∙⋅]\s*)`;
const OBF_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${LABEL})${OBF_DOT}(${COMMON_TLD}|${IDN_TLD})(?![\p{L}\p{N}])(?!\s+(?:era|bubble|boom|crash|days|compan\p{L}*|startup\p{L}*))`,
  'giu',
);
const COMMA_DOT_RE =
  /(?<![\p{L}\p{N}])([\p{L}\p{N}-]{2,63}),(com|net|org|io)(?![\p{L}\p{N}])/giu;

/** Ссылки и «похожее на ссылку» текста. */
export interface LinkFindings {
  /** Ссылка с высокой уверенностью (BLOCK там, где ссылки запрещены). */
  links: string[];
  /** Голый `слово.зона` известной зоны (WARN). */
  suspect: string[];
}

export function linkFindings(text: string | null | undefined): LinkFindings {
  const out: LinkFindings = { links: [], suspect: [] };
  if (!text) return out;
  // Обходы точки — до NFKC (`｡`, `․` NFKC превращает в обычную точку).
  const raw = decodeEntities(text).replace(INVISIBLE_RE, '');
  for (const t of [raw, raw.normalize('NFKC')]) {
    for (const m of t.matchAll(OBF_RE)) out.links.push(m[0].trim());
    for (const m of t.matchAll(COMMA_DOT_RE)) out.links.push(m[0]);
  }
  const t = plainMarkdown(base(text).replace(/\\\./g, '.'));
  for (const m of t.matchAll(SPACED_SCHEME_RE)) out.links.push(m[0]);
  for (const re of [SCHEME_RE, WWW_RE, MD_LINK_RE]) {
    for (const m of t.matchAll(re)) {
      const host = m[0]
        .toLowerCase()
        .replace(/^(?:https?|ftp):\/\//, '')
        .replace(/[/?#].*$/, '');
      if (
        re === WWW_RE &&
        REDDIT_MENTION.has(host) &&
        m[0].length === host.length
      )
        continue;
      out.links.push(m[0]);
    }
  }
  for (const m of t.matchAll(DOMAIN_RE)) {
    const tld = m[2];
    const host = `${m[1]}${tld}`.toLowerCase();
    const at = m.index! + m[0].length;
    if (!knownTld(tld)) continue;
    // Код и опечатки: `ASP.NET`, `works.Then`, `St.Louis`, `foo.io(`.
    if (CODE_NAMES.has(host)) continue;
    if (tld !== tld.toLowerCase() && tld !== tld.toUpperCase()) continue;
    if (tld === tld.toUpperCase() && m[1] !== m[1].toUpperCase()) continue;
    if (t[at] === '(') continue;
    if (!m[3] && REDDIT_MENTION.has(host)) continue;
    if ([...out.links].some((x) => x.toLowerCase().includes(host))) continue;
    if (m[3] && m[3].length > 1) out.links.push(m[0]);
    else out.suspect.push(m[0].replace(/\/$/, ''));
  }
  out.links = [...new Set(out.links)];
  out.suspect = [...new Set(out.suspect)];
  return out;
}

/** Ссылки текста с высокой уверенностью (URL, `www.`, markdown, домен с путём, обходы). */
export function linksIn(text: string | null | undefined): string[] {
  return linkFindings(text).links;
}

export function hasLink(text: string | null | undefined): boolean {
  return linksIn(text).length > 0;
}

// ── Личный опыт и отзывы (A07) ───────────────────────────────────────────

/**
 * Маркеры личного опыта («я купив / я використовую / I'm using …»): текст
 * от первого лица о покупке или использовании — при `affiliation ≠
 * customer` это возможный вымышленный отзыв (A07).
 */
const FIRST_PERSON_RES: readonly RegExp[] = [
  // en
  /\b(?:i|we)(?:'ve|'m|'re| have| am| are| had|'d)?(?:\s+(?:been|also|now|personally|actually|really|recently|already|still|just|finally|happily))*\s+(?:using|use|used|tried|trying|bought|buying|purchased|switched to|switching to|switched over to|switched(?!\s+(?:off|on|it|them|the|this|that|back|between|around|sides|gears|jobs|teams|careers|from\s+(?:it|them)))(?:\s+over)?|paid for|pay for|subscribed|subscribed to|rely on|relied on|started using|start using|moved to|migrated to|signed up|installed|rolled out|deployed|adopted|love using|loved using|enjoy using)\b/gu,
  /\b(?:i|we)(?:'ve| have| had)\s+(?:had|owned|got)\b/gu,
  /(?:^|[^\p{L}])been\s+using\b/gu,
  /\b(?:my|our)\s+(?:own\s+|personal\s+)?(?:experience|results?)\s+(?:with|using|of)\b/gu,
  /\b(?:my|our)\s+(?:team|company|startup|agency|shop|business|clients?)\s+(?:uses|used|relies on|switched to|moved to|has been using|runs(?:\s+\p{L}+){0,2}\s+on)\b/gu,
  /\b(?:worked|works|working)\s+(?:great|perfectly|wonders|well)\s+for\s+(?:me|us)\b/gu,
  /\bsaved\s+(?:me|us|my|our)\b/gu,
  /\b(?:cut|halved|doubled|tripled|boosted|transformed)\s+(?:my|our)\b/gu,
  /\b(?:a\s+)?(?:life\s?saver|game[- ]changer)\s+for\s+(?:me|us)\b/gu,
  /\bcan't\s+recommend\b[^.!?\n]{0,40}\benough\b/gu,
  /\bnever\s+looked\s+back\b/gu,
  // uk/ru латиницей (раунд 3): «ya ispolzuyu», «ya vykorystovuyu», «my polzuemsya»
  /\b(?:ya|my|mi)\s+(?:(?:uzhe|vzhe|davno|tozhe|tezh|takozh|kazhdyi|kazhdyy|shchodnia|shchodnya)\s+)?(?:isp[oa]l'?z\p{L}*|v[iy]k[oa]r[iy]st[oa]v\p{L}*|v[iy]k[oa]r[iy]stal\p{L}*|p[oa]l'?z[uo]\p{L}*|k[oa]r[iy]stu\p{L}*|kup[iy]l\p{L}*|kup[iy]v\p{L}*|kupuval\p{L}*|pridba\p{L}*|prydba\p{L}*|yuza\p{L}*|iuza\p{L}*|juza\p{L}*|poprob[oa]v\p{L}*|sprobuv\p{L}*|zakaz\p{L}*|zamov\p{L}*|peresh\p{L}*|vnedr\p{L}*|vprovad\p{L}*)/gu,
  /\b(?:mne|meni|nam)\s+(?:duzhe\s+|ochen'?\s+)?(?:pom[oa]g\p{L}*|dopom\p{L}*|ponrav\p{L}*|spodoba\p{L}*)/gu,
  // uk
  /(?<![\p{L}])(?:я|ми)\s+(?:вже\s+|давно\s+|теж\s+|також\s+|щодня\s+|нарешті\s+|сам\p{L}*\s+)?(?:купи\p{L}*|купу\p{L}*|придба\p{L}*|використову\p{L}*|використа\p{L}*|користу\p{L}*|юза\p{L}*|спробува\p{L}*|замови\p{L}*|замовля\p{L}*|перейш\p{L}*|переш\p{L}*|встанови\p{L}*|впровади\p{L}*|підключи\p{L}*|оплачу\p{L}*|оплати\p{L}*|передплати\p{L}*)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:мій|наш)\s+(?:особистий\s+)?досвід(?![\p{L}])/gu,
  /(?<![\p{L}])(?:мені|нам)\s+(?:дуже\s+)?(?:допом\p{L}*|сподоба\p{L}*|подоба\p{L}*|зекономи\p{L}*)/gu,
  /(?<![\p{L}])(?:у|в)\s+(?:мене|нас)\s+(?:\p{L}+\s+){0,2}(?:вже|давно)(?![\p{L}])/gu,
  // ru
  /(?<![\p{L}])(?:я|мы)\s+(?:уже\s+|давно\s+|тоже\s+|также\s+|каждый день\s+|наконец\s+|сам\p{L}*\s+)?(?:купи\p{L}*|покупа\p{L}*|приобре\p{L}*|использ\p{L}*|пользу\p{L}*|пользова\p{L}*|юза\p{L}*|попробова\p{L}*|заказа\p{L}*|заказыва\p{L}*|переш\p{L}*|перешл\p{L}*|установи\p{L}*|внедри\p{L}*|внедря\p{L}*|подключи\p{L}*|оплачива\p{L}*|оплати\p{L}*)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:мой|наш)\s+(?:личный\s+)?опыт(?![\p{L}])/gu,
  /(?<![\p{L}])(?:мне|нам)\s+(?:очень\s+)?(?:помог\p{L}*|понрави\p{L}*|нрави\p{L}*|сэконом\p{L}*)/gu,
  /(?<![\p{L}])у\s+(?:меня|нас)\s+(?:\p{L}+\s+){0,2}(?:уже|давно)(?![\p{L}])/gu,
];

function firstPersonIn(f: TextForms): RegExpMatchArray[] {
  return FIRST_PERSON_RES.flatMap((re) => matchesIn(re, f));
}

/** Маркеры личного опыта (полный текст, обе свёртки). */
export function firstPersonMarkers(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(firstPersonIn(formsOf(text)).map((m) => m[0].trim()))];
}

/** Предложение начинается с местоимения («It worked great for me»). */
const PRONOUN_START_RE =
  /^(?:it|this|that|this tool|they|воно|він|вона|це|он|оно|она|это)(?![\p{L}'])/u;
/** Местоимение сразу после маркера («I've been using it»): отсылка назад. */
const PRONOUN_AFTER_RE =
  /^\s+(?:it|this|them|that one|this one|ним|нею|його|ним|цим|цей|ним|им|его|ее|её|этим|этот|это)(?![\p{L}])/u;

/** Слова, на которых обрывается объект/подлежащее опыта (аудит m2-8). */
const EXPERIENCE_BREAK_RE =
  /^(?:before|after|building|built|while|when|whenever|because|since|but|than|instead|until|for|so|and|or|which|that|who|although|though|if|unless|without|перед|після|после|бо|тому|потому|але|но|коли|когда|і|и|та)$/u;
/** Собственное использование («we use Acme ourselves», «internally»). */
const OWN_USE_RE =
  /(?<![\p{L}])(?:ourselves|myself|internally|in-house|in house|dogfood\p{L}*|our own|my own)(?![\p{L}])/u;
const OWN_USE_VERB_RE =
  /(?<![\p{L}])(?:use|uses|using|used|rely on|relied on)$/u;
const MARKER_CLAUSE_RE = /[,.;:!?()\n—–]/u;

/**
 * Маркер опыта связан с брендом (`markers@4`, аудит m2-8): бренд — объект
 * опыта (≤ 6 слов после маркера до знака препинания или союза: «using
 * Acme», «switched from X to Acme», но не «switched to Rust for the backend
 * of Acme», не «tried every tool before building Acme») или подлежащее
 * (≤ 6 слов перед маркером в той же части фразы: «Acme saved me»,
 * «Honestly, Acme has been a game changer for us»).
 */
function markerTied(t: string, m: RegExpMatchArray, brand: string): boolean {
  if (brandIn(m[0], brand)) return true;
  const rest = t.slice(m.index! + m[0].length).split(MARKER_CLAUSE_RE)[0];
  const obj: string[] = [];
  for (const w of rest.split(/\s+/u).filter(Boolean)) {
    if (EXPERIENCE_BREAK_RE.test(w) || obj.length >= 6) break;
    obj.push(w);
  }
  if (obj.length && brandIn(obj.join(' '), brand)) return true;
  const head = t.slice(0, m.index!).split(MARKER_CLAUSE_RE).pop() ?? '';
  const words = head.split(/\s+/u).filter(Boolean);
  const subj: string[] = [];
  for (let k = words.length - 1; k >= 0 && subj.length < 6; k--) {
    if (EXPERIENCE_BREAK_RE.test(words[k])) break;
    subj.unshift(words[k]);
  }
  return subj.length > 0 && brandIn(subj.join(' '), brand);
}

/**
 * Личный опыт, связанный с продуктом (`tied`: бренд — объект или
 * подлежащее опыта, или «…using it» / «It worked great for me» после
 * предложения о бренде — цепочка местоимений «Acme is… It has… I've been
 * using it»), собственное использование раскрытым автором (`own_use`: «we
 * use Acme ourselves/internally» — WARN у founder/employee/agency), опыт
 * без такой связи (`loose`: WARN); null — маркеров нет.
 */
export function personalExperience(
  text: string,
  brand: string | null,
): 'tied' | 'own_use' | 'loose' | null {
  const sentences = sentencesOf(text);
  const strong = !!brand && !weakBrand(brand);
  // Предложение «о бренде»: бренд в нём или местоимение в начале после такого.
  const about: boolean[] = [];
  let tied = false;
  let ownUse = false;
  let loose = false;
  sentences.forEach((s, k) => {
    const f = formsOf(s);
    const pronounStart =
      PRONOUN_START_RE.test(f.lat) || PRONOUN_START_RE.test(f.cyr);
    const has = strong && brandIn(s, brand);
    about[k] = has || (pronounStart && k > 0 && about[k - 1]);
    const ms = firstPersonIn(f);
    if (!ms.length) return;
    loose = true;
    if (!strong) return;
    for (const m of ms) {
      const t =
        f.lat.slice(m.index!, m.index! + m[0].length) === m[0] ? f.lat : f.cyr;
      let hit = markerTied(t, m, brand);
      if (!hit) {
        const after = t.slice(m.index! + m[0].length);
        const pronounAfter = PRONOUN_AFTER_RE.test(after);
        const brandBefore = brandIn(t.slice(0, m.index!), brand);
        hit =
          (pronounAfter || pronounStart) &&
          ((k > 0 && about[k - 1]) || (pronounAfter && brandBefore));
      }
      if (!hit) continue;
      if (OWN_USE_RE.test(t) && OWN_USE_VERB_RE.test(m[0].trim()))
        ownUse = true;
      else tied = true;
    }
  });
  if (tied) return 'tied';
  if (ownUse) return 'own_use';
  return loose ? 'loose' : null;
}

// ── Цитаты клиентов и социальное доказательство (A07, аудит m2-4, m2-5) ──

/** Кто «сказал» (целым словом: не `superuser`, не `clientId`). */
const QUOTE_WHO = String.raw`(?:customer|client|user|reviewer|buyer|subscriber|fan)s?|клієнт\p{L}*|клиент\p{L}*|покупц\p{L}*|покупател\p{L}*|користувач\p{L}*|пользовател\p{L}*`;
const QUOTE_SAY = String.raw`сказав|сказала|сказали|каже|кажуть|пише|написав|написала|написали|сказал|говорит|говорят|пишет|написал|said|says|told(?:\s+(?:me|us))?|tells(?:\s+(?:me|us))?|wrote|writes`;
/** Кавычки цитаты — только двойные и ёлочки (апостроф `it's` — не кавычка). */
const QUOTE_FWD_RE = new RegExp(
  String.raw`(?<![\p{L}])(?:${QUOTE_WHO})(?![\p{L}])[^.\n]{0,40}?(?<![\p{L}])(?:${QUOTE_SAY})(?![\p{L}])[^.\n"«“„:]{0,10}(?:["«“„]([^"»”“\n]{1,400})|:\s*([^.!?\n]{1,400}))`,
  'gu',
);
const QUOTE_REV_RE = new RegExp(
  String.raw`["«“„]([^"»”“\n]{3,400})["»”“]\s*,?\s*(?:says|said|wrote|writes|according\s+to|—|–|-)\s+(?:(?:a|an|one|our|my|the|another|this)\s+)?(?:(?:happy|satisfied|verified|real|long-?time|early|recent|paying)\s+)?(?:${QUOTE_WHO})(?![\p{L}])`,
  'gu',
);
/** Похвала: делает цитату или пересказ отзывом. */
const PRAISE_RE = rx([
  String.raw`best|greatest|great|love[sd]?|loving|amazing|awesome|incredible|fantastic|excellent|perfect|brilliant|saved?|saves|game[- ]?changer|life ?saver|lifesaver|recommend\p{L}*|helped|thanks to|changed|must[- ]have|no[- ]brainer|worth (?:it|every)|five stars|5 stars|never looked back`,
  String.raw`найкращ\p{L}*|чудов\p{L}*|супер|рекоменд\p{L}*|допомі\p{L}*|допомог\p{L}*|врятува\p{L}*`,
  String.raw`лучш\p{L}*|отличн\p{L}*|помог\p{L}*|обожа\p{L}*|спас\p{L}*`,
]);

/** Цитата «клиента»: текст цитаты и похвала (бренд, оценка, число результата). */
export interface CustomerQuote {
  quote: string;
  praise: boolean;
}

/**
 * Цитаты «клиента/пользователя/рецензента» (`markers@4`, аудит m2-5, m2-4):
 * прямой порядок («a customer told us: "…"», «One of our users told me:
 * …»), обратный («"Best purchase," says one reviewer»). Слова — целиком,
 * кавычки — двойные/ёлочки. `praise=false` — техническая цитата («your
 * client says "connection refused"», «a customer told us "the export is
 * broken"»): WARN, а не BLOCK.
 */
export function customerQuotes(
  text: string | null | undefined,
  brand: string | null = null,
): CustomerQuote[] {
  if (!text) return [];
  const f = formsOf(text);
  const out: CustomerQuote[] = [];
  const seen = new Set<string>();
  for (const re of [QUOTE_FWD_RE, QUOTE_REV_RE])
    for (const m of matchesIn(re, f)) {
      const quote = squash(m[1] ?? m[2] ?? '');
      if (!quote || seen.has(quote)) continue;
      seen.add(quote);
      const praise =
        testIn(PRAISE_RE, formsOf(quote)) ||
        (!!brand && !weakBrand(brand) && brandIn(quote, brand)) ||
        resultNumbersIn(quote).length > 0;
      out.push({ quote, praise });
    }
  return out;
}

export function hasCustomerQuote(text: string | null | undefined): boolean {
  return customerQuotes(text).length > 0;
}

const SP_NOUN = String.raw`users|customers|clients|companies|teams|businesses|brands|startups|agencies|subscribers|downloads|installs|members|marketers|creators|developers|founders|shops|stores|sellers|merchants|stars|reviews|ratings|клієнтів|користувачів|компаній|клиентов|пользователей|компаний`;
/** «50,000 happy users», «300+ companies», «12k users» (значение ≥ 10). */
const SP_COUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])(?:over\s+|more\s+than\s+|almost\s+|nearly\s+)?(\d{1,3}(?:[,   ]\d{3})+|\d+(?:[.,]\d+)?)\s?(k|m|mm|bn|thousand|million|тис\.?|тыс\.?|млн)?\s?\+?\s+(?:(?:happy|satisfied|paying|active|monthly|daily|weekly|loyal|registered|verified|real|задоволених|довольных|активних|активных)\s+)?(?:${SP_NOUN})(?![\p{L}])`,
  'gu',
);
/** Лимит тарифа: «up to 50 users», «per 10 users» — не соцдоказательство. */
const SP_LIMIT_BEFORE_RE =
  /(?:^|\s)(?:up\s+to|upto|max(?:imum)?|limit(?:ed)?\s+to|per|for|only|до)\s*$/u;
/** Оценка: «4.9 rating», «4.8 stars», «4.7/5», «rated 4.9». */
const SP_RATING_RE =
  /(?<![\p{L}\p{N}.,])\d(?:[.,]\d)?\s*(?:\/\s*5(?![\p{N}])|out\s+of\s+5(?![\p{N}])|stars?(?![\p{L}])|★|-star(?![\p{L}]))|(?<![\p{L}])(?:rated|rating(?:\s+of)?|score\s+of)\s+\d(?:[.,]\d)?(?![\p{N}])|(?<![\p{L}\p{N}.,])\d[.,]\d\s+rating(?![\p{L}])/gu;
/** Награды и места: «#1 Product of the Day», «top-rated», «award-winning». */
const SP_AWARD_RE =
  /(?<![\p{L}])(?:(?:top|highest)[- ]rated|best[- ]selling|award[- ]winning|product\s+of\s+the\s+(?:day|week|month|year)|editor'?s\s+choice)(?![\p{L}])/gu;
const SP_RANK_RE =
  /(?<![\p{L}\p{N}])(?:#\s?1|no\.\s?1|number\s+one)(?![\p{L}\p{N}])/gu;
const SP_RANK_NOUN_RE =
  /^\s+(?:\S+\s+){0,2}?(?:product|app|tool|choice|pick|solution|platform|on|in)(?![\p{L}])/u;
/** Толпа: «thousands of marketers», «trusted by teams at…». */
const SP_CROWD_RE =
  /(?<![\p{L}])(?:thousands|hundreds|millions|dozens|tons|lots|plenty)\s+of\s+(?:happy\s+|satisfied\s+)?\p{L}+/gu;
const SP_CROWD_VERB_RE =
  /(?<![\p{L}])(?:use|uses|using|rely|relies|trust|trusts|trusted|love|loves|switched|swear|swears|recommend|recommends)(?![\p{L}])/u;
const SP_BY_RE =
  /(?<![\p{L}])(?:(trusted|loved|chosen|backed)|used|relied\s+on)\s+by\s+(?:over\s+|more\s+than\s+)?(?:thousands|hundreds|millions|teams|companies|brands|startups|businesses|developers|marketers|agencies|creators|founders|engineers|people\s+at)(?![\p{L}])/gu;
const SP_EVERYONE_RE =
  /(?<![\p{L}])(?:everyone|everybody|most\s+(?:people|teams|users|marketers|founders|developers))\s+(?:\S+\s+)?(?:uses|use|loves|love|is\s+using|are\s+using|recommends|recommend|switched|prefers|prefer)(?![\p{L}])/u;
/** Пересказ чужого мнения о бренде: «a friend tried Acme and said…». */
const SP_HEARSAY_RE =
  /(?<![\p{L}])(?:friends?|colleagues?|coworkers?|co-workers?|clients?|customers?|users?|reviewers?|people|folks|someone|somebody|agenc(?:y|ies)|founders?|marketers?|mom|mum|dad|wife|husband|sister|brother|boss|neighbou?rs?|roommates?)(?![\p{L}])[^.!?\n]{0,60}?(?<![\p{L}])(?:said|says|told|tell|tells|telling|wrote|writes|report|reports|reported|claim|claims|swear|swears|rave|raves|raving|mention|mentions|mentioned|uses|use|using|love|loves|relies\s+on|rely\s+on|tried)(?![\p{L}])/u;

const spValue = (num: string, scale: string | undefined): number => {
  const n = Number(normNumber(num));
  const k = (scale ?? '').replace('.', '');
  const mult =
    k === 'k' || k === 'thousand' || k === 'тис' || k === 'тыс'
      ? 1e3
      : k === 'm' || k === 'mm' || k === 'million' || k === 'млн'
        ? 1e6
        : k === 'bn'
          ? 1e9
          : 1;
  return n * mult;
};

/**
 * Социальное доказательство (`markers@4`, аудит m2-4): число пользователей,
 * клиентов, компаний, звёзд (≥ 10, не лимит тарифа), оценка и награды,
 * «тысячи…», «trusted by…», «everyone uses…», пересказ чужого мнения о
 * бренде с похвалой. Только WARN `reddit_social_proof`: подтверждает
 * проверяющий (Р-RD-74).
 */
export function socialProofIn(text: string, brand: string | null): string[] {
  const out: string[] = [];
  const strong = !!brand && !weakBrand(brand);
  for (const s of sentencesOf(text)) {
    const f = formsOf(s);
    const t = f.lat;
    const branded = strong && brandIn(s, brand);
    for (const m of matchesIn(SP_COUNT_RE, f)) {
      if (SP_LIMIT_BEFORE_RE.test(t.slice(0, m.index!))) continue;
      if (spValue(m[1], m[2]) >= 10) out.push(m[0].trim());
    }
    for (const re of [SP_RATING_RE, SP_AWARD_RE])
      for (const m of matchesIn(re, f)) out.push(m[0].trim());
    for (const m of matchesIn(SP_RANK_RE, f))
      if (branded || SP_RANK_NOUN_RE.test(t.slice(m.index! + m[0].length)))
        out.push(m[0].trim());
    if (branded || SP_CROWD_VERB_RE.test(t))
      for (const m of matchesIn(SP_CROWD_RE, f)) out.push(m[0].trim());
    for (const m of matchesIn(SP_BY_RE, f))
      if (m[1] || branded) out.push(m[0].trim());
    if (branded) {
      const e = SP_EVERYONE_RE.exec(t);
      if (e) out.push(e[0].trim());
      const h = SP_HEARSAY_RE.exec(t);
      if (h && testIn(PRAISE_RE, f)) out.push(h[0].trim());
    }
  }
  return [...new Set(out)];
}

// ── Раскрытие аффилированности (A08) ─────────────────────────────────────

/**
 * Сильные роли: сами по себе — раскрытие. `markers@4` (аудит m2-2): только
 * фразы «о себе» — `owner`, `behind`, `agency`, `partner`, `works with`,
 * `my team`, `my clients`, `my project` без субъекта автора раскрытием не
 * считаются («Acme works with Postgres», «great for shop owners like me»,
 * «I recommend Acme to all my clients», «Acme is behind…», «agency-friendly»).
 */
const INSIDER_STRONG = rx([
  // en
  String.raw`founding (?:team|member|engineer)`,
  String.raw`on the(?:\s+\S+){0,4}?\s+team|part of the(?:\s+\S+){0,3}?\s+team|(?:my|our)\s+team\s+(?:built|made|created|develops|developed|runs|maintains|launched)`,
  String.raw`(?:i|we)(?:'ve| have| had)?(?:\s+(?:also|currently|still|now|actually|previously))?\s+work(?:s|ed)?\s+(?:at|for|on)|(?:i|we)(?:'m| am|'re| are)(?:\s+(?:currently|still|now))?\s+(?:working|employed)\s+(?:at|for|on|by)|i(?:'m| am) (?:with|at|from)|employed (?:by|at)`,
  String.raw`(?:i|we)(?:'ve| have| had)?\s+(?:(?:co-?)?founded|started|launched|built|build|made|created|run|develop|developed|wrote|maintain|own|designed)`,
  String.raw`(?:i|we)(?:'m| am|'re| are)\s+(?:building|making|developing|creating|working on|launching|running)`,
  String.raw`(?:i|we)(?:'m| am|'re| are)\s+(?:\S+\s+){0,4}?behind`,
  String.raw`(?:i|we)(?:'m| am|'re| are)\s+(?:an?|the)\s+(?:\S+\s+){0,2}?agency|(?:i|we)\s+(?:run|own)\s+(?:an?|the)\s+(?:\S+\s+){0,2}?agency`,
  String.raw`(?:i|we)(?:'ve| have)?\s+partnered\s+with|(?:i|we)(?:'m| am|'re| are)\s+(?:an?\s+)?(?:\S+\s+)?partners?\s+(?:of|with)|(?:my|our)\s+(?:\S+\s+)?partnership\s+with`,
  String.raw`(?:affiliated|associated) with|affiliation|sponsored by|paid (?:by|partnership|promotion)|on behalf of|hired by|(?:i|we) represent`,
  // uk
  String.raw`(?:з|із|зі)\s+команди|(?:в|у)\s+команді|наш\p{L}*\s+команд\p{L}*|моя\s+команда`,
  String.raw`працюю\s+(?:в|у|на|з|із|над)|працював\p{L}*\s+(?:в|у|на|над)`,
  String.raw`(?:я|ми)\s+(?:сам\p{L}*\s+)?(?:створи\p{L}*|розроби\p{L}*|розробля\p{L}*|робимо|роблю|зробив|зробила|зробили|запусти\p{L}*|написав|написала|написали|заснува\p{L}*|веду|ведемо|підтриму\p{L}*)`,
  String.raw`(?:наш|наша|наше|мій|моя|моє)\s+(?:власн\p{L}*\s+)?(?:продукт|сервіс|стартап|компані\p{L}*|агенці\p{L}*|застосун\p{L}*|проєкт|проект|інструмент|клієнт)`,
  String.raw`від\s+імені|афілійован\p{L}*|агенці\p{L}*|спонсор\p{L}*|на\s+замовлення`,
  // ru
  String.raw`(?:из|с)\s+команды|в\s+команде|наш\p{L}*\s+команд\p{L}*|моя\s+команда`,
  String.raw`работаю\s+(?:в|на|с|над)|работал\p{L}*\s+(?:в|на|над)`,
  String.raw`(?:я|мы)\s+(?:сам\p{L}*\s+)?(?:созда\p{L}*|разработа\p{L}*|разрабатыва\p{L}*|делаем|делаю|сделал|сделала|сделали|запусти\p{L}*|написал|написала|написали|основал\p{L}*|ведем|ведём|веду|поддержива\p{L}*)`,
  String.raw`(?:наш|наша|наше|мой|моя|моё|мое)\s+(?:собственн\p{L}*\s+)?(?:продукт|сервис|стартап|компани\p{L}*|агентств\p{L}*|приложени\p{L}*|проект|инструмент|клиент)`,
  String.raw`от\s+имени|аффилирован\p{L}*|агентств\p{L}*|спонсор\p{L}*|по\s+заказу`,
]);
/**
 * Роли-существительные (основатель, владелец, разработчик…): раскрытие,
 * только если роль — автора (`roleLinked`): «I'm/we're … founder», «as the
 * founder», «я/ми/мы засновник», «founder of/at Acme», «Acme founder
 * here», «founder here». «Acme is great for founders» — нет (m2-2).
 */
const ROLE_NOUNS = rx([
  // en
  String.raw`(?:co-?)?founders?|cofounders?|ceo|cto|coo|cmo|cpo|(?:co-?)?owners?|makers?|creators?|maintainers?|employees?|staff member|staff|devs?|developers?|engineers?|authors?|contractors?|interns?`,
  // uk
  String.raw`(?:спів)?засновни\p{L}*|власник|власниця|співвласни\p{L}*|директор\p{L}*|співробітни\p{L}*|працівни\p{L}*|розробни\p{L}*|автор\p{L}*|інженер\p{L}*|програміст\p{L}*`,
  // ru
  String.raw`(?:со)?основател\p{L}*|(?:со)?владел\p{L}*|сотрудни\p{L}*|работник\p{L}*|разработчи\p{L}*|инженер\p{L}*|программист\p{L}*`,
]);
/** «Моё»: продукт/компания автора — раскрытие только рядом с брендом. */
const OWNED_RE = rx([
  String.raw`(?:my|our)\s+(?:own\s+)?(?:company|companies|product|startup|app|tool|service|agency|project|saas|business|employer|platform|extension|plugin|library|site|website|(?:side|pet|passion)[- ]project)`,
  String.raw`(?:a|an)\s+(?:side|pet|passion)[- ]project`,
]);
/** Субъект-автор перед ролью: «I'm the», «we are one of the», «as the», «я». */
const SELF_BEFORE_RE =
  /(?:^|[^\p{L}'])(?:(?:i|we)(?:'m|'re|\s+am|\s+are|\s+was|\s+were|'ve\s+been|\s+have\s+been|\s+had\s+been)(?:\s+\S+){0,4}|as\s+(?:the|a|an|one\s+of\s+the)(?:\s+\S+){0,2}|(?:я|ми|мы)(?:\s+\S+)?)\s*$/u;
const CLAUSE_SPLIT_RE = /[,.;:!?()\n—–]/u;
const ROLE_PREP_RE =
  /^\s*(?:(?:of|at|from|in|@|в|у|на|з|із|из|компанії|компании|команди|команды)\s+)?(?:(?:the|a|an)\s+)?/u;
const CLAUSE_END_RE = /^\s*(?:$|here(?![\p{L}])|[,.;:!?)\n—–])/u;

const wordsOf = (t: string): string[] =>
  t
    .replace(/[,:;()"«»“”„\-—–]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

/** Бренд сразу после роли («founder of Acme», «CEO Demo»). */
function brandRightAfter(rest: string, brand: string | null): boolean {
  if (!brand || weakBrand(brand)) return false;
  const n = squash(brand).split(' ').length;
  const words = rest.replace(ROLE_PREP_RE, '').split(/\s+/u).slice(0, n);
  return brandIn(words.join(' '), brand);
}

/** Текст заканчивается брендом («Acme», «Acme's»). */
function endsWithBrand(before: string, brand: string | null): boolean {
  if (!brand || weakBrand(brand)) return false;
  const n = squash(brand).split(' ').length;
  const words = before.trim().replace(/'s$/u, '').split(/\s+/u).slice(-n);
  return words.length > 0 && brandIn(words.join(' '), brand);
}

/** Роль-существительное — роль автора (аудит m2-2). */
function roleLinked(
  t: string,
  index: number,
  role: string,
  brand: string | null,
): boolean {
  const before = t.slice(0, index).split(CLAUSE_SPLIT_RE).pop() ?? '';
  const after = t.slice(index + role.length);
  if (SELF_BEFORE_RE.test(before)) return true;
  if (/^\s+here(?![\p{L}])/u.test(after)) return true;
  if (brandRightAfter(after, brand)) return true;
  // «Acme founder here», «Disclosure: Acme founder.», «— cofounder.»
  const atEnd = CLAUSE_END_RE.test(after);
  if (atEnd && (endsWithBrand(before, brand) || !before.trim())) return true;
  return false;
}

/** «Моё» (продукт, компания, side project) рядом с брендом брифа. */
function ownedLinked(
  t: string,
  index: number,
  phrase: string,
  brand: string | null,
): boolean {
  if (!brand || weakBrand(brand)) return false;
  const after = wordsOf(t.slice(index + phrase.length)).slice(0, 3);
  if (brandIn(after.join(' '), brand)) return true;
  const before = (t.slice(0, index).split(CLAUSE_SPLIT_RE).pop() ?? '').trim();
  return (
    /(?:^|\s|')(?:is|was|are|s|=)(?:\s+(?:just|basically|actually|really|literally))?$/u.test(
      before,
    ) && brandIn(before.split(/\s+/u).slice(-4).join(' '), brand)
  );
}
/** Чужая роль: «я клієнт», «just a user». */
const CUSTOMER_ROLE = rx([
  String.raw`customers?|clients?|users?|subscribers?|buyers?|fans?|paying`,
  String.raw`клієнт\p{L}*|користувач\p{L}*|покупець|покупниця|передплатни\p{L}*|фанат\p{L}*`,
  String.raw`клиент\p{L}*|пользовател\p{L}*|покупател\p{L}*|подписчи\p{L}*`,
]);

/** Отрицание связи (Р-RD-75): «not affiliated», «не працюю», «just a customer». */
const NEGATION_PHRASES = rx([
  // en
  String.raw`unaffiliated|unsponsored|not\s+(?:\S+\s+){0,2}?(?:affiliated|associated|connected|related|sponsored|paid|employed|involved|linked|tied|endorsed)`,
  String.raw`no\s+(?:\S+\s+)?(?:affiliation|ties|tie|connection|connections|relation|relationship|association|stake|ownership)`,
  String.raw`nothing to disclose|no disclosure|(?:nobody|no one|no-one)\s+(?:paid|sponsored|asked)`,
  String.raw`(?:just|only|simply|merely|purely)\s+(?:a|an)\s+(?:\S+\s+){0,2}?(?:customer|user|fan|client|subscriber|buyer)`,
  String.raw`independent\s+(?:user|reviewer|customer)|not\s+(?:a\s+|an\s+)?(?:shill|ad|advert|advertisement)`,
  String.raw`(?:don't|do not|never)\s+work(?:ed)?\s+(?:at|for|with)`,
  // uk
  String.raw`жодн\p{L}*\s+(?:стосунк\p{L}*|відношенн\p{L}*|зв'язк\p{L}*)|ніяк\p{L}*\s+(?:не\s+)?(?:пов'язан\p{L}*|стосу\p{L}*)`,
  String.raw`не\s+(?:\p{L}+\s+)?(?:пов'язан\p{L}*|афілійован\p{L}*|працюю|працював\p{L}*|засновни\p{L}*|співробітни\p{L}*|розробни\p{L}*|спонсор\p{L}*|реклам\p{L}*)`,
  String.raw`не\s+(?:маю|має|маємо)\s+(?:стосунку|відношення|жодного)|(?:мені|нам)\s+не\s+(?:платили|заплатили|платять)`,
  String.raw`(?:просто|лише|тільки)\s+(?:клієнт\p{L}*|користувач\p{L}*|покуп\p{L}*)`,
  // ru
  String.raw`никак\p{L}*\s+(?:не\s+)?(?:связан\p{L}*|отношени\p{L}*)|никакого\s+(?:отношения|касательства)`,
  String.raw`не\s+(?:\p{L}+\s+)?(?:связан\p{L}*|аффилирован\p{L}*|работаю|работал\p{L}*|основател\p{L}*|сотрудни\p{L}*|разработчи\p{L}*|спонсор\p{L}*|реклам\p{L}*)`,
  String.raw`не\s+(?:имею|имеем|имеет)\s+(?:отношения|никакого)|(?:мне|нам)\s+не\s+(?:платили|заплатили|платят)`,
  String.raw`(?:просто|лишь|только)\s+(?:клиент\p{L}*|пользовател\p{L}*|покупател\p{L}*)`,
]);
/**
 * Явное отрицание аффилированности (раунд 3, S3-R2-1): у founder/employee/
 * agency — всегда `negated`, какие бы слова роли ни стояли рядом.
 */
const EXPLICIT_NEGATION = rx([
  String.raw`not\s+(?:\S+\s+){0,2}?affiliated|no\s+affiliation|zero\s+affiliation|unaffiliated|non-affiliated`,
  String.raw`не\s+(?:\p{L}+\s+)?(?:пов'язан\p{L}*|афілійован\p{L}*|связан\p{L}*|аффилирован\p{L}*)|ніяк\p{L}*\s+не\s+пов'язан\p{L}*|никак\p{L}*\s+не\s+связан\p{L}*`,
]);
/** Слово отрицания прямо перед маркером роли (≤ 3 слов, та же часть фразы). */
const NEG_WORD_RE =
  /(?<![\p{L}'])(?:no|not|never|neither|nor|without|nobody|none|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|can't|cannot|haven't|hasn't|ain't|не|ні|ни|нет|ніколи|никогда|без|жодн\p{L}*|ніяк\p{L}*|никак\p{L}*|ніхто|никто)(?![\p{L}'])/u;

function negatedBefore(t: string, index: number): boolean {
  const clause =
    t
      .slice(0, index)
      .split(/[,.;:!?()\n—–]/u)
      .pop() ?? '';
  const words = clause.trim().split(/\s+/u).slice(-3).join(' ');
  return NEG_WORD_RE.test(words);
}

/** Роль в раскрытии: принято, отрицание/чужая роль, неясно. */
export function disclosureRole(
  disclosure: string,
  affiliation: Affiliation,
  brand: string | null,
): 'ok' | 'negated' | 'unclear' {
  let insider = false;
  let negated = false;
  let customer = false;
  let explicit = false;
  for (const s of sentencesOf(disclosure)) {
    if (/\?\s*\)?$/u.test(s)) continue; // вопрос — не утверждение роли
    const f = formsOf(s);
    // Отрицание — перед фразой или внутри неё («I'm not the founder»).
    const judge = (m: RegExpMatchArray) => {
      if (
        negatedBefore(f.lat, m.index!) ||
        negatedBefore(f.cyr, m.index!) ||
        NEG_WORD_RE.test(m[0])
      )
        negated = true;
      else insider = true;
    };
    const linkedIn = (
      m: RegExpMatchArray,
      fn: (t: string, i: number, p: string, b: string | null) => boolean,
    ) => fn(f.lat, m.index!, m[0], brand) || fn(f.cyr, m.index!, m[0], brand);
    for (const m of matchesIn(INSIDER_STRONG, f)) judge(m);
    for (const m of matchesIn(ROLE_NOUNS, f))
      if (linkedIn(m, roleLinked)) judge(m);
    for (const m of matchesIn(OWNED_RE, f))
      if (linkedIn(m, ownedLinked)) judge(m);
    if (testIn(NEGATION_PHRASES, f)) negated = true;
    if (testIn(CUSTOMER_ROLE, f)) customer = true;
    if (testIn(EXPLICIT_NEGATION, f)) explicit = true;
  }
  if (affiliation === 'customer')
    return customer || negated || insider ? 'ok' : 'unclear';
  if (explicit) return 'negated';
  if (insider) return negated ? 'unclear' : 'ok';
  if (negated || customer) return 'negated';
  return 'unclear';
}

/** Есть маркер роли (без отрицания) — совместимость. */
export function hasAffiliationMarker(text: string): boolean {
  return disclosureRole(text, 'founder', null) === 'ok';
}

/**
 * Причина, по которой раскрытие не принято (null — принято). `unclear` —
 * WARN (подтверждает проверяющий), остальные — BLOCK.
 */
export type DisclosureIssue =
  'empty' | 'too_short' | 'no_brand' | 'negated' | 'not_visible' | 'unclear';

export const DISCLOSURE_WARN_ISSUES: readonly DisclosureIssue[] = ['unclear'];

const FILL = '█';
const fill = (m: string): string => FILL.repeat([...m].length);
/** Разметка, в которой текст виден, но раскрытием не считается. */
const HIDDEN_MARKUP_RE = /~~|\^|`|>!|!<|<!--|^\s*>/u;

/**
 * Засчитываемый для раскрытия текст: спойлеры, комментарии и невидимые
 * символы удалены (не видны, места не занимают); код, зачёркнутое,
 * надстрочный и цитата `>` заменены заполнителем той же длины (видны и
 * занимают место в окне 300 знаков, но раскрытием не являются).
 */
function eligibleText(t: string): string {
  return base(t)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>![\s\S]*?!</g, '')
    .replace(/```[\s\S]*?```/g, fill)
    .replace(/`[^`\n]*`/g, fill)
    .replace(/~~[\s\S]*?~~/g, fill)
    .replace(/\^\([^)]*\)/g, fill)
    .replace(/\^+[^\s]*/g, fill)
    .replace(/^[ \t]*>(?!!).*$/gmu, fill)
    .replace(/^(?: {4}|\t).*$/gmu, fill);
}

/** Форма поиска раскрытия (без свёртки двойников: текст копируется как есть). */
const searchForm = (t: string): string =>
  squash(plainMarkdown(t).replace(APOSTROPHE_RE, "'").toLowerCase());

/**
 * Раскрытие аффилированности (A08, Р-RD-65, Р-RD-75): непусто, ≥ 20
 * знаков, бренд брифа целым словом (если задан), роль без отрицания, и оно
 * НАЧИНАЕТСЯ в первых 300 знаках засчитываемого текста (у поста — с
 * заголовком). Порядок причин: BLOCK раньше WARN.
 */
export function disclosureIssue(
  body: string,
  disclosure: string,
  brand: string | null,
  affiliation: Affiliation = 'founder',
  title: string | null = null,
): DisclosureIssue | null {
  const d = squash(normText(disclosure));
  if (!d) return 'empty';
  if ([...d].length < DISCLOSURE_MIN) return 'too_short';
  if (brand && squash(brand) && !brandIn(disclosure, brand)) return 'no_brand';
  const role = disclosureRole(disclosure, affiliation, brand);
  if (role === 'negated') return 'negated';
  if (HIDDEN_MARKUP_RE.test(base(disclosure))) return 'not_visible';
  const hay = searchForm(
    (title ? eligibleText(title) + '\n' : '') + eligibleText(body),
  );
  const i = hay.indexOf(searchForm(base(disclosure)));
  if (i < 0 || i >= DISCLOSURE_WINDOW) return 'not_visible';
  return role === 'unclear' ? 'unclear' : null;
}

/** Совместимость: раскрытие принято (без требования бренда). */
export function disclosureVisible(body: string, disclosure: string): boolean {
  return disclosureIssue(body, disclosure, null) === null;
}

// ── Гарантии ─────────────────────────────────────────────────────────────

/** Гарантия результата (узкий словарь, Р-RD-80). */
const GUARANTEE_RE = rx([
  // en
  String.raw`guarantee(?:s|d|ing)?(?!\s+(?:of\s+)?(?:memory|type|thread|data|ordering|order|safety|uniqueness|consistency|atomicity|delivery|isolation|durability|termination|correctness|immutability|at[- ]least|at[- ]most|exactly|that the (?:compiler|type|value|function|code|order)))`,
  String.raw`(?:i|we)\s+(?:can\s+)?promise|promise(?:s|d)?\s+(?:you|that|results?|to\s+\p{L}+)`,
  String.raw`assured|assure you|money[- ]back|risk[- ]free|no[- ]risk|zero[- ]risk|can't fail|cannot fail|never fails|works every time|100% (?:guaranteed|results?|success|effective|works)`,
  // uk
  String.raw`гарант\p{L}*(?!\s+(?:безпек\p{L}*|порядок|порядку|цілісн\p{L}*|атомарн\p{L}*|доставк\p{L}*|унікальн\p{L}*))`,
  String.raw`обіця(?:ю|ємо|є|ють)|точно\s+(?:спрацює|допоможе|дасть|принесе)|без\s+ризик\p{L}*|без\s+жодного\s+ризику|повернемо\s+гроші|стовідсотков\p{L}*`,
  // ru
  String.raw`гарант\p{L}*(?!\s+(?:безопасн\p{L}*|порядок|порядка|целостн\p{L}*|атомарн\p{L}*|доставк\p{L}*|уникальн\p{L}*))`,
  String.raw`обеща(?:ю|ем|ет|ют)|точно\s+(?:сработает|поможет|даст|принес[её]т)|без\s+риск\p{L}*|верн[её]м\s+деньги|стопроцентн\p{L}*`,
]);
/** Код: `Promise.all`, `.guarantee(`. */
const CODE_AFTER_RE = /^[.(<]/u;

/** Гарантии текста (без отрицания непосредственно перед словом). */
export function guaranteesIn(text: string): string[] {
  const f = formsOf(text);
  const out: string[] = [];
  for (const m of matchesIn(GUARANTEE_RE, f)) {
    const after = f.lat.slice(m.index! + m[0].length);
    if (CODE_AFTER_RE.test(after) && /^promise/u.test(m[0])) continue;
    if (f.lat[m.index! - 1] === '.') continue;
    const self = /^без/u.test(m[0]);
    const clause =
      f.lat
        .slice(0, m.index)
        .split(/[,.;:!?()\n—–]/u)
        .pop() ?? '';
    const near = clause.trim().split(/\s+/u).slice(-2).join(' ');
    const clauseC =
      f.cyr
        .slice(0, m.index)
        .split(/[,.;:!?()\n—–]/u)
        .pop() ?? '';
    const nearC = clauseC.trim().split(/\s+/u).slice(-2).join(' ');
    if (!self && (NEG_WORD_RE.test(near) || NEG_WORD_RE.test(nearC))) continue;
    out.push(m[0]);
  }
  return out;
}

/** Обещание в утверждении claimMap (гарантия, «100 %», «завжди»). */
const PROMISE_RE =
  /гарант|обіця|обеща|guarantee|promise|100\s?%|завжди|всегда|always|never fails|без ризик|без риск|risk[- ]free/u;

export function hasPromise(text: string): boolean {
  const f = formsOf(text);
  return PROMISE_RE.test(f.lat) || PROMISE_RE.test(f.cyr);
}

// ── Числа результата ─────────────────────────────────────────────────────

export function hasNumber(text: string): boolean {
  return /\p{Nd}/u.test(base(text));
}

/** Число в нормальной форме: без пробелов и разделителей тысяч, `,` → `.`. */
function normNumber(raw: string): string {
  const s = raw.replace(/[\s  ]/g, '');
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '');
  return s.replace(',', '.').replace(/^0+(?=\d)/, '');
}

/** Утверждение с числом: значение и единица (`%`, `money`, `x`, `''`). */
export interface ResultNumber {
  value: string;
  unit: '%' | 'money' | 'x' | '';
  raw: string;
}

const NUM = String.raw`\d+(?:[   ]\d{3})*(?:[.,]\d+)?`;
const MULT = String.raw`(?:times|раз(?:а|и|ів)?)`;
const COMPARATIVE = String.raw`(?:more|faster|better|cheaper|higher|lower|less|bigger|larger|over|as|the|більше|швидше|менше|дешевше|вище|більш|ефективн\p{L}*|больше|быстрее|меньше|дешевле|выше|эффективн\p{L}*)`;
const PERCENT_RE = new RegExp(
  String.raw`(${NUM})\s?(?:%|percent(?![\p{L}])|per cent(?![\p{L}])|pct(?![\p{L}])|відсот\p{L}*|процент\p{L}*)`,
  'gu',
);
const CUR = String.raw`(?:[$€£₴₽]|(?<![\p{L}])(?:usd|eur|uah|грн)(?![\p{L}]))`;
const CUR_AFTER = String.raw`(?:[$€£₴₽]|usd(?![\p{L}])|eur(?![\p{L}])|uah(?![\p{L}])|грн\.?|гривен\p{L}*|гривн\p{L}*|руб\p{L}*|dollars?(?![\p{L}])|bucks(?![\p{L}])|euros?(?![\p{L}])|доларів|долларов|євро|евро)`;
const SCALE = String.raw`(?:\s?(?:k|m|mm|bn|тис\.?|тыс\.?|млн|млрд)(?![\p{L}]))?`;
const MONEY_RE = new RegExp(
  String.raw`${CUR}\s?(${NUM})${SCALE}|(${NUM})${SCALE}\s?${CUR_AFTER}`,
  'gu',
);
const MULT_RE = new RegExp(
  String.raw`(${NUM})\s?[x×](?![\p{L}\p{N}])|(${NUM})\s?${MULT}\s+${COMPARATIVE}(?![\p{L}])|(?<![\p{L}])(?:в|у)\s+(${NUM})\s+раз(?:а|и|ів)?(?![\p{L}])|(${NUM})-?fold(?![\p{L}])`,
  'gu',
);
/** Множители словами (значение — канон). */
const WORD_MULT: ReadonlyArray<[RegExp, string]> = [
  [
    /(?<![\p{L}-])(?:doubl(?:e|es|ed|ing)|twice\s+as|вдвічі|удвічі|вдвоє|подво\p{L}*|вдвое|удво\p{L}*)(?![\p{L}-])/gu,
    '2',
  ],
  [
    /(?<![\p{L}-])(?:tripl(?:e|es|ed|ing)|втричі|утричі|втроє|потро\p{L}*|втрое|утро(?:ит|ить|или|ил|ение)\p{L}*)(?![\p{L}-])/gu,
    '3',
  ],
  [/(?<![\p{L}-])(?:quadrupl\p{L}*|вчетверо|вчетверо)(?![\p{L}-])/gu, '4'],
  [/(?<![\p{L}-])(?:ten-?fold|в\s+десятки\s+раз)(?![\p{L}-])/gu, '10'],
  [
    /(?<![\p{L}-])(?:in\s+half|halved|навпіл|вполовину|наполовину|вдвічі\s+менше)(?![\p{L}-])/gu,
    '0.5',
  ],
  [/(?<![\p{L}-])(?:в\s+рази|у\s+рази|в\s+разы)(?![\p{L}-])/gu, 'many'],
];
/** Слова результата (рядом с ними число — утверждение о результате). */
const RESULT_WORD_RE = rx([
  String.raw`roi|revenue|sales|profits?|income|earnings?|conversions?|leads|signups|sign-ups|traffic|growth|grow|grows|grew|grown|increase[sd]?|increasing|boost(?:s|ed)?|save[sd]?|saving|savings|cut|cuts|reduce[sd]?|reduction|faster|cheaper|uplift|ctr|engagement|mrr|arr|gmv|payback|new customers|more customers|new clients|more clients`,
  String.raw`дохід\p{L}*|доход\p{L}*|прибут\p{L}*|продаж\p{L}*|конверсі\p{L}*|ліди|лідів|трафік\p{L}*|зрост\p{L}*|зріс|збільш\p{L}*|економ\p{L}*|зеконом\p{L}*|заощад\p{L}*|скорот\p{L}*|швидше|дешевше|виручк\p{L}*|окупн\p{L}*|нових\s+клієнтів|більше\s+клієнтів`,
  String.raw`прибыл\p{L}*|конверси\p{L}*|лид(?:ы|ов)|трафик\p{L}*|рост\p{L}*|вырос\p{L}*|увелич\p{L}*|эконом\p{L}*|сэконом\p{L}*|сократ\p{L}*|быстрее|дешевле|выручк\p{L}*|окупаем\p{L}*|новых\s+клиентов|больше\s+клиентов`,
]);
/** Числительные en/uk/ru (раунд 3): «three hundred percent», «у десять разів». */
const NUMERAL: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  один: 1,
  одна: 1,
  одну: 1,
  два: 2,
  дві: 2,
  две: 2,
  три: 3,
  чотири: 4,
  четыре: 4,
  "п'ять": 5,
  пять: 5,
  шість: 6,
  шесть: 6,
  сім: 7,
  семь: 7,
  вісім: 8,
  восемь: 8,
  "дев'ять": 9,
  девять: 9,
  десять: 10,
  двадцять: 20,
  двадцать: 20,
  тридцять: 30,
  тридцать: 30,
  сорок: 40,
  "п'ятдесят": 50,
  пятьдесят: 50,
  сто: 100,
  двісті: 200,
  двести: 200,
  триста: 300,
  чотириста: 400,
  четыреста: 400,
  "п'ятсот": 500,
  пятьсот: 500,
  тисяча: 1000,
  тисячу: 1000,
  тысяча: 1000,
  тысячу: 1000,
};
const NUM_WORD = Object.keys(NUMERAL)
  .sort((a, b) => b.length - a.length)
  .join('|');
const NUM_SEQ = String.raw`(?:${NUM_WORD})(?:(?:\s+|-)(?:and\s+)?(?:${NUM_WORD}))*`;
/** Значение последовательности числительных («three hundred» → 300). */
function numeralValue(seq: string): number {
  let total = 0;
  let cur = 0;
  for (const w of seq.split(/[\s-]+/u)) {
    const n = NUMERAL[w];
    if (n === undefined) continue;
    if (n === 100) cur = (cur || 1) * 100;
    else if (n === 1000) {
      total += (cur || 1) * 1000;
      cur = 0;
    } else cur += n;
  }
  return total + cur;
}
const WORD_NUM_RES: ReadonlyArray<[RegExp, ResultNumber['unit']]> = [
  [
    new RegExp(
      String.raw`(?<![\p{L}'])(${NUM_SEQ})\s+(?:percent|per cent|відсот\p{L}*|процент\p{L}*)`,
      'gu',
    ),
    '%',
  ],
  [
    new RegExp(
      String.raw`(?<![\p{L}'])(${NUM_SEQ})\s+${MULT}\s+${COMPARATIVE}(?![\p{L}])|(?<![\p{L}])(?:в|у)\s+(${NUM_SEQ})\s+раз(?:а|и|ів)?(?![\p{L}])|(?<![\p{L}'])(${NUM_SEQ})-?fold(?![\p{L}])`,
      'gu',
    ),
    'x',
  ],
];
/** «Сотні годин», «hundreds of hours» рядом со словом результата. */
const MANY_RE =
  /(?<![\p{L}])(?:hundreds|thousands|millions|dozens|сотні|сотень|сотни|сотен|тисячі|тисяч|тысячи|тысяч|десятки|мільйони|миллионы)(?![\p{L}])/gu;
/** Правильная дробь `1/3` рядом со словом результата. */
const FRACTION_RE = /(?<![\p{N}/.])(\d{1,3})\s*\/\s*(\d{1,3})(?![\p{N}/])/gu;

const AGREE_RE =
  /(?:agree|sure|honest|correct|right|true|згоден|згодна|впевнен\p{L}*|согласен|согласна|уверен\p{L}*)/u;

const GLUED_UNIT_RE =
  /^\d+(?:k|m|mm|bn|x|тис|тыс|млн|млрд|раз\p{L}*|грн|uah|usd|eur|руб\p{L}*|percent|pct|відсот\p{L}*|процент\p{L}*|times|fold)$/u;

/** Маскировка «не утверждений»: версии, годы, время, склейки, списки. */
function maskNonClaims(t: string): string {
  const blank = (m: string): string => ' '.repeat(m.length);
  return (
    t
      // markers@4 (аудит m2-8): периодичность («every 30 seconds») и
      // «2x longer/slower» — не результат.
      .replace(
        /(?<![\p{L}])(?:every|each|кожн\p{L}*|каждые|каждый|каждую|каждое)\s+\d+(?:[.,]\d+)?/gu,
        blank,
      )
      .replace(
        /\d+(?:[.,]\d+)?\s?(?:[x×]|times|рази?|раза)\s+(?:longer|slower|harder|worse|more\s+(?:expensive|time|work|effort|code)|as\s+long|довше|повільніше|дольше|медленнее)(?![\p{L}])/gu,
        blank,
      )
      .replace(/(?:^|(?<=[\s:;,(]))\d{1,2}\)(?=\s)/gmu, blank)
      .replace(/^\s*\d{1,2}\.(?=\s)/gmu, blank)
      .replace(/(?:^|\s)\/?[ru]\/\S+/gu, blank)
      .replace(/[\p{L}\p{N}._-]*@\d+(?:\.\d+)*\S*/gu, blank)
      .replace(
        /(?<![\p{L}\p{N}])(?:node(?:\.?js)?|python|ios|android|java|php|ruby|go|rust|react|vue|angular|next\.?js|nuxt|django|rails|laravel|postgres(?:ql)?|mysql|windows|macos|ubuntu|debian|chrome|firefox|safari|es|ecmascript|typescript|ts|\.net|dotnet|version|release|versions|lts|api|http|tls|ssl|ipv|gpt|claude|gemini|llama|iphone|pixel|galaxy|версі\p{L}*|верси\p{L}*)\s*v?\d+(?:\.\d+)*(?:\s*(?:lts|beta|rc\d*))?/gu,
        blank,
      )
      .replace(/(?<![\p{L}\p{N}])v\d+(?:\.\d+)*/gu, blank)
      .replace(/\d+(?:\.\d+){2,}[\w.+-]*/gu, blank)
      .replace(/\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm))?/gu, blank)
      .replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/gu, blank)
      .replace(/\d+\s*\/\s*\d+/gu, blank)
      .replace(
        /(?<![\p{L}])(?:in|since|from|by|until|till|of|around|during|before|after|early|late|mid|в|у|з|із|с|до|від|от|після|после|перед|q[1-4])\s+(?:19|20)\d{2}(?![\p{N}]|[.,]\d)|(?<![\p{N}.,$€£₴₽])(?:19|20)\d{2}\s+(?:year|рік|року|год|году|р\.|г\.)/gu,
        blank,
      )
      .replace(/(?<![\p{L}\p{N}])\d{1,2}\s?(?:am|pm)(?![\p{L}])/gu, blank)
      .replace(/(?![x×]\d+(?![\p{L}]))[\p{L}]+-?\d+[\p{L}\p{N}]*/gu, blank)
      .replace(/\d+-(?!fold)(?=\p{L})[\p{L}\p{N}]+/gu, blank)
      .replace(/\d+(?=\p{L})[\p{L}\p{N}]+/gu, (m) =>
        GLUED_UNIT_RE.test(m) ? m : blank(m),
      )
  );
}

/**
 * Числа результата предложения (Р-RD-78): проценты, деньги, множители (и
 * словами — «triple», «вдвічі» — рядом со словом результата или «your/ваш»),
 * число рядом со словом результата (± 4 слова). Версии, годы, время,
 * `B2B`, `GPT-4`, `24/7`, коды и маркеры списков — не утверждения.
 */
export function resultNumbersIn(text: string): ResultNumber[] {
  const f = formsOf(text);
  const out: ResultNumber[] = [];
  const seen = new Set<string>();
  const add = (value: string, unit: ResultNumber['unit'], raw: string) => {
    const k = `${value}|${unit}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ value, unit, raw: raw.trim() });
  };
  for (const form of [f.lat, f.cyr]) {
    let t = maskNonClaims(form);
    const take = (re: RegExp, unit: ResultNumber['unit']) => {
      t = t.replace(re, (m: string, ...g: unknown[]) => {
        const at = g[g.length - 2] as number;
        const v = g
          .slice(0, -2)
          .find((x) => typeof x === 'string' && /\d/.test(x));
        if (typeof v === 'string') {
          const value = normNumber(v);
          const ctx = form.slice(Math.max(0, at - 25), at + m.length + 25);
          if (!(unit === '%' && value === '100' && AGREE_RE.test(ctx)))
            add(value, unit, m);
        }
        return ' '.repeat(m.length);
      });
    };
    const resultAt = [...form.matchAll(RESULT_WORD_RE)].map((m) => ({
      s: m.index!,
      e: m.index! + m[0].length,
    }));
    const near = (s: number, e: number) => {
      const before = form.slice(0, s).split(/\s+/u).slice(-5).join(' ');
      const after = form.slice(e).split(/\s+/u).slice(0, 5).join(' ');
      const from = s - before.length;
      const to = e + after.length;
      return resultAt.some((r) => r.e > from && r.s < to);
    };
    // Дроби — до маскировки (`24/7` и прочие неправильные — не утверждения).
    for (const m of form.matchAll(FRACTION_RE))
      if (+m[1] < +m[2] && near(m.index!, m.index! + m[0].length))
        add(`${+m[1]}/${+m[2]}`, '', m[0]);
    take(PERCENT_RE, '%');
    take(MONEY_RE, 'money');
    take(MULT_RE, 'x');
    for (const [re, unit] of WORD_NUM_RES)
      t = t.replace(re, (m: string, ...g: unknown[]) => {
        const seq = g.slice(0, -2).find((x) => typeof x === 'string');
        if (typeof seq === 'string') add(String(numeralValue(seq)), unit, m);
        return ' '.repeat(m.length);
      });
    for (const m of t.matchAll(MANY_RE))
      if (near(m.index!, m.index! + m[0].length)) add(m[0], '', m[0]);
    for (const [re, value] of WORD_MULT)
      for (const m of t.matchAll(re)) {
        const s = m.index!;
        const e = s + m[0].length;
        const yours = /^\s+(?:your|ваш\p{L}*|твій|твой|твою|твоє)/u.test(
          form.slice(e),
        );
        if (near(s, e) || yours) add(value, 'x', m[0]);
      }
    for (const m of t.matchAll(/\p{Nd}+(?:[   ]\d{3})*(?:[.,]\d+)?/gu)) {
      if (near(m.index!, m.index! + m[0].length))
        add(normNumber(m[0]), '', m[0]);
    }
  }
  return out;
}

/** Совместимость: значения чисел результата. */
export function numbersIn(text: string): string[] {
  return resultNumbersIn(text).map((n) => n.value);
}

/**
 * Все значения чисел текста (источник пункта claimMap, аудит m2-7): числа
 * результата (в т. ч. словами — «triple», «three hundred percent») и любые
 * числа цифрами (`1,400` → `1400`, `4,5` → `4.5`).
 */
export function numberValuesIn(text: string): string[] {
  if (!text) return [];
  const out = new Set(resultNumbersIn(text).map((n) => n.value));
  for (const m of base(text).matchAll(/\p{Nd}+(?:[   ]\d{3})*(?:[.,]\d+)?/gu))
    out.add(normNumber(m[0]));
  return [...out];
}

/** То же число: значение совпадает, единица та же или одна из них пустая. */
export function sameNumber(a: ResultNumber, b: ResultNumber): boolean {
  return a.value === b.value && (a.unit === b.unit || !a.unit || !b.unit);
}

const STOP_STEMS = new Set([
  'that',
  'this',
  'with',
  'from',
  'your',
  'have',
  'will',
  'more',
  'than',
  'they',
  'them',
  'what',
  'when',
  'вашо',
  'ваши',
  'якщо',
  'если',
  'цей',
  'этот',
]);
const stems = (t: string, brand: string | null): Set<string> => {
  const b = brand ? squash(normText(brand)) : '';
  return new Set(
    normText(t)
      .split(/[^\p{L}]+/u)
      .filter((w) => [...w].length >= 4 && w !== b)
      .map((w) => [...w].slice(0, 4).join(''))
      .filter((w) => !STOP_STEMS.has(w)),
  );
};

/**
 * Предложение — о том же, что пункт claimMap (Р-RD-78): есть общая основа
 * слова (4 буквы, без бренда и служебных) — число из пункта разрешает
 * только «своё» утверждение.
 */
export function sameStatement(
  sentence: string,
  claim: string,
  brand: string | null,
): boolean {
  const a = stems(sentence, brand);
  for (const s of stems(claim, brand)) if (a.has(s)) return true;
  return false;
}

// ── Контакты в Reddit-тексте ─────────────────────────────────────────────

const EMAIL_RE =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+|рф|укр|рус)(?![\p{L}\p{N}-]|:)/iu;
const HANDLE_RE =
  /(?<![\p{L}\p{N}_.\/@-])@([a-z][a-z0-9_]{4,31})(?![\p{L}\p{N}_\/@.(-])/giu;
const CODE_ANNOTATIONS = new Set([
  'override',
  'deprecated',
  'media',
  'import',
  'keyframes',
  'param',
  'return',
  'returns',
  'throws',
  'author',
  'since',
  'example',
  'apply',
  'tailwind',
  'layer',
  'supports',
  'mixin',
  'include',
  'extend',
  'before',
  'after',
  'input',
  'output',
  'component',
  'injectable',
  'property',
  'decorator',
  'charset',
  'font-face',
  'container',
  'typedef',
  'template',
]);
const MESSENGER_RE = new RegExp(PII_RULE.messenger);
const PHONE_RE = new RegExp(PII_RULE.phone);

/**
 * Контакт в Reddit-тексте (Р-RD-81): e-mail с доменной зоной (не
 * `git@host:repo`), `@handle` (не `@scope/pkg`, не `pkg@1.2.3`, не
 * аннотация кода), мессенджер и телефон по `PII_RULE` (после вырезания
 * дат, сумм и версий).
 */
export function redditContact(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = base(text).replace(/\s*[[(]\s*at\s*[\])]\s*/giu, '@');
  if (EMAIL_RE.test(t) || MESSENGER_RE.test(t)) return true;
  for (const m of t.matchAll(HANDLE_RE))
    if (!CODE_ANNOTATIONS.has(m[1].toLowerCase())) return true;
  const noVersions = t
    .replace(/[\p{L}\p{N}._-]*@\d+(?:\.\d+)*\S*/gu, ' ')
    .replace(/(?<![\p{L}\p{N}.])v?\d{1,3}\.\d{1,3}\.\d{1,4}(?![.\d])/gu, ' ')
    .replace(/(?<!\d)\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}(?!\d)/gu, ' ');
  return PHONE_RE.test(piiStripTokens(noVersions));
}

// ── Оскорбления и похожесть ──────────────────────────────────────────────

/**
 * Словарь оскорблений uk/ru/en (стартовый — утверждает владелец). Только
 * явные ругательства и оскорбления адресата; WARN, а не BLOCK.
 */
const OFFENSIVE_V1: readonly string[] = [
  // en
  'idiot',
  'stupid',
  'moron',
  'dumbass',
  'shut up',
  'loser',
  'scam artist',
  'fuck',
  'shit',
  // uk
  'ідіот',
  'дурень',
  'дебіл',
  'тупий',
  'придурок',
  'лох',
  'заткнись',
  // ru
  'идиот',
  'дурак',
  'дебил',
  'тупой',
  'придурок',
  'заткнись',
];

export function offensiveWords(text: string | null | undefined): string[] {
  if (!text) return [];
  const f = formsOf(text);
  return OFFENSIVE_V1.filter((w) =>
    testIn(new RegExp(`(?<![\\p{L}])${w}`, 'gu'), f),
  );
}

/** Запрещённое брифом утверждение в тексте (обе свёртки, S3-2). */
export function containsPhrase(text: string, phrase: string): boolean {
  const tf = formsOf(text);
  const pf = formsOf(phrase);
  return (['lat', 'cyr'] as const).some((k) => {
    const p = squash(pf[k]);
    return [...p].length >= 3 && squash(tf[k]).includes(p);
  });
}

/** Слова текста (≥ 3 букв/цифр) для похожести (Жаккар). */
export function wordSet(text: string): Set<string> {
  return new Set(
    normText(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Порог «дубля» (§M2.4: Жаккар ≥ 0,6 за 90 дней). */
export const DUPLICATE_JACCARD = 0.6;
export const DUPLICATE_WINDOW_DAYS = 90;
