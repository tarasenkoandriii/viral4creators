import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseLeadsConfig,
  parsePersona,
  parsePersonaSettings,
} from '../src/lib/persona-api';
import {
  createWidgetApi,
  parseInstallCheck,
  parsePreviewToken,
  parseWidgetConfig,
  parseWidgetSettings,
  safeWidgetOrigin,
} from '../src/lib/widget-api';
import * as T from '../src/lib/widget-types';
import {
  createWizardApi,
  parseCompleteness,
  parseWizard,
  WIZARD_BUSINESS_TYPES,
  WIZARD_ITEM_STATUSES,
  WIZARD_TARGETS,
  WIZARD_TOPICS,
} from '../src/lib/wizard-api';
// Серверные модули — чистые (без Nest/Prisma): сверяем ими напрямую.
import * as S from '../../sites-backend/src/modules/assist-site-setup/widget-config';
import * as SP from '../../sites-backend/src/modules/assist-site-setup/persona';
import * as SL from '../../sites-backend/src/modules/assist-site-setup/leads-config';

// ═══ 1. Перечни и лимиты — те же, что у сервера ════════════════════════
assert.deepEqual(T.WIDGET_POSITIONS, S.WIDGET_POSITIONS);
assert.deepEqual(T.WIDGET_MOBILE_MODES, S.WIDGET_MOBILE_MODES);
assert.deepEqual(T.WIDGET_THEMES, S.WIDGET_THEMES);
assert.deepEqual(T.WIDGET_FONTS, S.WIDGET_FONTS);
assert.deepEqual(T.WIDGET_PRESETS, S.WIDGET_PRESETS);
assert.deepEqual(T.WIDGET_LAUNCHER_ICONS, S.WIDGET_LAUNCHER_ICONS);
assert.deepEqual(T.WIDGET_UI_LANGS, S.WIDGET_UI_LANGS);
assert.deepEqual(T.WIDGET_TEXT_LIMITS, S.WIDGET_TEXT_LIMITS);
assert.deepEqual(T.WIDGET_COLOR_PRESETS, S.WIDGET_COLOR_PRESETS);
assert.deepEqual(T.WIDGET_SURFACES, S.WIDGET_SURFACES);
assert.deepEqual(T.PERSONA_TONES, SP.PERSONA_TONES);
assert.deepEqual(T.PERSONA_LIMITS, SP.PERSONA_LIMITS);
assert.equal(T.PERSONA_LANG.source, SP.PERSONA_LANG.source);
assert.deepEqual(T.LEAD_FIELDS, SL.LEAD_FIELDS);
assert.equal(T.LEADS_CONSENT_MAX, SL.LEADS_CONSENT_MAX);

// ═══ 2. Поля форм — по тексту api-types.ts (как knowledge-api.test) ═══
const BACK = '../../sites-backend/src/modules/';
function interfaces(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(
    /export interface (\w+)(?:<\w+>)?\s*\{([\s\S]*?)\n\}/g
  )) {
    const fields = [...m[2].matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]);
    out.set(m[1], fields.sort());
  }
  return out;
}
const SERVER = interfaces(
  readFileSync(
    new URL(`${BACK}assist-site-setup/api-types.ts`, import.meta.url),
    'utf8'
  )
);
const W5 = interfaces(
  readFileSync(
    new URL(
      `${BACK}assist-site-knowledge/wizard/wizard-types.ts`,
      import.meta.url
    ),
    'utf8'
  )
);
const keys = (o: object) => Object.keys(o).sort();

