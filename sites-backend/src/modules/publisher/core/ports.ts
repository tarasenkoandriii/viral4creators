/**
 * AI Publisher — порты между пакетами (P-A1, проектный документ §16.0).
 * Интерфейсы и DI-токены задаёт P-A1; реализует пакет-владелец и кладёт
 * провайдер с токеном в СВОЙ модуль. Ядро и другие пакеты берут порт
 * через `PubPorts` (поиск провайдера по всему приложению, `ModuleRef`
 * `strict: false`), поэтому модули пакетов не импортируют друг друга.
 *
 * Пока реализации нет — заглушка бросает `PUB_NOT_IMPLEMENTED` (501) при
 * ЛЮБОМ вызове: заглушка порта не возвращает «успех» (§16.0, аудит этапа
 * 0). Для тестов — фейки `core/testing/fake-ports.ts`.
 *
 * Множественные вклады пакетов (задания кронов, шаги создания продукта,
 * переназначение при удалении участника) — не токены, а классы с
 * `@PubContribution(...)` (`core/contributions.ts`).
 */
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { SitesDb } from '../../../prisma/sites-db.service';
import type { CronScope } from '../../../common/cron-scope';
import type { AiGateway } from '../contracts/ai';
import type {
  GateContext,
  GateName,
  GateResult,
  Minor,
  ProductCtx,
} from '../contracts/common';
import type { ParameterKey } from '../contracts/parameters';
import type {
  AuditAction,
  DependentStage,
  ObjectType,
  ParameterStatus,
  ReviewReason,
  ReviewSeverity,
} from '../contracts/states';
import { PubError } from './errors';
import type { Actor } from './state-machines';

/**
 * Продукт в вызовах портов: id и кабинет. Сверх сигнатур §16.0 (там
 * `productId`) — Р-PUB-A1-7: запись в таблицы кабинета требует `accountId`
 * (составные FK), а порт не должен перечитывать продукт ради него.
 */
export type ProductRef = Pick<ProductCtx, 'id' | 'accountId'>;

/** Клиент транзакции кабинета (`SitesDb.forAccount(...).$transaction`). */
export type PubTx = Parameters<
  Parameters<ReturnType<SitesDb['forAccount']>['$transaction']>[0]
>[0];

// ── Ядро (P-A1) ──────────────────────────────────────────────────────────

export interface AuditInput {
  objectType: ObjectType;
  objectId: string;
  action: AuditAction;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Свободный текст — проверка `pii-guard`. */
  reason?: string | null;
  /** Без ключей ПД (триггер); ≤ 8 КБ. */
  meta?: Record<string, unknown> | null;
  /** По умолчанию — продукт операции. */
  productId?: string;
  /** По умолчанию — участник операции (`member:<id>`). */
  actor?: string;
  occurredAt?: Date;
}

export interface AuditPort {
  write(
    tx: PubTx,
    e: AuditInput & { accountId: string; productId: string; actor: string },
  ): Promise<void>;
}

export interface ReviewItem {
  objectType: ObjectType;
  objectId: string;
  reason: ReviewReason;
  /** id события-причины: повтор того же события задач не плодит. */
  triggerRef: string;
  severity: ReviewSeverity;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
}

export interface ReviewPort {
  /** Открыть задачи проверки; возвращает число НОВЫХ задач. */
  open(
    tx: PubTx,
    product: ProductRef,
    items: ReviewItem[],
    opts?: { actor?: string },
  ): Promise<number>;
}

export interface GatePort {
  evaluate(
    tx: PubTx,
    product: ProductRef,
    gate: GateName,
    now: Date,
    ctx?: GateContext,
  ): Promise<GateResult>;
  /** То же, но закрытый гейт — 409 `PUB_GATE_CLOSED {gate, missing}`. */
  assertOpen(
    tx: PubTx,
    product: ProductRef,
    gate: GateName,
    now: Date,
    ctx?: GateContext,
  ): Promise<void>;
}

export interface ParameterCurrent {
  key: ParameterKey;
  value: unknown;
  status: ParameterStatus;
  version: number;
}

/**
 * Решение по параметру из операции другого пакета (P-B1: активация оффера
 * обновляет `offer_active_version` решением, §6.3). Порядок записи
 * (решение → параметр → `refreshGateFlags`) и блокировку строки продукта
 * (`lockProduct`, аудит P1-1) держит ядро.
 */
