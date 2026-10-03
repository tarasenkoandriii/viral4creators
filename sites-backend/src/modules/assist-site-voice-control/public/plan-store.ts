/**
 * Хранилище голосовых планов «Сайта» под ролью `assist_public` — ровно тот
 * SQL, что сверяет `prisma/assist-public-role.spec.ts` (Э6-бис): чтение
 * настроек режима, вставка/чтение/условное обновление СВОЕГО плана (id +
 * siteId + visitorId), дописывание журнала шагов. Удаления нет (ретенция —
 * основной ролью, каскадом с диалогом).
 *
 * Условное обновление — по прежнему состоянию целиком (статус, номер шага,
 * шаги): два параллельных отчёта одного шага не продвинут план дважды, а
 * `dispatched`-шаг не станет `dispatched` второй раз (§4-бис.5).
 *
 * Минимизация ПД (аудит Э6-бис, 03.10.2026): в `steps` значения полей —
 * МАСКИРОВАННЫЕ; сырые значения и текст команды — в `liveValues`, только
 * пока план живой. Тот же UPDATE, что переводит план в done/stopped/
 * failed/expired, обнуляет `liveValues`; истёкшие без визита — обнуляет
 * следующий запрос посетителя (`clearDeadLiveValues`) и крон ретенции
 * помощника (assist-site-chat/system/chat-retention.service.ts).
 */
import { randomUUID } from 'crypto';
import { maskLabel } from '../../assist-ui-core/snapshot';
import type { UiPlanStatus } from '../../assist-ui-core/types';
import type { UiPlanStepView } from '../api-types';

const PLANS = '"sites"."assist_site_ui_plans"';
const LOG = '"sites"."assist_site_ui_action_log"';

export interface PlanDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PlanRow {
  id: string;
  conversationId: string;
  status: UiPlanStatus;
  /** Шаги для исполнения: пока план живой — с СЫРЫМИ значениями (`liveValues`). */
  steps: UiPlanStepView[];
  /** Шаги как в базе (значения маскированы) — условие условного UPDATE. */
  storedSteps: UiPlanStepView[];
  currentStep: number;
  needsConfirm: boolean;
  confirmedBy: string | null;
  confirmBefore: Date;
  expiresAt: Date;
  utteranceMasked: string;
  /** Текст команды: сырой, пока план живой; иначе — маскированный. */
  utterance: string;
  source: string;
  lang: string | null;
  pageUrl: string;
}

/** Живые статусы: пока план в них, сырые значения держатся в `liveValues`. */
export const LIVE_PLAN_STATUSES: readonly UiPlanStatus[] = [
  'proposed',
  'confirmed',
  'running',
  'paused',
];
const LIVE_SQL = `('proposed', 'confirmed', 'running', 'paused')`;

/** Шаги для базы: значения полей — маской (e-mail, телефон, ключ, длинные цифры). */
export function maskedSteps(steps: UiPlanStepView[]): UiPlanStepView[] {
  return steps.map((s) => ({
    ...s,
    value:
      s.value === null || s.value === undefined ? null : maskLabel(s.value),
  }));
}

interface LiveValues {
  u: string;
  v: Array<string | null>;
}

function liveValuesOf(utterance: string, steps: UiPlanStepView[]): string {
  const live: LiveValues = { u: utterance, v: steps.map((s) => s.value) };
  return JSON.stringify(live);
}

function parseLive(raw: unknown): LiveValues | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.u !== 'string' || !Array.isArray(o.v)) return null;
  return {
    u: o.u,
    v: o.v.map((x) => (typeof x === 'string' ? x : null)),
  };
}

type DbRow = Omit<PlanRow, 'storedSteps' | 'utterance'> & {
  liveValues: unknown;
};

/** Строка базы → план: живые значения поверх маскированных шагов. */
function hydrate(row: DbRow): PlanRow {
  const { liveValues, ...rest } = row;
  const live = LIVE_PLAN_STATUSES.includes(row.status)
    ? parseLive(liveValues)
    : null;
  const steps = live
    ? row.steps.map((s, i) => ({
        ...s,
        value: s.value === null ? null : (live.v[i] ?? s.value),
      }))
    : row.steps;
  return {
    ...rest,
    steps,
    storedSteps: row.steps,
    utterance: live?.u ?? row.utteranceMasked,
  };
}

export interface SiteVcRow {
  voiceControlSiteState: string;
  voiceControlSiteRules: unknown;
}

export async function readSiteVoiceControl(
  db: PlanDb,
  siteId: string,
): Promise<SiteVcRow | null> {
  const rows = await db.$queryRawUnsafe<SiteVcRow[]>(
    `SELECT "voiceControlSiteState", "voiceControlSiteRules" FROM "sites"."assist_sites" WHERE "siteId" = $1`,
    siteId,
  );
  return rows[0] ?? null;
}

export async function insertPlan(
  db: PlanDb,
  p: {
    accountId: string;
    siteId: string;
    conversationId: string;
    visitorId: string;
    utteranceMasked: string;
    /** Сырой текст команды — в `liveValues`, пока план живой. */
    utterance: string;
    source: 'voice' | 'typed';
    lang: string | null;
    pageUrl: string;
    steps: UiPlanStepView[];
    status: UiPlanStatus;
    needsConfirm: boolean;
    confirmedBy: string | null;
    confirmBefore: Date;
    expiresAt: Date;
  },
): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO ${PLANS} ("id", "accountId", "siteId", "conversationId", "visitorId", "utteranceMasked", "source", "lang", "pageUrl", "steps", "liveValues", "currentStep", "status", "needsConfirm", "confirmedBy", "confirmBefore", "expiresAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $16::jsonb, 0, $11, $12, $13, $14, $15, now())`,
    id,
    p.accountId,
    p.siteId,
    p.conversationId,
    p.visitorId,
    p.utteranceMasked,
    p.source,
    p.lang,
    p.pageUrl,
    JSON.stringify(maskedSteps(p.steps)),
    p.status,
    p.needsConfirm,
    p.confirmedBy,
    p.confirmBefore,
    p.expiresAt,
    LIVE_PLAN_STATUSES.includes(p.status)
      ? liveValuesOf(p.utterance, p.steps)
      : null,
  );
  return id;
}

