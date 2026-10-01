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
 */
export type Dictionary = typeof uk;

const dictionaries: Record<Locale, Dictionary> = { uk, en, ru };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
