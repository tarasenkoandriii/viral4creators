/**
 * Клиенты Э3 (T): диалоги и передача (H), обучение (L), цели и статистика
 * (A), вовлечение (T). Сверка с сервером — перечни импортом чистых
 * модулей, поля интерфейсов — по тексту `api-types.ts`; строгость разбора
 * (ничего неожиданного не становится кнопкой, ссылкой или «секретом»);
 * пути и тела запросов — подменённым клиентом.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, type ApiClient } from '../src/kit';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import {
  E3_ERROR_CODES,
  e3ErrorNotice,
  e3ErrorText,
  fieldErrorLines,
} from '../src/lib/e3-errors';
import * as ET from '../src/lib/engagement-types';
import {
  conversationQuery,
  createHandoffApi,
  parseConversation,
  parseConversationList,
  parseHandoffSettings,
  parseReply,
  parseTake,
  requestVoid,
} from '../src/lib/handoff-api';
import * as HT from '../src/lib/handoff-types';
import {
  createLearningApi,
  parseGolden,
  parseQuality,
  parseQueue,
  parseQueueDraft,
  parseSimulation,
} from '../src/lib/learning-api';
import * as LT from '../src/lib/learning-types';
import { SETUP_ERROR_CODES } from '../src/lib/setup-errors';
import {
  createStatsApi,
  parseConversions,
  parseExport,
  parseGoal,
  parseIntegrations,
  parseOverview,
  parsePickerStatus,
  parsePickerToken,
  parseSecret,
  parseTopics,
} from '../src/lib/stats-api';
import * as ST from '../src/lib/stats-types';
import { createWidgetApi, parseWidgetConfig } from '../src/lib/widget-api';
import { goalWebhookUrl, publicApiBase } from '../src/lib/public-api';
// Серверные модули — чистые: сверяем ими напрямую.
import * as SE from '../../sites-backend/src/modules/assist-site-setup/engagement-config';
import { defaultWidgetConfig } from '../../sites-backend/src/modules/assist-site-setup/widget-config';

const BACK = '../../sites-backend/src/modules/';
const src = (rel: string) =>
  readFileSync(new URL(`${BACK}${rel}`, import.meta.url), 'utf8');

/** `export const NAME = [ 'a', 'b' ] as const` из текста файла. */
function constList(file: string, name: string): string[] {
  const m = file.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`)
  );
  assert.ok(m, `нет ${name}`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Поля интерфейсов по тексту (верхний уровень, 2 пробела отступа). */
function interfaces(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of file.matchAll(
    /export interface (\w+)(?:<\w+>)?\s*\{([\s\S]*?)\n\}/g
  )) {
    out.set(
      m[1],
      [...m[2].matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]).sort()
    );
  }
  return out;
}
const keys = (o: object) => Object.keys(o).sort();

const H_SRC = src('assist-site-handoff/api-types.ts');
const HC_SRC = src('assist-site-handoff/public/handoff-config.ts');
const L_SRC = src('assist-site-learning/api-types.ts');
const A_SRC = src('assist-analytics/api-types.ts');
const G_SRC = src('assist-analytics/goal-types.ts');
const AC_SRC = src('assist-analytics/analytics-config.ts');
const H = interfaces(H_SRC);
const HC = interfaces(HC_SRC);
const L = interfaces(L_SRC);
const A = interfaces(A_SRC);
const G = interfaces(G_SRC);
const AC = interfaces(AC_SRC);

// ═══ 1. Перечни — те же, что у сервера ═════════════════════════════════
assert.deepEqual([...HT.HANDOFF_STATES], constList(H_SRC, 'HANDOFF_STATES'));
assert.deepEqual([...HT.HANDOFF_REASONS], constList(H_SRC, 'HANDOFF_REASONS'));
assert.deepEqual(
  [...HT.ESCALATION_KINDS],
  constList(H_SRC, 'ESCALATION_KINDS')
);
assert.deepEqual(
  [...HT.HANDOFF_ERROR_CODES],
  constList(H_SRC, 'HANDOFF_ERROR_CODES')
);
assert.deepEqual([...HT.WEEKDAYS], constList(HC_SRC, 'WEEKDAYS'));
{
  // Лимиты передачи — числа из текста серверного модуля.
  const block = HC_SRC.match(
    /export const HANDOFF_LIMITS = \{([\s\S]*?)\} as const/
  )![1];
  for (const [k, v] of Object.entries(HT.HANDOFF_LIMITS)) {
    if (typeof v === 'number') {
      assert.ok(
        new RegExp(`\\b${k}: ${v},`).test(block),
        `HANDOFF_LIMITS.${k}`
      );
    } else {
      assert.ok(
        new RegExp(
          `\\b${k}: \\{ min: ${v.min}, max: ${v.max}, default: ${v.default} \\}`
        ).test(block),
        `HANDOFF_LIMITS.${k}`
      );
    }
  }
}
assert.deepEqual([...LT.LEARNING_KINDS], constList(L_SRC, 'LEARNING_KINDS'));
assert.deepEqual(
  [...LT.LEARNING_ERROR_CODES],
  constList(L_SRC, 'LEARNING_ERROR_CODES')
);
assert.deepEqual([...ST.GOAL_TEMPLATES], constList(G_SRC, 'GOAL_TEMPLATES'));
assert.deepEqual(
  [...ST.ANALYTICS_ERROR_CODES],
  constList(A_SRC, 'ANALYTICS_ERROR_CODES')
);
assert.ok(G_SRC.includes(`GOAL_KEY = ${ST.GOAL_KEY.toString()};`), 'GOAL_KEY');
for (const [k, v] of Object.entries(ST.GOAL_LIMITS)) {
  assert.ok(new RegExp(`\\b${k}: ${v},`).test(G_SRC), `GOAL_LIMITS.${k}`);
}
// Вовлечение — импортом (модуль T, чистый).
assert.deepEqual([...ET.TRIGGER_KINDS], [...SE.TRIGGER_KINDS]);
assert.deepEqual(ET.ENGAGEMENT_LIMITS, SE.ENGAGEMENT_LIMITS);
assert.equal(ET.ENGAGEMENT_KEY.source, SE.ENGAGEMENT_KEY.source);
assert.deepEqual(ET.defaultEngagement(), SE.defaultEngagementConfig());

// ═══ 2. Поля форм — по тексту api-types.ts ═════════════════════════════
const HANDOFF = {
  id: 'h1',
  state: 'active',
  reason: 'escalation',
  escalation: 'refund',
  requestedAt: '2026-10-02T10:00:00.000Z',
  takenAt: '2026-10-02T10:01:00.000Z',
  timeoutAt: '2026-10-02T10:05:00.000Z',
  closedAt: null,
  assignedMemberId: 'm1',
  assignedToMe: true,
  visitorLang: 'ru',
  operatorLang: 'uk',
  summary: { text: 'Хочет вернуть товар', lang: 'uk', source: 'model' },
  draft: {
    text: 'Возврат — 14 дней',
    lang: 'ru',
    sources: [{ n: 1, url: 'https://shop.ua/r', title: 'Возврат' }],
  },
  identity: { present: true, verified: true },
};
const MESSAGE = {
  id: 'm1',
  role: 'assistant',
  text: 'Ответ',
  lang: 'ru',
  translation: { lang: 'uk', text: 'Відповідь' },
  sources: [{ n: 1, url: 'https://shop.ua/a', title: 'A' }],
  actions: [{ kind: 'link', label: 'Открыть', url: 'https://shop.ua/a' }],
  rating: 1,
  flags: ['numbers'],
  trace: {
    knowledgeVersion: 3,
    configVersion: 2,
    path: 'model',
    chunkIds: ['c1'],
    faqId: null,
    rule: null,
    cache: false,
    translated: true,
  },
  authorIsMe: false,
  createdAt: '2026-10-02T10:00:00.000Z',
};
const CONV = {
  id: 'c1',
  createdAt: 'x',
  lastMessageAt: 'x',
  pageUrl: 'https://shop.ua/p',
  locale: 'ru',
  outcome: null,
  openedBy: 'trigger:delivery',
  messages: [MESSAGE],
  handoff: HANDOFF,
  lead: { id: 'l1', fieldNames: ['name', 'phone'], createdAt: 'x' },
};
const cv = parseConversation(CONV);
assert.deepEqual(keys(cv), H.get('ConversationView'));
assert.deepEqual(keys(cv.handoff!), H.get('HandoffView'));
assert.deepEqual(keys(cv.handoff!.summary!), H.get('HandoffSummary'));
assert.deepEqual(keys(cv.handoff!.draft!), H.get('HandoffDraft'));
assert.deepEqual(keys(cv.messages[0]), H.get('ConversationMessageView'));
assert.deepEqual(cv.messages[0], MESSAGE, 'сообщение читается без потерь');
assert.deepEqual(cv.handoff, HANDOFF, 'передача читается без потерь');
const list = parseConversationList({
  items: [
    {
      id: 'c1',
      createdAt: 'x',
      lastMessageAt: 'x',
      pageUrl: null,
      locale: 'ru',
      outcome: null,
      flagged: true,
      openedBy: null,
      preview: 'Привет',
      messages: 3,
      handoff: {
        id: 'h1',
        state: 'waiting',
        requestedAt: 'x',
        assignedToMe: false,
      },
      hasLead: false,
    },
  ],
  nextCursor: 'cur',
});
assert.deepEqual(keys(list), H.get('ConversationListView'));
assert.deepEqual(keys(list.items[0]), H.get('ConversationListItem'));
assert.deepEqual(
  keys(parseTake({ result: 'taken', handoff: HANDOFF })),
  H.get('TakeResult')
);
assert.deepEqual(
  keys(parseReply({ messageId: 'x', sentText: 'y', translated: true })),
  H.get('OperatorReplyResult')
);
const settings = parseHandoffSettings({
  config: {
    schema: 1,
    enabled: true,
    hours: { mon: [{ from: '09:00', to: '18:00' }], sun: [] },
    waitMinutes: 5,
    remindAfterMinutes: 3,
    maxReminders: 2,
    idleCloseHours: 24,
    etaText: { uk: '~5 хв' },
    templates: [{ id: 't1', title: 'Привет', text: 'Здравствуйте!' }],
    operatorLang: 'uk',
    translate: true,
    draft: true,
    escalation: {
      irritation: true,
      complaint: true,
      refund: true,
      wholesale: false,
      sensitive: true,
    },
  },
  etaMinutes: 4,
  availableNow: true,
  unavailableReason: null,
  operators: [
    {
      memberId: 'm1',
      telegramId: '42',
      role: 'operator',
      assist: 'operator',
      botStarted: true,
      botBlocked: false,
      isMe: false,
    },
  ],
});
assert.deepEqual(keys(settings), H.get('HandoffSettingsView'));
assert.deepEqual(keys(settings.config), HC.get('HandoffConfig'));
assert.deepEqual(keys(settings.operators[0]), H.get('OperatorView'));
assert.deepEqual(settings.config.hours, {
  mon: [{ from: '09:00', to: '18:00' }],
  sun: [],
});

const queue = parseQueue({
  entries: [
    {
      entry: 'cluster',
      id: 'k1',
      label: 'Доставка',
      kind: 'unknown',
      size: 5,
      distinctVisitors: 3,
      examples: ['Есть доставка?'],
      pages: ['https://shop.ua/d'],
      lang: 'ru',
      firstSeenAt: 'x',
      lastSeenAt: 'x',
      status: 'open',
      reopened: false,
    },
    {
      entry: 'candidate',
      id: 'k2',
      kind: 'operator_fix',
      questionMasked: 'Q',
      proposedAnswer: 'A',
      proposedByMe: true,
      proposedAt: 'x',
      conversationId: 'c1',
      status: 'proposed',
    },
  ],
  counts: {
    unknown: 1,
    wrong: 0,
    unhappy: 0,
    operator_fix: 1,
    voice_miss: 0,
    candidates: 1,
  },
});
assert.equal(queue.entries.length, 2);
assert.deepEqual(keys(queue), L.get('QueueView'));
assert.deepEqual(
  keys(parseQueueDraft({ text: 'x', lang: null, sources: [], status: 'ok' })),
  L.get('QueueDraftView')
);
const golden = parseGolden({
  id: 'g1',
  question: 'Q',
  answer: 'A',
  variants: ['q2'],
  lang: 'ru',
  origin: 'operator_candidate',
  sourceRefs: [{ documentId: null, url: 'https://shop.ua/a', chunkHash: 'h' }],
  status: 'active',
  conflictNote: null,
  approvedAt: '2026-10-01T00:00:00.000Z',
  approvedByMe: true,
  reviewAt: null,
  updatedAt: 'x',
});
assert.deepEqual(keys(golden!), L.get('GoldenView'));
const quality = parseQuality({
  completeness: { covered: 3, total: 5 },
  lastEval: {
    id: 'e',
    kind: 'scheduled',
    at: 'x',
    passed: 9,
    failed: 1,
    stale: 0,
    failures: [{ question: 'q', expected: null, got: 'g', reason: 'r' }],
  },
  weekly: [
    {
      weekStart: '2026-09-28',
      dialogs: 10,
      unknownShare: 0.1,
      thumbsUpShare: null,
      handoffShare: 0.2,
    },
  ],
  learningBudget: { spentMicroUsd: 1, capMicroUsd: 2, period: '2026-10' },
  nextScheduledEvalAt: null,
  goldenNeedsReview: 0,
});
assert.deepEqual(keys(quality), L.get('QualityView'));
assert.deepEqual(keys(quality.lastEval!.failures[0]), L.get('EvalFailureView'));
assert.deepEqual(
  keys(parseSimulation({ status: 'done', reason: null, personas: [] })),
  L.get('SimulationView')
);

const goal = parseGoal({
  id: 'g1',
  key: 'purchase',
  template: 'purchase',
  name: 'Покупка',
  detectors: [
    { kind: 'url', config: { pathMask: '/thanks*', fromPathMask: null } },
    { kind: 'click', config: { auto: 'tel' } },
    {
      kind: 'form_submit',
      config: {
        descriptor: {
          assistGoal: null,
          assistId: null,
          role: 'form',
          text: 'Купить',
          tag: 'form',
        },
        pathMask: '/cart',
      },
    },
    { kind: 's2s', config: {} },
  ],
  valueMode: 'event',
  fixedValue: null,
  currency: 'UAH',
  status: 'active',
  lastFiredAt: null,
  createdAt: 'x',
});
assert.deepEqual(keys(goal!), A.get('GoalView'));
assert.equal(goal!.detectors.length, 4);
assert.deepEqual(keys(goal!.detectors[2].config), ['descriptor', 'pathMask']);
assert.deepEqual(
  keys((goal!.detectors[2].config as { descriptor: object }).descriptor),
  G.get('ElementDescriptor')
);
const metric = { value: 10, prev: 8, deltaPct: 25, noise: true };
const PERIOD = {
  from: '2026-09-01',
  to: '2026-09-30',
  attributionWindowOpenFrom: null,
  timezone: 'Europe/Kyiv',
};
const overview = parseOverview({
  period: PERIOD,
  dialogs: metric,
  resolved: metric,
  resolvedShare: metric,
  operatorHoursSaved: 1.5,
  minutesPerQuestion: 3,
  handoffs: metric,
  handoffsMissed: metric,
  leads: metric,
  conversions: { total: metric, direct: metric, assisted: metric },
  thumbsUpShare: metric,
  costMicroUsd: 1234,
  series: [
    {
      day: '2026-09-01',
      dialogs: 1,
      resolved: 1,
      handoffs: 0,
      leads: 0,
      conversions: 0,
    },
  ],
});
assert.deepEqual(keys(overview), A.get('StatsOverviewView'));
assert.deepEqual(keys(overview.period), A.get('StatsPeriod'));
assert.deepEqual(keys(overview.dialogs), A.get('MetricView'));
assert.deepEqual(
  keys(parseConversions({ period: PERIOD, goals: [], proactive: [] })),
  A.get('StatsConversionsView')
);
assert.deepEqual(
  keys(parseTopics({ period: PERIOD, topics: [], uncovered: 2 })),
  A.get('StatsTopicsView')
);
assert.deepEqual(
  keys(parseIntegrations({ goalWebhook: {}, identity: {} })),
  A.get('IntegrationsView')
);
assert.deepEqual(
  keys(
    parsePickerToken({
      tokenId: 't1',
      url: 'https://shop.ua/?v4c_goal=x',
      expiresAt: 'x',
    })
  ),
  A.get('GoalPickerTokenView')
);
assert.deepEqual(
  keys(
    parseSecret({
      kind: 'identity',
      secret: 'idsec_0123456789abcdef',
      createdAt: 'x',
    })!
  ),
  A.get('SecretIssuedView')
);
assert.deepEqual(
  keys(
    parseExport({
      id: 'x1',
      kind: 'daily',
      status: 'done',
      rows: 3,
      url: 'https://blob/x',
      expiresAt: null,
      createdAt: 'x',
    })!
  ),
  A.get('ExportView')
);
assert.deepEqual(
  keys({
    schema: 1,
    minutesPerQuestion: 3,
    officeCidrs: [],
    excludedPaths: [],
  }),
  AC.get('AnalyticsConfig')
);

// ═══ 3. Строгость: неожиданное не становится действием/ссылкой ════════
{
  const h = parseConversation({
    ...CONV,
    handoff: {
      ...HANDOFF,
      state: 'hijacked',
      assignedToMe: 'yes',
      escalation: 'drop table',
    },
    messages: [
      {
        ...MESSAGE,
        role: 'admin',
        sources: [{ n: 1, url: 'javascript:alert(1)', title: 'x' }],
        actions: [
          { kind: 'link', label: 'x', url: 'http://shop.ua' },
          { kind: 'exec', label: 'x' },
        ],
        rating: 5,
        trace: 'secret',
      },
    ],
    pageUrl: 'javascript:alert(1)',
  });
  assert.equal(
    h.handoff!.state,
    'closed',
    'неизвестное состояние — без кнопок'
  );
  assert.equal(h.handoff!.assignedToMe, false);
  assert.equal(h.handoff!.escalation, null);
  assert.equal(h.messages[0].role, 'system');
  assert.equal(h.messages[0].sources[0].url, null);
  assert.deepEqual(h.messages[0].actions, []);
  assert.equal(h.messages[0].rating, null);
  assert.equal(h.messages[0].trace, null);
  assert.equal(h.pageUrl, null);
  assert.equal(
    parseTake({ result: 'maybe', handoff: HANDOFF }).result,
    'already_taken'
  );
  const bad = parseConversationList({ items: [{ id: '../x' }, { id: 'ok' }] });
  assert.deepEqual(
    bad.items.map((x) => x.id),
    ['ok']
  );
  const s2 = parseHandoffSettings({
    config: {
      hours: { mon: [{ from: '25:00', to: '18:00' }], xyz: [] },
      waitMinutes: 999,
      operatorLang: 'de',
    },
    operators: [{ memberId: 'a/b' }],
    etaMinutes: -1,
    unavailableReason: 'party',
  });
  assert.deepEqual(s2.config.hours, { mon: [] });
  assert.equal(s2.config.waitMinutes, HT.HANDOFF_LIMITS.waitMinutes.default);
  assert.equal(s2.config.operatorLang, 'uk');
  assert.equal(s2.config.enabled, false);
  assert.deepEqual(s2.operators, []);
  assert.equal(s2.etaMinutes, null);
  assert.equal(s2.unavailableReason, null);
}
{
  const q = parseQueue({
    entries: [
      { entry: 'mystery', id: 'x' },
      { entry: 'cluster', id: 'a', pages: ['javascript:x', 'https://s.ua/p'] },
    ],
  });
  assert.equal(q.entries.length, 1);
  assert.deepEqual((q.entries[0] as LT.ClusterEntry).pages, ['https://s.ua/p']);
  assert.equal(
    parseGolden({ id: 'g', status: 'weird' })!.status,
    'needs_review'
  );
  assert.equal(parseQueueDraft({ status: 'great' }).status, 'no_sources');
}
{
  const g = parseGoal({
    id: 'g',
    detectors: [
      { kind: 'eval', config: {} },
      { kind: 'click', config: {} },
    ],
  });
  assert.deepEqual(
    g!.detectors,
    [],
    'неизвестные детекторы не рисуются и не уходят обратно'
  );
  assert.equal(parseGoal({ id: 'g', status: 'running' })!.status, 'paused');
  assert.equal(
    parsePickerToken({ tokenId: 't', url: 'http://shop.ua/?x' }).url,
    ''
  );
  assert.equal(parsePickerStatus({ status: 'picked' }).result, null);
  assert.equal(parsePickerStatus({ status: '??' }).status, 'expired');
  assert.equal(parseSecret({ secret: 'short' }), null);
  assert.equal(parseSecret({ secret: 'has spaces in the secret value' }), null);
  assert.equal(
    parseExport({ id: 'x', status: 'queued', url: 'https://blob/x' })!.url,
    null,
    'ссылка — только у готового'
  );
  assert.equal(
    parseExport({ id: 'x', status: 'done', url: 'http://blob/x' })!.url,
    null
  );
  assert.equal(
    parseIntegrations({ goalWebhook: { endpoint: 'ftp://x' } }).goalWebhook
      .endpoint,
    ''
  );
  // Интеграция Э3: сервер (A) отдаёт ПУТЬ без origin — его и принимаем;
  // полный адрес собирает экран (goalWebhookUrl + PUBLIC_API_BASE).
  const srvPath =
    /return `(\/assist\/v1\/sites\/)\$\{encodeURIComponent\(siteId\)\}(\/goal-events)`/.exec(
      src('assist-analytics/integrations.service.ts')
    );
  assert.ok(
    srvPath,
    'goalWebhookEndpoint сервера сменил форму — сверьте парсер'
  );
  const path = `${srvPath![1]}site_ab12${srvPath![2]}`;
  assert.equal(
    parseIntegrations({ goalWebhook: { endpoint: path } }).goalWebhook.endpoint,
    path
  );
  for (const bad of [
    'https://evil.example/assist/v1/sites/x/goal-events',
    '/assist/v1/sites/x/goal-events?x=1',
    '/assist/v1/sites/../goal-events',
    '//evil.example/assist/v1/sites/x/goal-events',
  ])
    assert.equal(
      parseIntegrations({ goalWebhook: { endpoint: bad } }).goalWebhook
        .endpoint,
      '',
      bad
    );
  assert.equal(
    publicApiBase(
      'https://assist-api.viral4creators.app',
      '/api',
      'https://tma.x'
    ),
    'https://assist-api.viral4creators.app'
  );
  for (const badEnv of ['http://a.b', 'https://a.b/path', 'javascript:x', ''])
    assert.equal(
      publicApiBase(badEnv, '/api', 'https://tma.x'),
      'https://tma.x/api',
      `env ${badEnv}`
    );
  assert.equal(
    publicApiBase(undefined, 'http://localhost:3010/', 'http://localhost:5174'),
    'http://localhost:3010'
  );
  assert.equal(
    goalWebhookUrl(path, 'https://assist-api.viral4creators.app'),
    `https://assist-api.viral4creators.app${path}`
  );
  assert.equal(goalWebhookUrl('', 'https://a.b'), '');
  assert.equal(goalWebhookUrl(path, '/api'), '');
  const o = parseOverview({ dialogs: { value: 'NaN', noise: 'yes' } });
  assert.equal(o.dialogs.value, 0);
  assert.equal(o.dialogs.noise, null);
}

