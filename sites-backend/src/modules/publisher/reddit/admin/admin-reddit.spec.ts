/**
 * P-R-ADM — юнит-проверки внутреннего API вкладки «Reddit» Админки:
 * закрытые таблицы маршрутов = обработчики кабинета (метод, путь, действие
 * `@PubAllow`), список маршрутов контроллера, разбор пути, синтетическое
 * членство и закрытый список действий, формат актора, гварды (секрет 401
 * одинаково, актор 400; вкладка «Помощник» — прежнее поведение),
 * платформенный сайт из env, отчёт импорта без контактов.
 */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { InternalSecretGuard } from '../../../../common/internal-secret.guard';
import { publisherPlatformSiteId } from '../../../../config/publisher-env';
import { ContentMaterialsController } from '../../content/content-materials.controller';
import { ContentSourcesController } from '../../content/content-sources.controller';
import { PublisherAiController } from '../../ai/ai.controller';
import { PublisherDistributionController } from '../../distribution/distribution.controller';
import {
  ACTOR_RE,
  adminActor,
  memberActor,
  memberIdOfActor,
} from '../../contracts/common';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  GATE_PARAMETER_KEYS,
} from '../../contracts/parameters';
import {
  budgetConsistencyIssues,
  parameterApprovalIssues,
} from '../../core/parameter-schemas';
import {
  PLATFORM_AI_MONTHS,
  aiGateState,
  aiMonthState,
  platformBudgetHint,
} from './admin-ai-state';
import { REDDIT_ROUTES } from '../../contracts/reddit-api';
import {
  ADMIN_PARAMETER_KEYS,
  ADMIN_REDDIT_ACTIONS,
  adminMembership,
  adminRedditAccess,
  isAdminParameterKey,
} from '../../core/admin-actor';
import { PublisherCoreController } from '../../core/product.controller';
import { PUB_ACTIONS_KEY } from '../../core/pub-role.guard';
import { enumerateControllers } from '../../core/route-enumerator';
import { can, type PubAction } from '../../core/roles';
import { PublisherRedditController } from '../reddit.controller';
import { AdminRedditController } from './admin-reddit.controller';
import { AdminRedditGuard } from './admin-reddit.guard';
import {
  ADMIN_CONTENT_TRANSITIONS,
  ADMIN_SOURCE_KINDS,
  CX_ROUTES,
  RX_ROUTES,
  matchRoute,
} from './admin-reddit-routes';
import { AdminAccessLog, accessRouteOf } from './admin-access-log';
import { IMPORT_REDACTED, redactReport } from './admin-reddit.service';

const SECRET = 'unit-secret-0123456789abcdef';