export interface ParameterPort {
  current(
    tx: PubTx,
    product: ProductRef,
    key: ParameterKey,
  ): Promise<ParameterCurrent>;
  decide(
    tx: PubTx,
    product: ProductRef,
    input: {
      key: ParameterKey;
      toStatus: 'approved' | 'rejected' | 'revoked' | 'assumption';
      value?: unknown;
      basis: string;
      decidedBy: string;
      /**
       * Роли решающего участника (`actorsOf(access)` маршрута пакета) —
       * ОБЯЗАТЕЛЬНЫ: умолчания «владелец продукта» нет (аудит P3-5);
       * машина `parameter` проверяет по ним право решения.
       */
      actors: Actor[];
      dependentStages?: DependentStage[];
    },
  ): Promise<{ decisionId: string | null; version: number }>;
}

// ── Пакеты этапа 1 ───────────────────────────────────────────────────────

/** P-B1 (§16.0). */
export interface ContentPort {
  publishableVersion(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
  ): Promise<{
    contentId: string;
    hash: string;
    approvalId: string;
    approvalActive: boolean;
    criticalStale: boolean;
    firstLivePublishedAt: Date | null;
    offerActive: boolean;
    openChangeTasks: number;
  }>;
  markPublished(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    publicationId: string,
    stage: 'test' | 'live',
    at: Date,
  ): Promise<void>;
  markWithdrawn(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    reason: string,
  ): Promise<void>;
}

/**
 * qa-catalog: сводка сохранённого прогона приёмки (Р-PUB-Z2-27, DEF-C-07):
 * доказательство в `launch_evidence_*` — id прогона, а не свободная строка.
 * Реализация — `modules/qa-catalog/qa-run-evidence.ts` (структурно та же
 * форма; Publisher и qa-catalog друг друга не импортируют).
 */
export interface QaRunEvidence {
  runId: string;
  siteId: string;
  title: string;
  createdAt: Date;
  /** `caseKey` → версия кейса в снимке и статус последней попытки. */
  cases: Record<string, { version: number; status: string | null }>;
}
export interface QaRunEvidencePort {
  runEvidence(accountId: string, runId: string): Promise<QaRunEvidence | null>;
}

/** P-E: t0 эксперимента `pilot` ставится один раз (§3.2, ДТ-1). */
export interface PilotClockPort {
  setT0Once(
    tx: PubTx,
    product: ProductRef,
    at: Date,
  ): Promise<{ t0: Date; t42: Date; t72: Date; t90: Date } | null>;
}

/**
 * P-C: публикации снятого материала (§7.1 «публикации переводятся в
 * `withdrawn`»; интеграция Z-1, Р-PUB-Z1-1). Вызывает P-B1 в транзакции
 * перехода материала в `withdrawn`: активные публикации материала
 * (`pending|published`, все стадии и каналы) → `withdrawn` по машине 7.3 с
 * ролями решающего. `ContentPort.markWithdrawn` порт НЕ вызывает (материал
 * уже снимает вызывающий). Возвращает снятые строки — аудит пишет
 * операция вызывающего.
 */
export interface PublicationsPort {
  withdrawForContent(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    input: { reason: string; actors: Actor[] },
  ): Promise<Array<{ publicationId: string; fromStatus: string }>>;
}

/**
 * P-B2: принятие результата AI человеком (§7.5 `open → done`, интеграция
 * Z-1, Р-PUB-Z1-4). Вызывает P-B1, когда мутация человека записывает
 * предложение с `aiCallId`: задача вызова `open → done` (роль — машина
 * `ai_task`). Повтор и задача не в `open` — без изменений (`accepted:false`).
 */
export interface AiTasksPort {
  acceptCall(
    tx: PubTx,
    product: ProductRef,
    callId: string,
    input: { actors: Actor[] },
  ): Promise<{ taskId: string; fromStatus: string; accepted: boolean }>;
}

/**
 * P-C: сборка строки лимита из утверждённых параметров (§8.2).
 *
 * СВЕРКА СЧЁТЧИКОВ (решение координатора по Р-PUB-A0-2, 12.10.2026):
 * отложенного триггера `pub_budget_counters_check` НЕТ (CONSTRAINT TRIGGER
 * ломает migrate diff, как CHECK). Вместо него:
 *  1. каждая функция `sites.pub_budget_*` (миграция P-C
 *     `…_publisher_budget_fn`) в конце сама сверяет счётчики строки лимита
 *     (уже заблокированной её условным UPDATE) с Σ по `confirmed`-записям
 *     продукта и при расхождении — `RAISE EXCEPTION 'PUB_BUDGET_COUNTERS_MISMATCH'
 *     USING ERRCODE = 'P0001'` (откат всей операции);
 *  2. ежедневное задание `budget-reconcile` (P-C, `PUB_CRON_SCHEDULE`)
 *     сравнивает счётчики с `budgetSnapshot` по всем продуктам; расхождение
 *     — задача владельцу и остановка новых обязательств.
 * `paramVersion` строки лимита — `budgetParamVersion()` (contracts/parameters).
 */
