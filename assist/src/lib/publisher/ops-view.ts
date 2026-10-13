/**
 * AI Publisher (P-G2) — чистые функции показа экранов денег, заявок и
 * отчётов (проверяются `scripts/publisher-ops-view.test.ts` без React):
 *  - словарь `publisher-ops-*` по языку;
 *  - строки бюджета §17 ТЗ (delivered_unpaid — внутри обязательств, не
 *    вычитается второй раз; «план/обязательство/факт/неизвестно» различимы);
 *  - балл площадки отдельно от полноты (AT-F10-01), «невідомо» ≠ 0;
 *  - доступные шаги закупки (машина 7.2) и заявки (7.4) — только подсказка,
 *    решает сервер;
 *  - тон интеграции: зелёный только `connected` и не устаревшая;
 *  - разрешённые выводы эксперимента: при открытом окне — только
 *    «не определено» (AT-F17-02).
 */
import type { Locale } from '../../kit';
import { pubOpsEn } from '../../i18n/publisher-ops-en';
import { pubOpsRu, type PublisherOpsDict } from '../../i18n/publisher-ops-ru';
import { pubOpsUk } from '../../i18n/publisher-ops-uk';
import type {
  BudgetView,
  PlacementStatus,
  PlacementStep,
  PlacementStepIn,
  PlacementView,
  VenueCriterion,
  VenueView,
} from './distribution-api';
import { VENUE_CRITERIA } from './distribution-api';
import type {
  ExperimentVersionIn,
  ExperimentView,
  IntegrationView,
  MetricImportDay,
} from './reports-api';
import type { LeadStatus } from './leads-api';
import { LEAD_TRANSITIONS } from './leads-api';
import type { Tone } from './view';

export type { PublisherOpsDict };

const OPS: Record<Locale, PublisherOpsDict> = {
  uk: pubOpsUk,
  ru: pubOpsRu,
  en: pubOpsEn,
};

export function getOpsDict(locale: Locale): PublisherOpsDict {
  return OPS[locale];
}

// ── Деньги ───────────────────────────────────────────────────────────────

/** Вид числа для подписи: план, обязательство (прогноз расхода), факт. */
export type AmountKind = 'plan' | 'forecast' | 'fact' | 'unknown';

export interface BudgetRow {
  key:
    | 'total'
    | 'netPaid'
    | 'openCommitment'
    | 'deliveredUnpaid'
    | 'protectedReserve'
    | 'available';
  minor: string | null;
  kind: AmountKind;
  /** Знак строки в формуле «доступно» (deliveredUnpaid — 0: уже внутри). */
  sign: '+' | '−' | '=' | 'in';
  nested?: boolean;
}

/**
 * Строки бюджета в порядке формулы ТЗ §17. Лимит не собран (`built=false`)
 * — суммы неизвестны, а не нули: значения `null`.
 */
export function budgetRows(b: BudgetView): BudgetRow[] {
  const k = (m: string, kind: AmountKind) =>
    b.built ? { minor: m, kind } : { minor: null, kind: 'unknown' as const };
  return [
    { key: 'total', sign: '+', ...k(b.total, 'plan') },
    { key: 'netPaid', sign: '−', ...k(b.netPaid, 'fact') },
    { key: 'openCommitment', sign: '−', ...k(b.openCommitment, 'forecast') },
    {
      key: 'deliveredUnpaid',
      sign: 'in',
      nested: true,
      ...k(b.deliveredUnpaid, 'forecast'),
    },
    {
      key: 'protectedReserve',
      sign: '−',
      ...k(b.protectedReserve, 'plan'),
    },
    { key: 'available', sign: '=', ...k(b.available, 'plan') },
  ];
}

/**
 * Сверка формулы на экране (сервер — источник правды): доступно =
 * лимит − net_paid − open_commitment − резерв; delivered_unpaid не
 * вычитается. `null` — лимит не собран.
 */
export function budgetFormulaHolds(b: BudgetView): boolean | null {
  if (!b.built) return null;
  const v =
    BigInt(b.total) -
    BigInt(b.netPaid) -
    BigInt(b.openCommitment) -
    BigInt(b.protectedReserve);
  return v === BigInt(b.available);
}

