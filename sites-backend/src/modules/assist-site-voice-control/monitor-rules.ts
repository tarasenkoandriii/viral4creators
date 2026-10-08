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
  /**
   * Сайтов за проход монитора. Сайтов больше — keyset-курсор по `siteId`
   * (заход 9, аудит (г) (1)): следующий проход продолжает с места, где
   * кончился этот, по кругу — каждый сайт раз в ⌈N / 200⌉ проходов.
   */
  sitesPerRun: 200,
  /** Строк журнала шагов на сайт за окно (Pro — ≤ 1000 планов в сутки). */
  logRowsPerSite: 20_000,
  /**
   * (д) §5-бис.15 п.12: успешность возврата < 80% на ≥ 10 попытках за 24 ч —
   * тревога владельцу «разметка отмены устарела» (без деградации).
   */
  undo: { minAttempts: 10, successBelow: 0.8 },
  /**
   * (заход 9) «Не расслышал» > 30% по одному языку на ≥ 20 командах за
   * 24 ч — тревога владельцу (вероятна проблема распознавания/шума), без
   * деградации (§5-бис.14, таблица порогов).
   */
  notHeard: { minCommands: 20, above: 0.3 },
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
  /**
   * (заход 9, аудит (г) (3)) Хеш IP плана (строка `plan` журнала,
   * `planIpOf`): потолок вклада и по нему — множество visitor-token с
   * одного адреса не накрутит метрики. Нет — только потолок посетителя.
   */
  ipHash?: string | null;
  status: string;
  confirmedBy: string | null;
  createdAt: Date;
  release: string | null;
  steps: unknown;
  /** (д) Статус цепочки (§5-бис.15 п.11); нет — старый план. */
  chainStatus?: string | null;
}

