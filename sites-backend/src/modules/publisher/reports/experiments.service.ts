/**
 * AI Publisher — эксперименты F17 (P-E, проектный документ §6.6, §7.5,
 * §3.2 ДТ-1; ТЗ §23; AT-CORE-23, AT-F17-01/02).
 *
 *  - Регистрация — ДО запуска: `windowStart ≥ registeredAt`, пороги
 *    (`d42_thresholds` с `minSampleForConclusion`, `d90_thresholds`,
 *    `allowed_cpl_inputs`, `late_cohort_rules`) замораживаются в строке с
 *    версиями и статусами параметров; триггер `pub_experiments_guard`
 *    запрещает их правку. Новая гипотеза или порог — НОВАЯ версия
 *    (`supersedesId`), прежняя → `superseded`, её результат не меняется.
 *  - Применение (`apply`): `registered → running`, `appliedAt ≥ registeredAt`.
 *  - t0 пилота ставит система ОДИН раз при первой live-публикации
 *    (`PilotClockPort.setT0Once`, вызывает P-C), t42/t72/t90 — от t0
 *    (`pilotMilestones`), условный UPDATE `WHERE t0 IS NULL`.
 *  - Заключение: `supported/not_supported` — только при закрытом окне и
 *    выборке ≥ `minSampleForConclusion` (замороженной), иначе
 *    `PUB_WINDOW_OPEN`; решение `continue_limited|scale|test_external_order`
 *    требует лимита денег эксперимента. Победителя система не выбирает.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import type { ProductCtx } from '../contracts/common';
import { DEFAULT_PARAMETER_VALUES } from '../contracts/parameters';
import {
  EXPERIMENT_CONCLUSIONS,
  EXPERIMENT_DECISIONS,
  isOneOf,
} from '../contracts/states';
import type {
  ExperimentView,
  NewExperimentVersionBody,
} from '../contracts/reports-api';
import {
  PubContribution,
  type ProductInitContext,
  type ProductInitContributor,
} from '../core/contributions';
import { PubError, validationError } from '../core/errors';
import { addKyivCalendarDays, pilotMilestones } from '../core/kyiv-time';
import { parseMinor } from '../core/money';
import { piiIssues } from '../core/pii-guard';
import { PILOT_CAMPAIGN_CODE } from '../core/product.service';
import type {
  AuditInput,
  PilotClockPort,
  ProductRef,
  PubTx,
} from '../core/ports';
import {
  EXPERIMENT_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import type { FrozenThresholds } from './metrics/report-compute';
import type { FieldIssue } from '../contracts/errors';

export const PILOT_EXPERIMENT_KEY = 'pilot';
const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Решения, которым нужен денежный лимит эксперимента (AT-F17-01). */
export const DECISIONS_WITH_LIMIT = [
  'continue_limited',
  'scale',
  'test_external_order',
] as const;

type ExperimentRow = Prisma.PubExperimentGetPayload<object>;

const THRESHOLD_KEYS = [
  'd42_thresholds',
  'd90_thresholds',
  'allowed_cpl_inputs',
  'late_cohort_rules',
] as const;

/** Пороги из текущих параметров продукта + их версии и статусы (заморозка). */
export async function freezeThresholds(
  tx: PubTx,
  productId: string,
): Promise<FrozenThresholds> {
  const rows = await tx.pubParameter.findMany({
    where: { productId, key: { in: [...THRESHOLD_KEYS] } },
    select: { key: true, value: true, version: true, status: true },
  });
  const by = new Map(rows.map((r) => [r.key, r]));
  const val = <K extends (typeof THRESHOLD_KEYS)[number]>(k: K) =>
    (by.get(k)?.value ??
      DEFAULT_PARAMETER_VALUES[k]) as (typeof DEFAULT_PARAMETER_VALUES)[K];
  const versions: FrozenThresholds['versions'] = {};
  for (const k of THRESHOLD_KEYS) {
    const r = by.get(k);
    versions[k] = { version: r?.version ?? 0, status: r?.status ?? 'missing' };
  }
  return {
    d42: { ...val('d42_thresholds') },
    d90: { ...val('d90_thresholds') },
    allowedCpl: { ...val('allowed_cpl_inputs') },
    lateCohort: { ...val('late_cohort_rules') },
    versions,
  };
}

