import {
  buildArticleTranslationPrompt,
  languageNameForLocale,
  LOCALE_LANGUAGE_NAMES,
} from './grok-translation-prompt';

describe('languageNameForLocale / LOCALE_LANGUAGE_NAMES', () => {
  it('пять локалей продукта — явные названия языков, не ISO-коды', () => {
    expect(LOCALE_LANGUAGE_NAMES).toEqual({
      ru: 'Russian',
      uk: 'Ukrainian',
      en: 'English',
      de: 'German',
      es: 'Spanish',
    });
  });

  it('"uk" — Ukrainian, а не United Kingdom (реальный баг solar-shop, который это и предотвращает)', () => {
    expect(languageNameForLocale('uk')).toBe('Ukrainian');
    expect(languageNameForLocale('uk')).not.toMatch(/kingdom/i);
  });

  it('неизвестный код локали — возвращается как есть, а не подменяется молча', () => {
    expect(languageNameForLocale('fr')).toBe('fr');
  });
});

describe('buildArticleTranslationPrompt', () => {
  it('содержит явное имя языка, заголовок, тело и требование строгого JSON-ответа', () => {
    const prompt = buildArticleTranslationPrompt({
      targetLocale: 'de',
      title: 'Как снять вирусное видео',
      bodyHtml: '<p>Текст статьи</p>',
    });
    expect(prompt).toContain('into German');
    expect(prompt).toContain('Как снять вирусное видео');
    expect(prompt).toContain('<p>Текст статьи</p>');
    expect(prompt).toContain('{"title": string, "bodyHtml": string}');
    // HTML-разметку менять нельзя — промпт обязан это явно требовать.
    expect(prompt).toMatch(/translate text content only/i);
  });
});