const DRAFT = S.defaultWidgetConfig('Магазин');
const FULL_VIEW = {
  siteId: 's1',
  publicKey: 'pk_live_ABCDEFGHIJKLMNOPQRSTUVWX',
  testKey: 'pk_test_ABCDEFGHIJKLMNOPQRSTUVWX',
  publishedVersion: 2,
  published: DRAFT,
  draft: DRAFT,
  adjustments: [
    {
      path: 'brand.primaryColor',
      reason: 'contrast_darkened',
      from: '#FFFF00',
      to: '#8A8A00',
    },
  ],
  history: [
    {
      version: 2,
      publishedAt: '2026-10-01T00:00:00.000Z',
      publishedByTelegramId: '7',
      rolledBackFrom: 1,
    },
  ],
  hosts: [
    {
      hostId: 'h1',
      origin: 'https://shop.ua',
      status: 'verified',
      widgetAllowed: true,
      graceUntil: null,
      enabledPublished: true,
    },
  ],
  warnings: [
    { code: 'host_grace', hostId: 'h1', details: '2026-10-04T00:00:00.000Z' },
  ],
  snippet:
    '<script async src="https://w.v4c.example.invalid/v1/loader.js" data-site="pk_live_ABCDEFGHIJKLMNOPQRSTUVWX"></script>',
  cspSnippet: 'script-src https://w.v4c.example.invalid;',
  chatPaused: true,
  operatorBlocked: false,
  widgetOrigin: 'https://w.v4c.example.invalid',
  draftChanged: false,
  assets: [
    {
      id: 'a1',
      kind: 'logo',
      mime: 'image/png',
      width: 10,
      height: 10,
      path: '/widget/v1/asset/a1',
    },
  ],
};
const v = parseWidgetSettings(FULL_VIEW);
assert.deepEqual(keys(v), SERVER.get('WidgetSettingsView'));
assert.deepEqual(keys(v.hosts[0]), SERVER.get('WidgetHostView'));
assert.deepEqual(keys(v.warnings[0]), SERVER.get('WidgetWarning'));
assert.deepEqual(keys(v.history[0]), SERVER.get('ConfigHistoryItem'));
assert.deepEqual(keys(v.assets![0]), SERVER.get('AssetView'));
assert.equal(v.chatPaused, true);
assert.equal(v.history[0].rolledBackFrom, 1);
// Конфигурация с сервера читается без потерь.
assert.deepEqual(v.draft, DRAFT);
assert.deepEqual(parseWidgetConfig(DRAFT), DRAFT);

const pt = parsePreviewToken({
  url: 'https://shop.ua/?v4c_preview=abcdefghijklmnop',
  token: 'abcdefghijklmnopqrstuvwxyz012345',
  expiresAt: 'x',
});
assert.deepEqual(keys(pt), SERVER.get('PreviewTokenResult'));
const ic = parseInstallCheck({
  checkedAt: 'x',
  hosts: [
    {
      hostId: 'h1',
      origin: 'https://shop.ua',
      result: 'csp_blocked',
      tagFound: true,
      lastPingAt: null,
      missingCsp: ['script-src', 'connect-src'],
    },
  ],
});
assert.deepEqual(keys(ic), SERVER.get('InstallCheckView'));
assert.deepEqual(ic.hosts[0].missingCsp, ['script-src', 'connect-src']);
assert.equal(ic.hosts[0].result, 'csp_blocked');

const ps = parsePersonaSettings({
  siteId: 's1',
  configVersion: 1,
  published: SP.defaultPersona('uk'),
  draft: SP.defaultPersona('ru'),
  history: [],
  lastGate: { ran: true, invariantsPassed: true, blocked: false, notes: ['x'] },
});
assert.deepEqual(keys(ps), SERVER.get('PersonaSettingsView'));
assert.deepEqual(keys(ps.lastGate!), SERVER.get('PersonaGateView'));
assert.deepEqual(ps.draft, SP.defaultPersona('ru'));
assert.deepEqual(
  parseLeadsConfig(SL.defaultLeadsConfig()),
  SL.defaultLeadsConfig()
);

