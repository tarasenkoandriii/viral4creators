/**
 * Политика правил ролика по регистру — этап B ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md.
 *
 * «Перебрать все варианты» из запроса владельца здесь буквальное: тест
 * перебирает 24 повода × 5 тонов × наклейка × 3 вида музыки × 1–4 сцены
 * и сверяет вердикт политики с ОТДЕЛЬНО записанной таблицей ожиданий
 * (ORACLE ниже), а не с самой политикой — иначе тест проверял бы код
 * этим же кодом.
 */
import {
  GREETING_OCCASIONS,
  GREETING_REGISTERS,
  GREETING_TONES,
  GreetingOccasion,
  GreetingRegister,
  GreetingTone,
} from './types/greeting.types';
import { GREETING_OCCASION_SPECS, fallbackMessage } from './greeting-occasions';
import {
  OTHER_MOOD_REQUIRED,
  REGISTER_POLICY,
  catalogThemeAllowed,
  evaluateGreetingPolicy,
  greetingPolicyView,
  mourningKeyword,
  otherMoodMissing,
  presenterExpression,
  registerOfBrief,
  resolveBriefRegister,
  resolveOtherRegister,
  stricterRegister,
  textFitsRegister,
  toneRefusal,
} from './greeting-policy';
import { buildStoryboard } from './greeting-scenes';
import { buildGreetingFramePrompt } from '../modules/greeting-reference/greeting-frame-prompt';

/** Таблица §3.2–§3.3 ТЗ, переписанная руками. */
const ORACLE_REGISTER: Record<
  Exclude<GreetingOccasion, 'OTHER'>,
  GreetingRegister
> = {
  BIRTHDAY: 'CELEBRATORY',
  WEDDING: 'CELEBRATORY',
  ANNIVERSARY: 'CELEBRATORY',
  NEW_YEAR: 'CELEBRATORY',
  CHRISTMAS: 'CELEBRATORY',
  GRADUATION: 'CELEBRATORY',
  VALENTINES_DAY: 'CELEBRATORY',
  WOMENS_DAY: 'CELEBRATORY',
  MOTHERS_DAY: 'CELEBRATORY',
  FATHERS_DAY: 'CELEBRATORY',
  TEACHERS_DAY: 'CELEBRATORY',
  FIRST_SCHOOL_DAY: 'CELEBRATORY',
  NEW_BABY: 'CELEBRATORY',
  HOUSEWARMING: 'CELEBRATORY',
  PROMOTION: 'CELEBRATORY',
  RETIREMENT: 'CELEBRATORY',
  CORPORATE: 'CELEBRATORY',
  FAREWELL_COLLEAGUE: 'WARM_NEUTRAL',
  DEFENDERS_DAY: 'SOLEMN',
  BAPTISM: 'SOLEMN',
  APOLOGY: 'SENSITIVE',
  GET_WELL: 'SENSITIVE',
  CONDOLENCE: 'MOURNING',
};

const ORACLE_TONES: Record<GreetingOccasion, GreetingTone[]> = {
  BIRTHDAY: ['WARM', 'FUNNY', 'FORMAL'],
  WEDDING: ['WARM', 'FUNNY', 'FORMAL'],
  ANNIVERSARY: ['WARM', 'FUNNY', 'FORMAL'],
  NEW_YEAR: ['WARM', 'FUNNY', 'FORMAL'],
  CHRISTMAS: ['WARM', 'FUNNY', 'FORMAL'],
  GRADUATION: ['WARM', 'FUNNY', 'FORMAL'],
  VALENTINES_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  WOMENS_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  MOTHERS_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  FATHERS_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  TEACHERS_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  FIRST_SCHOOL_DAY: ['WARM', 'FUNNY', 'FORMAL'],
  NEW_BABY: ['WARM', 'FUNNY', 'FORMAL'],
  HOUSEWARMING: ['WARM', 'FUNNY', 'FORMAL'],
  PROMOTION: ['WARM', 'FUNNY', 'FORMAL'],
  RETIREMENT: ['WARM', 'FUNNY', 'FORMAL'],
  CORPORATE: ['FORMAL', 'WARM', 'FUNNY'],
  FAREWELL_COLLEAGUE: ['WARM', 'FUNNY', 'FORMAL'],
  DEFENDERS_DAY: ['WARM', 'FORMAL', 'RESPECTFUL'],
  BAPTISM: ['WARM', 'FORMAL', 'RESPECTFUL'],
  APOLOGY: ['RESPECTFUL', 'WARM'],
  GET_WELL: ['SUPPORTIVE', 'WARM'],
  CONDOLENCE: ['RESPECTFUL', 'SUPPORTIVE'],
  // OTHER без регистра — тёплый нейтральный
  OTHER: ['WARM', 'FUNNY', 'FORMAL'],
};