function ctxOf(headers: Record<string, string>) {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    once() {},
    end() {},
    statusCode: 200,
  };
  const req = { headers, method: 'GET', path: '/internal/admin/reddit/status' };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function errOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe('P-R-ADM: маршруты Админки = обработчики кабинета', () => {
  const reddit = enumerateControllers([PublisherRedditController as never]);
  const access = adminRedditAccess('u1');
  const actionsOf = (cls: { prototype: object }, name: string) =>
    Reflect.getMetadata(
      PUB_ACTIONS_KEY,
      (cls.prototype as Record<string, object>)[name],
    ) as PubAction[];

  it('rx: все 40 маршрутов REDDIT_ROUTES, путь/метод/действие — те же, что у обработчика', () => {
    expect(RX_ROUTES).toHaveLength(40);
    expect(RX_ROUTES.map((r) => r.name).sort()).toEqual(
      Object.keys(REDDIT_ROUTES).sort(),
    );
    for (const r of RX_ROUTES) {
      const h = reddit.find((x) => x.handler === r.name);
      expect({ name: r.name, method: h?.method, path: h?.path }).toEqual({
        name: r.name,
        method: r.method,
        path: `/publisher/products/:pid/reddit/${r.pattern}`,
      });
      const contract = REDDIT_ROUTES[r.name as keyof typeof REDDIT_ROUTES];
      expect(actionsOf(PublisherRedditController, r.name)).toEqual(
        Array.isArray(contract.action) ? contract.action : [contract.action],
      );
      // Каждое действие маршрута доступно оператору Админки.
      expect({
        name: r.name,
        ok: actionsOf(PublisherRedditController, r.name).some((a) =>
          can(access, a),
        ),
      }).toEqual({ name: r.name, ok: true });
    }
  });

  it('cx: 24 маршрута — те же обработчики кабинета (материалы, источники, оффер и бренд, публикации, AI); проверка объекта и сужения', () => {
    expect(CX_ROUTES.map((r) => `${r.ctl} ${r.method} ${r.pattern}`)).toEqual([
      'materials GET contents/:cid/versions',
      'materials POST contents/:cid/versions',
      'materials GET contents/:cid/versions/:vid',
      'materials PATCH contents/:cid/versions/:vid',
      'materials POST contents/:cid/versions/:vid/submit',
      'materials GET contents/:cid/versions/:a/diff/:b',
      'materials POST contents/:cid/transition',
      'materials GET versions/:vid/qa-checks',
      'materials POST versions/:vid/qa-checks',
      'materials POST versions/:vid/approve',
      'materials POST approvals/:id/revoke',
      'sources GET sources',
      'sources POST sources',
      'sources POST sources/:id/revoke',
      'sources GET offers',
      'sources POST offers',
      'sources POST offers/:id/activate',
      'sources GET brand-facts',
      'sources POST brand-facts',
      'sources POST brand-facts/:id/activate',
      'sources POST brand-facts/:id/resolve',
      'sources POST brand-facts/:id/retire',
      'distribution POST publications/:id/transition',
      'ai GET ai/calls/:callId',
    ]);
    const classes = {
      materials: ContentMaterialsController,
      sources: ContentSourcesController,
      distribution: PublisherDistributionController,
      ai: PublisherAiController,
    } as const;
    for (const r of CX_ROUTES) {
      const cls = classes[r.ctl as keyof typeof classes];
      const h = enumerateControllers([cls as never]).find(
        (x) => x.handler === r.name,
      );
      expect({ name: r.name, method: h?.method, path: h?.path }).toEqual({
        name: r.name,
        method: r.method,
        path: `/publisher/products/:pid/${r.pattern}`,
      });
      expect({
        name: r.name,
        ok: actionsOf(cls, r.name).some((a) => can(access, a)),
      }).toEqual({ name: r.name, ok: true });
    }
    // Объект пути — только Reddit/платформенный: у каждого маршрута с id,
    // кроме оффера и фактов бренда (они и есть объекты платформенного
    // продукта, обработчик ищет по продукту), есть проверка объекта.
    for (const r of CX_ROUTES.filter((x) => x.pattern.includes(':'))) {
      expect({
        name: r.name,
        scoped:
          r.scope !== undefined || /^(offers|brand-facts)\//.test(r.pattern),
      }).toEqual({ name: r.name, scoped: true });
    }
    const n = (name: string) => CX_ROUTES.find((r) => r.name === name);
    expect(n('qaCheck')?.narrow).toBe('qa_kind');
    expect(n('transition')?.narrow).toBe('content_transition');
    expect(n('createSource')?.narrow).toBe('source_kind');
    expect(n('publicationTransition')).toMatchObject({
      narrow: 'withdraw',
      scope: 'reddit_publication',
    });
    expect(n('revokeSource')?.scope).toBe('reddit_source');
    expect(n('revokeApproval')?.scope).toBe('reddit_approval');
    expect(n('getCall')?.scope).toBe('reddit_ai_call');
    expect([...ADMIN_CONTENT_TRANSITIONS]).toEqual([
      'request_changes',
      'unschedule',
    ]);
    expect([...ADMIN_SOURCE_KINDS]).toEqual(['manual_text', 'url']);
    for (const name of ['listParameters', 'listProposals', 'propose', 'decide'])
      expect(
        actionsOf(PublisherCoreController, name).some((a) => can(access, a)),
      ).toBe(true);
  });

  it('шаблон маршрута журнала доступа — без id и query', () => {
    const P = '/internal/admin/reddit/';
    expect(accessRouteOf('GET', `${P}rx/projects/p1`)).toBe('rx/projects/:id');
    expect(accessRouteOf('POST', `${P}cx/sources/s1/revoke`)).toBe(
      'cx/sources/:id/revoke',
    );
    expect(accessRouteOf('GET', `${P}cx/claims`)).toBe('cx/unknown');
    expect(accessRouteOf('POST', `${P}params/niche/decide`)).toBe(
      'params/:key/decide',
    );
    expect(accessRouteOf('GET', `${P}status`)).toBe('status');
    expect(accessRouteOf('POST', `${P}import/apply`)).toBe('import/apply');
    expect(accessRouteOf('GET', `${P}nope/x`)).toBe('unknown');
    expect(accessRouteOf('GET', `${P}cx/ai/calls/aic_1`)).toBe(
      'cx/ai/calls/:callId',
    );
  });

  it('контроллер: закрытый список путей, публичный маршрут с секретом, первый гвард — AdminRedditGuard', () => {
    const routes = enumerateControllers([AdminRedditController as never]);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'GET /internal/admin/reddit/status',
        'POST /internal/admin/reddit/setup',
        'GET /internal/admin/reddit/rx/*path',
        'POST /internal/admin/reddit/rx/*path',
        'PATCH /internal/admin/reddit/rx/*path',
        'GET /internal/admin/reddit/cx/*path',
        'POST /internal/admin/reddit/cx/*path',
        'PATCH /internal/admin/reddit/cx/*path',
        'GET /internal/admin/reddit/params',
        'GET /internal/admin/reddit/params/:key/proposals',
        'POST /internal/admin/reddit/params/:key/propose',
        'POST /internal/admin/reddit/params/:key/decide',
        'POST /internal/admin/reddit/import/plan',
        'POST /internal/admin/reddit/import/apply',
      ].sort(),
    );
    for (const r of routes) {
      expect(r.publicReason).toMatch(/X-Sites-Internal-Secret/);
      expect(r.pubActions).toBeUndefined();
    }
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminRedditController,
    ) as unknown[];
    expect(guards).toEqual([AdminRedditGuard]);
  });

  it('matchRoute: параметры, id не того формата, метод, длина пути', () => {
    expect(matchRoute(RX_ROUTES, 'GET', 'projects/p1')).toMatchObject({
      route: { name: 'getProject' },
      params: { id: 'p1' },
    });
    expect(
      matchRoute(RX_ROUTES, 'GET', 'communities/c1/rules/s1/source'),
    ).toMatchObject({
      route: { name: 'getRulesSource' },
      params: { id: 'c1', sid: 's1' },
    });
    expect(
      matchRoute(RX_ROUTES, 'POST', 'opportunities/o1/qualify')?.route.name,
    ).toBe('qualifyOpportunity');
    expect(matchRoute(RX_ROUTES, 'DELETE', 'projects/p1')).toBeNull();
    expect(matchRoute(RX_ROUTES, 'GET', 'projects/p.1')).toBeNull();
    expect(matchRoute(RX_ROUTES, 'GET', 'projects/p1/x')).toBeNull();
    expect(matchRoute(RX_ROUTES, 'GET', 'projects/%E0%A4%A')).toBeNull();
    expect(matchRoute(RX_ROUTES, 'GET', '../leads')).toBeNull();
    expect(
      matchRoute(CX_ROUTES, 'GET', 'contents/c1/versions/a1/diff/b1'),
    ).toMatchObject({
      route: { name: 'diff' },
      params: { cid: 'c1', a: 'a1', b: 'b1' },
    });
    expect(matchRoute(CX_ROUTES, 'GET', 'claims')).toBeNull();
  });
});