// ═══ 3. Строгость: ничего неожиданного не попадает в стиль/DOM/ссылки ═══
const hostile = parseWidgetSettings({
  ...FULL_VIEW,
  publicKey: 'pk_live_x"><script>',
  widgetOrigin: 'http://w.v4c.example.invalid',
  draft: {
    ...DRAFT,
    brand: {
      ...DRAFT.brand,
      primaryColor: 'red;background:url(//x)',
      buttonTextColor: 'expression(alert(1))',
      font: 'Comic; x',
      logoAssetId: 'https://evil/x.svg',
      avatar: { kind: 'asset', assetId: 'javascript:x' },
    },
    layout: {
      ...DRAFT.layout,
      position: 'middle',
      zIndex: -5,
      offset: { desktop: { x: 9999, y: -1 } },
    },
    hosts: [
      { hostId: '../x', enabled: true },
      { hostId: 'h1', enabled: 'yes' },
    ],
  },
  assets: [{ id: '"><img', kind: 'logo' }],
  warnings: [{ code: 'pwned' }],
  history: 'x',
});
assert.equal(hostile.publicKey, null);
assert.equal(hostile.snippet, '');
assert.equal(hostile.widgetOrigin, undefined);
assert.equal(hostile.draft.brand.primaryColor, T.WIDGET_COLOR_PRESETS[0]);
assert.equal(hostile.draft.brand.buttonTextColor, 'auto');
assert.equal(hostile.draft.brand.font, 'system');
assert.equal(hostile.draft.brand.logoAssetId, null);
assert.deepEqual(hostile.draft.brand.avatar, { kind: 'icon', icon: 'chat' });
assert.equal(hostile.draft.layout.position, 'bottom-right');
assert.equal(hostile.draft.layout.zIndex, 2147483000);
assert.deepEqual(hostile.draft.layout.offset.desktop, { x: 200, y: 0 });
assert.deepEqual(hostile.draft.hosts, [
  { hostId: 'h1', enabled: false, pathMasks: [], hideOn: [] },
]);
assert.deepEqual(hostile.assets, []);
assert.deepEqual(hostile.warnings, []);
assert.deepEqual(hostile.history, []);
// Имя-XSS — просто строка (экран выводит его текстом React).
const named = parseWidgetConfig({
  ...DRAFT,
  brand: { ...DRAFT.brand, name: '<img src=x onerror=alert(1)>' },
});
assert.equal(named.brand.name, '<img src=x onerror=alert(1)>');

assert.equal(
  safeWidgetOrigin('https://w.example.com'),
  'https://w.example.com'
);
assert.equal(
  safeWidgetOrigin('https://w.example.com/'),
  'https://w.example.com'
);
assert.equal(
  safeWidgetOrigin('http://localhost:5176'),
  'http://localhost:5176'
);
for (const bad of [
  'http://w.example.com',
  'https://w.example.com/x',
  'javascript:alert(1)',
  'https://u:p@w.example.com',
  '',
  null,
]) {
  assert.equal(safeWidgetOrigin(bad), null, String(bad));
}
assert.equal(
  parsePreviewToken({ url: 'javascript:alert(1)', token: '<x>' }).url,
  null
);
assert.equal(
  parsePreviewToken({ url: 'http://shop.ua/', token: 'a' }).token,
  ''
);
// Неизвестный итог проверки — не «ok».
assert.equal(
  parseInstallCheck({ hosts: [{ hostId: 'h1', result: 'great' }] }).hosts[0]
    .result,
  'not_found'
);
assert.deepEqual(
  parseInstallCheck({
    hosts: [{ hostId: 'h1', missingCsp: ['script-src; x', 'img-src'] }],
  }).hosts[0].missingCsp,
  ['img-src']
);
// Ворота персоны: неясный ответ — «заблокировано».
assert.equal(
  parsePersonaSettings({ lastGate: { ran: true } }).lastGate!.blocked,
  true
);
assert.equal(
  parsePersona({
    tone: 'rude',
    languages: { allowed: ['EN', 'uk'], default: 'xx' },
  }).tone,
  'friendly'
);
assert.deepEqual(
  parsePersona({ languages: { allowed: ['EN', 'uk'] } }).languages,
  { mode: 'auto', allowed: ['uk'], default: 'uk' }
);
assert.deepEqual(
  parseLeadsConfig({
    fields: [
      { field: 'passport' },
      { field: 'phone', required: true },
      { field: 'phone' },
    ],
    channels: ['webhook'],
  }),
  {
    schema: 1,
    fields: [{ field: 'phone', required: true }],
    consentText: {},
    channels: ['telegram'],
  }
);

// ═══ 4. Совместимость: то, что шлёт TMA, сервер принимает без отказа ══
const sent = parseWidgetConfig({
  ...DRAFT,
  brand: { ...DRAFT.brand, primaryColor: '#7C3AED' },
});
const back = S.parseWidgetConfig(sent);
assert.ok(back.ok, 'сервер принимает конфигурацию TMA');
assert.ok(SP.parsePersona(parsePersona(SP.defaultPersona('en'))).ok);
assert.ok(SL.parseLeadsConfig(parseLeadsConfig(SL.defaultLeadsConfig())).ok);

