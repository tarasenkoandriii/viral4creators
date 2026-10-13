/**
 * AI Publisher — AI-шлюз кабинета (P-B2, проектный документ §12.1;
 * интерфейс `AiGateway` — `contracts/ai.ts`, порт `AI_GATEWAY`).
 *
 * `open` — транзакция 1 (`openCall`): блокирующие статусы записаны сразу.
 * `startSync` (маршрут) исполняет `running` синхронно в окне 25 с; окно
 * вышло — модель прерывается, вызов остаётся `running` и его исполняет
 * задание очереди `ai-calls-run` (каждую минуту, под арендой; решение
 * координатора по аудиту S2-1, §11.1). Фона «в том же процессе» нет.
 * Через 10 мин без итога — `ai-calls-reap` (`timeout`, резерв держится).
 *
 * `await(product, callId, ms)` — опрос базы не дольше `ms`; вызов читается
 * через `SitesDb.forAccount` продукта (чужой кабинет — 404). Если первая
 * попытка не прошла схему и шлюз сделал повторную, вид — последней.
 *
 * Режим набора 30 задач здесь недоступен: шлюз всегда в режиме кабинета.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { GeminiText } from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type {
  AiCallView,
  AiGateway,
  AiStartInput,
  GeneratorId,
  PostCheckFinding,
} from '../contracts/ai';
import {
  memberActor,
  type GateMissing,
  type ProductCtx,
} from '../contracts/common';
import type { AiCallStatus, AiCostStatus } from '../contracts/states';
import { AuditService } from '../core/audit';
import { PubError, isPubError } from '../core/errors';
import { OPERATION_TX_OPTIONS, mapDbError } from '../core/operation';
import { PubPorts, type PubTx } from '../core/ports';
import type { ContextRequest } from './context';
import {
  ROUTE_WAIT_MS,
  derivedOpKey,
  existingByOpKey,
  isPendingEnvelope,
  openCall,
  purposeOf,
  runCall,
  type AiTextModel,
  type ExecPlan,
  type OpenResult,
  type RunDeps,
  type RunResult,
} from './gateway-core';
import { GENERATORS } from './generators';

/** Текст находки по коду (в журнале хранятся только код и важность). */
export const FINDING_TEXT: Record<string, string> = {
  source_outside_context: 'Посилання на джерело поза контекстом',
  forbidden_promise: 'Заборонена обіцянка у відповіді',
  number_not_in_context: 'Є числа, яких немає в контексті — перевірте',
  guarantee_word: 'Є слово «гарант…» — перевірте, що це не обіцянка',
  brief_without_source: 'Бриф без джерела не може стати готовим',
  supported_without_source: 'Твердження позначене підтвердженим без джерела',
  scenes_outside_script: 'Сцени заповнені не для сценарію',
};

/** Текст находки; у «чисел вне контекста» — какие числа (предаудит D2-05). */
export function findingText(f: {
  code: string;
  values?: unknown;
  more?: unknown;
}): string {
  const base = FINDING_TEXT[f.code] ?? f.code;
  const values = Array.isArray(f.values)
    ? f.values.filter((v): v is string => typeof v === 'string')
    : [];
  const more = typeof f.more === 'number' && f.more > 0 ? f.more : 0;
  if (!values.length && !more) return base;
  const list = values.join(', ');
  const tail = more ? `${list ? ' ' : ''}(+${more} довших)` : '';
  return `${base}: ${list}${tail}`;
}

export interface CabinetStart {
  product: ProductCtx;
  memberId: string;
  generator: GeneratorId;
  opKey: string;
  objectType: string;
  objectId: string;
  input: unknown;
  context: ContextRequest;
}

@Injectable()
export class AiGatewayService implements AiGateway {
  private readonly logger = new Logger('PublisherAiGateway');
  private model: AiTextModel;

  constructor(
    private readonly db: SitesDb,
    text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly audit: AuditService,
    private readonly ports: PubPorts,
  ) {
    this.model = text;
  }

  /** Тесты: модель без сети. */
  useModel(model: AiTextModel): this {
    this.model = model;
    return this;
  }

  private deps(): RunDeps {
    return {
      model: this.model,
      usage: this.usage,
      usageDb: (accountId) => this.db.forAccount(accountId),
      transaction: (accountId, fn) =>
        this.db
          .forAccount(accountId)
          .$transaction((tx) => fn(tx as PubTx), OPERATION_TX_OPTIONS),
      audit: this.audit,
    };
  }

  /** Контракт `AiGateway.start` (§12.1): контекст — явный список источников. */
  async start<I>(
    p: AiStartInput<I>,
  ): Promise<{ callId: string; status: AiCallStatus }> {
    const r = await this.open({
      product: p.product,
      memberId: p.member.memberId,
      generator: p.spec.id,
      opKey: p.opKey,
      objectType: p.objectType,
      objectId: p.objectId,
      input: p.input,
      context: {
        audience:
          (p.input as { audience?: unknown } | null)?.audience === 'public'
            ? 'public'
            : 'internal',
        sourceIds: p.sourceIds ?? [],
      },
    });
    // Порт не держит соседа 25 с: модель исполнит очередь `ai-calls-run`.
    return { callId: r.callId, status: r.status };
  }

