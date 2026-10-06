/**
 * Монитор Т-4 — чистые правила (Э6-бис (г), ТЗ §5-бис.10, §5-бис.14):
 * метрики из планов и журнала, пороги тревоги/деградации/выключения,
 * канарейка выпусков.
 */
import {
  computeMetrics,
  decideCanary,
  decideMemoReview,
  decideSite,
  MONITOR_THRESHOLDS,
  platformTrip,
  type MonitorLogRow,
  type MonitorPlanRow,
  type SiteVoiceMetrics,
} from './monitor-rules';

const t0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

function plan(
  id: string,
  o: Partial<MonitorPlanRow> & { states?: string[]; risks?: string[] } = {},
): MonitorPlanRow {
  const states = o.states ?? ['done'];
  const risks = o.risks ?? states.map(() => 'auto');
  return {
    id,
    status: o.status ?? 'done',
    confirmedBy: o.confirmedBy === undefined ? 'auto' : o.confirmedBy,
    createdAt: o.createdAt ?? t0,
    release: o.release ?? null,
    visitorId: o.visitorId,
    steps: states.map((s, i) => ({ risk: risks[i], state: s })),
  };
}

const log = (
  planId: string,
  o: Partial<MonitorLogRow> & { ms?: number },
): MonitorLogRow => ({
  planId,
  stepIndex: o.stepIndex ?? 0,
  action: o.action ?? 'click',
  result: o.result ?? 'done',
  reason: o.reason ?? null,
  createdAt: at(o.ms ?? 1000),
});

const metrics = (o: Partial<SiteVoiceMetrics>): SiteVoiceMetrics => ({
  plans: 0,
  done: 0,
  self: 0,
  notFound: 0,
  stoplistLive: 0,
  cancelled: 0,
  wrong: 0,
  violations: 0,
  latencyP50Ms: null,
  latencyP95Ms: null,
  ...o,
});

describe('метрики Т-4 (§5-бис.10)', () => {
  it('done — только план, где все исполнимые шаги done; «нажмите сами», не найдено', () => {
    const plans = [
      plan('a'),
      plan('b', {
        status: 'done',
        states: ['done', 'manual'],
        risks: ['auto', 'manual'],
      }),
      plan('c', { status: 'failed', states: ['failed'] }),
      // Только отказы («оплати») — не исполнимый план, в знаменатель не идёт.
      plan('d', { status: 'failed', states: ['pending'], risks: ['never'] }),
    ];
    const logs = [
      log('a', { ms: 800 }),
      log('b', { ms: 500 }),
      log('b', { stepIndex: 1, result: 'manual', reason: 'gesture', ms: 900 }),
      log('c', { result: 'failed', reason: 'no_target', ms: 700 }),
    ];
    const m = computeMetrics(plans, logs);
    expect(m.plans).toBe(3);
    expect(m.done).toBe(1);
    expect(m.self).toBe(2);
    expect(m.notFound).toBe(1);
  });

  it('стоп-лист при исполнении, нарушения, отмены на карточке, «не туда»', () => {
    const plans = [
      plan('a', { status: 'failed', states: ['failed'] }),
      plan('b', {
        status: 'stopped',
        confirmedBy: null,
        states: ['pending'],
        risks: ['confirm'],
      }),
      plan('c', { status: 'stopped', states: ['done', 'pending'] }),
      plan('v', { status: 'stopped', states: ['dispatched'] }),
    ];
    const logs = [
      log('a', { result: 'failed', reason: 'danger' }),
      log('c', { result: 'done', ms: 1000 }),
      log('c', {
        action: 'stop',
        result: 'stopped',
        reason: 'click',
        ms: 3000,
      }),
      log('v', { action: 'violation', result: 'failed', reason: 'payment' }),
    ];
    const m = computeMetrics(plans, logs);
    expect(m.stoplistLive).toBe(1);
    expect(m.cancelled).toBe(1);
    expect(m.wrong).toBe(1);
    expect(m.violations).toBe(1);
  });

  it('стоп человеком позже 5 с после шага — не «не туда»', () => {
    const m = computeMetrics(
      [plan('c', { status: 'stopped', states: ['done', 'pending'] })],
      [
        log('c', { result: 'done', ms: 1000 }),
        log('c', {
          action: 'stop',
          result: 'stopped',
          reason: 'click',
          ms: 7000,
        }),
      ],
    );
    expect(m.wrong).toBe(0);
  });

  it('задержка — от плана до первого шага, только без карточки', () => {
    const m = computeMetrics(
      [plan('a'), plan('b'), plan('c', { confirmedBy: 'button' })],
      [
        log('a', { action: 'plan', result: 'proposed', ms: 0 }),
        log('a', { ms: 1200 }),
        log('b', { ms: 3000 }),
        log('c', { ms: 60_000 }),
      ],
    );
    expect(m.latencyP50Ms).toBe(3000);
    expect(m.latencyP95Ms).toBe(3000);
  });
});

