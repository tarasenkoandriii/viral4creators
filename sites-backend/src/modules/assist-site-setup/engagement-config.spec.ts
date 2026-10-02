/**
 * Вовлечение виджета (Э3, T; №41 MVP-триггеры, §5-тер.12 лимиты, №40
 * сценарии): строгий разбор, отказ триггерам Э3-бис (`not_allowed`),
 * ссылка финала — только https verified-хоста, публичная часть без
 * выключенного. Процедуры персоны (№19) — здесь же (тот же владелец).
 */
import {
  DEFERRED_TRIGGER_KINDS,
  ENGAGEMENT_LIMITS,
  defaultEngagementConfig,
  parseEngagementConfig,
  parseScenarios,
  publicEngagement,
  safeLinkUrl,
  type EngagementConfig,
} from './engagement-config';
import { defaultPersona, parsePersona } from './persona';
import { defaultWidgetConfig, parseWidgetConfig } from './widget-config';

const SHOP = 'https://shop.example.com';

function trigger(over: Record<string, unknown> = {}) {
  return {
    key: 'delivery',
    enabled: true,
    condition: { kind: 'time_on_page', seconds: 20 },
    pathMasks: ['/catalog/*'],
    text: { uk: 'Підказати з доставкою?', ru: 'Подсказать с доставкой?' },
    onAccept: { kind: 'prefill', question: { uk: 'Як доставляєте?' } },
    ...over,
  };
}

function scenario(over: Record<string, unknown> = {}) {
  return {
    key: 'pick',
    enabled: true,
    title: { ru: 'Подобрать товар' },
    steps: [
      {
        key: 'budget',
        question: { ru: 'Какой бюджет?' },
        answer: { type: 'number', min: 0, max: 100000 },
      },
      {
        key: 'kind',
        question: { ru: 'Для чего?' },
        answer: {
          type: 'choice',
          options: [
            { key: 'home', label: { ru: 'Дом' } },
            { key: 'work', label: { ru: 'Работа' } },
          ],
        },
      },
      {
        key: 'notes',
        question: { ru: 'Что ещё важно?' },
        answer: { type: 'text', maxChars: 300 },
      },
    ],
    final: { kind: 'lead' },
    showInGreeting: true,
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    triggers: [trigger()],
    limits: {
      perVisit: 1,
      excludedPaths: ['/checkout*'],
      notOnFirstScreenMobile: true,
    },
    scenarios: [scenario()],
    ...over,
  };
}

function ok(input: unknown, verifiedOrigins?: string[]): EngagementConfig {
  const r = parseEngagementConfig(input, { verifiedOrigins });
  if (!r.ok) throw new Error(`ожидался успех: ${JSON.stringify(r.errors)}`);
  return r.config;
}

function codes(input: unknown, verifiedOrigins?: string[]): string[] {
  const r = parseEngagementConfig(input, { verifiedOrigins });
  if (r.ok) throw new Error('ожидался отказ');
  return r.errors.map((e) => `${e.path}:${e.code}`);
}

