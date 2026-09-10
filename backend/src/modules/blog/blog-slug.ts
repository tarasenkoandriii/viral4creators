/**
 * Слаг статьи блога (doc/TODO.md §II.3: "Модель BlogPost (slug, ...)").
 * Заголовки — обычно русские (генератор пишет `originalLocale: 'ru'`),
 * поэтому нужна транслитерация, а не просто вырезание нелатинских
 * символов: голое `[^a-z0-9]+` съело бы русский заголовок целиком и
 * оставило пустую строку, что не годится для `@@unique` в схеме.
 *
 * Схема — распространённая веб-транслитерация (не ГОСТ/ISO 9 — те
 * рассчитаны на паспортные документы и дают менее читаемые URL);
 * покрывает русский и украинский алфавиты, так как ручные записи (TODO
 * §II.3: "тот же экран управляет ручными записями") могут быть на любом
 * языке продукта.
 */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
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
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const MAX_SLUG_LENGTH = 80;

function transliterate(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) {
    out += TRANSLIT[ch] ?? ch;
  }
  return out;
}

/** Заголовок → URL-слаг: транслитерация, затем нормализация в [a-z0-9-]. */
export function slugify(title: string): string {
  return transliterate(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // срез по длине мог обрезать посреди дефиса
}

/**
 * Слаг для конкретного черновика. `disambiguator` (обычно videoId или
 * короткий случайный суффикс) добавляется всегда, а не только при
 * коллизии: `BlogPost.slug` уникален (`@@unique`), а два похожих
 * заголовка за разные дни — обычное дело для потока трендовых роликов, и
 * проверять занятость слага отдельным запросом к базе ради «красивого»
 * URL без суффикса не стоит опасности гонки между параллельными
 * прогонами крона.
 */
export function blogSlugFor(title: string, disambiguator: string): string {
  const base = slugify(title) || 'post';
  const suffix = slugify(disambiguator) || disambiguator.slice(0, 12);
  return `${base}-${suffix}`.slice(0, MAX_SLUG_LENGTH);
}