// ═══ 4. Пути и тела запросов ═══════════════════════════════════════════
interface Call {
  method: string;
  path: string;
  body?: unknown;
}
function fakeClient(reply: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const client: ApiClient = {
    async request<T>(method: string, path: string, body?: unknown) {
      const c = { method, path, ...(body === undefined ? {} : { body }) };
      calls.push(c);
      return reply(c) as T;
    },
  };
  return { client, calls };
}
{
  const { client, calls } = fakeClient((c) =>
    c.path.endsWith('/take') ? { result: 'taken', handoff: HANDOFF } : {}
  );
  const api = createHandoffApi(client);
  await api.list('s1', {
    view: 'all',
    flagged: true,
    cursor: 'c&x=1',
    limit: 500,
  });
  await api.get('s1', 'c1');
  await api.take('s1', 'c1');
  await api.reply('s1', 'c1', { text: 'Привет', noTranslate: true });
  await api.draft('s1', 'c1');
  await api.close('s1', 'c1');
  await api.settings('s1');
  await api.saveSettings('s1', settings.config);
  await api.operators();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /assist/sites/s1/conversations?view=all&cursor=c%26x%3D1&flagged=true&limit=100',
      'GET /assist/sites/s1/conversations/c1',
      'POST /assist/sites/s1/conversations/c1/take',
      'POST /assist/sites/s1/conversations/c1/reply',
      'POST /assist/sites/s1/conversations/c1/draft',
      'POST /assist/sites/s1/conversations/c1/close',
      'GET /assist/sites/s1/handoff-settings',
      'PATCH /assist/sites/s1/handoff-settings',
      'GET /assist/account/operators',
    ]
  );
  assert.deepEqual(calls[3].body, { text: 'Привет', noTranslate: true });
  assert.deepEqual(calls[7].body, { config: settings.config });
  await assert.rejects(api.get('s1', '../admin'));
  assert.equal(
    conversationQuery({ view: 'evil' as HT.ConversationViewKind }),
    'view=handoff'
  );
}
{
  const { client, calls } = fakeClient();
  const api = createLearningApi(client);
  await api.queue('s1', { kind: 'unknown', status: 'open&x' });
  await api.propose('s1', { messageId: 'm1' });
  await api.resolve('s1', 'k1', { action: 'ignore' });
  await api.draft('s1', 'k1');
  await api.golden('s1');
  await api.createGolden('s1', { question: 'q', answer: 'a' });
  await api.patchGolden('s1', 'g1', { reviewed: true });
  await api.deleteGolden('s1', 'g1');
  await api.copyGolden('s1', 's2', ['g1']);
  await api.quality('s1');
  await api.evalRun('s1');
  await api.simulate('s1');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /assist/sites/s1/learning/site/queue?kind=unknown',
      'POST /assist/sites/s1/learning/site/queue',
      'POST /assist/sites/s1/learning/site/queue/k1/resolve',
      'POST /assist/sites/s1/learning/site/queue/k1/draft',
      'GET /assist/sites/s1/learning/site/golden',
      'POST /assist/sites/s1/learning/site/golden',
      'PATCH /assist/sites/s1/learning/site/golden/g1',
      'DELETE /assist/sites/s1/learning/site/golden/g1',
      'POST /assist/sites/s1/learning/site/golden/copy-to/s2',
      'GET /assist/sites/s1/learning/site/quality',
      'POST /assist/sites/s1/learning/site/eval-run',
      'POST /assist/sites/s1/learning/site/simulate',
    ]
  );
  assert.deepEqual(calls[8].body, { ids: ['g1'] });
}
{
  const { client, calls } = fakeClient();
  const api = createStatsApi(client);
  const p = { from: '2026-09-01', to: '2026-09-30' };
  await api.goals('s1');
  await api.createGoal('s1', {
    key: 'lead',
    template: 'lead',
    name: 'Заявка',
    detectors: [{ kind: 'builtin', config: { event: 'lead' } }],
    valueMode: 'none',
    fixedValue: null,
    currency: null,
  });
  await api.patchGoal('s1', 'g1', { status: 'paused' });
  await api.deleteGoal('s1', 'g1');
  await api.pickerToken('s1', { hostId: 'h1', path: '/' });
  await api.pickerStatus('s1', 't1');
  await api.recent('s1', 'g1');
  await api.deleteGoalEvents('s1', 'A-1&x');
  await api.overview('s1', { ...p, compare: 'prev' });
  await api.conversions('s1', { from: 'bad', to: p.to });
  await api.topics('s1', p);
  await api.sites(p);
  await api.analyticsSettings('s1');
  await api.integrations('s1');
  await api.issueSecret('s1', 'goal-webhook');
  await api.revokeIntegration('s1', 'identity');
  await api.createExport('s1', { kind: 'daily', ...p });
  await api.exports('s1');
  await api.exportOne('s1', 'x1');
  await api.subscription('s1');
  await api.saveSubscription('s1', { weekly: true, digest: false });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /assist/sites/s1/goals',
      'POST /assist/sites/s1/goals',
      'PATCH /assist/sites/s1/goals/g1',
      'DELETE /assist/sites/s1/goals/g1',
      'POST /assist/sites/s1/goals/picker-token',
      'GET /assist/sites/s1/goals/picker/t1',
      'GET /assist/sites/s1/goals/g1/recent',
      'DELETE /assist/sites/s1/goal-events?orderId=A-1%26x',
      'GET /assist/sites/s1/stats/overview?from=2026-09-01&to=2026-09-30&compare=prev',
      'GET /assist/sites/s1/stats/conversions?to=2026-09-30',
      'GET /assist/sites/s1/stats/topics?from=2026-09-01&to=2026-09-30',
      'GET /assist/stats/sites?from=2026-09-01&to=2026-09-30',
      'GET /assist/sites/s1/analytics-settings',
      'GET /assist/sites/s1/integrations',
      'POST /assist/sites/s1/integrations/goal-webhook/secret',
      'DELETE /assist/sites/s1/integrations/identity',
      'POST /assist/sites/s1/exports',
      'GET /assist/sites/s1/exports',
      'GET /assist/sites/s1/exports/x1',
      'GET /assist/sites/s1/reports/subscription',
      'PATCH /assist/sites/s1/reports/subscription',
    ]
  );
}
{
  // Вовлечение: PATCH черновика — только `{ config: { engagement } }`; PUT сценариев.
  const { client, calls } = fakeClient(() => ({
    draft: defaultWidgetConfig('x'),
  }));
  const api = createWidgetApi(client);
  const e = ET.defaultEngagement();
  await api.saveEngagement('s1', e);
  await api.saveScenarios('s1', []);
  assert.deepEqual(calls[0], {
    method: 'PATCH',
    path: '/assist/sites/s1/widget/draft',
    body: { config: { engagement: e } },
  });
  assert.deepEqual(calls[1], {
    method: 'PUT',
    path: '/assist/sites/s1/scenarios',
    body: { scenarios: [] },
  });
}
{
  // DELETE без data — успех; иные ошибки — как есть.
  const ok: ApiClient = {
    request: () => Promise.reject(new ApiError('empty_response', 'x', 200)),
  };
  await requestVoid(ok, 'DELETE', '/x');
  const fail: ApiClient = {
    request: () => Promise.reject(new ApiError('GOAL_NOT_FOUND', 'x', 404)),
  };
  await assert.rejects(requestVoid(fail, 'DELETE', '/x'));
}