export function experimentView(
  r: ExperimentRow,
  contentIds: string[],
): ExperimentView {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: r.id,
    key: r.key,
    version: r.version,
    kind: r.kind as ExperimentView['kind'],
    hypothesis: r.hypothesis,
    change: r.change,
    metric: r.metric,
    expectedSignal: r.expectedSignal,
    stopConditions: r.stopConditions,
    baselineVersionId: r.baselineVersionId,
    newVersionId: r.newVersionId,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    limitMinor: r.limitMinor === null ? null : r.limitMinor.toString(),
    thresholds: r.thresholds,
    t0Planned: iso(r.t0Planned),
    t0: iso(r.t0),
    t42: iso(r.t42),
    t72: iso(r.t72),
    t90: iso(r.t90),
    lateCohortEnd: iso(r.lateCohortEnd),
    registeredAt: r.registeredAt.toISOString(),
    appliedAt: iso(r.appliedAt),
    status: r.status as ExperimentView['status'],
    conclusion: r.conclusion as ExperimentView['conclusion'],
    conclusionReason: r.conclusionReason,
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedAt: iso(r.decidedAt),
    supersedesId: r.supersedesId,
    contentIds,
  };
}

function text(
  v: unknown,
  field: string,
  issues: FieldIssue[],
  required = true,
): string | undefined {
  if (v === undefined || v === null) {
    if (required) issues.push({ field, code: 'required' });
    return undefined;
  }
  if (typeof v !== 'string' || v.trim().length < 1 || [...v].length > 2000) {
    issues.push({ field, code: 'length' });
    return undefined;
  }
  return v.trim();
}

function date(
  v: unknown,
  field: string,
  issues: FieldIssue[],
): Date | undefined {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/T/.test(v)) {
    issues.push({ field, code: v === undefined ? 'required' : 'format' });
    return undefined;
  }
  return new Date(v);
}

/** Есть ли у продукта решение по эксперименту, которое влияет на чтение (для отчётов). */
export interface ExperimentInput {
  hypothesis: string;
  change: string;
  metric: string;
  expectedSignal: string;
  stopConditions: string;
  baselineVersionId: string | null;
  newVersionId: string | null;
  windowStart: Date;
  windowEnd: Date;
  limitMinor: bigint | null;
  contentIds: string[];
  lateCohortEnd: Date | null;
}

