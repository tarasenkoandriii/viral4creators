/**
 * Э3-бис: находки кодом и проверка выводов модели (§5-тер.5, Р-45,
 * §5-тер.16 п.11).
 */
import {
  buildInsightPrompt,
  checkInsightText,
  detectFindings,
  dryFindingLine,
  insightTextFor,
  metricFor,
  numbersIn,
  parseInsights,
  wilson,
  type FindingInputs,
} from './findings';

const empty: FindingInputs = {
  labeledDialogs: 100,
  failures: [],
  topics: [],
  unknownClusters: [],
  pages: [],
  totalViews: 1000,
  proactive: [],
};

describe('находки недели (Э3-бис)', () => {
  it('Вильсон: границы в [0,1], содержит долю', () => {
    const [lo, hi] = wilson(8, 40);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    expect(lo).toBeLessThan(0.2);
    expect(hi).toBeGreaterThan(0.2);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  it('ниже порога выборки находки нет; выше — с n, долей и интервалом', () => {
    const below = detectFindings({
      ...empty,
      failures: [{ page: '/p', reason: 'out_of_stock', x: 9, n: 19 }],
    });
    expect(below).toEqual([]);
    const f = detectFindings({
      ...empty,
      failures: [{ page: '/p', reason: 'out_of_stock', x: 8, n: 40 }],
      unknownClusters: [{ label: 'Доставка в Польщу', visitors: 23 }],
      pages: [
        {
          path: '/checkout',
          views: 300,
          rage: 2,
          jsErrors: 40,
          formStarts: 120,
          formAbandons: 60,
          abandonFields: { phone: 45, name: 10 },
          lcpP75: 4600,
          inpP75: 200,
          clsP75: 0.05,
        },
      ],
      proactive: [{ trigger: 'exit', shown: 250, dismissed: 200 }],
    });
    const codes = f.map((x) => x.code).sort();
    expect(codes).toEqual(['N10', 'N2', 'N3', 'N5', 'N7', 'N8'].sort());
    const n3 = f.find((x) => x.code === 'N3')!;
    expect(n3).toMatchObject({
      n: 40,
      x: 8,
      share: 0.2,
      page: '/p',
      reason: 'out_of_stock',
    });
    expect(n3.ciLow).toBeLessThan(0.2);
  });

  it('вывод с числом, которого нет в находке, — отброшен; с числами находки — принят', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [
        { page: '/product/:id', reason: 'no_delivery_region', x: 10, n: 40 },
      ],
    });
    const ok = {
      title: 'Доставка в регион',
      what: 'На /product/:id 10 из 40 диалогов (25%) — нет доставки в регион.',
      action: 'Добавьте блок о регионах доставки.',
    };
    expect(checkInsightText(ok, [f])).toBeNull();
    expect(
      checkInsightText({ ...ok, what: 'Конверсия упадёт на 37%' }, [f]),
    ).toBe('numbers');
    expect(
      checkInsightText({ ...ok, action: 'Смотрите /secret/admin' }, [f]),
    ).toBe('links');
    const parsed = parseInsights(
      JSON.stringify({
        insights: [
          { findingIds: [0], ...ok },
          { findingIds: [0], title: 'x', what: 'рост на 37%', action: 'y' },
        ],
      }),
      [f],
    );
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.rejected).toEqual([{ findingIndexes: [0], code: 'numbers' }]);
    expect(parseInsights('мусор', [f]).invalid).toBe(true);
  });

  it('аудит: внешняя ссылка (схема, www, домен, t.me, @имя, markdown) — отброшен; путь страницы с точкой — принят', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [
        { page: '/dostavka.html', reason: 'no_delivery_region', x: 10, n: 40 },
      ],
    });
    const ok = {
      title: 'Доставка в регион',
      what: 'На /dostavka.html 10 из 40 диалогов — нет доставки в регион, т.е. уходят.',
      action: 'Добавьте блок о регионах доставки.',
    };
    expect(checkInsightText(ok, [f])).toBeNull();
    for (const bad of [
      'Проверьте https://evil.example/login',
      'Зайдите на www.evil-shop.com',
      'Подробнее: evil-shop.com',
      'Пишите в t.me/scam_support',
      'Напишите @scam_support',
      'Смотрите [тут](evil)',
      'Новый сайт: магазин.укр',
    ]) {
      expect(checkInsightText({ ...ok, action: bad }, [f])).toBe('links');
    }
  });

  it('числа внутри путей не считаются; сухая строка — только числа находки', () => {
    expect(numbersIn('На /product/42 уходят 25%')).toEqual(['25']);
    const [f] = detectFindings({
      ...empty,
      failures: [{ page: '*', reason: 'price_too_high', x: 10, n: 40 }],
    });
    expect(dryFindingLine(f)).toBe(
      'Причина отказа «дорого»: 10 из 40 диалогов без конверсии (25%)',
    );
  });

  it('до/после: та же метрика на другом периоде', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [{ page: '*', reason: 'price_too_high', x: 10, n: 40 }],
    });
    expect(
      metricFor(f, {
        ...empty,
        failures: [{ page: '*', reason: 'price_too_high', x: 3, n: 30 }],
      }),
    ).toEqual({ x: 3, n: 30, share: 0.1 });
  });

  // ── заход 9 (Р-З9-7): язык получателя ─────────────────────────────────
  it('переводы: каждый язык — своя проверка чисел; не прошедший опущен, основной текст остаётся', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [{ page: '*', reason: 'price_too_high', x: 10, n: 40 }],
    });
    const uk = {
      title: 'Дорого',
      what: '10 із 40 діалогів без конверсії (25%) — дорого.',
      action: 'Покажіть розстрочку.',
    };
    const parsed = parseInsights(
      JSON.stringify({
        insights: [
          {
            findingIds: [0],
            ...uk,
            i18n: {
              en: {
                title: 'Too expensive',
                what: '10 of 40 dialogs without conversion (25%).',
                action: 'Show installments.',
              },
              ru: { title: 'Дорого', what: 'Рост на 37%', action: 'x' },
            },
          },
        ],
      }),
      [f],
      ['en', 'ru'],
    );
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.accepted[0].text).toEqual(uk);
    expect(parsed.accepted[0].i18n).toEqual({
      en: {
        title: 'Too expensive',
        what: '10 of 40 dialogs without conversion (25%).',
        action: 'Show installments.',
      },
    });
    // Без запрошенных языков переводы игнорируются (как раньше).
    expect(
      parseInsights(
        JSON.stringify({ insights: [{ findingIds: [0], ...uk, i18n: {} }] }),
        [f],
      ).accepted[0].i18n,
    ).toBeUndefined();
  });

  it('промпт: основной язык и переводы; без переводов — прежняя форма ответа', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [{ page: '*', reason: 'price_too_high', x: 10, n: 40 }],
    });
    const one = buildInsightPrompt({
      findings: [f],
      siteName: 'S',
      niche: null,
      lang: 'uk',
    });
    expect(one.system).toContain('Write in Ukrainian');
    expect(one.system).not.toContain('i18n');
    const many = buildInsightPrompt({
      findings: [f],
      siteName: 'S',
      niche: null,
      lang: 'en',
      extraLangs: ['uk', 'en'],
    });
    expect(many.system).toContain('Write in English');
    expect(many.system).toContain('"i18n":{"uk"');
    expect(many.system).not.toContain('"en":{');
  });

  it('текст на языке читателя: перевод, основной на его языке, иначе null; старые записи — русские', () => {
    const stored = {
      title: 'Т',
      what: 'W',
      action: 'A',
      lang: 'uk',
      i18n: { en: { title: 'T', what: 'W', action: 'A' } },
    };
    expect(insightTextFor(stored, 'uk')).toEqual({
      title: 'Т',
      what: 'W',
      action: 'A',
    });
    expect(insightTextFor(stored, 'en')?.title).toBe('T');
    expect(insightTextFor(stored, 'ru')).toBeNull();
    const legacy = { title: 'Р', what: 'W', action: 'A' };
    expect(insightTextFor(legacy, 'ru')?.title).toBe('Р');
    expect(insightTextFor(legacy, 'uk')).toBeNull();
    expect(insightTextFor(null, 'uk')).toBeNull();
    expect(insightTextFor({ title: 1 }, 'ru')).toBeNull();
  });

  it('сухая строка — на языке читателя; числа те же', () => {
    const [f] = detectFindings({
      ...empty,
      failures: [{ page: '/cart', reason: 'price_too_high', x: 10, n: 40 }],
    });
    expect(dryFindingLine(f, 'uk')).toBe(
      'Причина відмови «дорого» на /cart: 10 з 40 діалогів без конверсії (25%)',
    );
    expect(dryFindingLine(f, 'en')).toBe(
      'Drop-off reason “too expensive” on /cart: 10 of 40 conversations without conversion (25%)',
    );
    for (const lang of ['uk', 'ru', 'en'] as const) {
      expect(numbersIn(dryFindingLine(f, lang)).sort()).toEqual(
        ['10', '25', '40'].sort(),
      );
    }
  });
});