const COLS = `"id", "conversationId", "status", "steps", "liveValues", "currentStep", "needsConfirm", "confirmedBy", "confirmBefore", "expiresAt", "utteranceMasked", "source", "lang", "pageUrl"`;

/** План ЭТОГО посетителя этого сайта; чужой id неотличим от несуществующего. */
export async function readPlan(
  db: PlanDb,
  p: { id: string; siteId: string; visitorId: string },
): Promise<PlanRow | null> {
  const rows = await db.$queryRawUnsafe<DbRow[]>(
    `SELECT ${COLS} FROM ${PLANS} WHERE "id" = $1 AND "siteId" = $2 AND "visitorId" = $3`,
    p.id,
    p.siteId,
    p.visitorId,
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Последний живой план посетителя (продолжение после перехода, §4-бис.5). */
export async function readActivePlan(
  db: PlanDb,
  p: { siteId: string; visitorId: string; now: Date },
): Promise<PlanRow | null> {
  const rows = await db.$queryRawUnsafe<DbRow[]>(
    `SELECT ${COLS} FROM ${PLANS}
      WHERE "siteId" = $1 AND "visitorId" = $2
        AND "status" IN ('proposed', 'confirmed', 'running') AND "expiresAt" > $3
      ORDER BY "createdAt" DESC LIMIT 1`,
    p.siteId,
    p.visitorId,
    p.now,
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * Сырые значения планов посетителя, которые больше не живые (завершён,
 * остановлен, истёк по сроку без визита), — обнулить. Зовут создание плана
 * и продолжение (`active`); остальное — крон ретенции помощника.
 */
export async function clearDeadLiveValues(
  db: PlanDb,
  p: { siteId: string; visitorId: string; now: Date },
): Promise<number> {
  return db.$executeRawUnsafe(
    `UPDATE ${PLANS} SET "liveValues" = NULL
      WHERE "siteId" = $1 AND "visitorId" = $2 AND "liveValues" IS NOT NULL
        AND ("status" NOT IN ${LIVE_SQL} OR "expiresAt" <= $3)`,
    p.siteId,
    p.visitorId,
    p.now,
  );
}

/**
 * Перевести план из ТОГО состояния, что прочитано, в новое. `false` — план
 * успел измениться (параллельный отчёт/стоп): вызывающий перечитывает.
 */
export async function updatePlan(
  db: PlanDb,
  prev: PlanRow,
  p: { siteId: string; visitorId: string },
  next: {
    steps: UiPlanStepView[];
    currentStep: number;
    status: UiPlanStatus;
    needsConfirm: boolean;
    confirmedBy: string | null;
    /** Новое окно подтверждения (карточка после продолжения); null — прежнее. */
    confirmBefore?: Date | null;
  },
): Promise<boolean> {
  // Завершён/остановлен/истёк — сырые значения и команда обнуляются тем же
  // UPDATE (в журнале и в шагах — только маска).
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ${PLANS}
        SET "steps" = $4::jsonb, "liveValues" = $13::jsonb, "currentStep" = $5, "status" = $6, "needsConfirm" = $7, "confirmedBy" = $8,
            "confirmBefore" = COALESCE($12, "confirmBefore"), "updatedAt" = now()
      WHERE "id" = $1 AND "siteId" = $2 AND "visitorId" = $3
        AND "status" = $9 AND "currentStep" = $10 AND "steps" = $11::jsonb
      RETURNING "id"`,
    prev.id,
    p.siteId,
    p.visitorId,
    JSON.stringify(maskedSteps(next.steps)),
    next.currentStep,
    next.status,
    next.needsConfirm,
    next.confirmedBy,
    prev.status,
    prev.currentStep,
    JSON.stringify(prev.storedSteps),
    next.confirmBefore ?? null,
    LIVE_PLAN_STATUSES.includes(next.status)
      ? liveValuesOf(prev.utterance, next.steps)
      : null,
  );
  return rows.length > 0;
}

/** Запись журнала шагов (§5-бис.9) — только дописывается. */
export async function insertActionLog(
  db: PlanDb,
  p: {
    accountId: string;
    siteId: string;
    planId: string;
    stepIndex: number;
    action: string;
    target: unknown;
    url: string | null;
    risk: string;
    confirmedBy: string | null;
    result: string;
    reason: string | null;
    valueMasked: string | null;
    durationMs: number | null;
  },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO ${LOG} ("id", "accountId", "siteId", "planId", "stepIndex", "action", "target", "url", "risk", "confirmedBy", "result", "reason", "valueMasked", "durationMs")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    randomUUID(),
    p.accountId,
    p.siteId,
    p.planId,
    p.stepIndex,
    p.action,
    p.target === null || p.target === undefined
      ? null
      : JSON.stringify(p.target),
    p.url,
    p.risk,
    p.confirmedBy,
    p.result,
    p.reason,
    p.valueMasked,
    p.durationMs,
  );
}