export function parseExperimentInput(
  body: Record<string, unknown>,
  base: ExperimentInput | null,
): ExperimentInput {
  const issues: FieldIssue[] = [];
  const pick = (k: keyof ExperimentInput) =>
    body[k] !== undefined ? body[k] : undefined;
  const req = base === null;
  const t = (
    k: 'hypothesis' | 'change' | 'metric' | 'expectedSignal' | 'stopConditions',
  ) =>
    pick(k) === undefined && base
      ? base[k]
      : (text(body[k], k, issues, req) as string);
  const out: ExperimentInput = {
    hypothesis: t('hypothesis'),
    change: t('change'),
    metric: t('metric'),
    expectedSignal: t('expectedSignal'),
    stopConditions: t('stopConditions'),
    baselineVersionId: base?.baselineVersionId ?? null,
    newVersionId: base?.newVersionId ?? null,
    windowStart: base?.windowStart ?? new Date(0),
    windowEnd: base?.windowEnd ?? new Date(0),
    limitMinor: base?.limitMinor ?? null,
    contentIds: base?.contentIds ?? [],
    lateCohortEnd: base?.lateCohortEnd ?? null,
  };
  for (const k of ['baselineVersionId', 'newVersionId'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'string' && ID_RE.test(v)) out[k] = v;
    else issues.push({ field: k, code: 'format' });
  }
  if (req || body.windowStart !== undefined)
    out.windowStart =
      date(body.windowStart, 'windowStart', issues) ?? out.windowStart;
  if (req || body.windowEnd !== undefined)
    out.windowEnd = date(body.windowEnd, 'windowEnd', issues) ?? out.windowEnd;
  if (body.limitMinor !== undefined) {
    if (body.limitMinor === null) out.limitMinor = null;
    else {
      const m = parseMinor(body.limitMinor);
      if (m === null || m < 0n)
        issues.push({ field: 'limitMinor', code: 'format' });
      else out.limitMinor = m;
    }
  }
  if (body.contentIds !== undefined) {
    const ids = body.contentIds;
    if (
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some((x) => typeof x !== 'string' || !ID_RE.test(x))
    ) {
      issues.push({ field: 'contentIds', code: 'format' });
    } else out.contentIds = [...new Set(ids as string[])];
  }
  if (body.lateCohortEnd !== undefined) {
    out.lateCohortEnd =
      body.lateCohortEnd === null
        ? null
        : (date(body.lateCohortEnd, 'lateCohortEnd', issues) ?? null);
  }
  if (
    out.windowEnd.getTime() <= out.windowStart.getTime() &&
    !issues.some((x) => x.field.startsWith('window'))
  ) {
    issues.push({ field: 'windowEnd', code: 'before_start' });
  }
  issues.push(
    ...piiIssues({
      hypothesis: out.hypothesis,
      change: out.change,
      metric: out.metric,
      expectedSignal: out.expectedSignal,
      stopConditions: out.stopConditions,
    }),
  );
  if (issues.length) throw validationError(issues);
  return out;
}