describe('пороги Т-4 (§5-бис.14)', () => {
  const T = MONITOR_THRESHOLDS;

  it('≥ 50 планов и done < 40% — деградация', () => {
    expect(decideSite(metrics({ plans: 50, done: 19 }), 'on')).toEqual({
      action: 'degrade',
      codes: ['done_low'],
    });
    // Ровно на пороге — нет.
    expect(decideSite(metrics({ plans: 50, done: 20 }), 'on').action).toBe(
      'alert',
    );
    expect(decideSite(metrics({ plans: 49, done: 0 }), 'on').action).toBe(
      'alert',
    );
  });

  it('≥ 50 планов и «не найдено» > 40% — деградация', () => {
    const d = decideSite(metrics({ plans: 50, done: 40, notFound: 21 }), 'on');
    expect(d).toEqual({ action: 'degrade', codes: ['not_found_high'] });
  });

  it('≥ 20 планов и (done < 60% или «нажмите сами» > 30%) — тревога', () => {
    expect(decideSite(metrics({ plans: 20, done: 11 }), 'on').codes).toEqual([
      'done_low',
    ]);
    expect(
      decideSite(metrics({ plans: 20, done: 20, self: 7 }), 'on').codes,
    ).toEqual(['self_high']);
    expect(decideSite(metrics({ plans: 19, done: 0 }), 'on').action).toBe(
      'none',
    );
  });

  it('стоп-лист при исполнении: > 3 — тревога, > 10 — деградация', () => {
    expect(
      decideSite(metrics({ stoplistLive: T.stoplistLive.alertAbove }), 'on')
        .action,
    ).toBe('none');
    expect(decideSite(metrics({ stoplistLive: 4 }), 'on').action).toBe('alert');
    expect(decideSite(metrics({ stoplistLive: 11 }), 'on').action).toBe(
      'degrade',
    );
  });

  it('нарушение запрета — off в любом состоянии', () => {
    for (const s of ['on', 'degraded', 'test', 'off'])
      expect(decideSite(metrics({ violations: 1 }), s).action).toBe('off');
  });

  it('деградация и тревога — только из `on`', () => {
    expect(
      decideSite(metrics({ plans: 100, done: 0 }), 'degraded').action,
    ).toBe('none');
    expect(decideSite(metrics({ plans: 100, done: 0 }), 'test').action).toBe(
      'none',
    );
  });
});

describe('канарейка выпусков (§5-бис.12)', () => {
  it('падение done > 10 п.п. при ≥ 50 планах в обеих группах — откат', () => {
    expect(
      decideCanary({
        canary: { plans: 50, done: 30, violations: 0 },
        stable: { plans: 200, done: 160 },
      }),
    ).toEqual({ rollback: true, code: 'done_drop' });
    expect(
      decideCanary({
        canary: { plans: 50, done: 36, violations: 0 },
        stable: { plans: 200, done: 160 },
      }).rollback,
    ).toBe(false);
  });

  it('мало планов — не решаем; нарушение на канарейке — откат сразу', () => {
    expect(
      decideCanary({
        canary: { plans: 49, done: 0, violations: 0 },
        stable: { plans: 200, done: 200 },
      }).rollback,
    ).toBe(false);
    expect(
      decideCanary({
        canary: { plans: 1, done: 1, violations: 1 },
        stable: { plans: 0, done: 0 },
      }),
    ).toEqual({ rollback: true, code: 'violation' });
  });
});

describe('аудит (г) 03.10: накрутка метрик и рубильник платформы', () => {
  it('один посетитель — не больше perVisitorPlans планов в метриках: стоп-лист «при исполнении» не накручивается', () => {
    const plans: MonitorPlanRow[] = [];
    const logs: MonitorLogRow[] = [];
    for (let i = 0; i < 12; i++) {
      plans.push(
        plan(`p${i}`, {
          status: 'failed',
          states: ['failed'],
          visitorId: 'v1',
        }),
      );
      logs.push(log(`p${i}`, { result: 'failed', reason: 'payment' }));
    }
    const m = computeMetrics(plans, logs);
    expect(m.plans).toBe(MONITOR_THRESHOLDS.perVisitorPlans);
    expect(m.stoplistLive).toBe(MONITOR_THRESHOLDS.perVisitorPlans);
    expect(decideSite(m, 'on').action).not.toBe('degrade');
    // Те же 12 провалов от 12 посетителей — деградация (стоп-лист > 10).
    const many = plans.map((p, i) => ({ ...p, visitorId: `v${i}` }));
    expect(decideSite(computeMetrics(many, logs), 'on')).toEqual({
      action: 'degrade',
      codes: ['stoplist_live'],
    });
  });

  it('нарушение запрета считается и сверх потолка посетителя', () => {
    const plans = [0, 1, 2, 3, 4].map((i) =>
      plan(`q${i}`, { visitorId: 'v1' }),
    );
    const logs = [log('q4', { action: 'violation', result: 'failed' })];
    expect(computeMetrics(plans, logs).violations).toBe(1);
  });

  it('рубильник: ≥ 2 сайта И ≥ 2 кабинета', () => {
    expect(platformTrip([{ accountId: 'a' }, { accountId: 'a' }])).toBe(false);
    expect(platformTrip([{ accountId: 'a' }])).toBe(false);
    expect(platformTrip([{ accountId: 'a' }, { accountId: 'b' }])).toBe(true);
  });
});