// ═══ 5. Вовлечение: TMA не теряет и не выдумывает ═══════════════════════
{
  const valid = {
    schema: 1,
    triggers: [
      {
        key: 'd',
        enabled: true,
        condition: { kind: 'url_match', pathMask: '/sale*', seconds: 15 },
        pathMasks: ['/catalog/*'],
        text: { uk: 'Знижки?' },
        onAccept: { kind: 'scenario', scenarioKey: 's' },
      },
    ],
    limits: {
      perVisit: 2,
      excludedPaths: ['/checkout*'],
      notOnFirstScreenMobile: true,
    },
    scenarios: [
      {
        key: 's',
        enabled: true,
        title: { ru: 'Подбор' },
        showInGreeting: false,
        steps: [
          {
            key: 'a',
            question: { ru: 'Что?' },
            answer: {
              type: 'choice',
              options: [{ key: 'x', label: { ru: 'X' } }],
            },
          },
          {
            key: 'b',
            question: { ru: 'Сколько?' },
            answer: { type: 'number', min: 1, max: null },
          },
        ],
        final: {
          kind: 'link',
          url: 'https://shop.ua/sale',
          label: { ru: 'Открыть' },
        },
      },
    ],
  };
  const tma = ET.parseEngagement(valid);
  assert.deepEqual(tma, valid, 'полная конфигурация — без потерь');
  const back = SE.parseEngagementConfig(tma);
  assert.ok(back.ok, 'то, что TMA отправит, сервер принимает');
  // Вид с вовлечением: «Вид» сохраняет конфигурацию целиком — вовлечение не теряется.
  const view = parseWidgetConfig({
    ...defaultWidgetConfig('x'),
    engagement: valid,
  });
  assert.deepEqual(view.engagement, valid);
  // Триггер Э3-бис из будущей версии — не рисуется и не уходит обратно.
  const future = ET.parseEngagement({
    ...valid,
    triggers: [{ ...valid.triggers[0], condition: { kind: 'return_visit' } }],
  });
  assert.deepEqual(future.triggers, []);
  // Удаление сценария не ломает черновик: триггер становится «открыть чат».
  const removed = ET.removeScenario(tma, 's');
  assert.deepEqual(removed.scenarios, []);
  assert.deepEqual(removed.triggers[0].onAccept, { kind: 'open' });
  assert.ok(SE.parseEngagementConfig(removed).ok);
  // Подсказки до сохранения — те же места, что отвергнет сервер.
  const blank = {
    ...tma,
    triggers: [ET.newTrigger([])],
    scenarios: [ET.newScenario([])],
  };
  assert.deepEqual(ET.engagementIssues(blank), [
    'triggers[0].text',
    'scenarios[0].title',
  ]);
  const srv = SE.parseEngagementConfig(blank);
  assert.ok(!srv.ok);
  assert.deepEqual(
    (srv as { errors: Array<{ path: string; code: string }> }).errors.map(
      (x) => x.path
    ),
    ['scenarios[0].title', 'triggers[0].text']
  );
  assert.equal(ET.freeKey('trigger', ['trigger', 'trigger-2']), 'trigger-3');
}