  /**
   * Транзакция 1 (§12.1): вызов создан или найден по `opKey`. Модель здесь
   * НЕ запускается — синхронно её исполняет `startSync` (маршрут, окно
   * 25 с), иначе задание очереди `ai-calls-run` (аудит S2-1).
   */
  async open(s: CabinetStart): Promise<OpenResult> {
    const spec = GENERATORS[s.generator];
    if (!spec) throw new PubError('PUB_NOT_FOUND', { generator: s.generator });
    const actor = memberActor(s.memberId);
    const tx = <T>(fn: (tx: PubTx) => Promise<T>) =>
      this.db
        .forAccount(s.product.accountId)
        .$transaction((t) => fn(t as PubTx), OPERATION_TX_OPTIONS);
    try {
      return await tx((t) =>
        openCall(
          t,
          {
            product: s.product,
            actor,
            spec,
            opKey: s.opKey,
            objectType: s.objectType,
            objectId: s.objectId,
            input: s.input,
            context: s.context,
            mode: { kind: 'cabinet' },
            now: new Date(),
          },
          { gates: this.ports.gates(), audit: this.audit },
        ),
      );
    } catch (e) {
      const mapped = mapDbError(e) ?? e;
      // Аудит S2-6: параллельный повтор того же `opKey` проиграл гонку
      // уникальности — вернуть вызов победителя (или 409, если запрос другой).
      if (
        isPubError(mapped, 'PUB_CONFLICT') &&
        mapped.details.reason === 'unique'
      ) {
        const again = await tx((t) =>
          existingByOpKey(t, s.product.id, s.opKey, {
            generator: s.generator,
            purpose: purposeOf(s.objectType, s.objectId, s.input, s.context),
            actor,
          }),
        );
        if (again) return again;
      }
      throw mapped;
    }
  }

  /**
   * Исполнить план: модель вне транзакции и финализация. С `budgetMs`
   * окно истекло — вызов остаётся `running` для очереди. Ошибка
   * финализации не теряет вызов: его доведёт очередь или `ai-calls-reap`.
   */
  async execute(plan: ExecPlan, budgetMs?: number): Promise<RunResult | null> {
    try {
      return await runCall(plan, this.deps(), { budgetMs });
    } catch (e) {
      this.logger.warn(
        `AI ${plan.generator} ${plan.callId}: исполнение не завершено (${(e as Error)?.name ?? 'Error'})`,
      );
      return null;
    }
  }

  /** Маршрут: старт + синхронный путь ≤ `budgetMs` (по умолчанию 25 с). */
  async startSync(
    s: CabinetStart,
    budgetMs: number = ROUTE_WAIT_MS,
  ): Promise<OpenResult & { handedOff: boolean }> {
    const r = await this.open(s);
    if (!r.plan) return { ...r, handedOff: false };
    const run = await this.execute(r.plan, budgetMs);
    return { ...r, handedOff: run?.handedOff ?? true };
  }

  /** Опрос: ждать финального статуса не дольше `maxWaitMs` (без процесса-фона). */
  async await(
    product: ProductCtx,
    callId: string,
    maxWaitMs: number,
  ): Promise<AiCallView> {
    const until = Date.now() + Math.max(0, maxWaitMs);
    let v = await this.view(product, callId);
    while (v.status === 'running' && Date.now() < until) {
      await new Promise((r) =>
        setTimeout(r, Math.min(250, until - Date.now())),
      );
      v = await this.view(product, callId);
    }
    return v;
  }

  /** Вид вызова; ошибка схемы с повтором — вид повторной попытки. */
  async view(
    product: Pick<ProductCtx, 'id' | 'accountId'>,
    callId: string,
    depth = 0,
  ): Promise<AiCallView> {
    const db = this.db.forAccount(product.accountId);
    const row = await db.pubAiCall.findFirst({
      where: { id: callId, productId: product.id },
    });
    if (!row) throw new PubError('PUB_NOT_FOUND');
    if (row.status === 'schema_invalid' && depth === 0) {
      const retry = await db.pubAiCall.findFirst({
        where: {
          productId: product.id,
          opKey: derivedOpKey(row.opKey, 'schema-retry'),
        },
        select: { id: true },
      });
      if (retry) return this.view(product, retry.id, 1);
    }
    return callView(db as unknown as PubTx, row);
  }
}

type CallRow = NonNullable<
  Awaited<ReturnType<PubTx['pubAiCall']['findFirst']>>
>;

/** Вид строки вызова (+ факты контекста и находки — из журнала вызова). */
export async function callView(db: PubTx, row: CallRow): Promise<AiCallView> {
  const events = await db.pubAuditEvent.findMany({
    where: {
      productId: row.productId,
      objectType: 'ai_call',
      objectId: row.id,
    },
    select: { action: true, meta: true },
    orderBy: { occurredAt: 'asc' },
  });
  let factIds: string[] = [];
  let findings: PostCheckFinding[] = [];
  for (const e of events) {
    const meta = (e.meta ?? {}) as {
      factIds?: unknown;
      findings?: Array<{
        code: string;
        severity: 'critical' | 'warning';
        values?: unknown;
        more?: unknown;
      }>;
    };
    if (Array.isArray(meta.factIds))
      factIds = meta.factIds.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(meta.findings)) {
      findings = meta.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        text: findingText(f),
      }));
    }
  }
  return {
    callId: row.id,
    generator: row.generator as GeneratorId,
    status: row.status as AiCallStatus,
    taskId: row.taskId,
    attemptNo: row.attemptNo,
    // Пока вызов `running`, в `output` — конверт исполнения: не ответ.
    output: isPendingEnvelope(row.output) ? null : (row.output ?? null),
    findings,
    errorCode: row.errorCode,
    costStatus: row.costStatus as AiCostStatus,
    costMicroUsd:
      row.costMicroUsd === null ? null : row.costMicroUsd.toString(),
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    contextFactIds: factIds,
    contextSourceIds: Array.isArray(row.sourceIds)
      ? (row.sourceIds as string[])
      : [],
  };
}

/** Недостающее гейта из ответа старта (для деталей ошибки маршрута). */
export function missingOf(r: OpenResult): GateMissing[] {
  return r.missing ?? [];
}
