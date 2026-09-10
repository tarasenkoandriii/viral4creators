import { defaultLocale, type Locale } from './i18n';
import ru from '../dictionaries/ru.json';
import uk from '../dictionaries/uk.json';
import en from '../dictionaries/en.json';
import de from '../dictionaries/de.json';
import es from '../dictionaries/es.json';

// Все пять словарей статические и попадают в бандл целиком — их суммарный
// вес (текст лендинга × 5 языков) на два порядка меньше одной картинки,
// поэтому асинхронная догрузка по локали (как в некоторых next-intl
// сетапах) здесь не нужна: она усложнила бы код ради экономии, которой
// физически неоткуда взяться.
const dictionaries: Record<Locale, typeof ru> = { ru, uk, en, de, es };

// Тип строится по русскому словарю — он же исходник для остальных
// (см. lib/i18n.ts). Если словарь другого языка отстанет по форме
// (пропущенный ключ), это конкретная и явная ошибка типов в
// dictionaries/*.json, а не молчаливый undefined в рантайме.
export type Dictionary = typeof ru;

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries[defaultLocale];
}
