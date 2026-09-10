import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  languageNameForLocale,
  localeFromHeader,
  localeFromRequest,
  LOCALE_LANGUAGE_NAMES,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from './locale';

describe('SUPPORTED_LOCALES / LOCALE_LANGUAGE_NAMES', () => {
  it('has an explicit English name for every supported locale (§35.1 finding)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_LANGUAGE_NAMES[locale]).toEqual(expect.any(String));
      expect(LOCALE_LANGUAGE_NAMES[locale].length).toBeGreaterThan(0);
    }
  });

  it('defaults to Russian — the existing audience, not English', () => {
    expect(DEFAULT_LOCALE).toBe('ru');
  });
});

describe('isSupportedLocale', () => {
  it('accepts only the five product locales', () => {
    expect(isSupportedLocale('ru')).toBe(true);
    expect(isSupportedLocale('uk')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('de')).toBe(true);
    expect(isSupportedLocale('es')).toBe(true);
  });

  it('rejects unknown, empty or missing values', () => {
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});

describe('normalizeLocale', () => {
  it('passes supported locales through unchanged', () => {
    expect(normalizeLocale('uk')).toBe('uk');
    expect(normalizeLocale('es')).toBe('es');
  });

  it('falls back to DEFAULT_LOCALE for unknown or missing values — never throws', () => {
    expect(normalizeLocale('fr')).toBe('ru');
    expect(normalizeLocale(null)).toBe('ru');
    expect(normalizeLocale(undefined)).toBe('ru');
    expect(normalizeLocale('')).toBe('ru');
  });
});

describe('languageNameForLocale', () => {
  it('returns the explicit English language name for supported locales', () => {
    expect(languageNameForLocale('ru')).toBe('Russian');
    expect(languageNameForLocale('uk')).toBe('Ukrainian');
    expect(languageNameForLocale('en')).toBe('English');
    expect(languageNameForLocale('de')).toBe('German');
    expect(languageNameForLocale('es')).toBe('Spanish');
  });

  it('returns an unknown locale code as-is, not silently swapped for the default (honest-fallback contract, grok-translation-prompt.spec.ts)', () => {
    expect(languageNameForLocale('fr')).toBe('fr');
  });
});

/** Г-5.2 (аудит 2026-09-08): локаль запроса из Accept-Language. */
describe('localeFromHeader', () => {
  it('распознаёт голый код локали — то, что реально шлёт фронтенд', () => {
    expect(localeFromHeader('en')).toBe('en');
    expect(localeFromHeader('uk')).toBe('uk');
  });

  it('берёт первый язык из полного HTTP-формата, игнорируя регион и q', () => {
    expect(localeFromHeader('en-US,en;q=0.9')).toBe('en');
    expect(localeFromHeader('de-DE')).toBe('de');
  });

  it('массив заголовков (Express может отдать так) — берёт первый элемент', () => {
    expect(localeFromHeader(['es', 'en'])).toBe('es');
  });

  it('отсутствие заголовка или незнакомая локаль — DEFAULT_LOCALE, не throw', () => {
    expect(localeFromHeader(undefined)).toBe(DEFAULT_LOCALE);
    expect(localeFromHeader('fr-FR')).toBe(DEFAULT_LOCALE);
    expect(localeFromHeader('')).toBe(DEFAULT_LOCALE);
  });
});

describe('localeFromRequest', () => {
  it('читает accept-language из express-подобного запроса', () => {
    expect(localeFromRequest({ headers: { 'accept-language': 'de' } })).toBe(
      'de',
    );
  });

  it('запрос без headers вообще (частый мок в тестах) — DEFAULT_LOCALE, не throw', () => {
    expect(localeFromRequest({})).toBe(DEFAULT_LOCALE);
  });
});