describe('parseEngagementConfig — MVP-триггеры (№41)', () => {
  it('полная корректная конфигурация проходит без потерь', () => {
    const c = ok(cfg());
    expect(c.triggers).toHaveLength(1);
    expect(c.triggers[0].condition).toEqual({
      kind: 'time_on_page',
      seconds: 20,
    });
    expect(c.scenarios[0].steps.map((s) => s.answer.type)).toEqual([
      'number',
      'choice',
      'text',
    ]);
    expect(c.limits).toEqual({
      perVisit: 1,
      excludedPaths: ['/checkout*'],
      notOnFirstScreenMobile: true,
    });
  });

  it('все четыре условия MVP принимаются', () => {
    const c = ok(
      cfg({
        triggers: [
          trigger({ key: 't1' }),
          trigger({
            key: 't2',
            condition: { kind: 'scroll_depth', percent: 60 },
          }),
          trigger({ key: 't3', condition: { kind: 'exit_intent' } }),
          trigger({
            key: 't4',
            condition: { kind: 'url_match', pathMask: '/sale*', seconds: 15 },
          }),
        ],
      }),
    );
    expect(c.triggers.map((t) => t.condition.kind)).toEqual([
      'time_on_page',
      'scroll_depth',
      'exit_intent',
      'url_match',
    ]);
  });

  it.each([...DEFERRED_TRIGGER_KINDS, 'anything_else'])(
    'триггер Э3-бис «%s» — not_allowed (загрузчик его не исполняет)',
    (kind) => {
      expect(
        codes(cfg({ triggers: [trigger({ condition: { kind } })] })),
      ).toEqual(['triggers[0].condition.kind:not_allowed']);
    },
  );

  it('§5-тер.12 п.3: раньше 10 с — нельзя; дольше 10 мин — нельзя; дробное — нельзя', () => {
    const at = (seconds: unknown) =>
      codes(
        cfg({
          triggers: [trigger({ condition: { kind: 'time_on_page', seconds } })],
        }),
      );
    expect(at(ENGAGEMENT_LIMITS.minDelaySeconds - 1)).toEqual([
      'triggers[0].condition.seconds:range',
    ]);
    expect(at(ENGAGEMENT_LIMITS.maxDelaySeconds + 1)).toEqual([
      'triggers[0].condition.seconds:range',
    ]);
    expect(at(12.5)).toEqual(['triggers[0].condition.seconds:type']);
    expect(at('20')).toEqual(['triggers[0].condition.seconds:type']);
    ok(
      cfg({
        triggers: [
          trigger({
            condition: {
              kind: 'time_on_page',
              seconds: ENGAGEMENT_LIMITS.minDelaySeconds,
            },
          }),
        ],
      }),
    );
  });

  it('прокрутка 10–100 %; маска url_match — по правилам масок пути', () => {
    expect(
      codes(
        cfg({
          triggers: [
            trigger({ condition: { kind: 'scroll_depth', percent: 101 } }),
          ],
        }),
      ),
    ).toEqual(['triggers[0].condition.percent:range']);
    expect(
      codes(
        cfg({
          triggers: [
            trigger({
              condition: {
                kind: 'url_match',
                pathMask: 'https://evil/x',
                seconds: 20,
              },
            }),
          ],
        }),
      ),
    ).toEqual(['triggers[0].condition.pathMask:path_mask']);
  });

  it('лимиты навязчивости: perVisit только 1|2; «не на первом экране телефона» не выключается', () => {
    expect(codes(cfg({ limits: { perVisit: 3 } }))).toEqual([
      'limits.perVisit:range',
    ]);
    expect(codes(cfg({ limits: { notOnFirstScreenMobile: false } }))).toEqual([
      'limits.notOnFirstScreenMobile:not_allowed',
    ]);
    // Лимиты не заданы — умолчание: шаг оплаты исключён (§5-тер.12 п.5).
    const c = ok({ triggers: [] });
    expect(c.limits).toEqual(defaultEngagementConfig().limits);
    expect(c.limits.excludedPaths).toContain('/checkout*');
  });

  it('больше 10 триггеров / 5 сценариев / 8 шагов / 6 вариантов — too_many', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => trigger({ key: `t${i}` }));
    expect(
      codes(cfg({ triggers: many(ENGAGEMENT_LIMITS.maxTriggers + 1) })),
    ).toEqual(['triggers:too_many']);
    expect(
      codes(
        cfg({
          triggers: [],
          scenarios: Array.from({ length: 6 }, (_, i) =>
            scenario({ key: `s${i}` }),
          ),
        }),
      ),
    ).toEqual(['scenarios:too_many']);
    const steps = Array.from({ length: 9 }, (_, i) => ({
      key: `q${i}`,
      question: { ru: 'Вопрос?' },
      answer: { type: 'none' },
    }));
    expect(codes(cfg({ scenarios: [scenario({ steps })] }))).toEqual([
      'scenarios[0].steps:too_many',
    ]);
    const options = Array.from({ length: 7 }, (_, i) => ({
      key: `o${i}`,
      label: { ru: 'Вариант' },
    }));
    expect(
      codes(
        cfg({
          scenarios: [
            scenario({
              steps: [
                {
                  key: 'c',
                  question: { ru: 'Выбор?' },
                  answer: { type: 'choice', options },
                },
              ],
            }),
          ],
        }),
      ),
    ).toEqual(['scenarios[0].steps[0].answer.options:too_many']);
  });

  it('строгость: неизвестное поле, неверный ключ, дубликат ключа, пустой текст', () => {
    expect(codes(cfg({ extra: 1 }))).toEqual(['extra:unknown']);
    expect(codes(cfg({ triggers: [trigger({ selector: '#buy' })] }))).toEqual([
      'triggers[0].selector:unknown',
    ]);
    expect(codes(cfg({ triggers: [trigger({ key: 'Bad Key' })] }))).toEqual([
      'triggers[0].key:key',
    ]);
    expect(codes(cfg({ triggers: [trigger(), trigger()] }))).toEqual([
      'triggers[1].key:duplicate',
    ]);
    expect(
      codes(cfg({ triggers: [trigger({ text: { uk: '   ' } })] })),
    ).toEqual(['triggers[0].text:required']);
    expect(
      codes(cfg({ triggers: [trigger({ text: { de: 'Hallo' } })] })),
    ).toEqual(['triggers[0].text:required', 'triggers[0].text.de:unknown']);
  });

  it('тексты — данные: управляющие/bidi-символы — отказ, длина — отказ, а не обрезка', () => {
    expect(
      codes(cfg({ triggers: [trigger({ text: { ru: 'Привет‮там' } })] })),
    ).toEqual(['triggers[0].text.ru:control_chars']);
    expect(
      codes(
        cfg({
          triggers: [
            trigger({
              text: { ru: 'я'.repeat(ENGAGEMENT_LIMITS.triggerText + 1) },
            }),
          ],
        }),
      ),
    ).toEqual(['triggers[0].text.ru:too_long']);
    // Разметка — просто текст (загрузчик рисует textContent).
    const c = ok(
      cfg({
        triggers: [trigger({ text: { ru: '<img src=x onerror=alert(1)>' } })],
      }),
    );
    expect(c.triggers[0].text.ru).toBe('<img src=x onerror=alert(1)>');
  });

  it('клик по пузырю ведёт в сценарий — только в существующий', () => {
    expect(
      codes(
        cfg({
          triggers: [
            trigger({ onAccept: { kind: 'scenario', scenarioKey: 'nope' } }),
          ],
        }),
      ),
    ).toEqual(['triggers[0].onAccept.scenarioKey:scenario_unknown']);
    ok(
      cfg({
        triggers: [
          trigger({ onAccept: { kind: 'scenario', scenarioKey: 'pick' } }),
        ],
      }),
    );
    expect(
      codes(cfg({ triggers: [trigger({ onAccept: { kind: 'autosend' } })] })),
    ).toEqual(['triggers[0].onAccept.kind:not_allowed']);
  });
});