export interface MonitorLogRow {
  planId: string;
  stepIndex: number;
  action: string;
  result: string;
  reason: string | null;
  createdAt: Date;
  /** Цель строки: у строки `plan` — хеш IP плана (`target.ip`). */
  target?: unknown;
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
  /** (д) Цепочки со сбоем/стопом после первого эффекта (знаменатель «следов»). */
  chainsBroken?: number;
  /** (д) …из них со следами: `kept` + `partially_compensated` + `unknown`. */
  chainsWithTraces?: number;
  /** (д) Предложений «Вернуть» принято / «Оставить». */
  undoAccepted?: number;
  undoKept?: number;
  /** (д) Возвратов полей: попыток и успешных (проверено загрузчиком). */
  undoAttempts?: number;
  undoDone?: number;
  /** (д) Сбой на точке невозврата после `dispatched` — «не знаю, отправилось ли». */
  pnrUnknown?: number;
  /**
   * (заход 9) Распознавание за 24 ч по языкам: расслышано / «не
   * расслышал» (счётчики маршрута голоса `vc-stt`).
   */
  stt?: Record<string, { heard: number; notHeard: number }>;
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

/** Хеш IP плана из строки `plan` (как `planIpOf` мемо; ≤ 128 знаков). */
function ipOfTarget(target: unknown): string | null {
  const ip =
    target && typeof target === 'object' && !Array.isArray(target)
      ? (target as { ip?: unknown }).ip
      : null;
  return typeof ip === 'string' && ip.length > 0 && ip.length <= 128
    ? ip
    : null;
}

/**
 * Потолок вклада (аудит (г) 03.10 + заход 9 аудит (3)): план идёт в метрики,
 * только если он среди `perVisitorPlans` самых новых планов окна СВОЕГО
 * посетителя И своего хеша IP. Ранги независимы (не «жадный» пропуск) —
 * то же правило считает SQL канарейки (`canaryAggregates`), сверка —
 * приёмка e6b. Порядок — новее раньше, при равенстве — по id.
 */
export function cappedPlanIds(
  plans: ReadonlyArray<
    Pick<MonitorPlanRow, 'id' | 'createdAt' | 'visitorId' | 'ipHash'>
  >,
): Set<string> {
  const cap = MONITOR_THRESHOLDS.perVisitorPlans;
  const sorted = [...plans].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const byVisitor = new Map<string, number>();
  const byIp = new Map<string, number>();
  const ok = new Set<string>();
  for (const p of sorted) {
    let pass = true;
    if (p.visitorId) {
      const n = (byVisitor.get(p.visitorId) ?? 0) + 1;
      byVisitor.set(p.visitorId, n);
      if (n > cap) pass = false;
    }
    if (p.ipHash) {
      const n = (byIp.get(p.ipHash) ?? 0) + 1;
      byIp.set(p.ipHash, n);
      if (n > cap) pass = false;
    }
    if (pass) ok.add(p.id);
  }
  return ok;
}

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
  // Хеш IP плана — из строки `plan` журнала, если в строке плана его нет.
  const ipFromLog = new Map<string, string>();
  for (const l of logs)
    if (l.action === 'plan') {
      const ip = ipOfTarget(l.target);
      if (ip) ipFromLog.set(l.planId, ip);
    }
  const counted = cappedPlanIds(
    plans.map((p) => ({
      ...p,
      ipHash: p.ipHash ?? ipFromLog.get(p.id) ?? null,
    })),
  );
  m.chainsBroken = 0;
  m.chainsWithTraces = 0;
  m.undoAccepted = 0;
  m.undoKept = 0;
  m.undoAttempts = 0;
  m.undoDone = 0;
  m.pnrUnknown = 0;
  for (const p of plans) {
    const rows = (byPlan.get(p.id) ?? []).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    // Нарушение запрета — сигнал нашего кода, не голос посетителя: считается
    // всегда (потолок посетителя его не прячет).
    m.violations += rows.filter((r) => r.action === 'violation').length;
    if (!counted.has(p.id)) continue;
    const steps = stepsOf(p.steps);
    // (д) Цепочки (§5-бис.15 п.12): следы после сбоя, «Вернуть»/«Оставить»,
    // успешность возврата полей, неизвестный итог на точке невозврата.
    const cs = p.chainStatus ?? null;
    if (cs && cs !== 'clean' && cs !== 'committed') m.chainsBroken++;
    if (cs === 'kept' || cs === 'partially_compensated' || cs === 'unknown')
      m.chainsWithTraces++;
    for (const r of rows) {
      if (r.action !== 'undo') continue;
      if (r.result === 'proposed') m.undoAccepted++;
      else if (r.reason === 'keep') m.undoKept++;
      // (Э6-тер (и)) Отметка «компенсация начата» — не попытка: итог придёт
      // отдельной строкой (или `unknown` после перезагрузки).
      else if (r.result === 'dispatched') continue;
      else {
        m.undoAttempts++;
        if (r.result === 'done') m.undoDone++;
      }
    }
    if (
      steps.some(
        (s) =>
          (s as { undo?: unknown }).undo === 'irrev' &&
          (s as { fx?: unknown }).fx === true &&
          s.state !== 'done',
      )
    )
      m.pnrUnknown++;
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
  | 'not_heard_high'
  | 'done_low'
  | 'self_high'
  | 'not_found_high'
  | 'stoplist_live'
  | 'violation'
  /** (д) Возврат полей не удаётся — «разметка отмены устарела» (только тревога). */
  | 'undo_low';

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
  if (
    (m.undoAttempts ?? 0) >= T.undo.minAttempts &&
    rate(m.undoDone ?? 0, m.undoAttempts ?? 0) < T.undo.successBelow
  )
    alert.push('undo_low');
  if (notHeardLangs(m.stt).length) alert.push('not_heard_high');
  return alert.length
    ? { action: 'alert', codes: alert }
    : { action: 'none', codes: [] };
}

/**
 * (заход 9) Языки, где «не расслышал» > 30% на ≥ 20 командах за 24 ч
 * (§5-бис.14) — тревога без деградации. По убыванию доли.
 */
export function notHeardLangs(stt: SiteVoiceMetrics['stt']): string[] {
  const T = MONITOR_THRESHOLDS.notHeard;
  return (
    Object.entries(stt ?? {})
      // `any` — «не расслышал» старых бандлов без языка интерфейса: не язык.
      .filter(([lang]) => lang !== 'any')
      .map(([lang, c]) => ({
        lang,
        n: c.heard + c.notHeard,
        r: rate(c.notHeard, c.heard + c.notHeard),
      }))
      .filter((x) => x.n >= T.minCommands && x.r > T.above)
      .sort((a, b) => b.r - a.r || (a.lang < b.lang ? -1 : 1))
      .map((x) => x.lang)
  );
}

/**
 * (заход 9, аудит (г) (1)) Страница сайтов прохода по keyset-курсору:
 * сначала `siteId > cursor` (по возрастанию), недобор — с начала круга до
 * курсора включительно. Новый курсор — последний взятый `siteId`; круг
 * замкнулся (взяты все) — курсор сбрасывается в null.
 */
export function cursorPage<T extends { siteId: string }>(p: {
  after: T[];
  wrapped: T[];
  limit: number;
}): { page: T[]; cursor: string | null } {
  const page = p.after.slice(0, p.limit);
  if (page.length < p.limit)
    for (const s of p.wrapped) {
      if (page.length >= p.limit) break;
      if (!page.some((x) => x.siteId === s.siteId)) page.push(s);
    }
  const full = page.length >= p.limit;
  return {
    page,
    cursor: full && page.length ? page[page.length - 1].siteId : null,
  };
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

// ── (е) Мемо: «требует проверки» (§5-бис.17 п.8) ─────────────────────────

export interface MemoReviewInput {
  view: 'any' | 'desktop' | 'mobile';
  /** Виды вёрстки, где элемент шага помечен Ш4 «устарел». */
  staleViews: ReadonlyArray<'desktop' | 'mobile'>;
  /** Сбои/`pinMismatch` по шагам за 7 дней: разные посетители и хеши IP. */
  stepFailures: ReadonlyMap<
    number,
    { visitors: ReadonlySet<string>; ips: ReadonlySet<string>; pin: boolean }
  >;
  /** Запуски с итогом цели за 7 дней и сколько дошли до цели. */
  goalRuns: number;
  goalReached: number;
  thresholds: { minVisitors: number; goalMinRuns: number; goalBelow: number };
}

export interface MemoReviewDecision {
  /** null — мемо работает; иначе — `needs_review` с причиной. */
  review: {
    code: 'stale' | 'pin_mismatch' | 'failures' | 'goal_low';
    step: number | null;
  } | null;
  /** Виды, где мемо не исполняется (устаревший элемент), — остальным работает. */
  staleViews: Array<'desktop' | 'mobile'>;
}

/**
 * `needs_review` (§5-бис.17 п.8): (1) элемент шага устарел (Ш4) для вида
 * мемо — у `any` только по виду, где устарел (на другом мемо работает), оба
 * вида — `needs_review`; (4) сбой или `pinMismatch` на одном шаге у ≥ 3
 * разных посетителей И хешей IP за 7 дней (один посетитель не «выключит»
 * мемо, подделав свой DOM); (5) успех цели < 60% на ≥ 10 запусках.
 * Само-лечения нет: выход — новая версия с прогоном и подтверждением.
 */
export function decideMemoReview(i: MemoReviewInput): MemoReviewDecision {
  const stale = [...new Set(i.staleViews)];
  const wanted: Array<'desktop' | 'mobile'> =
    i.view === 'any' ? ['desktop', 'mobile'] : [i.view];
  const staleOwn = stale.filter((v) => wanted.includes(v));
  if (staleOwn.length === wanted.length)
    return { review: { code: 'stale', step: null }, staleViews: staleOwn };
  for (const [step, f] of [...i.stepFailures.entries()].sort(
    (a, b) => a[0] - b[0],
  ))
    if (
      f.visitors.size >= i.thresholds.minVisitors &&
      f.ips.size >= i.thresholds.minVisitors
    )
      return {
        review: { code: f.pin ? 'pin_mismatch' : 'failures', step },
        staleViews: staleOwn,
      };
  if (
    i.goalRuns >= i.thresholds.goalMinRuns &&
    i.goalReached / i.goalRuns < i.thresholds.goalBelow
  )
    return { review: { code: 'goal_low', step: null }, staleViews: staleOwn };
  return { review: null, staleViews: staleOwn };
}