@Injectable()
export class ExperimentsService implements PilotClockPort {
  async contentIdsOf(tx: PubTx, experimentId: string): Promise<string[]> {
    const rows = await tx.pubExperimentContent.findMany({
      where: { experimentId },
      select: { contentId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.contentId);
  }

  async view(tx: PubTx, row: ExperimentRow): Promise<ExperimentView> {
    return experimentView(row, await this.contentIdsOf(tx, row.id));
  }

  async list(tx: PubTx, product: ProductRef): Promise<ExperimentView[]> {
    const rows = await tx.pubExperiment.findMany({
      where: { productId: product.id },
      orderBy: [{ key: 'asc' }, { version: 'asc' }],
    });
    return Promise.all(rows.map((r) => this.view(tx, r)));
  }

  async get(
    tx: PubTx,
    product: ProductRef,
    id: string,
  ): Promise<ExperimentRow> {
    const row = ID_RE.test(id)
      ? await tx.pubExperiment.findFirst({
          where: { id, productId: product.id },
        })
      : null;
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return row;
  }

  /** Версии материалов и сами материалы — только этого продукта (иначе 404 как «чужое»). */
  private async checkRefs(
    tx: PubTx,
    product: ProductRef,
    input: ExperimentInput,
  ): Promise<void> {
    for (const k of ['baselineVersionId', 'newVersionId'] as const) {
      const id = input[k];
      if (!id) continue;
      const v = await tx.pubContentVersion.findFirst({
        where: { id, productId: product.id },
        select: { id: true },
      });
      if (!v) throw validationError([{ field: k, code: 'not_found' }]);
    }
    if (input.contentIds.length) {
      const found = await tx.pubContent.findMany({
        where: { id: { in: input.contentIds }, productId: product.id },
        select: { id: true },
      });
      if (found.length !== input.contentIds.length) {
        throw validationError([{ field: 'contentIds', code: 'not_found' }]);
      }
    }
  }

  private async insert(
    tx: PubTx,
    product: ProductRef,
    data: {
      key: string;
      version: number;
      kind: 'pilot' | 'change';
      input: ExperimentInput;
      thresholds: FrozenThresholds;
      actor: string;
      now: Date;
      supersedesId: string | null;
      pilot?: {
        t0Planned: Date | null;
        t0: Date | null;
        t42: Date | null;
        t72: Date | null;
        t90: Date | null;
      };
      /** Пилот после t0: новая версия сразу действует (t0 уже стоит). */
      running?: boolean;
    },
  ): Promise<ExperimentRow> {
    const row = await tx.pubExperiment.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        key: data.key,
        version: data.version,
        kind: data.kind,
        hypothesis: data.input.hypothesis,
        change: data.input.change,
        metric: data.input.metric,
        expectedSignal: data.input.expectedSignal,
        stopConditions: data.input.stopConditions,
        baselineVersionId: data.input.baselineVersionId,
        newVersionId: data.input.newVersionId,
        windowStart: data.input.windowStart,
        windowEnd: data.input.windowEnd,
        limitMinor: data.input.limitMinor,
        thresholds: data.thresholds as unknown as Prisma.InputJsonValue,
        lateCohortEnd: data.input.lateCohortEnd,
        registeredAt: data.now,
        status: data.running ? 'running' : 'registered',
        appliedAt: data.running ? data.now : null,
        supersedesId: data.supersedesId,
        createdBy: data.actor,
        ...(data.pilot ?? {}),
      },
    });
    for (const contentId of data.input.contentIds) {
      await tx.pubExperimentContent.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          experimentId: row.id,
          contentId,
          createdBy: data.actor,
        },
      });
    }
    return row;
  }

  /** Регистрация гипотезы изменения (`kind=change`) до запуска (AT-F17-01). */
  async register(
    tx: PubTx,
    product: ProductCtx,
    body: Record<string, unknown>,
    actor: string,
    now: Date,
  ): Promise<{ row: ExperimentRow; audit: AuditInput[] }> {
    const key = body.key;
    if (
      typeof key !== 'string' ||
      !KEY_RE.test(key) ||
      key === PILOT_EXPERIMENT_KEY
    ) {
      throw validationError([
        {
          field: 'key',
          code: key === PILOT_EXPERIMENT_KEY ? 'reserved' : 'format',
        },
      ]);
    }
    const input = parseExperimentInput(body, null);
    if (input.windowStart.getTime() < now.getTime()) {
      // Гипотеза фиксируется до запуска (ТЗ §23): задним числом не регистрируется.
      throw validationError([
        { field: 'windowStart', code: 'before_registration' },
      ]);
    }
    await this.checkRefs(tx, product, input);
    const exists = await tx.pubExperiment.findFirst({
      where: { productId: product.id, key },
      select: { id: true },
    });
    if (exists)
      throw new PubError('PUB_CONFLICT', {
        reason: 'key_exists',
        experimentId: exists.id,
      });
    const row = await this.insert(tx, product, {
      key,
      version: 1,
      kind: 'change',
      input,
      thresholds: await freezeThresholds(tx, product.id),
      actor,
      now,
      supersedesId: null,
    });
    return {
      row,
      audit: [
        {
          objectType: 'experiment',
          objectId: row.id,
          action: 'create',
          toStatus: 'registered',
          // `keyRef`: ключ эксперимента — код (может быть датой из цифр), а
          // значение `meta.key` pii-guard принял бы за телефон (Z-1).
          meta: { keyRef: key, version: 1 },
        },
      ],
    };
  }

  /**
   * Новая версия: прежняя → `superseded`, её строка и результат неизменны
   * (аудит P-E S1-1 — «гипотеза и пороги фиксируются до старта»):
   *  - `change` — новая гипотеза с НОВЫМ будущим окном (`windowStart ≥
   *    now`, иначе 400 `before_registration`), пороги из текущих параметров
   *    замораживаются заново — до её старта;
   *  - `pilot` до t0 — любые правки (пилот ещё не начат), пороги заново;
   *  - `pilot` после t0 — только явный конец поздней когорты
   *    (`lateCohortEnd`); гипотеза, материалы, окно, лимит — 400
   *    `pilot_started` (новая гипотеза — отдельный эксперимент `change`),
   *    пороги и вехи копируются из прежней версии как есть. Снимки
   *    D42/D72/D90 всё равно судятся версией на t0 (`ReportsService.pilotAtT0`).
   */
  async newVersion(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown> & Partial<NewExperimentVersionBody>,
    actors: Actor[],
    actor: string,
    now: Date,
  ): Promise<{ row: ExperimentRow; audit: AuditInput[] }> {
    const old = await this.get(tx, product, id);
    assertTransition(EXPERIMENT_MACHINE, old.status as never, 'superseded', {
      actors,
    });
    const base: ExperimentInput = {
      hypothesis: old.hypothesis,
      change: old.change,
      metric: old.metric,
      expectedSignal: old.expectedSignal,
      stopConditions: old.stopConditions,
      baselineVersionId: old.baselineVersionId,
      newVersionId: old.newVersionId,
      windowStart: old.windowStart,
      windowEnd: old.windowEnd,
      limitMinor: old.limitMinor,
      contentIds: await this.contentIdsOf(tx, old.id),
      lateCohortEnd: old.lateCohortEnd,
    };
    const started = old.kind === 'pilot' && old.t0 !== null;
    if (started) {
      const locked = [
        'hypothesis',
        'change',
        'metric',
        'expectedSignal',
        'stopConditions',
        'baselineVersionId',
        'newVersionId',
        'windowStart',
        'windowEnd',
        'limitMinor',
        'contentIds',
      ].filter((k) => body[k] !== undefined);
      if (locked.length)
        throw validationError(
          locked.map((field) => ({ field, code: 'pilot_started' })),
        );
    }
    const input = parseExperimentInput(body, base);
    if (old.kind === 'change' && input.windowStart.getTime() < now.getTime()) {
      // Окно прежней версии уже началось: новая гипотеза — только с новым
      // будущим окном (иначе она сформулирована после просмотра данных).
      throw validationError([
        { field: 'windowStart', code: 'before_registration' },
      ]);
    }
    if (
      input.lateCohortEnd &&
      old.t42 &&
      input.lateCohortEnd.getTime() <= old.t42.getTime()
    ) {
      throw validationError([{ field: 'lateCohortEnd', code: 'before_t42' }]);
    }
    await this.checkRefs(tx, product, input);
    const max = await tx.pubExperiment.aggregate({
      where: { productId: product.id, key: old.key },
      _max: { version: true },
    });
    const version = (max._max.version ?? old.version) + 1;
    const updated = await tx.pubExperiment.updateMany({
      where: { id: old.id, status: old.status },
      data: { status: 'superseded' },
    });
    if (updated.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'status_changed' });
    const row = await this.insert(tx, product, {
      key: old.key,
      version,
      kind: old.kind as 'pilot' | 'change',
      input,
      thresholds: started
        ? (old.thresholds as unknown as FrozenThresholds)
        : await freezeThresholds(tx, product.id),
      actor,
      now,
      supersedesId: old.id,
      pilot:
        old.kind === 'pilot'
          ? {
              t0Planned: old.t0Planned,
              t0: old.t0,
              t42: old.t42,
              t72: old.t72,
              t90: old.t90,
            }
          : undefined,
      running: old.kind === 'pilot' && old.t0 !== null,
    });
    if (old.kind === 'pilot') await linkPilotCampaign(tx, product.id, row.id);
    return {
      row,
      audit: [
        {
          objectType: 'experiment',
          objectId: old.id,
          action: 'transition',
          fromStatus: old.status,
          toStatus: 'superseded',
        },
        {
          objectType: 'experiment',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { keyRef: old.key, version, supersedesId: old.id },
        },
      ],
    };
  }

  /** Применение изменения: `registered → running` (пилот запускает t0). */
  async apply(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    actors: Actor[],
    now: Date,
  ): Promise<{ row: ExperimentRow; audit: AuditInput[] }> {
    const old = await this.get(tx, product, id);
    if (old.kind === 'pilot') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: EXPERIMENT_MACHINE.name,
        from: old.status,
        to: 'running',
        allowed: [],
        reason: 'pilot_starts_at_t0',
      });
    }
    assertTransition(EXPERIMENT_MACHINE, old.status as never, 'running', {
      actors,
    });
    const n = await tx.pubExperiment.updateMany({
      where: { id: old.id, status: 'registered' },
      data: { status: 'running', appliedAt: now },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'status_changed' });
    const row = await this.get(tx, product, id);
    return {
      row,
      audit: [
        {
          objectType: 'experiment',
          objectId: id,
          action: 'transition',
          fromStatus: 'registered',
          toStatus: 'running',
        },
      ],
    };
  }

  /**
   * Заключение и решение (AT-F17-01/02). `allowed` — результат
   * `experimentConclusionAllowed` по свежему расчёту (вызывающий).
   */
  async conclude(
    tx: PubTx,
    product: ProductCtx,
    row: ExperimentRow,
    body: Record<string, unknown>,
    gate: {
      allowed: 'any' | 'inconclusive_only';
      windowClosed: boolean;
      qualifiedUnique: number;
      minSample: number;
    },
    actors: Actor[],
    actor: string,
    now: Date,
  ): Promise<{ row: ExperimentRow; audit: AuditInput[] }> {
    const issues: FieldIssue[] = [];
    if (!isOneOf(EXPERIMENT_CONCLUSIONS, body.conclusion))
      issues.push({ field: 'conclusion', code: 'enum' });
    if (!isOneOf(EXPERIMENT_DECISIONS, body.decision))
      issues.push({ field: 'decision', code: 'enum' });
    const reason = text(body.reason, 'reason', issues);
    if (reason) issues.push(...piiIssues({ reason }));
    if (issues.length) throw validationError(issues);
    assertTransition(EXPERIMENT_MACHINE, row.status as never, 'concluded', {
      actors,
    });
    const conclusion =
      body.conclusion as (typeof EXPERIMENT_CONCLUSIONS)[number];
    const decision = body.decision as (typeof EXPERIMENT_DECISIONS)[number];
    if (conclusion !== 'inconclusive' && gate.allowed === 'inconclusive_only') {
      throw new PubError('PUB_WINDOW_OPEN', {
        windowClosed: gate.windowClosed,
        qualifiedUnique: gate.qualifiedUnique,
        minSampleForConclusion: gate.minSample,
        allowed: ['inconclusive'],
      });
    }
    if (
      (DECISIONS_WITH_LIMIT as readonly string[]).includes(decision) &&
      row.limitMinor === null
    ) {
      throw validationError([{ field: 'decision', code: 'limit_required' }]);
    }
    const n = await tx.pubExperiment.updateMany({
      where: { id: row.id, status: 'running' },
      data: {
        status: 'concluded',
        conclusion,
        conclusionReason: reason as string,
        decision,
        decidedBy: actor,
        decidedAt: now,
      },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'status_changed' });
    const fresh = await this.get(tx, product, row.id);
    return {
      row: fresh,
      audit: [
        {
          objectType: 'experiment',
          objectId: row.id,
          action: 'transition',
          fromStatus: 'running',
          toStatus: 'concluded',
          reason: reason as string,
          meta: {
            conclusion,
            decision,
            qualifiedUnique: gate.qualifiedUnique,
            windowClosed: gate.windowClosed,
          },
        },
      ],
    };
  }

  /** Текущая (не заменённая) версия пилота. */
  async currentPilot(
    tx: PubTx,
    productId: string,
  ): Promise<ExperimentRow | null> {
    return tx.pubExperiment.findFirst({
      where: {
        productId,
        key: PILOT_EXPERIMENT_KEY,
        status: { notIn: ['superseded', 'cancelled'] },
      },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * PilotClockPort (§3.2, ДТ-1): t0 ставится ОДИН раз в транзакции первой
   * live-публикации; null — уже стоит (или пилота нет). Условный UPDATE
   * `t0 IS NULL` + триггер «NULL → значение один раз».
   */
  async setT0Once(
    tx: PubTx,
    product: ProductRef,
    at: Date,
  ): Promise<{ t0: Date; t42: Date; t72: Date; t90: Date } | null> {
    const pilot = await this.currentPilot(tx, product.id);
    if (!pilot || pilot.t0) return null;
    const m = pilotMilestones(at);
    const applied =
      at.getTime() >= pilot.registeredAt.getTime() ? at : pilot.registeredAt;
    const n = await tx.pubExperiment.updateMany({
      where: { id: pilot.id, t0: null },
      data: {
        t0: m.t0,
        t42: m.t42,
        t72: m.t72,
        t90: m.t90,
        ...(pilot.status === 'registered'
          ? { status: 'running', appliedAt: applied }
          : {}),
      },
    });
    if (n.count !== 1) return null;
    return { t0: m.t0, t42: m.t42, t72: m.t72, t90: m.t90 };
  }
}

/**
 * Шаг создания продукта `pilot-experiment` (§11.3): эксперимент `pilot` v1
 * с `t0Planned` из `pilot_calendar`, окном 90 дней и порогами-допущениями
 * (заморожены с версиями/статусами; утверждённые до D0 пороги — новой
 * версией до t0).
 */
@Injectable()
@PubContribution('product-init')
export class PilotExperimentInit implements ProductInitContributor {
  readonly key = 'pilot-experiment' as const;

  async init(
    tx: PubTx,
    product: ProductCtx,
    ctx: ProductInitContext,
  ): Promise<void> {
    const cal = ctx.parameters.pilot_calendar as
      { t0Planned?: string | null } | undefined;
    const planned =
      cal?.t0Planned && !Number.isNaN(Date.parse(cal.t0Planned))
        ? new Date(cal.t0Planned)
        : null;
    const start = planned ?? ctx.now;
    const pilot = await tx.pubExperiment.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        key: PILOT_EXPERIMENT_KEY,
        version: 1,
        kind: 'pilot',
        hypothesis:
          'Шість матеріалів-відповідей на перевірені питання й дві закупки дають попередній сигнал попиту D42 за зафіксованими порогами.',
        change:
          'Запуск пілоту: публікація шести матеріалів і заздалегідь вибрані закупки.',
        metric:
          'Унікальні зовнішні кваліфіковані prospect_id, вимірювані сесії, пропозиції різним prospect_id.',
        expectedSignal:
          'Пороги d42_thresholds (затверджуються власником до D0).',
        stopConditions:
          'Вичерпано ліміт бюджету, відсутнє вимірювання або критичний дефект.',
        windowStart: start,
        windowEnd: addKyivCalendarDays(start, 90),
        thresholds: (await freezeThresholds(
          tx,
          product.id,
        )) as unknown as Prisma.InputJsonValue,
        t0Planned: planned,
        registeredAt: ctx.now,
        status: 'registered',
        createdBy: ctx.actor,
      },
    });
    await linkPilotCampaign(tx, product.id, pilot.id);
  }
}

/**
 * Кампания пилота (`pub_campaigns.code = pilot`, создаёт ядро до шагов
 * product-init) ссылается на ТЕКУЩУЮ версию эксперимента `pilot`
 * (интеграция Z-1, Р-PUB-Z1-8): при регистрации и при каждой новой версии.
 * Единственная колонка `pub_campaigns`, которую пишет P-E (исключение
 * `table-ownership.spec`).
 */
export async function linkPilotCampaign(
  tx: PubTx,
  productId: string,
  experimentId: string,
): Promise<void> {
  await tx.pubCampaign.updateMany({
    where: { productId, code: PILOT_CAMPAIGN_CODE },
    data: { experimentId },
  });
}

/** id для строк, которым нужен известный заранее id (AAD шифра копии). */
export function newRowId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