// ═══ 6. Коды ошибок Э3 — переведены везде, ENGAGEMENT_INVALID у сервера ═══
{
  const setupSrc = src('assist-site-setup/errors.ts');
  assert.ok(
    setupSrc.includes("'ENGAGEMENT_INVALID'"),
    'SetupCode без ENGAGEMENT_INVALID'
  );
  assert.ok(
    (SETUP_ERROR_CODES as readonly string[]).includes('ENGAGEMENT_INVALID')
  );
  for (const [lang, app, kit] of [
    ['uk', appUk, uk],
    ['ru', appRu, ru],
    ['en', appEn, en],
  ] as const) {
    assert.deepEqual(keys(app.e3.errors), [...E3_ERROR_CODES].sort(), lang);
    for (const code of E3_ERROR_CODES) {
      const text = e3ErrorText(
        new ApiError(code, 'серверный текст', 400),
        app,
        kit
      );
      assert.equal(text, app.e3.errors[code], `${lang}: ${code}`);
    }
  }
}

// ═══ Ошибки полей форм (интеграция Э3: details.errors[] кита) ═════════
// Каждый код поля, который пишут разборы вовлечения (T) и передачи (H), —
// переведён на uk/ru/en; строки «путь — что не так».
{
  const codes = new Set<string>();
  for (const rel of [
    'assist-site-setup/engagement-config.ts',
    'assist-site-handoff/public/handoff-config.ts',
    // A: GOAL_INVALID / ANALYTICS_CONFIG_INVALID тоже несут details.errors[].
    'assist-analytics/goal-types.ts',
    'assist-analytics/analytics-config.ts',
    'assist-analytics/analytics-settings.service.ts',
    'assist-analytics/goals.service.ts',
  ]) {
    const f = src(rel);
    for (const m of f.matchAll(/code: '([a-z_]+)'/g)) codes.add(m[1]);
    for (const m of f.matchAll(/err\([^,()]+, '([a-z_]+)'\)/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 15, `кодов полей мало: ${[...codes]}`);
  for (const d of [appUk, appRu, appEn]) {
    const t = d.e3.fieldErrors as Record<string, string>;
    for (const c of codes) assert.ok(t[c], `нет перевода кода поля ${c}`);
  }
  const e = new ApiError('ENGAGEMENT_INVALID', 'x', 400, undefined, {
    errors: [
      { path: 'triggers[0].text.ru', code: 'too_long' },
      { path: '', code: 'type' },
      { path: 'x', code: 'brand_new_code' },
    ],
  });
  assert.deepEqual(fieldErrorLines(e, appRu), [
    'triggers[0].text.ru — слишком длинно',
    'неверный тип значения',
    'x — не прошло проверку',
  ]);
  assert.deepEqual(fieldErrorLines(new Error('x'), appRu), []);

  // Формы целей и настроек аналитики: текст по коду + строки полей (а не
  // одно «Проверьте настройки» — непонятно, что править).
  const g = new ApiError('GOAL_INVALID', 'x', 400, undefined, {
    errors: [{ path: 'detectors.0.config.pathMask', code: 'path_mask' }],
  });
  assert.deepEqual(e3ErrorNotice(g, appRu, ru), {
    tone: 'danger',
    text: appRu.e3.errors.GOAL_INVALID,
    lines: ['detectors.0.config.pathMask — маска пути должна начинаться с /'],
  });
  // Экраны с формами A показывают эти строки (NoticeBar), не только текст.
  const goalsSrc = readFileSync(
    new URL('../src/screens/e3/GoalsScreen.tsx', import.meta.url),
    'utf8'
  );
  const statsSrc = readFileSync(
    new URL('../src/screens/e3/StatsScreens.tsx', import.meta.url),
    'utf8'
  );
  const catchOf = (src: string, call: string) => {
    const i = src.indexOf(call);
    assert.ok(i >= 0, `нет вызова ${call}`);
    const c = src.indexOf('catch (e)', i);
    return src.slice(c, src.indexOf('}', c));
  };
  for (const [src, call] of [
    [goalsSrc, 'stats.createGoal('],
    [goalsSrc, 'stats.patchGoal('],
    [statsSrc, 'stats.saveAnalyticsSettings('],
  ] as const) {
    const pattern = /errNotice\(e\)|fieldErrorLines\(/;
    const block = call === 'stats.patchGoal(' ? goalsSrc : catchOf(src, call);
    if (call === 'stats.patchGoal(') {
      // patchGoal идёт через act(): его catch — один на экран.
      const a = block.indexOf('async function act(');
      assert.ok(a >= 0, 'нет act()');
      const c = block.indexOf('catch (e)', a);
      assert.ok(pattern.test(block.slice(c, block.indexOf('}', c))), call);
    } else assert.ok(pattern.test(block), call);
  }
}

console.log('e3-api: ok');