describe('сценарии (№40): шаги, типы ответов, финал §4.9', () => {
  it('финал — только lead | handoff | link | ask', () => {
    for (const kind of ['lead', 'handoff', 'ask']) {
      ok(cfg({ scenarios: [scenario({ final: { kind } })] }));
    }
    expect(
      codes(cfg({ scenarios: [scenario({ final: { kind: 'model' } })] })),
    ).toEqual(['scenarios[0].final.kind:not_allowed']);
  });

  it('ссылка финала: только https, без логина в адресе; с verifiedOrigins — только verified-хост', () => {
    const link = (url: string) =>
      cfg({
        scenarios: [
          scenario({
            final: { kind: 'link', url, label: { ru: 'Открыть' } },
          }),
        ],
      });
    expect(codes(link('http://shop.example.com/sale'), [SHOP])).toEqual([
      'scenarios[0].final.url:url',
    ]);
    expect(codes(link('javascript:alert(1)'))).toEqual([
      'scenarios[0].final.url:url',
    ]);
    expect(codes(link('https://user:pw@shop.example.com/'))).toEqual([
      'scenarios[0].final.url:url',
    ]);
    expect(codes(link('https://evil.example.net/sale'), [SHOP])).toEqual([
      'scenarios[0].final.url:host_not_verified',
    ]);
    const c = ok(link('https://shop.example.com/sale?x=1'), [SHOP]);
    expect(c.scenarios[0].final).toEqual({
      kind: 'link',
      url: 'https://shop.example.com/sale?x=1',
      label: { ru: 'Открыть' },
    });
    expect(safeLinkUrl('https://shop.example.com/a b')).toBeNull();
  });

  it('число: min ≤ max; текст: 1…500 символов; выбор: хотя бы один вариант без дублей', () => {
    const one = (answer: unknown) =>
      cfg({
        scenarios: [
          scenario({ steps: [{ key: 's', question: { ru: '?' }, answer }] }),
        ],
      });
    expect(codes(one({ type: 'number', min: 10, max: 1 }))).toEqual([
      'scenarios[0].steps[0].answer:range',
    ]);
    ok(one({ type: 'number', min: null, max: null }));
    expect(codes(one({ type: 'text', maxChars: 0 }))).toEqual([
      'scenarios[0].steps[0].answer.maxChars:range',
    ]);
    expect(codes(one({ type: 'choice', options: [] }))).toEqual([
      'scenarios[0].steps[0].answer.options:required',
    ]);
    expect(
      codes(
        one({
          type: 'choice',
          options: [
            { key: 'a', label: { ru: 'A' } },
            { key: 'a', label: { ru: 'B' } },
          ],
        }),
      ),
    ).toEqual(['scenarios[0].steps[0].answer.options[1].key:duplicate']);
    expect(codes(one({ type: 'file' }))).toEqual([
      'scenarios[0].steps[0].answer.type:not_allowed',
    ]);
  });

  it('parseScenarios — отдельно для PUT …/scenarios, путь ошибок от «scenarios»', () => {
    expect(parseScenarios([scenario(), scenario()])).toEqual({
      ok: false,
      errors: [{ path: 'scenarios[1].key', code: 'duplicate' }],
    });
    expect(parseScenarios({})).toEqual({
      ok: false,
      errors: [{ path: 'scenarios', code: 'type' }],
    });
  });
});