describe('P-R-ADM: актор и синтетическое членство', () => {
  it('memberActor: участник → member:<id>, синтетический admin:<id> → он же; memberIdOfActor — обратно', () => {
    expect(memberActor('cm1')).toBe('member:cm1');
    expect(memberActor('admin:u1')).toBe('admin:u1');
    expect(adminActor('u1')).toBe('admin:u1');
    expect(memberIdOfActor('member:cm1')).toBe('cm1');
    expect(memberIdOfActor('admin:u1')).toBe('admin:u1');
    expect(memberIdOfActor('system:x')).toBeNull();
    expect(memberIdOfActor(null)).toBeNull();
    expect(ACTOR_RE.test(`admin:${'a'.repeat(58)}`)).toBe(true);
    expect(ACTOR_RE.test(`admin:${'a'.repeat(59)}`)).toBe(false);
  });

  it('членство: не владелец, без ролей продуктов; права — PO+ED+OP+AN и только закрытый список', () => {
    const m = adminMembership('acc1', 'u1');
    expect(m).toMatchObject({
      accountId: 'acc1',
      memberId: 'admin:u1',
      role: 'operator',
      telegramId: 0n,
    });
    expect(m.productRoles.publisher ?? 'none').toBe('none');
    const a = adminRedditAccess('u1');
    expect([a.admin, a.accountOwner, a.memberId]).toEqual([
      false,
      false,
      'admin:u1',
    ]);
    expect(can(a, 'lead.contact.reveal')).toBe(false);
    expect(can(a, 'role.manage')).toBe(false);
    expect(can(a, 'reddit.handoff')).toBe(true);
    expect(ADMIN_REDDIT_ACTIONS).toContain('version.approve');
    // Доступ setup: только создание продукта, даже с admin=true.
    const setup = {
      ...adminRedditAccess('u1', ['product.create']),
      admin: true,
    };
    expect(can(setup, 'product.create')).toBe(true);
    expect(can(setup, 'product.mode')).toBe(false);
    expect(can(setup, 'reddit.read')).toBe(false);
  });

  it('ключи параметров: reddit_publish + P-R; v1.4 — ai_use, ai_unpriced_allowed и бюджет месяца AI', () => {
    expect([...ADMIN_PARAMETER_KEYS].sort()).toEqual(
      [
        ...GATE_PARAMETER_KEYS.reddit_publish,
        'reddit_excerpt_retention_days',
        'ai_budget_usd_month',
        'ai_fx_rate',
        'ai_unpriced_allowed',
        'budget_total',
        'budget_split',
        'per_purchase_max',
      ].sort(),
    );
    for (const k of [
      ...GATE_PARAMETER_KEYS.ai_use,
      ...BUDGET_LIMIT_PARAMETER_KEYS,
      ...GATE_PARAMETER_KEYS.spend,
    ])
      expect(isAdminParameterKey(k)).toBe(true);
    for (const k of [
      'rates_by_role',
      'domain_host',
      'retention_policy',
      'allowed_cpl_inputs',
      'launch_evidence_purchase',
    ])
      expect(isAdminParameterKey(k)).toBe(false);
    expect(isAdminParameterKey('niche')).toBe(true);
  });

  it('платформенный сайт: первый валидный id из ASSIST_INTERNAL_SITE_IDS', () => {
    expect(publisherPlatformSiteId({})).toBeNull();
    expect(
      publisherPlatformSiteId({ ASSIST_INTERNAL_SITE_IDS: '  ' }),
    ).toBeNull();
    expect(
      publisherPlatformSiteId({ ASSIST_INTERNAL_SITE_IDS: 'bad!, s1 s2' }),
    ).toBe('s1');
    expect(publisherPlatformSiteId({ ASSIST_INTERNAL_SITE_IDS: 's9,s1' })).toBe(
      's9',
    );
  });
});

