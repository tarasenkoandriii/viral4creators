/**
 * Монитор голосового управления в бою Т-4 — ЧИСТЫЕ правила (Э6-бис (г), ТЗ
 * помощника §5-бис.10 «Метрики», §5-бис.14 «Пороги»). Числа считает код из
 * журнала шагов и планов (`computeMetrics`), решение — `decideSite`;
 * система (`system/voice-monitor.service.ts`) только читает строки и
 * исполняет решение. Цифры порогов — ТЗ (Р-39, В-34: уточняются на пилотах).
 *
 * Планы тестовой сессии мастера и сухие прогоны в метрики не идут (их
 * отфильтровывает чтение: `voiceTestId IS NULL`).
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const MONITOR_THRESHOLDS = {
  /** Окно метрик — скользящие 24 ч (§5-бис.14). */
  windowMs: DAY,
  /** Тревога владельцу: ≥ 20 планов и (done < 60% или «нажмите сами» > 30%). */
  alert: { minPlans: 20, doneBelow: 0.6, selfAbove: 0.3 },
  /** Авто-деградация: ≥ 50 планов и (done < 40% или «цель не найдена» > 40%). */
  degrade: { minPlans: 50, doneBelow: 0.4, notFoundAbove: 0.4 },
  /** Стоп-лист при исполнении (страница изменилась): > 3 — тревога, > 10 — деградация. */
  stoplistLive: { alertAbove: 3, degradeAbove: 10 },
  /** «Не туда»: стоп/свой клик в течение 5 с после шага. */
  wrongWindowMs: 5_000,
  /** Нарушение запрета на ≥ 2 сайтах за сутки — дефект нашего кода: рубильник платформы. */
  platformViolationSites: 2,
  /**
   * …и этих сайтов — в ≥ 2 РАЗНЫХ кабинетах (аудит (г) 03.10): один кабинет
   * не может выключить режим всей платформе своими сайтами.
   */
  platformViolationAccounts: 2,
  /**
   * Планов ОДНОГО посетителя в метриках окна (аудит (г) 03.10): посетитель
   * не накрутит деградацию чужого сайта потоком своих провальных планов —
   * пороги требуют выборки от многих посетителей. Сверх — не считаются.
   */
  perVisitorPlans: 3,
  /** Тревога одного вида по сайту — не чаще раза в сутки. */
  alertDedupMs: DAY,
  /** Журнал монитора — 90 дней. */
  incidentRetentionMs: 90 * DAY,
  /** Переходный период для `on` без отчёта (решение владельца п.1). */
  transitionMs: 14 * DAY,
  /** Канарейка загрузчика (§5-бис.12): падение `done` > 10 п.п. при ≥ 50 планах. */
  canary: { minPlans: 50, dropPp: 0.1, defaultPercent: 10, days: 3 },
  /** Сайтов за проход монитора. */
  sitesPerRun: 200,
  /** Строк журнала шагов на сайт за окно (Pro — ≤ 1000 планов в сутки). */
  logRowsPerSite: 20_000,
} as const;

/** Причины журнала шагов, означающие «стоп-лист сработал при исполнении». */
export const STOPLIST_LIVE_REASONS: ReadonlySet<string> = new Set([
  'danger',
  'payment',
  'denied',
  'sensitive_field',
]);

export interface MonitorPlanRow {
  id: string;
  /** Посетитель плана (потолок вклада одного посетителя); нет — без потолка. */
  visitorId?: string | null;
  status: string;
  confirmedBy: string | null;
  createdAt: Date;
  release: string | null;
  steps: unknown;
}

export interface MonitorLogRow {
  planId: string;
  stepIndex: number;
  action: string;
  result: string;
  reason: string | null;
  createdAt: Date;
}