describe('publicEngagement — что уходит загрузчику', () => {
  it('только enabled; триггер в выключенный сценарий не уходит', () => {
    const c = ok(
      cfg({
        triggers: [
          trigger({ key: 'on' }),
          trigger({ key: 'off', enabled: false }),
          trigger({
            key: 'to-off-scenario',
            onAccept: { kind: 'scenario', scenarioKey: 'hidden' },
          }),
          trigger({
            key: 'to-on-scenario',
            onAccept: { kind: 'scenario', scenarioKey: 'pick' },
          }),
        ],
        scenarios: [scenario(), scenario({ key: 'hidden', enabled: false })],
      }),
    );
    const p = publicEngagement(c);
    expect(p.triggers.map((t) => t.key)).toEqual(['on', 'to-on-scenario']);
    expect(p.scenarios.map((s) => s.key)).toEqual(['pick']);
    expect(p.limits.notOnFirstScreenMobile).toBe(true);
  });

  it('вид Э2 без поля и битое значение из базы — умолчание, не исключение', () => {
    expect(publicEngagement(undefined)).toEqual(defaultEngagementConfig());
    expect(
      publicEngagement({ triggers: 'x' } as unknown as EngagementConfig),
    ).toEqual(defaultEngagementConfig());
  });
});

describe('widget-config: engagement внутри вида', () => {
  it('ошибки вовлечения приходят с префиксом engagement.; вид без поля — без поля', () => {
    const base = defaultWidgetConfig('Магазин');
    const plain = parseWidgetConfig(base);
    expect(plain.ok && 'engagement' in plain.config).toBe(false);
    const bad = parseWidgetConfig({
      ...base,
      engagement: cfg({ triggers: [trigger({ condition: { kind: 'idle' } })] }),
    });
    expect(bad).toEqual({
      ok: false,
      errors: [
        { path: 'engagement.triggers[0].condition.kind', code: 'not_allowed' },
      ],
    });
    const good = parseWidgetConfig({ ...base, engagement: cfg() });
    expect(good.ok && good.config.engagement?.triggers).toHaveLength(1);
  });
});

describe('процедуры персоны (№19)', () => {
  const base = () => defaultPersona('uk') as unknown as Record<string, unknown>;

  it('до 10 «когда — сделай»; пустой список в персону не пишется', () => {
    const r = parsePersona({
      ...base(),
      procedures: [
        {
          when: 'Спрашивают про возврат',
          steps: 'Дай ссылку\nПредложи заявку',
        },
      ],
    });
    expect(r.ok && r.persona.procedures).toEqual([
      { when: 'Спрашивают про возврат', steps: 'Дай ссылку\nПредложи заявку' },
    ]);
    const empty = parsePersona({ ...base(), procedures: [] });
    expect(empty.ok && 'procedures' in empty.persona).toBe(false);
  });

  it('лимиты, лишние поля, пустые части, дубликаты — ошибки', () => {
    const errs = (procedures: unknown) => {
      const r = parsePersona({ ...base(), procedures });
      return r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`);
    };
    expect(
      errs(
        Array.from({ length: 11 }, (_, i) => ({ when: `w${i}`, steps: 's' })),
      ),
    ).toEqual(['procedures:too_many']);
    expect(errs([{ when: 'a', steps: 'b', action: 'refund' }])).toEqual([
      'procedures[0].action:unknown',
    ]);
    expect(errs([{ when: '', steps: 'b' }])).toEqual([
      'procedures[0].when:required',
    ]);
    expect(errs([{ when: 'a\nb', steps: 'b' }])).toEqual([
      'procedures[0].when:control_chars',
    ]);
    expect(errs([{ when: 'a', steps: 'я'.repeat(801) }])).toEqual([
      'procedures[0].steps:too_long',
    ]);
    expect(
      errs([
        { when: 'Возврат', steps: 'x' },
        { when: 'возврат', steps: 'y' },
      ]),
    ).toEqual(['procedures[1].when:duplicate']);
  });
});