export interface BudgetLimitPort {
  applyParameters(tx: PubTx, product: ProductRef): Promise<void>;
}

/** Снимок бюджета (§9.2) — форма для чтения другими пакетами. */
export interface BudgetSnapshot {
  currency: string;
  total: Minor;
  netPaid: Minor;
  openCommitment: Minor;
  deliveredUnpaid: Minor;
  protectedReserve: Minor;
  available: Minor;
  usageBp: number;
  warn: boolean;
  stopped: boolean;
  byCategory: Record<
    'placements' | 'tools',
    { used: Minor; limit: Minor; available: Minor }
  >;
}

export interface BudgetReadPort {
  snapshot(tx: PubTx, product: ProductRef, at?: Date): Promise<BudgetSnapshot>;
}

/** P-D: обогащение заявки вне очереди (открытие карточки, §11.4). */
export interface LeadEnrichPort {
  enrichNow(product: ProductRef, leadId: string): Promise<void>;
}

/** P-D: сброс счётчика лимита формы тестового продукта (§11.3, AT-CORE-02). */
export interface RateLimitResetPort {
  reset(tx: PubTx, product: ProductRef): Promise<number>;
}

// ── Кроны (§15.1) ────────────────────────────────────────────────────────

/**
 * `minute` — очередь AI-вызовов `ai-calls-run` (решение координатора по
 * аудиту P-B2 S2-1, §11.1): путь `/cron/publisher-minute` каждую минуту.
 */
export type CronSchedule = 'minute' | 'tick' | 'daily';

export interface PubCronContext {
  now: Date;
  /** Тесты на общей базе — только свои сайты (`CronScope`). */
  scope?: CronScope;
  /** Срок, к которому задание должно закончить проход (остаток — в следующий раз). */
  deadline: Date;
}

export interface CronResult {
  processed: number;
  details?: Record<string, number | string | boolean>;
  /**
   * Задание не может сделать свою работу, пока нет вкладов/портов других
   * пакетов (ключи недостающего): статус `pending`, ответ крона — 501
   * `PUB_NOT_IMPLEMENTED`, работа НЕ помечается сделанной и повторится,
   * когда вклад появится (аудит P2-4: «заглушка — не успех», §16.0).
   */
  pending?: string[];
}

/** Задание крона (класс с `@PubContribution('cron-job')`). */
export interface CronJob {
  key: string;
  schedule: CronSchedule;
  run(ctx: PubCronContext): Promise<CronResult>;
}

// ── Токены ────────────────────────────────────────────────────────────────

export const AUDIT_PORT = 'PUB_AUDIT_PORT';
export const REVIEW_PORT = 'PUB_REVIEW_PORT';
export const GATE_PORT = 'PUB_GATE_PORT';
export const PARAMETER_PORT = 'PUB_PARAMETER_PORT';
export const CONTENT_PORT = 'PUB_CONTENT_PORT';
export const PILOT_CLOCK_PORT = 'PUB_PILOT_CLOCK_PORT';
export const BUDGET_LIMIT_PORT = 'PUB_BUDGET_LIMIT_PORT';
export const BUDGET_READ_PORT = 'PUB_BUDGET_READ_PORT';
export const LEAD_ENRICH_PORT = 'PUB_LEAD_ENRICH_PORT';
export const RATE_LIMIT_RESET_PORT = 'PUB_RATE_LIMIT_RESET_PORT';
export const AI_GATEWAY = 'PUB_AI_GATEWAY';
export const PUBLICATIONS_PORT = 'PUB_PUBLICATIONS_PORT';
export const AI_TASKS_PORT = 'PUB_AI_TASKS_PORT';
/** Провайдер — qa-catalog (`QA_RUN_EVIDENCE_TOKEN`, то же значение). */
export const QA_RUN_EVIDENCE_PORT = 'PUB_QA_RUN_EVIDENCE_PORT';

