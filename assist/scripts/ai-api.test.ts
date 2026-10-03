/**
 * Э3-бис «Аналитика с ИИ» в TMA: перечни сверены с сервером (по тексту
 * модулей), строгий разбор ответов, пути и тела запросов (подменённый
 * клиент), «сухие» строки находок на трёх языках, честный показ
 * эксперимента (итог — только у завершённого).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiClient } from '../src/kit';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import {
  createAiApi,
  parseAiSettings,
  parseDialogs,
  parseExperiment,
  parseInsights,
  parseSummary,
} from '../src/lib/ai-api';
import * as T from '../src/lib/ai-types';
import {
  CONSENT_SNIPPET,
  dryLine,
  experimentLines,
  followUpValue,
  metricValue,
  powerLine,
} from '../src/lib/ai-view';
import { STATS_TABS } from '../src/lib/e3-view';
import { E3_ERROR_CODES } from '../src/lib/e3-errors';

const BACK = '../../sites-backend/src/modules/assist-analytics/';
const src = (rel: string) =>
  readFileSync(new URL(`${BACK}${rel}`, import.meta.url), 'utf8');
function constList(file: string, name: string): string[] {
  const m = file.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`)
  );
  assert.ok(m, `нет ${name}`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ═══ 1. Перечни — как у сервера ═════════════════════════════════════
const LS = src('ai/label-schema.ts');
const LEAD = src('ai/lead-score.ts');
const FIND = src('ai/findings.ts');
const EXP = src('exp/experiment-math.ts');
assert.deepEqual([...T.AI_INTENTS], constList(LS, 'INTENTS'));
assert.deepEqual([...T.AI_STAGES], constList(LS, 'STAGES'));
assert.deepEqual([...T.AI_OUTCOMES], constList(LS, 'OUTCOMES'));
assert.deepEqual([...T.AI_FAILURES], constList(LS, 'FAILURE_REASONS'));
assert.deepEqual([...T.LEAD_FEATURES], constList(LEAD, 'LEAD_FEATURES'));
assert.deepEqual([...T.VERTICALS], constList(LEAD, 'VERTICALS'));
assert.deepEqual([...T.FINDING_CODES], constList(FIND, 'FINDING_CODES'));
assert.deepEqual([...T.EXPERIMENT_KINDS], constList(EXP, 'EXPERIMENT_KINDS'));
for (const c of [
  'ANALYTICS_OWNER_ONLY',
  'EXPERIMENT_UNDERPOWERED',
  'EXPERIMENT_NEEDS_CONSENT',
]) {
  assert.ok((E3_ERROR_CODES as readonly string[]).includes(c), c);
}
for (const k of ['ai', 'insights', 'experiments', 'behavior'] as const) {
  assert.ok((STATS_TABS as readonly string[]).includes(k), k);
}

// ═══ 2. Словари: каждый перечень подписан на трёх языках ═════════════
for (const d of [appRu, appUk, appEn]) {
  const t = d.e3b;
  for (const k of T.AI_INTENTS) assert.ok(t.ai.intentNames[k], k);
  for (const k of T.AI_STAGES) assert.ok(t.ai.stageNames[k], k);
  for (const k of T.AI_FAILURES) assert.ok(t.ai.failureNames[k], k);
  for (const k of T.LEAD_FEATURES) assert.ok(t.ai.features[k], k);
  for (const k of T.FINDING_CODES) assert.ok(t.insights.dry[k], k);
  for (const k of T.EXPERIMENT_KINDS) assert.ok(t.experiments.kinds[k], k);
  for (const k of T.VERTICALS) assert.ok(t.settings.verticals[k], k);
  // Запрещённые обещания (§5-тер.2): нет «окупаемости» и «благодаря».
  const all = JSON.stringify(t).toLowerCase();
  for (const w of ['окупаем', 'благодаря', 'завдяки', 'roi']) {
    assert.ok(!all.includes(w), `слово «${w}» в e3b`);
  }
}

// ═══ 3. Строгий разбор ══════════════════════════════════════════════
{
  const s = parseSummary({
    plan: { planId: 'business', aiAnalytics: true, linkedWindowDays: 7 },
    model: { ok: false, reason: 'no_model' },
    coverage: { closed: 10, labeled: 4, pending: 'x' },
    buckets: { hot: 2, warm: 1, cold: 1, hotNoLead: 1 },
    intents: [{ key: 'price', n: 3 }, { key: '', n: 1 }, 'junk'],
    calibration: null,
  });
  assert.equal(s.plan.aiAnalytics, true);
  assert.equal(s.plan.experiments, false);
  assert.equal(s.coverage.pending, 0);
  assert.deepEqual(s.intents, [{ key: 'price', n: 3 }]);
  assert.equal(s.calibration, null);

  const p = parseDialogs({
    items: [
      {
        conversationId: 'c1',
        createdAt: '2026-10-01T10:00:00.000Z',
        intent: 'price',
        stage: 'nonsense',
        leadBucket: 'boiling',
        leadScore: 71,
        features: [
          { f: 'stage', c: 1.2 },
          { f: '<img>', c: 9 },
        ],
      },
      { createdAt: 'x' },
    ],
    nextCursor: '2026-10-01T10:00:00.000Z',
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].stage, null);
  assert.equal(p.items[0].leadBucket, null);
  assert.deepEqual(p.items[0].features, [{ f: 'stage', c: 1.2 }]);

  const ins = parseInsights({
    weeks: ['2026-09-28'],
    weekStart: '2026-09-28',
    items: [
      {
        id: 'i1',
        code: 'N3',
        impact: 'high',
        status: 'new',
        finding: { n: 40, x: 12, share: 0.3, reason: 'price_too_high' },
        text: { title: 'T', what: 'W', action: 'A' },
      },
      { id: 'i2', code: 'RUN', impact: 'high', finding: {} },
      { id: 'i3', code: 'N9', impact: 'low', finding: {} },
    ],
  });
  assert.deepEqual(
    ins.items.map((i) => i.id),
    ['i1']
  );

  assert.equal(parseExperiment({ id: 'e1', kind: 'persona' }), null);
  const st = parseAiSettings({
    config: { linked: 'yes', linkedWindowDays: 99, vertical: 'casino' },
  });
  assert.equal(st.linked, false);
  assert.equal(st.vertical, 'other');
  assert.equal(st.linkedWindowDays, 7);
}

// ═══ 4. Пути и тела ═════════════════════════════════════════════════
{
  const calls: Array<{ m: string; p: string; b?: unknown }> = [];
  const client = {
    request: async (m: string, p: string, b?: unknown) => {
      calls.push({ m, p, b });
      if (p.endsWith('/experiments')) return m === 'GET' ? [] : { id: 'e1' };
      return {};
    },
  } as unknown as ApiClient;
  const api = createAiApi(client);
  let rejected = false;
  try {
    await api.summary('s/1', 'a', 'b');
  } catch {
    rejected = true;
  }
  assert.ok(rejected, 'кривой id сайта не уходит в запрос');
  await api.summary('s1', '2026-09-01', '2026-09-30');
  await api.dialogs('s1', { from: 'a', to: 'b', bucket: 'hot' });
  await api.fixLabel('s1', 'c1', { intent: 'price' });
  await api.insights('s1');
  await api.insights('s1', '2026-09-28');
  await api.markInsight('s1', 'i1', { status: 'done' });
  await api.behavior('s1', 'a', 'b');
  await api.experiments('s1');
  await api.preview('s1', { kind: 'holdout', goalKey: 'order' });
  await api.startExperiment('s1', { kind: 'holdout', goalKey: 'order' });
  await api.stopExperiment('s1', 'e1');
  await api.saveSettings('s1', { linked: true });
  assert.deepEqual(
    calls.map((c) => `${c.m} ${c.p}`),
    [
      'GET /assist/sites/s1/ai/summary?from=2026-09-01&to=2026-09-30',
      'GET /assist/sites/s1/ai/dialogs?from=a&to=b&bucket=hot',
      'PATCH /assist/sites/s1/conversations/c1/label',
      'GET /assist/sites/s1/stats/insights',
      'GET /assist/sites/s1/stats/insights?week=2026-09-28',
      'PATCH /assist/sites/s1/insights/i1',
      'GET /assist/sites/s1/stats/behavior?from=a&to=b',
      'GET /assist/sites/s1/experiments',
      'POST /assist/sites/s1/experiments/preview',
      'POST /assist/sites/s1/experiments',
      'POST /assist/sites/s1/experiments/e1/stop',
      'PATCH /assist/sites/s1/analytics-settings',
    ]
  );
  // Частичная правка настроек: только переданный ключ (сервер сливает).
  assert.deepEqual(calls[calls.length - 1].b, { config: { linked: true } });
}

// ═══ 5. «Сухие» строки и числа ══════════════════════════════════════
{
  const finding = (f: Partial<T.FindingView>): T.FindingView => ({
    n: 40,
    x: 12,
    share: 0.3,
    ciLow: 0.2,
    ciHigh: 0.4,
    base: null,
    page: null,
    topic: null,
    reason: null,
    field: null,
    metric: null,
    value: null,
    trigger: null,
    ...f,
  });
  const samples: Array<[T.FindingCode, Partial<T.FindingView>]> = [
    ['N2', { topic: 'доставка в Польшу' }],
    ['N3', { reason: 'price_too_high', page: '/p/1' }],
    ['N4', { topic: 'гарантия' }],
    ['N5', { page: '/checkout', field: 'phone' }],
    ['N6', { page: '/cart' }],
    ['N7', { page: '/', value: 17 }],
    ['N8', { page: '/', metric: 'lcp', value: 4210.4 }],
    ['N10', { trigger: 'exit' }],
  ];
  for (const d of [appRu, appUk, appEn]) {
    for (const [code, f] of samples) {
      const line = dryLine(d.e3b, { code, finding: finding(f) });
      assert.ok(!/[{}]/.test(line), `${code}: ${line}`);
    }
  }
  assert.equal(
    dryLine(appRu.e3b, {
      code: 'N3',
      finding: finding({ reason: 'price_too_high', page: '/p/1' }),
    }),
    'Причина «Дорого» на /p/1: 12 из 40 диалогов без конверсии (30 %)'
  );
  assert.equal(metricValue('lcp', 4210.4), '4210 ms');
  assert.equal(metricValue('cls', 0.1234), '0.12');
  assert.equal(
    followUpValue({ code: 'N3', finding: finding({}) }, { share: 0.25 }),
    '25 %'
  );
  assert.ok(
    CONSENT_SNIPPET.startsWith("V4CAssist('consent', { analytics: true })")
  );
}

// ═══ 6. Эксперимент: итог только у завершённого ═════════════════════
{
  const result: T.ExperimentResultView = {
    nA: 500,
    nB: 500,
    xA: 50,
    xB: 30,
    rateA: 0.1,
    rateB: 0.06,
    diff: -0.04,
    ciLow: -0.07,
    ciHigh: -0.01,
    p: 0.02,
    liftRel: -0.4,
    verdict: 'significant',
  };
  const base: T.ExperimentView = {
    id: 'e1',
    kind: 'holdout',
    goalKey: 'order',
    share: 0.1,
    status: 'running',
    horizonDays: 28,
    startedAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-09-29T00:00:00.000Z',
    stopReason: null,
    mdeRel: 0.2,
    minUnitsPerArm: 400,
    units: { a: 300, b: 40 },
    srmP: null,
    result,
  };
  const t = appRu.e3b;
  const running = experimentLines(t, base, '29.09').join(' ');
  assert.ok(!running.includes('Итог:'), 'идущий — без итога');
  assert.ok(running.includes('A 300, B 40'));
  const stopped = experimentLines(
    t,
    {
      ...base,
      status: 'stopped',
      stopReason: 'owner',
    },
    ''
  ).join(' ');
  assert.ok(!stopped.includes('Итог:') && stopped.includes('без итога'));
  const invalid = experimentLines(t, { ...base, status: 'invalid' }, '').join(
    ' '
  );
  assert.ok(!invalid.includes('Итог:'));
  const done = experimentLines(t, { ...base, status: 'done' }, '');
  assert.ok(done[1].startsWith('Итог: A 10 %'));
  assert.ok(done[1].includes('−4.0 %'), done[1]);
  assert.equal(done[2], t.experiments.verdicts.significant);

  const power: T.PowerView = {
    units28: 3000,
    conversions28: 150,
    baseRate: 0.05,
    unitsPerDay: 107.14,
    expectedUnits: 3000,
    mdeRel: 0.25,
    minUnitsPerArm: 1200,
    ok: true,
    reason: null,
  };
  assert.ok(powerLine(t, power, 28).includes('25 %'));
  assert.equal(
    powerLine(
      t,
      { ...power, ok: false, reason: 'underpowered', mdeRel: null },
      28
    ),
    t.experiments.reasons.underpowered
  );
}

console.log('ai-api: ok');
