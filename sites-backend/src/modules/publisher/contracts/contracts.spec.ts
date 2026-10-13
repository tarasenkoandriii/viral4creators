/**
 * Общие контракты P-A1 (проектный документ §6.2, §10, §11.2, §11.4, §12.2):
 * параметры (ключи, формы, умолчания, гейты, бюджет), ошибки, форма заявки,
 * схемы AI, контракт маршрутов ядра ↔ контроллер.
 */
import { PublisherCoreController } from '../core/product.controller';
import {
  budgetConsistencyIssues,
  defaultValueIssues,
  parameterApprovalIssues,
  parameterValueIssues,
  RATE_ROLES,
} from '../core/parameter-schemas';
import { enumerateControllers } from '../core/route-enumerator';
import {
  GENERATOR_IDS,
  P0_ENABLED_GENERATORS,
  aiOperationOf,
  isEnabledInP0,
} from './ai';
import {
  ADAPTATION_MAKE_SCHEMA,
  EVAL_SCHEMA_OF,
  GENERATOR_SCHEMAS,
  HELPER_ANSWER_SCHEMA,
  QA_REVIEW_SCHEMA,
  sourceIdsOutside,
} from './ai-schemas';
import { GATE_NAMES } from './common';
import { CORE_ROUTES } from './core-api';
import {
  PUB_ERROR_CODES,
  PUB_ERROR_MESSAGES,
  PUB_ERROR_STATUS,
  pubLangOf,
} from './errors';
import { validateLeadBody } from './lead-validation';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  DEFAULT_PARAMETER_VALUES,
  GATE_PARAMETER_KEYS,
  PARAMETER_KEYS,
  budgetParamVersion,
  defaultDependentStages,
  gatesOfKey,
} from './parameters';
import { SITE_AI_OPERATIONS } from '../../site-ai/operations';
import { PUB_ROLES } from './states';

