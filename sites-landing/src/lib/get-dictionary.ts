import { BRAND_IS_PLACEHOLDER, brandDisplayName } from '../brand';
import type { Locale } from './i18n';
import uk from '../dictionaries/uk.json';
import en from '../dictionaries/en.json';
import ru from '../dictionaries/ru.json';

/**
 * Словари uk/en/ru (ТЗ §11). Тип строится по украинскому — он исходник
 * (первый рынок). Отставший по форме словарь — ошибка типов здесь, а
 * паритет ключей, длин массивов, `claim` и плейсхолдеров — ещё и
 * `scripts/dictionaries.test.ts` (JSON-импорт типизирует массивы
 * объединением, и пропуск поля в одном элементе тип не ловит).
 *
 * Все словари — только на сервере: клиентским компонентам (FAQ, форма)
 * страница передаёт ровно нужные строки пропсами.
 *
 * Имя бренда (Р-З15-1). `getDictionary()` отдаёт строки, где `{brand}`
 * УЖЕ подставлен — `brandDisplayName(locale)`: настоящее имя после В-1,
 * а пока бренд — заглушка, родовое имя продукта на языке страницы. Так
 * имя на языке страницы получают и серверные страницы, и клиентские
 * компоненты (им строки приходят пропсами), а `fmt()` локали знать не
 * нужно. Пока бренд — заглушка, сначала применяется раздел словаря
 * `brandFallback` («путь.к.строке» → текст): там, где родовое имя на
 * месте `{brand}` дало бы тавтологию («ШІ-помічника ШІ-помічник для
 * сайту») или неверный падеж («Бот обходу ШІ-помічник…»), — вариант той
 * же строки без имени. Суффикс имени сайта у заголовков страниц
 * (`pages.*.title`, «Пілот ШІ-помічника — {brand}») при заглушке
 * срезается, если заголовок уже называет помощника (`trimBrandSuffix`):
 * иначе в `<title>`/`og:title` — «Пілот ШІ-помічника — ШІ-помічник для
 * сайту»; имя сайта остаётся в `og:site_name`. После В-1 оба приёма не
 * действуют.
 */
export type Dictionary = typeof uk;

const raw: Record<Locale, Dictionary> = { uk, en, ru };
const resolved = new Map<Locale, Dictionary>();

const BRAND_RE = /\{brand\}/g;

function substituteBrand<T>(value: T, name: string): T {
  if (typeof value === 'string') return value.replace(BRAND_RE, () => name) as T;
  if (Array.isArray(value)) return value.map((v) => substituteBrand(v, name)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteBrand(v, name)])) as T;
  }
  return value;
}

/**
 * Применяет `brandFallback` к копии словаря. Путь, которого нет, или
 * строка без `{brand}` — ошибка сборки: устаревшая замена молча
 * переписала бы чужой текст.
 */
export function applyBrandFallback(dict: Dictionary, locale: string): Dictionary {
  const out = structuredClone(dict) as Dictionary;
  for (const [p, text] of Object.entries(dict.brandFallback as Record<string, string>)) {
    const keys = p.split('.');
    let node: unknown = out;
    for (const k of keys.slice(0, -1)) node = (node as Record<string, unknown> | undefined)?.[k];
    const last = keys[keys.length - 1];
    const target = (node as Record<string, unknown> | undefined)?.[last];
    if (typeof target !== 'string') throw new Error(`brandFallback (${locale}): нет строки «${p}»`);
    if (!target.includes('{brand}')) throw new Error(`brandFallback (${locale}): в «${p}» нет {brand} — замена лишняя`);
    (node as Record<string, unknown>)[last] = text;
  }
  return out;
}

/** Слова, которыми заголовок уже называет продукт (uk/ru/en). */
export const ASSISTANT_WORD = /помічник|помощник|assistant/i;
const BRAND_SUFFIX = / — \{brand\}$/;

/** «Пілот ШІ-помічника — {brand}» → «Пілот ШІ-помічника»; прочее — как есть. */
export function trimBrandSuffix(title: string): string {
  return BRAND_SUFFIX.test(title) && ASSISTANT_WORD.test(title.replace(BRAND_SUFFIX, '')) ? title.replace(BRAND_SUFFIX, '') : title;
}

function trimPageTitles(dict: Dictionary): Dictionary {
  const pages = Object.fromEntries(
    Object.entries(dict.pages).map(([k, v]) => [k, typeof v.title === 'string' ? { ...v, title: trimBrandSuffix(v.title) } : v]),
  ) as Dictionary['pages'];
  return { ...dict, pages };
}

export function getDictionary(locale: Locale): Dictionary {
  let dict = resolved.get(locale);
  if (!dict) {
    const base = BRAND_IS_PLACEHOLDER ? trimPageTitles(applyBrandFallback(raw[locale], locale)) : raw[locale];
    dict = substituteBrand(base, brandDisplayName(locale));
    resolved.set(locale, dict);
  }
  return dict;
}