describe('P-R-ADM: гварды внутреннего API', () => {
  const saved = process.env.SITES_INTERNAL_SECRET;
  beforeEach(() => {
    process.env.SITES_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SITES_INTERNAL_SECRET;
    else process.env.SITES_INTERNAL_SECRET = saved;
  });
  const g = new AdminRedditGuard({
    write: jest.fn(),
  } as unknown as AdminAccessLog);
  const ok = { 'x-sites-internal-secret': SECRET, 'x-admin-actor': 'u1' };

  it('Reddit: секрет нет/неверный — 401 с одним текстом; актор нет/формат — 400 ADMIN_ACTOR_REQUIRED; env нет — 503', () => {
    const none = errOf(() => g.canActivate(ctxOf({ 'x-admin-actor': 'u1' })));
    const wrong = errOf(() =>
      g.canActivate(ctxOf({ ...ok, 'x-sites-internal-secret': 'nope' })),
    );
    expect(none).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((none as Error).message).toBe((wrong as Error).message);
    for (const actor of [undefined, '', 'admin:u1', 'u 1', 'x'.repeat(59)]) {
      const h: Record<string, string> = { 'x-sites-internal-secret': SECRET };
      if (actor !== undefined) h['x-admin-actor'] = actor;
      const e = errOf(() => g.canActivate(ctxOf(h)));
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({
        error: 'ADMIN_ACTOR_REQUIRED',
      });
    }
    expect(g.canActivate(ctxOf(ok))).toBe(true);
    process.env.SITES_INTERNAL_SECRET = 'short';
    expect(errOf(() => g.canActivate(ctxOf(ok)))).toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('«Помощник» (общий InternalSecretGuard): поведение прежнее — нет актора 401, двоеточие в акторе допустимо', () => {
    const p = new InternalSecretGuard();
    expect(
      errOf(() => p.canActivate(ctxOf({ 'x-sites-internal-secret': SECRET }))),
    ).toBeInstanceOf(UnauthorizedException);
    expect(
      p.canActivate(
        ctxOf({ 'x-sites-internal-secret': SECRET, 'x-admin-actor': 'op:1' }),
      ),
    ).toBe(true);
    expect(
      errOf(() => p.canActivate(ctxOf({ 'x-admin-actor': 'op' }))),
    ).toBeInstanceOf(UnauthorizedException);
  });
});

describe('P-R-ADM: отчёт импорта без контактов', () => {
  it('ref/detail с контактом или ником — скрыты, прочее — как есть', () => {
    const r = redactReport({
      apply: false,
      productId: 'p1',
      items: [
        {
          kind: 'keyword',
          ref: 'admin: call me@example.org',
          outcome: 'rejected',
          code: 'pii',
        },
        {
          kind: 'keyword',
          ref: 'admin: ask u/someone',
          outcome: 'rejected',
          code: 'profile_ref',
        },
        {
          kind: 'community',
          ref: 'r/SaaS',
          outcome: 'would_create',
          detail: '+380 67 123 45 67',
        },
        { kind: 'project', ref: 'Платформа', outcome: 'exists' },
      ],
      blocks: [],
      complete: true,
      warnings: [
        {
          kind: 'rules',
          ref: 'admin: r/a',
          code: 'enum_default',
          detail: 'call +380 67 123 45 67',
        },
      ],
      summary: {},
    });
    expect(r.warnings[0].detail).toBe(IMPORT_REDACTED);
    expect(r.items.map((i) => [i.ref, i.detail])).toEqual([
      [IMPORT_REDACTED, undefined],
      [IMPORT_REDACTED, undefined],
      ['r/SaaS', IMPORT_REDACTED],
      ['Платформа', undefined],
    ]);
  });
});

describe('P-R-ADM v1.4: AI платформенного продукта (Р-RD-ADM-14, -15)', () => {
  const miss = (key: string) => ({
    kind: 'parameter' as const,
    key,
    detail: 'assumption',
  });

  it('aiGate: флаг → генератор (до eval 2.3) → гейт; генератор включён — отдельным полем', () => {
    const closed = { open: false, missing: [miss('ai_fx_rate')] };
    const open = { open: true, missing: [] };
    expect(
      aiGateState({ flagOn: false, generatorEnabled: true, gate: open }),
    ).toMatchObject({ reason: 'flag_off', generatorEnabled: true, open: true });
    expect(
      aiGateState({ flagOn: true, generatorEnabled: false, gate: open }),
    ).toMatchObject({ reason: 'generator_disabled', generatorEnabled: false });
    expect(
      aiGateState({ flagOn: true, generatorEnabled: true, gate: closed }),
    ).toEqual({
      open: false,
      missing: closed.missing,
      generatorEnabled: true,
      reason: 'gate_closed',
    });
    expect(
      aiGateState({ flagOn: true, generatorEnabled: true, gate: open }).reason,
    ).toBeNull();
  });

  it('aiMonth: ключи AI → гейт spend → ждёт задания; строка месяца — остаток или cap_exhausted', () => {
    const month = '2026-10';
    const row = (cap: bigint, spent: bigint, reserved: bigint) => ({
      capMicroUsd: cap,
      spentMicroUsd: spent,
      reservedMicroUsd: reserved,
    });
    expect(
      aiMonthState({
        month,
        row: null,
        aiParamsMissing: [miss('ai_budget_usd_month')],
        spend: { open: false, missing: [miss('budget_total')] },
      }),
    ).toEqual({
      month,
      open: false,
      reason: 'ai_params_missing',
      missing: [miss('ai_budget_usd_month')],
    });
    const spendMissing = [
      {
        kind: 'budget' as const,
        key: 'pub_budget_limits',
        detail: 'not_built',
      },
    ];
    expect(
      aiMonthState({
        month,
        row: null,
        aiParamsMissing: [],
        spend: { open: false, missing: spendMissing },
      }),
    ).toMatchObject({
      open: false,
      reason: 'spend_gate_closed',
      missing: spendMissing,
    });
    expect(
      aiMonthState({
        month,
        row: null,
        aiParamsMissing: [],
        spend: { open: true, missing: [] },
      }),
    ).toMatchObject({ open: false, reason: 'month_not_open' });
    expect(
      aiMonthState({
        month,
        row: row(10n, 4n, 5n),
        aiParamsMissing: [],
        spend: null,
      }),
    ).toEqual({ month, open: true, reason: null, missing: [] });
    expect(
      aiMonthState({
        month,
        row: row(10n, 4n, 6n),
        aiParamsMissing: [],
        spend: null,
      }),
    ).toMatchObject({ open: true, reason: 'cap_exhausted' });
  });

  it('подсказка бюджета «только AI»: размещения, резерв и закупка 0; инструменты = месяц AI по курсу × 12; значения проходят утверждение и согласованность', () => {
    const none = platformBudgetHint({
      ai_budget_usd_month: { microUsd: 20_000_000 },
      ai_fx_rate: { rate: null, source: null, at: null },
      budget_total: { amountMinor: 1_000_000, currency: 'UAH' },
    });
    expect(none).toEqual({
      mode: 'ai_only',
      currency: 'UAH',
      months: PLATFORM_AI_MONTHS,
      aiMonthMinor: null,
      values: null,
    });
    const h = platformBudgetHint({
      ai_budget_usd_month: { microUsd: 20_000_000 },
      ai_fx_rate: { rate: '41.5', source: 'NBU', at: '2026-10-01T00:00:00Z' },
      budget_total: { amountMinor: 1_000_000, currency: 'UAH' },
    });
    // 20 USD = 2000 центов × 41.5 = 83 000 копеек в месяц
    expect(h.aiMonthMinor).toBe(83_000);
    expect(h.values).toEqual({
      budget_total: { amountMinor: 83_000 * 12, currency: 'UAH' },
      budget_split: {
        placementsMinor: 0,
        toolsMinor: 83_000 * 12,
        reserveMinor: 0,
      },
      per_purchase_max: { amountMinor: 0 },
    });
    for (const [k, v] of Object.entries(h.values!))
      expect(parameterApprovalIssues(k as never, v)).toEqual([]);
    expect(budgetConsistencyIssues(h.values!)).toEqual([]);
    expect(
      platformBudgetHint({
        ai_budget_usd_month: { microUsd: 1 },
        ai_fx_rate: { rate: 'x', source: null, at: null },
      }).values,
    ).toBeNull();
  });
});