/** Доля использования лимита «12,5 %» из базисных пунктов. */
export function usagePct(bp: number, locale: Locale): string {
  const pct = bp / 100;
  const s = new Intl.NumberFormat(
    locale === 'en' ? 'en-GB' : locale === 'uk' ? 'uk-UA' : 'ru-RU',
    { maximumFractionDigits: 1 }
  ).format(pct);
  return `${s} %`;
}

export function budgetTone(b: BudgetView): Tone {
  if (!b.built || b.stopped || b.reconcileStopped) return 'danger';
  if (b.warn || b.warnings.length) return 'warning';
  return 'neutral';
}

/**
 * Ввод суммы человеком («1 500,50», «1500.5») → минимальные единицы
 * строкой. Неоднозначное — `null` (форма не отправится).
 */
export function parseMoneyInput(raw: string): string | null {
  const s = raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = (m[3] ?? '').padEnd(2, '0');
  const v = BigInt(m[2]) * 100n + BigInt(cents || '0');
  if (v === 0n) return '0';
  return `${m[1]}${v.toString()}`;
}

// ── Площадки ─────────────────────────────────────────────────────────────

export interface VenueScoreView {
  /** Балл по известным оценкам; null — не оценено ни одного критерия. */
  score: { sum: number; max: number; known: number } | null;
  /** Полнота — отдельно: «оценено n из 5». */
  completeness: { rated: number; total: number };
  /** Подпись каждого критерия: 0/1/2 или «unknown». */
  cells: Array<{
    criterion: VenueCriterion;
    value: '0' | '1' | '2' | 'unknown';
    why: string;
  }>;
}

export function venueScoreView(v: VenueView): VenueScoreView {
  const cells = VENUE_CRITERIA.map((c) => {
    const s = v.criteria[c];
    return {
      criterion: c,
      value:
        s && s.score !== null
          ? (String(s.score) as '0' | '1' | '2')
          : 'unknown',
      why: s?.why ?? '',
    } as const;
  });
  return {
    score: v.score.known > 0 ? v.score : null,
    completeness: { rated: v.completeness, total: VENUE_CRITERIA.length },
    cells,
  };
}

// ── Закупки (машина 7.2) ─────────────────────────────────────────────────

export type PlacementUiStep =
  | 'approve'
  | 'reserve'
  | 'order'
  | 'publication'
  | 'published'
  | 'verify'
  | 'dispute'
  | 'resolve'
  | 'cancel'
  | 'reject'
  | 'editPrice';

const STEPS_BY_STATUS: Record<PlacementStatus, readonly PlacementUiStep[]> = {
  proposed: ['approve', 'editPrice', 'reject'],
  approved: ['reserve', 'approve', 'editPrice', 'reject'],
  budget_reserved: ['order', 'approve', 'editPrice', 'cancel'],
  ordered: ['publication', 'approve', 'dispute', 'cancel'],
  publication_pending: ['published', 'approve', 'dispute', 'cancel'],
  published: ['verify', 'dispute'],
  verified_complete: [],
  rejected: [],
  cancelled: [],
  disputed: ['resolve'],
};

/** Действие матрицы §4.2 для шага. */
export const STEP_ACTION: Record<
  PlacementUiStep,
  | 'placement.approve'
  | 'budget.operate'
  | 'placement.claim'
  | 'placement.propose'
> = {
  approve: 'placement.approve',
  reserve: 'budget.operate',
  order: 'budget.operate',
  publication: 'budget.operate',
  published: 'budget.operate',
  verify: 'budget.operate',
  dispute: 'placement.claim',
  resolve: 'placement.claim',
  cancel: 'budget.operate',
  reject: 'placement.propose',
  editPrice: 'placement.propose',
};

/**
 * Шаги закупки, которые имеет смысл показать: по статусу и ролям. Пока
 * оплата `pending|unknown`, заказ не предлагается — сначала сверка
 * (AT-CORE-15; сервер ответит `PUB_RECONCILE_REQUIRED`).
 */
export function placementSteps(
  p: Pick<PlacementView, 'status' | 'paymentStatus'>,
  can: (a: (typeof STEP_ACTION)[PlacementUiStep]) => boolean
): PlacementUiStep[] {
  return STEPS_BY_STATUS[p.status].filter((s) => {
    if (!can(STEP_ACTION[s])) return false;
    if (
      s === 'order' &&
      (p.paymentStatus === 'pending' || p.paymentStatus === 'unknown')
    ) {
      return false;
    }
    return true;
  });
}

