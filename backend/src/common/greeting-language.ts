/**
 * Язык поздравления — этап C ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.8 (Г-5).
 *
 * ## Зачем отдельное поле
 *
 * До этапа C язык текста не выбирался вовсе: промпт жёстко просил «на
 * русском языке», а озвучка угадывала язык по буквам (`detectLanguage`).
 * Угадывание ломается ровно там, где продукт продаёт: испанский текст
 * `detectLanguage` читает как английский (у него нет испанских примет),
 * короткий украинский без «і/ї/є/ґ» — как русский. Язык получателя к тому
 * же не обязан совпадать с языком интерфейса автора: бабушка в Харькове,
 * внук в Берлине.
 *
 * ## Правило
 *
 * 1. Язык из брифа (`scriptLanguage`), если задан.
 * 2. Иначе — язык интерфейса, в котором создана сессия.
 * 3. Иначе — `DEFAULT_LOCALE`.
 *
 * Озвучка берёт тот же язык явно; `detectLanguage` остаётся запасным —
 * только когда алфавит текста спорит с выбранным языком (свой текст
 * человека на кириллице при выбранном английском). Озвучить кириллицу
 * английским голосом хуже, чем довериться буквам.
 */

import {
  DEFAULT_LOCALE,
  LOCALE_LANGUAGE_NAMES,
  SUPPORTED_LOCALES,
  SupportedLocale,
  isSupportedLocale,
} from './locale';
import { detectLanguage } from './voiceover';
import type {
  GreetingOccasion,
  GreetingRegister,
} from './types/greeting.types';

export type GreetingScriptLanguage = SupportedLocale;
export const GREETING_SCRIPT_LANGUAGES = SUPPORTED_LOCALES;

export function isGreetingScriptLanguage(
  v: unknown,
): v is GreetingScriptLanguage {
  return typeof v === 'string' && isSupportedLocale(v);
}

/** Язык текста сессии: бриф → язык интерфейса сессии → умолчание. */
export function scriptLanguageOf(
  brief: { scriptLanguage?: string | null } | null | undefined,
  sessionLocale?: string | null,
): GreetingScriptLanguage {
  if (isGreetingScriptLanguage(brief?.scriptLanguage))
    return brief!.scriptLanguage;
  if (isGreetingScriptLanguage(sessionLocale)) return sessionLocale;
  return DEFAULT_LOCALE;
}

/**
 * Название языка для русскоязычного промпта: «на украинском языке
 * (Ukrainian)». Английское имя рядом — та же находка, что в
 * `common/locale.ts`: голый код `uk` модель читает как «United Kingdom».
 */
const LANGUAGE_PREPOSITIONAL_RU: Readonly<
  Record<GreetingScriptLanguage, string>
> = {
  ru: 'русском',
  uk: 'украинском',
  en: 'английском',
  de: 'немецком',
  es: 'испанском',
};

export function scriptLanguageForPrompt(lang: GreetingScriptLanguage): string {
  return `на ${LANGUAGE_PREPOSITIONAL_RU[lang]} языке (${LOCALE_LANGUAGE_NAMES[lang]})`;
}

const CYRILLIC_LANGS: ReadonlySet<string> = new Set(['ru', 'uk']);

/**
 * Язык озвучки. Выбранный язык — главный сигнал; буквы текста — только
 * страховка от явного противоречия алфавитов (см. шапку файла).
 */
export function speechLanguage(
  chosen: GreetingScriptLanguage,
  speech: string | null | undefined,
): string {
  const guessed = detectLanguage(speech);
  if (!guessed) return chosen;
  const chosenCyr = CYRILLIC_LANGS.has(chosen);
  const guessedCyr = CYRILLIC_LANGS.has(guessed);
  if (chosenCyr !== guessedCyr) return guessed;
  return chosen;
}

/**
 * Запасные тексты — когда модель не ответила или дважды ответила не в
 * регистре (§3.7). Язык × регистр = 25 строк, плюс две деликатные
 * особые строки (извинение, выздоровление) на язык — всего 35.
 *
 * Праздничная строка намеренно НЕ подставляет название повода: подпись
 * повода живёт только по-русски, а «поздравляем с День рождения» было
 * грамматической ошибкой и в русском варианте.
 *
 * Правила регистров соблюдены и здесь, а не только в промпте: у
 * деликатного и траурного — ни поздравлений, ни восклицательных знаков
 * (проверяется `textFitsRegister` в тестах для всех строгих строк).
 */