describe('(е) мемо «требует проверки» (§5-бис.17 п.8; приёмка п.8–9)', () => {
  it('needs_review: один посетитель 10 раз — нет; 3 разных посетителя и IP — да; успех цели < 60% на ≥ 10 — да; устарело на одном виде — только этот вид', () => {
    const T = { minVisitors: 3, goalMinRuns: 10, goalBelow: 0.6 };
    const one = new Map([
      [1, { visitors: new Set(['v1']), ips: new Set(['i1']), pin: true }],
    ]);
    expect(
      decideMemoReview({
        view: 'any',
        staleViews: [],
        stepFailures: one,
        goalRuns: 10,
        goalReached: 9,
        thresholds: T,
      }).review,
    ).toBeNull();
    const three = new Map([
      [
        1,
        {
          visitors: new Set(['v1', 'v2', 'v3']),
          ips: new Set(['i1', 'i2', 'i3']),
          pin: true,
        },
      ],
    ]);
    expect(
      decideMemoReview({
        view: 'any',
        staleViews: [],
        stepFailures: three,
        goalRuns: 0,
        goalReached: 0,
        thresholds: T,
      }).review,
    ).toEqual({ code: 'pin_mismatch', step: 1 });
    expect(
      decideMemoReview({
        view: 'any',
        staleViews: [],
        stepFailures: new Map(),
        goalRuns: 10,
        goalReached: 5,
        thresholds: T,
      }).review,
    ).toEqual({ code: 'goal_low', step: null });
    const d = decideMemoReview({
      view: 'any',
      staleViews: ['mobile'],
      stepFailures: new Map(),
      goalRuns: 0,
      goalReached: 0,
      thresholds: T,
    });
    expect(d).toEqual({ review: null, staleViews: ['mobile'] });
    expect(
      decideMemoReview({
        view: 'mobile',
        staleViews: ['mobile'],
        stepFailures: new Map(),
        goalRuns: 0,
        goalReached: 0,
        thresholds: T,
      }).review,
    ).toEqual({ code: 'stale', step: null });
  });
});

describe('(д) метрики цепочек (§5-бис.15 п.12)', () => {
  it('следы после сбоя, «Вернуть»/«Оставить», успешность возврата; < 80% на ≥ 10 — тревога undo_low (без деградации)', () => {
    const plans: MonitorPlanRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      visitorId: `v${i}`,
      status: 'failed',
      confirmedBy: 'button',
      createdAt: at(0),
      release: null,
      steps: [{ risk: 'confirm', state: 'failed', undo: 'local', fx: true }],
      chainStatus: i < 2 ? 'kept' : 'partially_compensated',
    }));
    const logs: MonitorLogRow[] = plans.flatMap((p, i) => [
      {
        planId: p.id,
        stepIndex: 0,
        action: 'undo',
        result: 'proposed',
        reason: null,
        createdAt: at(1000),
      },
      {
        planId: p.id,
        stepIndex: 0,
        action: 'undo',
        result: i < 5 ? 'done' : 'failed',
        reason: null,
        createdAt: at(2000),
      },
    ]);
    const m = computeMetrics(plans, logs);
    expect(m.chainsBroken).toBe(12);
    expect(m.chainsWithTraces).toBe(12);
    expect(m.undoAccepted).toBe(12);
    expect(m.undoAttempts).toBe(12);
    expect(m.undoDone).toBe(5);
    expect(m.pnrUnknown).toBe(0);
    const d = decideSite(m, 'on');
    expect(d.codes).toContain('undo_low');
    expect(d.action).not.toBe('degrade');
  });

  it('(Э6-тер (и)) отметка «компенсация начата» (`dispatched`) — не попытка: успешность считается по итогам', () => {
    const plans: MonitorPlanRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      visitorId: `v${i}`,
      status: 'failed',
      confirmedBy: 'button',
      createdAt: at(0),
      release: null,
      steps: [{ risk: 'auto', state: 'done', undo: 'comp', fx: true }],
      chainStatus: 'compensated',
    }));
    const logs: MonitorLogRow[] = plans.flatMap((p) => [
      {
        planId: p.id,
        stepIndex: 0,
        action: 'undo',
        result: 'dispatched',
        reason: 'comp',
        createdAt: at(1000),
      },
      {
        planId: p.id,
        stepIndex: 0,
        action: 'undo',
        result: 'done',
        reason: null,
        createdAt: at(2000),
      },
    ]);
    const m = computeMetrics(plans, logs);
    expect(m.undoAttempts).toBe(10);
    expect(m.undoDone).toBe(10);
    expect(decideSite(m, 'on').codes).not.toContain('undo_low');
  });
});