// ═══ 5. Мастер и полнота (W5) — поля и перечни ══════════════════════════
const wz = parseWizard({
  siteId: 's1',
  businessType: 'services',
  status: 'in_progress',
  draftRunsLeft: 3,
  siteSummary: {
    businessType: 'shop',
    sections: ['A'],
    contacts: { phones: ['+380'], emails: [], address: null },
    hours: null,
    about: 'x',
    lang: 'uk',
  },
  items: [
    {
      topic: 'delivery',
      question: 'Q',
      target: 'golden',
      draft: 'D',
      draftSources: [
        { url: 'javascript:alert(1)', title: 't' },
        { url: 'https://shop.ua/d', title: null },
      ],
      answer: null,
      status: 'pending',
      faqId: null,
    },
    { topic: 'nope', question: 'x' },
  ],
});
assert.deepEqual(keys(wz), W5.get('WizardView'));
assert.deepEqual(keys(wz.items[0]), W5.get('WizardItemView'));
assert.deepEqual(keys(wz.siteSummary!), W5.get('SiteSummary'));
assert.equal(wz.items.length, 1);
assert.deepEqual(wz.items[0].draftSources, [
  { url: null, title: 't' },
  { url: 'https://shop.ua/d', title: null },
]);
assert.equal(parseWizard({ status: 'weird' }).status, 'in_progress');
const cp = parseCompleteness({
  siteId: 's1',
  topics: { covered: 3, total: 10, missing: ['delivery', 'evil'] },
  pages: { read: 5, skipped: 1, quarantined: 0, excluded: 0 },
  quality: { lastEvalAt: null, passed: null, failed: null },
  openGapsOlderThan7d: 0,
  goldenNeedsReview: 1,
  next: ['run_wizard', 'hack'],
});
assert.deepEqual(keys(cp), W5.get('CompletenessView'));
assert.deepEqual(cp.topics.missing, ['delivery']);
assert.deepEqual(cp.next, ['run_wizard']);
const wizardTypes = readFileSync(
  new URL(
    `${BACK}assist-site-knowledge/wizard/wizard-types.ts`,
    import.meta.url
  ),
  'utf8'
);
for (const list of [
  WIZARD_TOPICS,
  WIZARD_TARGETS,
  WIZARD_ITEM_STATUSES,
  WIZARD_BUSINESS_TYPES,
]) {
  for (const x of list)
    assert.ok(wizardTypes.includes(`'${x}'`), `wizard-types.ts: нет '${x}'`);
}
const topicsUnion = /export type WizardTopic =([\s\S]*?);/.exec(
  wizardTypes
)![1];
assert.deepEqual(
  [...topicsUnion.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort(),
  [...WIZARD_TOPICS].sort()
);

// ═══ 6. Пути и тела запросов ═══════════════════════════════════════════
const calls: Array<[string, string, unknown]> = [];
const fake = {
  async request<R>(method: string, path: string, body?: unknown): Promise<R> {
    calls.push([method, path, body]);
    return {} as R;
  },
};
const api = createWidgetApi(fake);
const wapi = createWizardApi(fake);
await api.get('s1');
await api.saveDraft('s1', DRAFT as T.WidgetConfig);
await api.previewToken('s1', { purpose: 'tma' });
await api.rollback('s1', 3);
await api.acquisition('lp_x');
await wapi.answer('s1', 'delivery', { status: 'skipped' });
await wapi.completeness('s1');
assert.deepEqual(
  calls.map(([m, p]) => `${m} ${p}`),
  [
    'GET /assist/sites/s1/widget',
    'PATCH /assist/sites/s1/widget/draft',
    'POST /assist/sites/s1/widget/preview-token',
    'POST /assist/sites/s1/widget/rollback/3',
    'POST /assist/acquisition',
    'PATCH /assist/sites/s1/learning/site/onboarding/items/delivery',
    'GET /assist/sites/s1/learning/site/completeness',
  ]
);
assert.deepEqual(calls[1][2], { config: DRAFT });
assert.deepEqual(calls[4][2], { payload: 'lp_x' });
// Идентификатор с «/» в путь не попадает.
await assert.rejects(api.get('../admin'));

console.log('widget-api: ok');
