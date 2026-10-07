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

/**
 * Словарь для клиентского дерева (`DictionaryProvider` в
 * `app/[locale]/layout.tsx`) — без текстов секции «Вы в кадре».
 *
 * Зачем: всё, что серверный layout отдаёт клиентскому компоненту
 * пропсом, Next сериализует в RSC-данные КАЖДОЙ страницы — они лежат
 * в HTML скриптом `self.__next_f.push(...)`. Словарь целиком уходит
 * провайдеру, и без этой вырезки тексты `greetingsLanding.persona`
 * (о лице, селфи и голосе) были бы в исходнике главной, блога и самой
 * страницы поздравлений задолго до юридического шлюза (§5.2 п.5 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`). Клиентским
 * компонентам эти тексты не нужны и после шлюза: секцию и дополнения
 * к «Данным» рисует серверная страница, поэтому вырезаются всегда, а не
 * по константе. Держит `scripts/greeting-sections.test.ts`.
 *
 * Тем же приёмом вырезается `compare` — таблица сравнения с категориями
 * альтернатив (за `COMPARE_SECTION_ENABLED`, `lib/greeting-sections.ts`):
 * её утверждения о рынке подтверждает владелец, и до включения их не
 * должно быть в HTML. Рисует её тоже только серверная страница. Держит
 * `scripts/greeting-compare.test.ts`.
 */
export type ClientDictionary = Omit<Dictionary, 'greetingsLanding'> & {
  greetingsLanding: Omit<Dictionary['greetingsLanding'], 'persona' | 'compare'>;
};

export function clientDictionary(dict: Dictionary): ClientDictionary {
  const { persona, compare, ...greetingsLanding } = dict.greetingsLanding;
  void persona;
  void compare;
  return { ...dict, greetingsLanding };
}