describe('contracts/parameters', () => {
  it('39 ключей (с dev_investment, Р-PUB-Z2-24, и reddit_rules_stale_days P-R); умолчания ТЗ §26/§17 проходят свои схемы', () => {
    expect(PARAMETER_KEYS).toHaveLength(39);
    // P-R (§M1.3): 1..365, по умолчанию 30; гейтов P0 не трогает.
    expect(DEFAULT_PARAMETER_VALUES.reddit_rules_stale_days).toEqual({
      days: 30,
    });
    expect(
      parameterValueIssues('reddit_rules_stale_days', { days: 0 }),
    ).not.toEqual([]);
    expect(
      parameterValueIssues('reddit_rules_stale_days', { days: 365 }),
    ).toEqual([]);
    expect(gatesOfKey('reddit_rules_stale_days')).toEqual([]);
    expect(Object.keys(DEFAULT_PARAMETER_VALUES).sort()).toEqual(
      [...PARAMETER_KEYS].sort(),
    );
    expect(defaultValueIssues()).toEqual([]);
    expect(DEFAULT_PARAMETER_VALUES.budget_split).toEqual({
      placementsMinor: 600_000,
      toolsMinor: 200_000,
      reserveMinor: 200_000,
    });
    expect(DEFAULT_PARAMETER_VALUES.d42_thresholds).toEqual({
      sessions: 100,
      qualified: 5,
      proposals: 2,
      minSampleForConclusion: 5,
    });
    expect(DEFAULT_PARAMETER_VALUES.form_limit).toEqual({
      count: 5,
      windowSec: 600,
    });
    expect(DEFAULT_PARAMETER_VALUES.analytics_storage).toBe('none');
  });

  it('формы, которые читает представление pub_public_products (Р-PUB-A0-10)', () => {
    expect(parameterValueIssues('analytics_storage', 'session')).toEqual([]);
    expect(
      parameterValueIssues('analytics_storage', { v: 'none' }),
    ).not.toEqual([]);
    expect(
      parameterValueIssues('test_hosts', [
        'https://test.ai-publisher.org',
        'https://x.example:8443',
      ]),
    ).toEqual([]);
    expect(parameterValueIssues('test_hosts', ['http://x.example'])).toEqual([
      { field: 'value[0]', code: 'format' },
    ]);
    expect(
      parameterValueIssues('consent_map', { default: 'granted', note: null }),
    ).toEqual([]);
    expect(
      parameterValueIssues('data_notice_version', {
        version: 'v1',
        text: 'Текст',
      }),
    ).toEqual([]);
  });

  it('гейты → ключи (§10): real_leads ⊃ public_publish, purchases ⊃ spend; каждый ключ гейта — из списка', () => {
    for (const g of GATE_NAMES)
      for (const k of GATE_PARAMETER_KEYS[g])
        expect(PARAMETER_KEYS).toContain(k);
    for (const k of GATE_PARAMETER_KEYS.public_publish)
      expect(GATE_PARAMETER_KEYS.real_leads).toContain(k);
    for (const k of GATE_PARAMETER_KEYS.spend)
      expect(GATE_PARAMETER_KEYS.purchases).toContain(k);
    expect(gatesOfKey('form_limit')).toEqual(['real_leads']);
    expect(gatesOfKey('budget_total')).toEqual(['spend', 'purchases']);
    expect(defaultDependentStages('d42_thresholds')).toEqual([
      'purchases',
      'reports',
    ]);
  });

  it('утверждение требует полного значения; бюджет: категории + резерв = общий, закупка ≤ размещений', () => {
    expect(
      parameterApprovalIssues(
        'ai_fx_rate',
        DEFAULT_PARAMETER_VALUES.ai_fx_rate,
      ).map((i) => i.field),
    ).toEqual(['value.rate', 'value.source', 'value.at']);
    expect(
      parameterApprovalIssues('niche', DEFAULT_PARAMETER_VALUES.niche),
    ).toEqual([]);
    expect(
      parameterApprovalIssues('alt_contact', {
        label: 'Пишіть',
        href: 'mailto:hi@ai-publisher.org',
      }),
    ).toEqual([]);
    const D = DEFAULT_PARAMETER_VALUES;
    expect(budgetConsistencyIssues(D)).toEqual([]);
    expect(
      budgetConsistencyIssues({
        ...D,
        budget_split: {
          placementsMinor: 600_000,
          toolsMinor: 200_000,
          reserveMinor: 100_000,
        },
      }),
    ).toEqual([{ key: 'budget_split', detail: 'inconsistent', check: 'sum' }]);
    expect(
      budgetConsistencyIssues({
        ...D,
        per_purchase_max: { amountMinor: 700_000 },
      }),
    ).toEqual([
      {
        key: 'per_purchase_max',
        detail: 'inconsistent',
        check: 'over_placements',
      },
    ]);
    expect(
      budgetConsistencyIssues({
        ...D,
        rates_by_role: { ...D.rates_by_role, currency: 'USD' },
      }),
    ).toEqual([
      { key: 'rates_by_role', detail: 'inconsistent', check: 'currency' },
    ]);
    // Аудит P3-8: курс — формат parseFxRate и > 0.
    for (const rate of ['041.5', '0', '0.00000000']) {
      expect(
        parameterValueIssues('ai_fx_rate', {
          rate,
          source: 'НБУ',
          at: '2026-10-16T00:00:00.000Z',
        }).map((i) => i.field),
      ).toEqual(['value.rate']);
    }
    expect(
      parameterValueIssues('ai_fx_rate', {
        rate: '41.5',
        source: 'НБУ',
        at: '2026-10-16T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('paramVersion лимита — сумма версий бюджетных ключей (растёт при любом решении)', () => {
    expect(BUDGET_LIMIT_PARAMETER_KEYS).toEqual([
      'budget_total',
      'budget_split',
      'per_purchase_max',
    ]);
    expect(
      budgetParamVersion({
        budget_total: 2,
        budget_split: 1,
        per_purchase_max: 1,
      }),
    ).toBe(4);
    expect(
      budgetParamVersion({
        budget_total: 2,
        budget_split: 2,
        per_purchase_max: 1,
      }),
    ).toBe(5);
  });

  it('ставки — по всем ролям продукта и admin', () => {
    expect(RATE_ROLES).toEqual([...PUB_ROLES, 'admin']);
  });
});

describe('contracts/errors (§11.2)', () => {
  it('у каждого кода — статус и три языка; коды §11.2 на месте', () => {
    for (const c of PUB_ERROR_CODES) {
      expect(PUB_ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
      expect(Object.keys(PUB_ERROR_MESSAGES[c]).sort()).toEqual([
        'en',
        'ru',
        'uk',
      ]);
    }
    // 40 кодов §11.2 + PUB_NOT_IMPLEMENTED (Р-PUB-A1-3)
    expect(PUB_ERROR_CODES).toHaveLength(41);
    expect(PUB_ERROR_STATUS.PUB_BUSY).toBe(503);
    expect(PUB_ERROR_STATUS.PUB_AI_SCHEMA_INVALID).toBe(422);
    expect(PUB_ERROR_STATUS.PUB_RATE_LIMITED).toBe(429);
  });

  it('язык из Accept-Language (q-веса; умолчание — uk)', () => {
    expect(pubLangOf(undefined)).toBe('uk');
    expect(pubLangOf('ru-RU,ru;q=0.9,en;q=0.8')).toBe('ru');
    expect(pubLangOf('de-DE,en;q=0.5,ru;q=0.7')).toBe('ru');
    expect(pubLangOf('fr')).toBe('uk');
    expect(pubLangOf('en;q=0, uk;q=0.1')).toBe('uk');
  });
});

describe('contracts/lead-validation (§11.4)', () => {
  const body = {
    key: `pp_${'a'.repeat(24)}`,
    submissionKey: '0f5c5b9e-1a2b-4c3d-8e9f-0123456789ab',
    name: ' Олена ',
    contactMethod: 'phone',
    contact: '+38 (067) 123-45-67',
    business: 'Курси англійської',
    task: 'Потрібні статті під запити клієнтів',
    dataNoticeVersion: 'draft-1',
    consentState: 'not_required',
    elapsedMs: 5000,
  };

  it('валидное тело — нормализовано; мягкие поля атрибуции отбрасываются, не роняя заявку', () => {
    const r = validateLeadBody({
      ...body,
      contentSlug: 'Bad Slug!',
      placementCode: 'pl-01',
      sessionRef: 'short',
    });
    expect(r).toMatchObject({
      ok: true,
      trap: false,
      suspectedSpam: false,
      dropped: ['sessionRef', 'contentSlug'],
    });
    expect(r.ok && r.value).toMatchObject({
      name: 'Олена',
      placementCode: 'pl-01',
      contentSlug: null,
      budgetRange: null,
    });
  });

  it('контакт — по способу связи; обязательные поля; длина задачи', () => {
    const bad = validateLeadBody({
      ...body,
      contactMethod: 'email',
      contact: 'not-an-email',
      task: 'x'.repeat(2001),
      name: '',
    });
    expect(bad).toEqual({
      ok: false,
      fields: [
        { field: 'name', code: 'required' },
        { field: 'contact', code: 'format' },
        { field: 'task', code: 'length' },
      ],
    });
    expect(
      validateLeadBody({
        ...body,
        contactMethod: 'telegram',
        contact: '@good_user',
      }).ok,
    ).toBe(true);
    expect(
      validateLeadBody({ ...body, contactMethod: 'phone', contact: '12345' })
        .ok,
    ).toBe(false);
    expect(validateLeadBody({ ...body, budgetRange: 'million' })).toEqual({
      ok: false,
      fields: [{ field: 'budgetRange', code: 'enum' }],
    });
    expect(validateLeadBody(null)).toEqual({
      ok: false,
      fields: [{ field: '$', code: 'type' }],
    });
  });

  it('ловушка hp — флаг, а не ошибка; быстрое заполнение — мягкая пометка', () => {
    expect(validateLeadBody({ ...body, hp: 'bot' })).toMatchObject({
      ok: true,
      trap: true,
    });
    expect(validateLeadBody({ ...body, elapsedMs: 300 })).toMatchObject({
      ok: true,
      suspectedSpam: true,
    });
  });
});

describe('contracts/ai + ai-schemas (§12.2)', () => {
  it('девять генераторов; в P0 включены четыре; операции site-ai — pub-*', () => {
    expect(GENERATOR_IDS).toHaveLength(9);
    expect([...P0_ENABLED_GENERATORS]).toEqual([
      'pub.helper.answer',
      'pub.brief.draft',
      'pub.qa.review',
      'pub.adaptation.make',
    ]);
    expect(isEnabledInP0('pub.draft.write')).toBe(false);
    expect(Object.keys(GENERATOR_SCHEMAS).sort()).toEqual(
      [...GENERATOR_IDS].sort(),
    );
    expect(Object.keys(EVAL_SCHEMA_OF).sort()).toEqual(
      [...P0_ENABLED_GENERATORS].sort(),
    );
    for (const g of GENERATOR_IDS)
      expect(SITE_AI_OPERATIONS).toContain(aiOperationOf(g));
  });

  it('строгие схемы: лишнее поле, null вне разрешённого, флаг сценария', () => {
    const ok = {
      answer: 'Так',
      used_source_ids: ['s1'],
      unknowns: [],
      next_action: 'Уточнити',
    };
    expect(HELPER_ANSWER_SCHEMA.validate(ok)).toEqual([]);
    expect(HELPER_ANSWER_SCHEMA.validate({ ...ok, tool: 'pay' })).toEqual([
      { field: 'tool', code: 'unknown_field' },
    ]);
    expect(HELPER_ANSWER_SCHEMA.validate({ ...ok, answer: null })).toEqual([
      { field: 'answer', code: 'type' },
    ]);
    const ad = {
      parent_version: 'v1',
      format: 'video_script',
      title: 'Сценарій',
      body: null,
      cards: null,
      scenes: [{ visual: 'кадр', voice: 'голос', caption: 'підпис' }],
      is_script: false,
      cta: 'Напишіть',
      used_source_ids: [],
      preserved_caveats: [],
      unresolved_questions: [],
    };
    expect(ADAPTATION_MAKE_SCHEMA.validate(ad)).toEqual([
      { field: 'is_script', code: 'video_script_flag' },
    ]);
    expect(ADAPTATION_MAKE_SCHEMA.validate({ ...ad, is_script: true })).toEqual(
      [],
    );
    const qa = {
      object_version: 'v1',
      claims: [
        {
          statement: 'Ціна',
          type: 'fact',
          risk: 'critical',
          source_ids: ['s1', 's9'],
          supported: 'unknown',
        },
      ],
      blockers: [{ code: 'no_source', text: 'Немає джерела', claim_index: 0 }],
      unresolved_questions: [],
      recommendation: 'Доопрацювати',
    };
    expect(QA_REVIEW_SCHEMA.validate(qa)).toEqual([]);
    expect(sourceIdsOutside(qa, ['s1'])).toEqual(['s9']);
  });
});

describe('contracts/core-api ↔ контроллер ядра', () => {
  it('CORE_ROUTES = маршруты PublisherCoreController (метод, путь, действие)', () => {
    const fromController = enumerateControllers([
      PublisherCoreController as never,
    ])
      .map((r) => `${r.method} ${r.path} ${JSON.stringify(r.pubActions)}`)
      .sort();
    const fromContract = Object.values(CORE_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${JSON.stringify(Array.isArray(r.action) ? r.action : [r.action])}`,
      )
      .sort();
    expect(fromController).toEqual(fromContract);
  });
});