type FallbackKind = GreetingRegister | 'APOLOGY' | 'GET_WELL';

const FALLBACKS: Readonly<
  Record<GreetingScriptLanguage, Readonly<Record<FallbackKind, string>>>
> = {
  ru: {
    CELEBRATORY: '{name}, поздравляем! Пусть всё будет хорошо.',
    WARM_NEUTRAL: '{name}, эти слова — для вас.',
    SOLEMN: '{name}, этот день важен для нас. Спасибо, что вы есть.',
    SENSITIVE: '{name}, эти слова — от всего сердца. Мы рядом.',
    MOURNING: '{name}, примите наши искренние соболезнования. Мы рядом.',
    APOLOGY: '{name}, простите нас. Нам действительно жаль.',
    GET_WELL: '{name}, сил вам и скорейшего выздоровления.',
  },
  uk: {
    CELEBRATORY: '{name}, вітаємо! Нехай усе буде добре.',
    WARM_NEUTRAL: '{name}, ці слова — для вас.',
    SOLEMN: '{name}, цей день важливий для нас. Дякуємо, що ви є.',
    SENSITIVE: '{name}, ці слова — від щирого серця. Ми поруч.',
    MOURNING: '{name}, прийміть наші щирі співчуття. Ми поруч.',
    APOLOGY: '{name}, пробачте нас. Нам справді шкода.',
    GET_WELL: '{name}, сил вам і якнайшвидшого одужання.',
  },
  en: {
    CELEBRATORY: '{name}, congratulations! Wishing you all the best.',
    WARM_NEUTRAL: '{name}, these words are for you.',
    SOLEMN: '{name}, this day matters to us. Thank you for being you.',
    SENSITIVE: '{name}, these words come from the heart. We are here for you.',
    MOURNING:
      '{name}, please accept our deepest condolences. We are here for you.',
    APOLOGY: '{name}, we are truly sorry. Please forgive us.',
    GET_WELL: '{name}, sending you strength and wishing you a speedy recovery.',
  },
  de: {
    CELEBRATORY: '{name}, herzlichen Glückwunsch! Alles Gute für dich.',
    WARM_NEUTRAL: '{name}, diese Worte sind für dich.',
    SOLEMN: '{name}, dieser Tag bedeutet uns viel. Danke, dass es dich gibt.',
    SENSITIVE: '{name}, diese Worte kommen von Herzen. Wir sind für dich da.',
    MOURNING: '{name}, unser aufrichtiges Beileid. Wir sind für dich da.',
    APOLOGY: '{name}, es tut uns wirklich leid. Bitte verzeih uns.',
    GET_WELL: '{name}, wir wünschen dir viel Kraft und gute Besserung.',
  },
  es: {
    CELEBRATORY: '{name}, ¡felicidades! Te deseamos lo mejor.',
    WARM_NEUTRAL: '{name}, estas palabras son para ti.',
    SOLEMN: '{name}, este día es importante para nosotros. Gracias por estar.',
    SENSITIVE: '{name}, estas palabras salen del corazón. Estamos contigo.',
    MOURNING: '{name}, te acompañamos en el sentimiento. Estamos contigo.',
    APOLOGY: '{name}, lo sentimos de verdad. Por favor, perdónanos.',
    GET_WELL: '{name}, te enviamos fuerza y deseamos que te recuperes pronto.',
  },
};

export function fallbackKind(
  occasion: GreetingOccasion,
  register: GreetingRegister,
): FallbackKind {
  if (occasion === 'APOLOGY') return 'APOLOGY';
  if (occasion === 'GET_WELL') return 'GET_WELL';
  return register;
}

export function localizedFallback(
  lang: GreetingScriptLanguage,
  occasion: GreetingOccasion,
  register: GreetingRegister,
  recipientName: string,
): string {
  return FALLBACKS[lang][fallbackKind(occasion, register)].replace(
    '{name}',
    recipientName,
  );
}

/** Для тестов: все строки таблицы. */
export function allFallbacks(): Array<{
  lang: GreetingScriptLanguage;
  kind: FallbackKind;
  text: string;
}> {
  return (Object.keys(FALLBACKS) as GreetingScriptLanguage[]).flatMap((lang) =>
    (Object.keys(FALLBACKS[lang]) as FallbackKind[]).map((kind) => ({
      lang,
      kind,
      text: FALLBACKS[lang][kind],
    })),
  );
}
