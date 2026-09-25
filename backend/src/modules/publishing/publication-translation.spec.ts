import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  buildPublicationTranslationPrompt,
  parsePublicationTranslations,
  targetLocales,
} from './publication-translation';

/**
 * Перевод метаданных ролика (этап 137). Разбор чужого JSON — самое
 * вероятное место поломки во всей затее, и проверяется он здесь, а не
 * через сетевой вызов.
 */
describe('targetLocales', () => {
  it('язык оригинала в список переводов не попадает', () => {
    // Он уже лежит в самом snippet; дубль — лишнее место для расхождения.
    expect(targetLocales('uk')).toEqual(['ru', 'en', 'de', 'es']);
    expect(targetLocales('en')).toEqual(['ru', 'uk', 'de', 'es']);
    expect(targetLocales('uk')).not.toContain('uk');
  });
});

describe('buildPublicationTranslationPrompt', () => {
  it('называет язык оригинала, все цели и потолок заголовка', () => {
    const prompt = buildPublicationTranslationPrompt(
      { title: 'Кружка Steel 500', description: 'Стальная термокружка' },
      'ru',
    );
    expect(prompt).toContain('Russian');
    expect(prompt).toContain('uk (Ukrainian)');
    expect(prompt).toContain('de (German)');
    expect(prompt).toContain(String(TITLE_MAX));
    // Исходник уезжает как JSON — иначе перевод ломается на кавычках и
    // переводах строки в описании.
    expect(prompt).toContain(
      JSON.stringify({
        title: 'Кружка Steel 500',
        description: 'Стальная термокружка',
      }),
    );
  });

  it('длинный исходник режется до потолков площадки ещё в промпте', () => {
    const prompt = buildPublicationTranslationPrompt(
      { title: 'т'.repeat(300), description: 'о'.repeat(9000) },
      'ru',
    );
    expect(prompt).not.toContain('т'.repeat(TITLE_MAX + 1));
    expect(prompt).not.toContain('о'.repeat(DESCRIPTION_MAX + 1));
  });
});

describe('parsePublicationTranslations', () => {
  const ok = JSON.stringify({
    uk: { title: 'Кухоль', description: 'Опис' },
    en: { title: 'Mug', description: 'Description' },
  });

  it('берёт знакомые локали, отбрасывая язык оригинала и незнакомые', () => {
    const out = parsePublicationTranslations(
      JSON.stringify({
        uk: { title: 'Кухоль', description: 'Опис' },
        ru: { title: 'Кружка', description: 'Описание' },
        fr: { title: 'Tasse', description: 'Description' },
      }),
      'ru',
    );
    expect(Object.keys(out)).toEqual(['uk']);
  });

  it('снимает ```json-забор, которым модель иногда оборачивает ответ', () => {
    const out = parsePublicationTranslations('```json\n' + ok + '\n```', 'ru');
    expect(out.en?.title).toBe('Mug');
  });

  it('локализация без заголовка отбрасывается целиком', () => {
    // YouTube не принимает локализацию без заголовка, а описание пустым
    // быть может — как и у оригинала.
    const out = parsePublicationTranslations(
      JSON.stringify({
        uk: { title: '   ', description: 'Опис' },
        en: { title: 'Mug' },
      }),
      'ru',
    );
    expect(out.uk).toBeUndefined();
    expect(out.en).toEqual({ title: 'Mug', description: '' });
  });

  it('режет перевод по тем же потолкам, что и оригинал', () => {
    const out = parsePublicationTranslations(
      JSON.stringify({
        en: { title: 'M'.repeat(200), description: 'D'.repeat(9000) },
      }),
      'ru',
    );
    expect(out.en?.title.length).toBe(TITLE_MAX);
    expect(out.en?.description.length).toBe(DESCRIPTION_MAX);
  });

  it('мусор вместо ответа — пустая карта, а не исключение', () => {
    // Локализация не обязана ронять публикацию (приёмка этапа).
    for (const raw of ['', 'извините, не могу', '[1,2]', '{нет']) {
      expect(parsePublicationTranslations(raw, 'ru')).toEqual({});
    }
    expect(
      parsePublicationTranslations(JSON.stringify({ en: 'Mug' }), 'ru'),
    ).toEqual({});
  });
});