const ORACLE_OTHER_TONES: Record<GreetingRegister, GreetingTone[]> = {
  CELEBRATORY: ['WARM', 'FUNNY', 'FORMAL'],
  WARM_NEUTRAL: ['WARM', 'FUNNY', 'FORMAL'],
  SOLEMN: ['WARM', 'FORMAL', 'RESPECTFUL'],
  SENSITIVE: ['WARM', 'SUPPORTIVE', 'RESPECTFUL'],
  MOURNING: ['RESPECTFUL', 'SUPPORTIVE'],
};

const ORACLE_STICKERS: Record<GreetingRegister, boolean> = {
  CELEBRATORY: true,
  WARM_NEUTRAL: true,
  SOLEMN: false,
  SENSITIVE: false,
  MOURNING: false,
};

const ORACLE_MAX_SCENES: Record<GreetingRegister, number> = {
  CELEBRATORY: 4,
  WARM_NEUTRAL: 4,
  SOLEMN: 3,
  SENSITIVE: 2,
  MOURNING: 2,
};

/** Общая тема каталога (`occasions: null`) — кому открыта. */
const ORACLE_UNIVERSAL_THEME: Record<GreetingRegister, boolean> = {
  CELEBRATORY: true,
  WARM_NEUTRAL: true,
  SOLEMN: false,
  SENSITIVE: false,
  MOURNING: false,
};

const MUSIC = [
  { name: 'тема повода', source: 'catalog' as const, own: true },
  { name: 'общая тема', source: 'catalog' as const, own: false },
  { name: 'свой файл', source: 'upload' as const, own: false },
];

describe('каталог: регистр у каждого повода — как в ТЗ', () => {
  it.each(GREETING_OCCASIONS.filter((o) => o !== 'OTHER'))('%s', (occasion) => {
    expect(GREETING_OCCASION_SPECS[occasion].register).toBe(
      ORACLE_REGISTER[occasion as Exclude<GreetingOccasion, 'OTHER'>],
    );
  });

  it('«Особый повод» без регистра — тёплый нейтральный, не праздник (Г-1)', () => {
    expect(registerOfBrief({ occasion: 'OTHER' })).toBe('WARM_NEUTRAL');
    expect(GREETING_OCCASION_SPECS.OTHER.festive).toBe(false);
  });
});

describe('перебор всех комбинаций: 24 × 5 × 2 × 3 × 4', () => {
  let checked = 0;
  for (const occasion of GREETING_OCCASIONS) {
    const register: GreetingRegister =
      occasion === 'OTHER' ? 'WARM_NEUTRAL' : ORACLE_REGISTER[occasion];
    for (const tone of GREETING_TONES) {
      for (const sticker of [false, true]) {
        for (const music of MUSIC) {
          for (let scenes = 1; scenes <= 4; scenes++) {
            const expected = {
              tone: ORACLE_TONES[occasion].includes(tone),
              sticker: !sticker || ORACLE_STICKERS[register],
              music:
                music.source !== 'catalog' ||
                music.own ||
                ORACLE_UNIVERSAL_THEME[register],
              scenes: scenes <= ORACLE_MAX_SCENES[register],
            };
            const verdict = evaluateGreetingPolicy({
              occasion,
              tone,
              sticker,
              music: {
                source: music.source,
                occasions:
                  music.source === 'catalog'
                    ? music.own
                      ? [occasion]
                      : null
                    : undefined,
              },
              sceneCount: scenes,
            });
            const got = {
              tone: !verdict.violations.some((v) => v.field === 'tone'),
              sticker: !verdict.violations.some((v) => v.field === 'sticker'),
              music: !verdict.violations.some((v) => v.field === 'music'),
              scenes: !verdict.violations.some((v) => v.field === 'sceneCount'),
            };
            checked++;
            if (JSON.stringify(got) !== JSON.stringify(expected)) {
              it(`${occasion}/${tone}/${sticker ? 'наклейка' : '—'}/${music.name}/${scenes}`, () => {
                expect(got).toEqual(expected);
              });
            }
          }
        }
      }
    }
  }
  it('перебрано ровно 2880 комбинаций, расхождений нет', () => {
    expect(checked).toBe(2880);
  });

  it('«Особый повод» × 5 регистров × 5 тонов', () => {
    for (const register of GREETING_REGISTERS) {
      for (const tone of GREETING_TONES) {
        const v = evaluateGreetingPolicy({
          occasion: 'OTHER',
          occasionRegister: register,
          tone,
        });
        expect(v.ok).toBe(ORACLE_OTHER_TONES[register].includes(tone));
      }
    }
  });
});