/** Оплата требует сверки (жёлтая плашка, не зелёный). */
export function paymentNeedsReconcile(
  p: Pick<PlacementView, 'paymentStatus'>
): boolean {
  return p.paymentStatus === 'pending' || p.paymentStatus === 'unknown';
}

/** Тон статуса оплаты: «paid» — зелёный, неизвестное — жёлтый. */
export function paymentTone(s: PlacementView['paymentStatus']): Tone {
  if (s === 'paid') return 'success';
  if (s === 'pending' || s === 'unknown') return 'warning';
  if (s === 'refunded') return 'neutral';
  return 'neutral';
}

// ── Заявки (машина 7.4) ──────────────────────────────────────────────────

/** Переход требует кода причины (отказ, потеря, пересмотр, отмена квалификации). */
export function transitionNeedsReason(
  from: LeadStatus,
  to: LeadStatus
): boolean {
  if (to === 'rejected' || to === 'lost') return true;
  if (to === 'contacted' && (from === 'rejected' || from === 'lost'))
    return true;
  if (to === 'contacted' && from === 'qualified') return true;
  return false;
}

export function leadTargets(from: LeadStatus): readonly LeadStatus[] {
  return LEAD_TRANSITIONS[from];
}

/** Раскрытое (контакт, заметки): чьё и до какого момента показывать. */
export interface Revealed<T> {
  leadId: string;
  value: T;
  until: number;
}

/**
 * Показ раскрытого: только для той же заявки и до срока; иначе `null`
 * (экран стирает состояние) — контакт не переживает смену заявки.
 */
export function revealedFor<T>(
  r: Revealed<T> | null,
  leadId: string,
  now: number
): T | null {
  return r && r.leadId === leadId && now < r.until ? r.value : null;
}

/** Сколько секунд держать раскрытый контакт на экране. */
export const CONTACT_SHOW_SECONDS = 60;

// ── Интеграции и отчёты ──────────────────────────────────────────────────

/** Зелёный — только подключено и не устарело (AT-CORE-12). */
export function integrationTone(
  i: Pick<IntegrationView, 'exists' | 'status' | 'stale'>
): Tone {
  if (!i.exists) return 'warning';
  if (i.status === 'connected' && !i.stale) return 'success';
  if (i.status === 'disconnected') return 'danger';
  return 'warning';
}

export function integrationsProblems(
  list: IntegrationView[]
): IntegrationView[] {
  return list.filter((i) => integrationTone(i) !== 'success');
}

/**
 * Допустимые выводы заключения: при открытом окне (`windowEnd` в будущем)
 * — только «не определено». Окончательно решает сервер (`PUB_WINDOW_OPEN`).
 */
export function allowedConclusions(
  e: Pick<ExperimentView, 'windowEnd'>,
  now: Date
): Array<'supported' | 'not_supported' | 'inconclusive'> {
  const end = Date.parse(e.windowEnd);
  if (!Number.isFinite(end) || end > now.getTime()) return ['inconclusive'];
  return ['supported', 'not_supported', 'inconclusive'];
}

/** Минуты → часы с одной десятой. */
export function hours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

export interface TimeTotals {
  minutes: number;
  operations: number;
  investment: number;
  byRole: Record<string, number>;
  byCategory: Record<string, number>;
}

export function timeTotals(
  entries: Array<{
    minutes: number;
    isInvestment: boolean;
    role: string;
    category: string;
  }>
): TimeTotals {
  const out: TimeTotals = {
    minutes: 0,
    operations: 0,
    investment: 0,
    byRole: {},
    byCategory: {},
  };
  for (const e of entries) {
    out.minutes += e.minutes;
    if (e.isInvestment) out.investment += e.minutes;
    else out.operations += e.minutes;
    out.byRole[e.role] = (out.byRole[e.role] ?? 0) + e.minutes;
    out.byCategory[e.category] = (out.byCategory[e.category] ?? 0) + e.minutes;
  }
  return out;
}

/** Локальное «YYYY-MM-DDTHH:mm» (input datetime-local) → ISO; пусто — null. */
export function localToIso(v: string): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Сегодняшняя дата по Киеву `YYYY-MM-DD`. */
export function kyivToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Сутки Киева `YYYY-MM-DD` → ISO-момент внутри этих суток (полдень по
 * Киеву при любом смещении +02/+03): сервер берёт `kyivDateOf` — дата не
 * «съезжает» от часового пояса браузера.
 */