/** Владелец каждого порта (для текста ошибки и отчёта этапа). */
export const PORT_OWNERS = {
  [AUDIT_PORT]: 'P-A1',
  [REVIEW_PORT]: 'P-A1',
  [GATE_PORT]: 'P-A1',
  [PARAMETER_PORT]: 'P-A1',
  [CONTENT_PORT]: 'P-B1',
  [PILOT_CLOCK_PORT]: 'P-E',
  [BUDGET_LIMIT_PORT]: 'P-C',
  [BUDGET_READ_PORT]: 'P-C',
  [LEAD_ENRICH_PORT]: 'P-D',
  [RATE_LIMIT_RESET_PORT]: 'P-D',
  [AI_GATEWAY]: 'P-B2',
  [PUBLICATIONS_PORT]: 'P-C',
  [AI_TASKS_PORT]: 'P-B2',
  [QA_RUN_EVIDENCE_PORT]: 'qa-catalog',
} as const;
export type PortToken = keyof typeof PORT_OWNERS;

interface PortTypes {
  [AUDIT_PORT]: AuditPort;
  [REVIEW_PORT]: ReviewPort;
  [GATE_PORT]: GatePort;
  [PARAMETER_PORT]: ParameterPort;
  [CONTENT_PORT]: ContentPort;
  [PILOT_CLOCK_PORT]: PilotClockPort;
  [BUDGET_LIMIT_PORT]: BudgetLimitPort;
  [BUDGET_READ_PORT]: BudgetReadPort;
  [LEAD_ENRICH_PORT]: LeadEnrichPort;
  [RATE_LIMIT_RESET_PORT]: RateLimitResetPort;
  [AI_GATEWAY]: AiGateway;
  [PUBLICATIONS_PORT]: PublicationsPort;
  [AI_TASKS_PORT]: AiTasksPort;
  [QA_RUN_EVIDENCE_PORT]: QaRunEvidencePort;
}

/**
 * Заглушка нереализованного порта: любой метод — 501 `PUB_NOT_IMPLEMENTED`
 * с именем порта и пакета-владельца. Ничего не возвращает «успешно».
 */
export function notImplementedPort<T extends PortToken>(
  token: T,
): PortTypes[T] {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined; // не thenable
        return () => {
          throw new PubError('PUB_NOT_IMPLEMENTED', {
            port: token,
            method: String(prop),
            owner: PORT_OWNERS[token],
          });
        };
      },
    },
  ) as PortTypes[T];
}

/** Доступ к портам из любого пакета (ленивый поиск провайдера). */
@Injectable()
export class PubPorts {
  constructor(private readonly moduleRef: ModuleRef) {}

  get<T extends PortToken>(token: T): PortTypes[T] {
    try {
      const impl = this.moduleRef.get<PortTypes[T]>(token, { strict: false });
      if (impl) return impl;
    } catch {
      // провайдера нет ни в одном модуле — заглушка ниже
    }
    return notImplementedPort(token);
  }

  /** Есть ли настоящая реализация (отчёт крона, экран «Запуск»). */
  has(token: PortToken): boolean {
    try {
      return !!this.moduleRef.get(token, { strict: false });
    } catch {
      return false;
    }
  }

  audit = (): AuditPort => this.get(AUDIT_PORT);
  review = (): ReviewPort => this.get(REVIEW_PORT);
  gates = (): GatePort => this.get(GATE_PORT);
  parameters = (): ParameterPort => this.get(PARAMETER_PORT);
  content = (): ContentPort => this.get(CONTENT_PORT);
  pilotClock = (): PilotClockPort => this.get(PILOT_CLOCK_PORT);
  budgetLimit = (): BudgetLimitPort => this.get(BUDGET_LIMIT_PORT);
  budgetRead = (): BudgetReadPort => this.get(BUDGET_READ_PORT);
  leadEnrich = (): LeadEnrichPort => this.get(LEAD_ENRICH_PORT);
  rateLimitReset = (): RateLimitResetPort => this.get(RATE_LIMIT_RESET_PORT);
  aiGateway = (): AiGateway => this.get(AI_GATEWAY);
  publications = (): PublicationsPort => this.get(PUBLICATIONS_PORT);
  aiTasks = (): AiTasksPort => this.get(AI_TASKS_PORT);
  qaRuns = (): QaRunEvidencePort => this.get(QA_RUN_EVIDENCE_PORT);
}

/** Для типизации тестов и экранов: продукт порта. */
export type { ProductCtx };