describe('«Особый повод»: регистр только поднимается (§3.4)', () => {
  it('пример владельца: «похороны бабушки» + юмор — отказ с объяснением', () => {
    const r = resolveOtherRegister({ text: 'похороны бабушки' });
    expect(r.register).toBe('MOURNING');
    expect(r.source).toBe('keywords');
    const msg = toneRefusal('OTHER', r.register, 'FUNNY', r.keyword);
    expect(msg).toMatch(/похорон/);
    expect(msg).toMatch(/недоступен/);
  });

  it.each([
    ['поминки по дедушке', 'ru'],
    ['слова співчуття родині', 'uk'],
    ['funeral of my uncle', 'en'],
    ['Beileid zum Verlust', 'de'],
    ['mi más sentido pésame', 'es'],
    ['светлая память маме', 'ru'],
  ])('ключевое слово «%s» (%s) поднимает до траура', (text) => {
    expect(resolveOtherRegister({ text }).register).toBe('MOURNING');
  });

  it.each([
    'до смерти рада за тебя',
    'умереть со смеху, какой ты молодец',
    'защита диплома',
    'жалоба на соседей решена в нашу пользу',
  ])('обычный текст «%s» трауром не становится', (text) => {
    expect(mourningKeyword(text)).toBeNull();
  });

  it('выбор человека «траурный» не опускается праздничным классификатором', () => {
    const r = resolveOtherRegister({
      user: 'MOURNING',
      text: 'встреча',
      classifier: 'CELEBRATORY',
    });
    expect(r.register).toBe('MOURNING');
    expect(r.source).toBe('user');
  });

  it('классификатор может только поднять', () => {
    expect(
      resolveOtherRegister({
        user: 'CELEBRATORY',
        text: 'прощание',
        classifier: 'SENSITIVE',
      }).register,
    ).toBe('SENSITIVE');
    expect(
      resolveOtherRegister({
        user: 'SOLEMN',
        text: 'x',
        classifier: 'CELEBRATORY',
      }).register,
    ).toBe('SOLEMN');
  });

  it('stricterRegister — порядок строгости', () => {
    expect(stricterRegister('CELEBRATORY', 'MOURNING')).toBe('MOURNING');
    expect(stricterRegister('MOURNING', 'CELEBRATORY')).toBe('MOURNING');
    expect(stricterRegister('SOLEMN', null)).toBe('SOLEMN');
  });

  it('классификатор не зовут, когда поднимать уже некуда', async () => {
    let calls = 0;
    const r = await resolveBriefRegister(
      { occasion: 'OTHER', customOccasionText: 'похороны' },
      async () => {
        calls++;
        return 'CELEBRATORY';
      },
    );
    expect(calls).toBe(0);
    expect(r.occasionRegister).toBe('MOURNING');
  });

  it('готовый ответ классификатора переиспользуется, повторного вызова нет', async () => {
    let calls = 0;
    const r = await resolveBriefRegister(
      {
        occasion: 'OTHER',
        customOccasionText: 'прощание с дедушкой',
        knownClassifier: 'MOURNING',
      },
      async () => {
        calls++;
        return null;
      },
    );
    expect(calls).toBe(0);
    expect(r.occasionRegister).toBe('MOURNING');
    expect(r.registerSource).toBe('classifier');
  });

  it('у каталожных поводов регистр в брифе не хранится', async () => {
    const r = await resolveBriefRegister({
      occasion: 'CONDOLENCE',
      customOccasionText: null,
    });
    expect(r.occasionRegister).toBeNull();
  });
});