/**
 * Дни выгрузки метрик из JSON, вставленного человеком: массив объектов
 * формы `MetricImportDay` контракта (дата `ГГГГ-ММ-ДД`, числа — числа или
 * `null`, лишних ключей нет). Иначе `null` — форма покажет «неверный JSON»
 * до запроса, а не после 400 сервера.
 */
export function metricDays(raw: unknown): MetricImportDay[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const NUM = ['sessions', 'engagedVisits', 'impressions', 'clicks'] as const;
  const KEYS = new Set<string>([
    'date',
    'page',
    ...NUM,
    'indexed',
    'partial',
    'extra',
  ]);
  const isNum = (v: unknown) =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  for (const d of raw) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const o = d as Record<string, unknown>;
    if (Object.keys(o).some((k) => !KEYS.has(k))) return null;
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date))
      return null;
    if ('page' in o && o.page !== null && typeof o.page !== 'string')
      return null;
    for (const k of NUM) if (k in o && !isNum(o[k])) return null;
    if ('indexed' in o && o.indexed !== null && typeof o.indexed !== 'boolean')
      return null;
    if ('partial' in o && typeof o.partial !== 'boolean') return null;
    if ('extra' in o) {
      const e = o.extra;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
      if (!Object.values(e).every(isNum)) return null;
    }
  }
  return raw as MetricImportDay[];
}

export function kyivNoonIso(date: string): string {
  return new Date(`${date}T12:00:00+02:00`).toISOString();
}

// ── Тела шагов закупки (одно место для экрана и теста тел) ───────────────

/** Значения формы шага: строки полей, сумма (минимальные единицы), hash. */
export interface StepFormValues {
  fields: Readonly<Record<string, string>>;
  amountMinor?: string | null;
  versionHash?: string | null;
}

export type StepRequest = {
  [S in PlacementStep]: { step: S; body: PlacementStepIn[S] };
}[PlacementStep];