export interface SiteVoiceMetrics {
  /** Исполнимых планов (есть шаг `auto|confirm`). */
  plans: number;
  done: number;
  /** «Нажмите сами»: шаг закончился `manual`/`failed`. */
  self: number;
  /** «Цель не найдена» (`no_target`). */
  notFound: number;
  /** Стоп-лист сработал на живой цели (страница изменилась между снимком и кликом). */
  stoplistLive: number;
  /** Отменено на карточке подтверждения. */
  cancelled: number;
  /** «Не туда»: стоп/свой клик ≤ 5 с после шага. */
  wrong: number;
  /** Нарушения запрета (последний рубеж сработал). */
  violations: number;
  /** «Конец фразы → первая подсветка» (план → первый отчёт шага), мс. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

interface StepLike {
  risk?: unknown;
  state?: unknown;
}

function stepsOf(raw: unknown): StepLike[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is StepLike => !!x && typeof x === 'object')
    : [];
}

const EXEC = (s: StepLike) => s.risk === 'auto' || s.risk === 'confirm';

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

/** Метрики окна по планам и журналу шагов (§5-бис.10). */
export function computeMetrics(
  plans: MonitorPlanRow[],
  logs: MonitorLogRow[],
): SiteVoiceMetrics {
  const byPlan = new Map<string, MonitorLogRow[]>();
  for (const l of logs) {
    const a = byPlan.get(l.planId) ?? [];
    a.push(l);
    byPlan.set(l.planId, a);
  }
  const m: SiteVoiceMetrics = {
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
  };
  const lat: number[] = [];
  const perVisitor = new Map<string, number>();
  for (const p of plans) {
    const rows = (byPlan.get(p.id) ?? []).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    // Нарушение запрета — сигнал нашего кода, не голос посетителя: считается
    // всегда (потолок посетителя его не прячет).
    m.violations += rows.filter((r) => r.action === 'violation').length;
    if (p.visitorId) {
      const n = perVisitor.get(p.visitorId) ?? 0;
      if (n >= MONITOR_THRESHOLDS.perVisitorPlans) continue;
      perVisitor.set(p.visitorId, n + 1);
    }
    const steps = stepsOf(p.steps);
    m.stoplistLive += rows.filter(
      (r) =>
        r.action !== 'violation' &&
        r.result === 'failed' &&
        r.reason !== null &&
        STOPLIST_LIVE_REASONS.has(r.reason),
    ).length;
    const exec = steps.filter(EXEC);
    if (!exec.length) continue;
    m.plans++;
    // Доведён до конца: все исполнимые шаги `done` и ни один шаг не кончился
    // «нажмите сами»/провалом (хвост `manual` — это не «помощник сделал»).
    if (
      p.status === 'done' &&
      exec.every((s) => s.state === 'done') &&
      !steps.some((s) => s.state === 'manual' || s.state === 'failed')
    )
      m.done++;
    const selfRow = rows.some(
      (r) =>
        (r.result === 'manual' || r.result === 'failed') &&
        !['plan', 'refused', 'violation'].includes(r.action),
    );
    if (
      selfRow ||
      steps.some((s) => s.state === 'manual' || s.state === 'failed')
    )
      m.self++;
    if (
      rows.some(
        (r) =>
          (r.result === 'manual' || r.result === 'failed') &&
          r.reason === 'no_target',
      )
    )
      m.notFound++;
    if (p.status === 'stopped' && p.confirmedBy === null) m.cancelled++;
    // «Не туда»: стоп человеком в течение 5 с после исполненного шага.
    const doneAt = rows
      .filter((r) => r.result === 'done' && r.action !== 'confirm')
      .map((r) => r.createdAt.getTime());
    const stop = rows.find(
      (r) =>
        r.action === 'stop' &&
        r.reason !== null &&
        ['click', 'esc', 'voice', 'button'].includes(r.reason),
    );
    if (
      stop &&
      doneAt.some(
        (t) =>
          stop.createdAt.getTime() >= t &&
          stop.createdAt.getTime() - t <= MONITOR_THRESHOLDS.wrongWindowMs,
      )
    )
      m.wrong++;
    // Задержка — только у планов без карточки (ожидание «Да» — не задержка).
    if (p.confirmedBy === 'auto') {
      const first = rows.find(
        (r) => !['plan', 'refused', 'confirm', 'violation'].includes(r.action),
      );
      if (first)
        lat.push(
          Math.max(0, first.createdAt.getTime() - p.createdAt.getTime()),
        );
    }
  }
  lat.sort((a, b) => a - b);
  m.latencyP50Ms = quantile(lat, 0.5);
  m.latencyP95Ms = quantile(lat, 0.95);
  return m;
}

export type MonitorCode =
  'done_low' | 'self_high' | 'not_found_high' | 'stoplist_live' | 'violation';

export interface SiteDecision {
  action: 'none' | 'alert' | 'degrade' | 'off';
  codes: MonitorCode[];
}

const rate = (n: number, d: number) => (d > 0 ? n / d : 0);

/**
 * Решение по сайту (§5-бис.14, режим «Сайт»). Деградация и тревога — только
 * для `on` (в `degraded` помощник уже лишь подсвечивает; выход — новый
 * `pass` мастера). Нарушение запрета — `off` в любом состоянии.
 */
export function decideSite(m: SiteVoiceMetrics, state: string): SiteDecision {
  const T = MONITOR_THRESHOLDS;
  if (m.violations > 0) return { action: 'off', codes: ['violation'] };
  if (state !== 'on') return { action: 'none', codes: [] };
  const degrade: MonitorCode[] = [];
  if (m.plans >= T.degrade.minPlans) {
    if (rate(m.done, m.plans) < T.degrade.doneBelow) degrade.push('done_low');
    if (rate(m.notFound, m.plans) > T.degrade.notFoundAbove)
      degrade.push('not_found_high');
  }
  if (m.stoplistLive > T.stoplistLive.degradeAbove)
    degrade.push('stoplist_live');
  if (degrade.length) return { action: 'degrade', codes: degrade };
  const alert: MonitorCode[] = [];
  if (m.plans >= T.alert.minPlans) {
    if (rate(m.done, m.plans) < T.alert.doneBelow) alert.push('done_low');
    if (rate(m.self, m.plans) > T.alert.selfAbove) alert.push('self_high');
  }
  if (m.stoplistLive > T.stoplistLive.alertAbove) alert.push('stoplist_live');
  return alert.length
    ? { action: 'alert', codes: alert }
    : { action: 'none', codes: [] };
}

/**
 * Рубильник платформы (§5-бис.14): нарушения запрета на ≥ 2 сайтах за
 * сутки И в ≥ 2 разных кабинетах (аудит (г) 03.10 — иначе один кабинет
 * выключал бы режим всей платформе).
 */
export function platformTrip(
  sites: ReadonlyArray<{ accountId: string }>,
): boolean {
  const T = MONITOR_THRESHOLDS;
  return (
    sites.length >= T.platformViolationSites &&
    new Set(sites.map((s) => s.accountId)).size >= T.platformViolationAccounts
  );
}

/**
 * Канарейка загрузчика (§5-бис.12, §5-бис.14 «Платформа»): доля `done`
 * канареечного выпуска против стабильного за то же окно; падение > 10 п.п.
 * при ≥ 50 планах в каждой группе — откат. Нарушение запрета на канарейке —
 * откат сразу.
 */
export function decideCanary(p: {
  canary: { plans: number; done: number; violations: number };
  stable: { plans: number; done: number };
}): { rollback: boolean; code: 'done_drop' | 'violation' | null } {
  const T = MONITOR_THRESHOLDS.canary;
  if (p.canary.violations > 0) return { rollback: true, code: 'violation' };
  if (p.canary.plans < T.minPlans || p.stable.plans < T.minPlans)
    return { rollback: false, code: null };
  const drop =
    rate(p.stable.done, p.stable.plans) - rate(p.canary.done, p.canary.plans);
  return drop > T.dropPp
    ? { rollback: true, code: 'done_drop' }
    : { rollback: false, code: null };
}
