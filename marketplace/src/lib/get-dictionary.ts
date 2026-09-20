import { defaultLocale, type Locale } from './i18n';
import ru from '../dictionaries/ru.json';
import uk from '../dictionaries/uk.json';
import en from '../dictionaries/en.json';
import de from '../dictionaries/de.json';
import es from '../dictionaries/es.json';

// Все пять словарей статические, попадают в бандл целиком — тот же приём
// и то же обоснование, что в landing/src/lib/get-dictionary.ts.
const dictionaries: Record<Locale, typeof ru> = { ru, uk, en, de, es };

// Тип строится по русскому словарю — он же исходник для остальных.
// Отставание другого языка по форме (пропущенный ключ) — явная ошибка
// типов в dictionaries/*.json, а не молчаливый undefined в рантайме.
export type Dictionary = typeof ru;

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries[defaultLocale];
}