const HTTPS_RE = /^https:\/\/[^\s/?#]+[^\s]*$/i;
export const isHttps = (v: string | undefined | null): v is string =>
  !!v && HTTPS_RE.test(v.trim());

/**
 * Запрос шага машины 7.2 из формы или `null`, если обязательного нет
 * (кнопка неактивна). Ключи — ровно `*Body` контракта (тест тел).
 * Проверка размещения (P-C S1-2): адрес публикации, ссылка со страницы
 * (`linkUrl`, с `utm_content=<код>`), доказательство (`evidenceUrl`) и
 * маркировка — все обязательны, все https.
 */
export function placementStepRequest(
  step: Exclude<PlacementUiStep, 'editPrice'>,
  p: Pick<
    PlacementView,
    | 'revision'
    | 'currency'
    | 'totalPriceMinor'
    | 'priceSnapshotHash'
    | 'purchaseSeq'
  >,
  f: StepFormValues
): StepRequest | null {
  const v = (k: string) => (f.fields[k] ?? '').trim();
  const iso = (k: string) => localToIso(v(k));
  const expectedRevision = p.revision;
  switch (step) {
    case 'approve': {
      if (!f.versionHash) return null;
      if (p.purchaseSeq >= 3 && !v('reportDecisionId')) return null;
      return {
        step,
        body: {
          expectedRevision,
          maxAmountMinor: f.amountMinor ?? p.totalPriceMinor,
          currency: p.currency,
          versionHash: f.versionHash,
          priceSnapshotHash: p.priceSnapshotHash,
          ...(v('reportDecisionId')
            ? { reportDecisionId: v('reportDecisionId') }
            : {}),
          ...(v('reason') ? { reason: v('reason') } : {}),
        },
      };
    }
    case 'reserve':
      return { step, body: { expectedRevision } };
    case 'order':
      if (!v('externalOrderId')) return null;
      return {
        step,
        body: {
          expectedRevision,
          externalOrderId: v('externalOrderId'),
          ...(v('note') ? { note: v('note') } : {}),
        },
      };
    case 'publication': {
      const at = iso('publishDueAt');
      return at ? { step, body: { expectedRevision, publishDueAt: at } } : null;
    }
    case 'published': {
      const at = iso('publishedAt');
      if (!at || !isHttps(v('url'))) return null;
      return {
        step,
        body: { expectedRevision, url: v('url'), publishedAt: at },
      };
    }
    case 'verify': {
      const marking = v('marking');
      if (
        !isHttps(v('url')) ||
        !isHttps(v('linkUrl')) ||
        !isHttps(v('evidenceUrl'))
      )
        return null;
      if (marking !== 'sponsored' && marking !== 'nofollow') return null;
      return {
        step,
        body: {
          expectedRevision,
          url: v('url'),
          linkUrl: v('linkUrl'),
          evidenceUrl: v('evidenceUrl'),
          marking,
        },
      };
    }
    case 'dispute': {
      const at = iso('nextActionAt');
      if (!v('owner') || !at || !v('reason')) return null;
      return {
        step,
        body: {
          expectedRevision,
          claimOwnerMemberId: v('owner'),
          nextActionAt: at,
          reason: v('reason'),
        },
      };
    }
    case 'resolve': {
      const to = v('to');
      if (!v('reason')) return null;
      if (to === 'publication_pending') {
        const at = iso('publishDueAt');
        if (!at) return null;
        return {
          step: 'dispute/resolve',
          body: { expectedRevision, to, reason: v('reason'), publishDueAt: at },
        };
      }
      if (to === 'published') {
        const at = iso('publishedAt');
        if (!at || !isHttps(v('url'))) return null;
        return {
          step: 'dispute/resolve',
          body: {
            expectedRevision,
            to,
            reason: v('reason'),
            url: v('url'),
            publishedAt: at,
          },
        };
      }
      if (to === 'cancelled') {
        if (
          f.amountMinor == null ||
          f.amountMinor.startsWith('-') ||
          !v('document')
        )
          return null;
        return {
          step: 'dispute/resolve',
          body: {
            expectedRevision,
            to,
            reason: v('reason'),
            confirmedAmountMinor: f.amountMinor,
            document: v('document'),
          },
        };
      }
      return null;
    }
    case 'cancel':
      if (
        f.amountMinor == null ||
        f.amountMinor.startsWith('-') ||
        !v('document')
      )
        return null;
      return {
        step,
        body: {
          expectedRevision,
          confirmedAmountMinor: f.amountMinor,
          document: v('document'),
        },
      };
    case 'reject':
      return v('reason')
        ? { step, body: { expectedRevision, reason: v('reason') } }
        : null;
  }
}

/** Ссылка со страницы ведёт на выданную (`utm_content=<код>`) — подсказка. */
export function linkMatchesCode(
  linkUrl: string,
  placementCode: string
): boolean {
  try {
    return new URL(linkUrl).searchParams.get('utm_content') === placementCode;
  } catch {
    return false;
  }
}

// ── Новая версия эксперимента (P-E S1-1, Р-PUB-E-21) ─────────────────────

/**
 * `pilot_started` — пилот после t0: меняется только конец поздней когорты;
 * `change` — новая гипотеза только с новым БУДУЩИМ окном (`windowStart`);
 * `pilot` — пилот до t0: любые правки.
 */
export type ExperimentVersionMode = 'pilot_started' | 'change' | 'pilot';

export function experimentVersionMode(
  e: Pick<ExperimentView, 'kind' | 't0'>
): ExperimentVersionMode {
  if (e.kind === 'pilot') return e.t0 ? 'pilot_started' : 'pilot';
  return 'change';
}

export const EXPERIMENT_TEXT_FIELDS = [
  'hypothesis',
  'change',
  'metric',
  'expectedSignal',
  'stopConditions',
] as const;

/** Тело новой версии из формы или `null` (кнопка неактивна). */
export function experimentVersionBody(
  e: Pick<ExperimentView, 'kind' | 't0'>,
  f: Readonly<Record<string, string>>,
  now: Date
): ExperimentVersionIn | null {
  const v = (k: string) => (f[k] ?? '').trim();
  const mode = experimentVersionMode(e);
  const late = localToIso(v('lateCohortEnd'));
  if (mode === 'pilot_started') {
    return late ? { lateCohortEnd: late } : null;
  }
  const body: ExperimentVersionIn = {};
  for (const k of EXPERIMENT_TEXT_FIELDS) if (v(k)) body[k] = v(k);
  const start = localToIso(v('windowStart'));
  const end = localToIso(v('windowEnd'));
  if (start) body.windowStart = start;
  if (end) body.windowEnd = end;
  if (late) body.lateCohortEnd = late;
  if (mode === 'change') {
    if (!start || Date.parse(start) < now.getTime()) return null;
  }
  return Object.keys(body).length ? body : null;
}
