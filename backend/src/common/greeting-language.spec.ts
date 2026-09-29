/**
 * Язык поздравления — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.8 (Г-5).
 */
import {
  allFallbacks,
  localizedFallback,
  scriptLanguageForPrompt,
  scriptLanguageOf,
  speechLanguage,
} from './greeting-language';
import { fallbackMessage } from './greeting-occasions';
import { textFitsRegister } from './greeting-policy';
import { GREETING_REGISTERS } from './types/greeting.types';
// Снимок — отдельный модуль, но язык в нём проверяется здесь же: файл
// про язык, и путь «строка брифа → снимок» — часть этого пути.
import { greetingBriefSnapshotFrom } from '../modules/project-session/snapshot';

describe('scriptLanguageOf — откуда берётся язык', () => {
  it('язык брифа главнее языка интерфейса', () => {
    expect(scriptLanguageOf({ scriptLanguage: 'de' }, 'ru')).toBe('de');
  });
  it('без языка в брифе — язык интерфейса сессии', () => {
    expect(scriptLanguageOf({ scriptLanguage: null }, 'uk')).toBe('uk');
    expect(scriptLanguageOf({}, 'es')).toBe('es');
  });
  it('мусор в базе не протаскивается дальше', () => {
    expect(scriptLanguageOf({ scriptLanguage: 'klingon' }, 'en')).toBe('en');
    expect(scriptLanguageOf({ scriptLanguage: 'klingon' }, 'xx')).toBe('ru');
    expect(scriptLanguageOf(null, null)).toBe('ru');
  });
});

describe('scriptLanguageForPrompt', () => {
  it('украинский назван явно — «uk» модель читала как Великобританию', () => {
    expect(scriptLanguageForPrompt('uk')).toBe(
      'на украинском языке (Ukrainian)',
    );
    expect(scriptLanguageForPrompt('es')).toContain('Spanish');
  });
});

describe('speechLanguage — озвучка', () => {
  /**
   * Сама причина поля: `detectLanguage` не знает испанских примет и
   * читает испанский текст как английский.
   */
  it('испанский текст озвучивается по-испански, а не по-английски', () => {
    expect(speechLanguage('es', 'Querida Marta, te deseamos lo mejor.')).toBe(
      'es',
    );
  });
  it('короткий украинский без «і/ї/є/ґ» — украинский, а не русский', () => {
    expect(speechLanguage('uk', 'Мамо, ми тебе любимо')).toBe('uk');
  });
  it('кириллица при выбранном английском — доверяем буквам', () => {
    expect(speechLanguage('en', 'Марина, с днём рождения')).toBe('ru');
  });
  it('латиница при выбранном русском — тоже буквам', () => {
    expect(speechLanguage('ru', 'Happy birthday, Marina')).toBe('en');
  });
  it('пустой текст — выбранный язык', () => {
    expect(speechLanguage('de', '')).toBe('de');
  });
});

describe('запасные тексты: язык × регистр', () => {
  it('5 языков × (5 регистров + извинение + выздоровление)', () => {
    expect(allFallbacks()).toHaveLength(35);
  });

  it('у каждой строки есть имя получателя', () => {
    for (const f of allFallbacks()) expect(f.text).toContain('{name}');
  });

  /**
   * Правила регистра действуют и на запасной текст: иначе на провале
   * модели траурный ролик получил бы «поздравляем!» на любом языке.
   */
  it('строгие регистры проходят ту же проверку, что текст модели', () => {
    const strict = ['SENSITIVE', 'MOURNING', 'APOLOGY', 'GET_WELL'];
    for (const f of allFallbacks().filter((x) => strict.includes(x.kind))) {
      expect([f.lang, f.kind, textFitsRegister('MOURNING', f.text)]).toEqual([
        f.lang,
        f.kind,
        true,
      ]);
    }
  });

  it('праздничная строка на каждом языке действительно праздничная', () => {
    for (const f of allFallbacks().filter((x) => x.kind === 'CELEBRATORY')) {
      expect([f.lang, textFitsRegister('MOURNING', f.text)]).toEqual([
        f.lang,
        false,
      ]);
    }
  });

  it('соболезнование по-немецки говорит о соболезновании', () => {
    expect(localizedFallback('de', 'CONDOLENCE', 'MOURNING', 'Anna')).toMatch(
      /Beileid/,
    );
    expect(fallbackMessage('CONDOLENCE', 'Anna', 'x', null, 'de')).toMatch(
      /Beileid/,
    );
  });

  it('извинение и выздоровление — свои строки, а не общий деликатный текст', () => {
    expect(fallbackMessage('APOLOGY', 'Ana', 'x', null, 'es')).toMatch(
      /perdón|siento/i,
    );
    expect(fallbackMessage('GET_WELL', 'Ana', 'x', null, 'uk')).toMatch(
      /одужання/,
    );
  });

  it('«Особый повод» по регистру: траурный — без поздравления на любом языке', () => {
    for (const lang of ['ru', 'uk', 'en', 'de', 'es'] as const) {
      const t = fallbackMessage('OTHER', 'Anna', 'x', 'MOURNING', lang);
      expect(textFitsRegister('MOURNING', t)).toBe(true);
    }
  });

  it('без языка — по-русски, как до этапа C', () => {
    expect(fallbackMessage('CONDOLENCE', 'Марина', 'x')).toMatch(
      /соболезнован/,
    );
  });

  it('праздничный текст больше не склеивает «поздравляем с День рождения»', () => {
    expect(
      fallbackMessage('BIRTHDAY', 'Марина', 'День рождения'),
    ).not.toContain('с День');
  });

  it('все регистры покрыты таблицей', () => {
    for (const r of GREETING_REGISTERS) {
      expect(localizedFallback('en', 'OTHER', r, 'X').length).toBeGreaterThan(
        5,
      );
    }
  });
});

describe('снимок брифа несёт язык (этап C)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Anna',
    senderName: null,
    tone: 'WARM',
    personalMessage: null,
    presenterProvider: 'grok',
    resolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    ...over,
  });
  it('копирует выбранный язык', () => {
    expect(
      greetingBriefSnapshotFrom(row({ scriptLanguage: 'de' })).scriptLanguage,
    ).toBe('de');
  });
  it('неизвестное значение из базы — «не выбран»', () => {
    expect(
      greetingBriefSnapshotFrom(row({ scriptLanguage: 'xx' })).scriptLanguage,
    ).toBeNull();
    expect(greetingBriefSnapshotFrom(row({})).scriptLanguage).toBeNull();
  });
});

describe('приметы праздника на других языках не задевают траур', () => {
  it.each([
    'Wir denken an dich und sehen uns bei der Trauerfeier.',
    'We gather to celebrate his life and remember him with love.',
    'Unser aufrichtiges Beileid.',
  ])('«%s» подходит траурному регистру', (text) => {
    expect(textFitsRegister('MOURNING', text)).toBe(true);
  });
  it.each([
    'Herzlichen Glückwunsch zum Geburtstag',
    'Muchas felicidades, Ana',
    'Feliz cumpleaños',
  ])('«%s» — праздник', (text) => {
    expect(textFitsRegister('MOURNING', text)).toBe(false);
  });
});
