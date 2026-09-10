import {
  detectLanguage,
  isKnownLanguage,
  languageName,
  resolveVoiceoverLanguage,
  voiceoverBriefText,
} from './voiceover';
import type { ProductInformation } from './types/product.types';

const product = (
  over: Partial<ProductInformation> = {},
): ProductInformation => ({
  productName: 'Термокружка',
  productDescription: 'Стальная термокружка на 500 мл, держит тепло 12 часов.',
  addedAt: new Date(),
  ...over,
});

describe('detectLanguage', () => {
  it.each([
    ['Стальна термокружка, тримає тепло 12 годин, зручна кришка', 'uk'],
    ['Стальная термокружка, держит тепло 12 часов', 'ru'],
    ['Steel travel mug, keeps drinks hot for 12 hours', 'en'],
    ['Kubek termiczny ze stali, trzyma ciepło przez 12 godzin', 'pl'],
    ['Thermobecher aus Stahl, hält 12 Stunden warm', 'de'],
    ['Çelik termos bardak, 12 saat sıcak tutar', 'tr'],
    ['ステンレスのタンブラー', 'ja'],
    ['12', null],
    ['', null],
    [null, null],
  ])('%s → %s', (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });
});

describe('languageName / isKnownLanguage', () => {
  it('maps codes, tolerates region suffixes, passes unknown codes through', () => {
    expect(languageName('uk')).toBe('Ukrainian');
    expect(languageName('pt-BR')).toBe('Portuguese');
    expect(languageName('EN')).toBe('English');
    expect(languageName('xx')).toBe('xx');
    expect(isKnownLanguage('uk')).toBe(true);
    expect(isKnownLanguage('xx')).toBe(false);
  });
});

describe('resolveVoiceoverLanguage', () => {
  it('user choice > country language > description script > English', () => {
    expect(
      resolveVoiceoverLanguage(
        product({ dialogueLanguage: 'en', languageCode: 'uk' }),
      ),
    ).toEqual({
      language: 'en',
      languageName: 'English',
      source: 'user',
    });
    expect(resolveVoiceoverLanguage(product({ languageCode: 'uk' }))).toEqual({
      language: 'uk',
      languageName: 'Ukrainian',
      source: 'country',
    });
    expect(resolveVoiceoverLanguage(product())).toEqual({
      language: 'ru',
      languageName: 'Russian',
      source: 'description',
    });
    expect(
      resolveVoiceoverLanguage(
        product({ productDescription: '12', productName: '500' }),
      ),
    ).toEqual({
      language: 'en',
      languageName: 'English',
      source: 'default',
    });
    expect(resolveVoiceoverLanguage(undefined).source).toBe('default');
  });
});

describe('voiceoverBriefText', () => {
  it('names the language, quotes the description, adds brand voice when given', () => {
    const text = voiceoverBriefText(
      product({ languageCode: 'uk' }),
      ' спокойный женский голос, без сленга ',
    );
    expect(text).toContain('language: Ukrainian');
    expect(text).toContain('must be in Ukrainian');
    expect(text).toContain(
      '"""Стальная термокружка на 500 мл, держит тепло 12 часов."""',
    );
    expect(text).toContain('Brand voice: спокойный женский голос, без сленга');
    expect(text).toContain('verbatim');
  });
  it('omits the brand line without notes and returns empty without a product', () => {
    expect(voiceoverBriefText(product(), null)).not.toContain('Brand voice');
    expect(voiceoverBriefText(undefined, 'x')).toBe('');
  });
});