describe('лицо ведущего и раскадровка (Г-2)', () => {
  it('в трауре — без улыбки при любом тоне', () => {
    for (const tone of GREETING_TONES) {
      const e = presenterExpression('CONDOLENCE', 'MOURNING', tone);
      expect(e).toMatch(/no smile/);
    }
  });

  it('извинение — серьёзное лицо', () => {
    expect(presenterExpression('APOLOGY', 'SENSITIVE', 'WARM')).toMatch(
      /no smile/,
    );
  });

  it('праздник — прежнее лицо по тону', () => {
    expect(presenterExpression('BIRTHDAY', 'CELEBRATORY', 'WARM')).toMatch(
      /smile/,
    );
  });

  it('раскадровка серьёзных регистров без улыбки и прощального жеста', () => {
    // Список нарушений, а не голое `expect` в цикле: упавшая проверка
    // называет регистр и число сцен, на которых она упала.
    const found: string[] = [];
    for (const register of GREETING_REGISTERS) {
      if (register === 'CELEBRATORY') continue;
      const style = REGISTER_POLICY[register].beats;
      for (let n = 2; n <= REGISTER_POLICY[register].maxScenes; n++) {
        const sb = buildStoryboard(n, 15, style);
        const where = `${register}/${n}`;
        if (!sb.length) found.push(`${where}: пусто`);
        if (/a smile/.test(sb)) found.push(`${where}: улыбка`);
        if (register !== 'WARM_NEUTRAL' && /farewell/.test(sb)) {
          found.push(`${where}: прощальный жест`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('праздничная раскадровка не изменилась ни на байт', () => {
    expect(buildStoryboard(3, 15)).toMatch(
      /a gesture, a smile, the moment settling/,
    );
  });

  it('кадр «Особого повода» в трауре запрещает праздник', () => {
    const p = buildGreetingFramePrompt({
      occasion: 'OTHER',
      customOccasionText: 'похороны бабушки',
      occasionRegister: 'MOURNING',
      tone: 'RESPECTFUL',
      presenter: 'grok',
    });
    expect(p).toMatch(/NOT a celebration/);
    expect(p).not.toMatch(/festive decor/);
  });
});

describe('музыка каталога', () => {
  it('тема повода подходит всегда; общая — только празднику и тёплому', () => {
    for (const register of GREETING_REGISTERS) {
      expect(catalogThemeAllowed('CONDOLENCE', register, ['CONDOLENCE'])).toBe(
        true,
      );
      expect(catalogThemeAllowed('BIRTHDAY', register, null)).toBe(
        ORACLE_UNIVERSAL_THEME[register],
      );
    }
  });

  it('выбор до этапа B (поводы темы неизвестны) задним числом не блокируется', () => {
    expect(catalogThemeAllowed('CONDOLENCE', 'MOURNING', undefined)).toBe(true);
  });
});

describe('текст модели в серьёзных регистрах (§3.7)', () => {
  it('поздравление и восклицания в трауре не проходят', () => {
    expect(textFitsRegister('MOURNING', 'Марина, поздравляю!')).toBe(false);
    expect(textFitsRegister('MOURNING', 'Марина, мы рядом. Держись.')).toBe(
      true,
    );
    expect(textFitsRegister('SENSITIVE', 'Выздоравливай скорее!')).toBe(false);
  });

  it('в празднике проверки нет', () => {
    expect(textFitsRegister('CELEBRATORY', 'С днём рождения!!! )))')).toBe(
      true,
    );
  });

  it('запасной текст «Особого повода» следует регистру', () => {
    expect(fallbackMessage('OTHER', 'Марина', 'x', 'MOURNING')).toMatch(
      /соболезнован/,
    );
    expect(fallbackMessage('OTHER', 'Марина', 'x', 'MOURNING')).not.toMatch(
      /поздравля|!/,
    );
    expect(fallbackMessage('OTHER', 'Марина', 'x', null)).not.toMatch(
      /поздравля/,
    );
    expect(fallbackMessage('OTHER', 'Марина', 'x', 'CELEBRATORY')).toMatch(
      /поздравля/,
    );
  });
});

describe('публичная таблица GET /greeting/policy', () => {
  it('GET /greeting/policy покрывает все поводы и регистры', () => {
    const v = greetingPolicyView();
    expect(v.occasions.map((o) => o.occasion).sort()).toEqual(
      [...GREETING_OCCASIONS].sort(),
    );
    expect(v.registers.map((r) => r.register)).toEqual([...GREETING_REGISTERS]);
  });

  /*
   * Этап D (Т-18): копии тонов во фронтенде больше нет — интерфейс строит
   * выбор из `GET /greeting/policy`. Сверку копии заменили шов check-docs
   * «тоны по поводу — только с сервера» и тест
   * `frontend/scripts/greeting-policy.test.ts`, который гоняет помощники
   * интерфейса по этой самой таблице.
   */
});

describe('otherMoodMissing — этап D, §3.4 п.1', () => {
  it('у OTHER пропуск и явный null — «нет ответа»', () => {
    expect(otherMoodMissing('OTHER', undefined)).toBe(true);
    expect(otherMoodMissing('OTHER', null)).toBe(true);
  });

  it('у OTHER любой из регистров — ответ есть', () => {
    for (const r of GREETING_REGISTERS) {
      expect(otherMoodMissing('OTHER', r)).toBe(false);
    }
  });

  it('каталожным поводам ответ не нужен', () => {
    for (const o of GREETING_OCCASIONS.filter((x) => x !== 'OTHER')) {
      expect(otherMoodMissing(o, null)).toBe(false);
    }
  });

  it('текст отказа называет поле и все допустимые значения', () => {
    expect(OTHER_MOOD_REQUIRED).toContain('occasionRegister');
    for (const r of GREETING_REGISTERS) {
      expect(OTHER_MOOD_REQUIRED).toContain(r);
    }
  });
});
