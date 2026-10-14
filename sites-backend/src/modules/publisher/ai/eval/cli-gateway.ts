/**
 * AI Publisher — шлюз прогона набора 30 задач (P-B2, проектный документ
 * §12.1, §12.6; аудит P3-12). ЕДИНСТВЕННОЕ место, где создаётся режим
 * вызова `evalRun`: его использует только CLI `ai/eval/run.ts`
 * (`npm run eval:publisher`); HTTP-контроллеры и `AiGatewayService` его не
 * получают (тест `ai-eval-fake.spec`: ни один маршрут не принимает флаг,
 * класс не зарегистрирован в модуле Nest).
 *
 * Прогон идёт через ТОТ ЖЕ код шлюза (`openCall` → `runCall`): контекст
 * `ctx@1` только из разрешённых задаче источников, строгая схема, журнал
 * `pub_ai_calls` (операция `pub-eval`). Отличия режима: продукт —
 * `kind=eval` (гейт `ai_use` у него закрыт всегда — CLI его не проверяет),
 * потолок — `--max-usd` прогона (не месяц продукта), повтора при ошибке
 * схемы нет — оценивается ПЕРВЫЙ ответ.
 *
 * Результат — `pub_ai_eval_runs/results`: первый ответ, жёсткие провалы и
 * флаги неизменны (триггер), оценку ставит человек в кабинете
 * eval-продукта. `mode=fake` не может дать `passed` (триггер + сервис).
 */
import { randomUUID } from 'crypto';
import type { SitesDb } from '../../../../prisma/sites-db.service';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../../site-ai/text-model';
import type { AiUsageRecorder } from '../../../site-ai/usage-recorder';
import type { ProductCtx } from '../../contracts/common';
import { EVAL_SET_VERSION, type EvalSetVersion } from '../../contracts/ai';
import { EVAL_SCHEMA_OF } from '../../contracts/ai-schemas';
import type {
  ProductKind,
  ProductMode,
  ProductStatus,
} from '../../contracts/states';
import { PubError } from '../../core/errors';
import { OPERATION_TX_OPTIONS } from '../../core/operation';
import type { AuditPort, GatePort, PubTx } from '../../core/ports';
import { estimateCallMicroUsd } from '../ai-budget';
import { maskContacts, maskDeep } from '../pii-mask';
import { configHashOf, currentCallParams, currentConfigSpec } from '../config';
import {
  type AttemptOutcome,
  maskKeep,
  openCall,
  runCall,
  type AiTextModel,
  type CallMode,
  type RunDeps,
} from '../gateway-core';
import { GENERATORS } from '../generators';
import { autoCheck } from './auto-checks';
import { FAKE_ANSWERS } from './fake-answers';
import {
  EVAL_FIXTURES,
  EVAL_FIXTURE_SET_HASH,
  fixtureMismatches,
  fixtureRef,
  type FixtureCode,
} from './fixtures';
import {
  protocolOf,
  totalsOf,
  type Protocol,
  type ResultRow,
  type RunInfo,
} from './protocol';
import { evalTasksOf, type EvalTask } from './tasks';

export const EVAL_ACTOR = 'system:eval';
export const FAKE_PROVIDER = 'fake';
export const FAKE_MODEL = 'fake-eval-2.2';

/** Модель режима `fake`: заготовленный ответ задачи (CI, без сети). */
export class FakeEvalModel implements AiTextModel {
  next: string | null = null;
  /** Промпты прогона (проверка контекста в тестах механики). */
  requests: GenerateRequest[] = [];
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = this.next ?? '{}';
    this.next = null;
    return {
      text,
      model: req.model ?? FAKE_MODEL,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      cachedInputTokens: 0,
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}

export interface EvalRunOptions {
  /** Только эти задачи (`AI-01,AI-05`). */
  only?: string[];
  /** Потолок затрат прогона, USD (live — обязателен в CLI). */
  maxUsd?: number;
  /**
   * Модель без ставки в прайсе (live): без явного разрешения прогон
   * отказывает (аудит S2-4); с разрешением — потолок считает оценку по
   * наибольшим ставкам прайса.
   */
  allowUnpriced?: boolean;
  /** Дописать повторы в существующий прогон (новые строки со ссылкой). */
  runId?: string;
  /** Подмена заготовленного ответа задачи (тесты механики). */
  fakeAnswer?: (
    task: EvalTask,
    ids: Record<FixtureCode, string>,
  ) => string | null;
}

const denyGates: GatePort = {
  evaluate: () => {
    throw new Error('CliEvalGateway: гейт не применяется к прогону набора');
  },
  assertOpen: () => {
    throw new Error('CliEvalGateway: гейт не применяется к прогону набора');
  },
};

/**
 * Жёсткий провал попытки без текста ответа (предаудит D2-01): расход есть
 * (`truncated`/`empty` — модель ответила, ответ обрезан или пуст) —
 * `answer_<статус>`, это ответ; расхода нет (`timeout`/`unavailable` без
 * отчёта провайдера) — `no_answer:<статус>`, ответом не считается.
 */
export function noAnswerOf(o: Pick<AttemptOutcome, 'status' | 'spent'>): {
  code: string;
  text: string;
} {
  return o.spent
    ? {
        code: `answer_${o.status}`,
        text: 'Відповідь обрізана або порожня (модель відповіла, витрати є)',
      }
    : {
        code: `no_answer:${o.status}`,
        text: 'Модель не відповіла: провайдер не повернув відповіді, витрат немає',
      };
}

export class CliEvalGateway {
  constructor(
    private readonly db: SitesDb,
    private readonly deps: {
      usage: AiUsageRecorder;
      audit: AuditPort;
      model: AiTextModel;
      provider: string;
      modelName: string;
      fake: boolean;
      /** Версия набора (Р-RD-64): `2.2` — P0 (умолчание), `2.3` — с Reddit. */
      evalSet?: EvalSetVersion;
    },
  ) {}

  private get set(): EvalSetVersion {
    return this.deps.evalSet ?? EVAL_SET_VERSION;
  }

  private tx<T>(accountId: string, fn: (tx: PubTx) => Promise<T>): Promise<T> {
    return this.db
      .forAccount(accountId)
      .$transaction((tx) => fn(tx as PubTx), OPERATION_TX_OPTIONS);
  }

  /** Продукт прогона: только `kind=eval` (синтетика — только там, §12.6). */
  async evalProduct(productId: string): Promise<ProductCtx> {
    const p = await this.db
      .system('eval:publisher — продукт прогона по id из аргумента CLI')
      .pubProduct.findFirst({
        where: { id: productId },
        select: {
          id: true,
          accountId: true,
          siteId: true,
          kind: true,
          mode: true,
          status: true,
          revision: true,
        },
      });
    if (!p) throw new PubError('PUB_NOT_FOUND', { productId });
    if (p.kind !== 'eval') {
      throw new PubError('PUB_VALIDATION', {
        fields: [{ field: 'product', code: 'not_eval_product' }],
      });
    }
    return {
      id: p.id,
      accountId: p.accountId,
      siteId: p.siteId,
      kind: p.kind as ProductKind,
      mode: p.mode as ProductMode,
      status: p.status as ProductStatus,
      revision: p.revision,
    };
  }

  /** Конфигурация текущего кода (создаётся `not_run`, если её нет). */
  async ensureConfig(
    product: ProductCtx,
  ): Promise<{ id: string; configHash: string }> {
    const spec = currentConfigSpec(
      this.deps.provider,
      this.deps.modelName,
      this.set,
    );
    const configHash = configHashOf(spec);
    return this.tx(product.accountId, async (tx) => {
      const found = await tx.pubAiConfig.findFirst({
        where: { productId: product.id, configHash },
        select: { id: true },
      });
      if (found) return { id: found.id, configHash };
      const row = await tx.pubAiConfig.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          provider: spec.provider,
          model: spec.model,
          contextRulesVersion: spec.contextRulesVersion,
          schemaSetVersion: spec.schemaSetVersion,
          instructionVersions: spec.instructionVersions,
          configHash,
          coveredGenerators: spec.coveredGenerators,
          evalSetVersion: spec.evalSetVersion,
          createdBy: EVAL_ACTOR,
        },
        select: { id: true },
      });
      await this.deps.audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: EVAL_ACTOR,
        objectType: 'ai_config',
        objectId: row.id,
        action: 'create',
        toStatus: 'not_run',
        meta: { configHash, model: spec.model },
      });
      return { id: row.id, configHash };
    });
  }

  /** id синтетических источников продукта по кодам (сеет `testing/synthetic-seed`). */
  async fixtureIds(product: ProductCtx): Promise<Record<FixtureCode, string>> {
    const rows = await this.db
      .forAccount(product.accountId)
      .pubSource.findMany({
        where: {
          productId: product.id,
          isSynthetic: true,
          externalRef: { in: EVAL_FIXTURES.map((f) => fixtureRef(f.code)) },
        },
        select: {
          id: true,
          externalRef: true,
          title: true,
          fragment: true,
          contentHash: true,
          usage: true,
          visibility: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    // Аудит S3-10: строки S1–S7 — эталонные (текст, доступ, без замены).
    const successors = await this.db
      .forAccount(product.accountId)
      .pubSource.findMany({
        where: {
          productId: product.id,
          supersedesId: { in: rows.map((r) => r.id) },
        },
        select: { supersedesId: true },
      });
    const replaced = new Set(successors.map((x) => x.supersedesId));
    const bad = fixtureMismatches(
      rows.map((r) => ({ ...r, supersededBy: replaced.has(r.id) })),
    );
    if (bad.length) {
      throw new Error(
        `Синтетика ${bad.join(', ')} расходится с эталоном набора 2.2 — прогон невозможен`,
      );
    }
    const out: Partial<Record<FixtureCode, string>> = {};
    for (const f of EVAL_FIXTURES) {
      const r = rows.find((x) => x.externalRef === fixtureRef(f.code));
      if (r) out[f.code] = r.id;
    }
    const missing = EVAL_FIXTURES.filter((f) => !out[f.code]).map(
      (f) => f.code,
    );
    if (missing.length) {
      throw new Error(
        `В eval-продукте нет синтетики ${missing.join(', ')} — запустите с --seed`,
      );
    }
    return out as Record<FixtureCode, string>;
  }

  /** Прогон (или повторы в существующий прогон). */
  async run(
    product: ProductCtx,
    mode: 'fake' | 'live',
    opts: EvalRunOptions = {},
  ): Promise<Protocol> {
    if ((mode === 'fake') !== this.deps.fake) {
      throw new Error('CliEvalGateway: режим прогона не совпадает с моделью');
    }
    const ids = await this.fixtureIds(product);
    const config = await this.ensureConfig(product);
    const setTasks = evalTasksOf(this.set);
    const tasks = setTasks.filter(
      (t) => !opts.only?.length || opts.only.includes(t.code),
    );
    if (opts.only?.some((c) => !setTasks.some((t) => t.code === c))) {
      throw new Error(`Неизвестная задача в --only: ${opts.only.join(',')}`);
    }
    const runId = opts.runId
      ? await this.existingRun(product, opts.runId, config.id, mode)
      : await this.tx(product.accountId, async (tx) => {
          const r = await tx.pubAiEvalRun.create({
            data: {
              accountId: product.accountId,
              productId: product.id,
              configId: config.id,
              mode,
              createdBy: EVAL_ACTOR,
            },
            select: { id: true },
          });
          await this.deps.audit.write(tx, {
            accountId: product.accountId,
            productId: product.id,
            actor: EVAL_ACTOR,
            objectType: 'ai_eval_run',
            objectId: r.id,
            action: 'create',
            meta: { mode, configId: config.id, taskCount: tasks.length },
          });
          return r.id;
        });
    const callMode: CallMode = {
      kind: 'eval',
      evalRun: true,
      configId: config.id,
      provider: this.deps.provider,
      model: this.deps.modelName,
      fake: this.deps.fake,
    };
    const runDeps: RunDeps = {
      model: this.deps.model,
      usage: this.deps.usage,
      usageDb: (accountId) => this.db.forAccount(accountId),
      transaction: (accountId, fn) => this.tx(accountId, fn),
      audit: this.deps.audit,
    };
    const capMicro =
      opts.maxUsd === undefined
        ? null
        : BigInt(Math.floor(opts.maxUsd * 1_000_000));
    if (
      !this.deps.fake &&
      !opts.allowUnpriced &&
      tasks.some(
        (t) =>
          !estimateCallMicroUsd(
            this.deps.modelName,
            GENERATORS[t.generator].maxOutputTokens,
          ).priced,
      )
    ) {
      // Аудит S2-4: неизвестная ставка — не ноль; без разрешения не тратим.
      throw new Error(
        `Модель ${this.deps.modelName} без ставки в прайсе — потолок --max-usd не проверить; --allow-unpriced считает по наибольшим ставкам`,
      );
    }
    // Потрачено: факт, а где он неизвестен (`unknown`/`unpriced`) — оценка
    // сверху (аудит S2-4: неизвестное не ноль).
    let spent = 0n;
    for (const task of tasks) {
      const spec = GENERATORS[task.generator];
      if (EVAL_SCHEMA_OF[task.generator] !== task.schema) {
        throw new Error(
          `${task.code}: схема ${task.schema} ≠ генератор ${task.generator}`,
        );
      }
      if (capMicro !== null && !this.deps.fake) {
        const est = estimateCallMicroUsd(
          this.deps.modelName,
          spec.maxOutputTokens,
        ).estMicroUsd;
        if (spent + est > capMicro) break; // остальные задачи — «не запускалась»
      }
      const prior = opts.runId
        ? await this.db.forAccount(product.accountId).pubAiEvalResult.findMany({
            where: { runId, taskCode: task.code },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
        : [];
      const input = this.inputOf(task, ids);
      if (this.deps.model instanceof FakeEvalModel) {
        const custom = opts.fakeAnswer?.(task, ids);
        this.deps.model.next =
          custom !== undefined && custom !== null
            ? custom
            : JSON.stringify(FAKE_ANSWERS[task.code](ids));
      }
      const allowedSourceIds = task.allowedSources.map((c) => ids[c]);
      const opened = await this.tx(product.accountId, (tx) =>
        openCall(
          tx,
          {
            product,
            actor: EVAL_ACTOR,
            spec,
            opKey: randomUUID(),
            objectType: 'ai_eval_run',
            objectId: `${runId}:${task.code}${prior.length ? `:r${prior.length}` : ''}`,
            input: input.generatorInput,
            context: { audience: task.mode, sourceIds: allowedSourceIds },
            mode: callMode,
            now: new Date(),
          },
          { gates: denyGates, audit: this.deps.audit },
        ),
      );
      let parsed: unknown = undefined;
      let raw: string | null = null;
      let costStatus = 'unknown';
      let costMicroUsd: bigint | null = null;
      let first: AttemptOutcome | null = null;
      if (opened.plan) {
        const r = await runCall(opened.plan, runDeps);
        first = r.first;
        parsed = r.first.parsed;
        raw = r.first.rawText;
        costStatus = r.first.costStatus;
        costMicroUsd = r.first.costMicroUsd;
        spent +=
          costMicroUsd !== null
            ? costMicroUsd
            : this.deps.fake
              ? 0n
              : opened.plan.est;
      }
      const keep = {
        keep: maskKeep(input.generatorInput, opened.plan?.ctx ?? null),
      };
      const checks = autoCheck(task, parsed, raw, ids);
      if (!opened.plan) {
        checks.hardFails.push({
          code: `not_run:${opened.status}`,
          text: 'Модель не викликалась',
        });
      } else if (first && first.rawText === null) {
        // Предаудит D2-01: «модель не ответила» — только когда провайдер не
        // вернул ответа и расхода нет. Обрезанный/пустой ответ (в т. ч.
        // фильтр безопасности) оплачен — это ПЕРВЫЙ ответ и провал.
        checks.hardFails.push(noAnswerOf(first));
      }
      await this.tx(product.accountId, async (tx) => {
        const row = await tx.pubAiEvalResult.create({
          data: {
            accountId: product.accountId,
            productId: product.id,
            runId,
            taskCode: task.code,
            schema: task.schema,
            input: { ...input.record, aiCallId: opened.callId },
            allowedSourceIds,
            // Аудит S1-3: в протокол — с маской контактов (проверки — по сырому).
            firstAnswer:
              parsed === undefined
                ? undefined
                : (maskDeep(parsed, keep).value as object),
            firstAnswerRaw:
              raw === null
                ? null
                : maskContacts(raw.slice(0, 100_000), keep).text.slice(
                    0,
                    100_000,
                  ),
            claimSources: checks.claimSources,
            autoHardFail: checks.hardFails as unknown as object,
            autoFlags: checks.flags as unknown as object,
            flagResolutions: [],
            costStatus:
              costStatus === 'priced' && costMicroUsd !== null
                ? 'priced'
                : costStatus === 'unpriced'
                  ? 'unpriced'
                  : 'unknown',
            costMicroUsd: costStatus === 'priced' ? costMicroUsd : null,
            retryOfResultId: prior[0]?.id ?? null,
            createdBy: EVAL_ACTOR,
          },
          select: { id: true },
        });
        await this.deps.audit.write(tx, {
          accountId: product.accountId,
          productId: product.id,
          actor: EVAL_ACTOR,
          objectType: 'ai_eval_result',
          objectId: row.id,
          action: 'create',
          meta: {
            taskCode: task.code,
            hardFails: checks.hardFails.map((h) => h.code),
            flags: checks.flags.map((f) => f.code),
          },
        });
      });
    }
    return this.finish(product, runId);
  }

  private async existingRun(
    product: ProductCtx,
    runId: string,
    configId: string,
    mode: 'fake' | 'live',
  ): Promise<string> {
    const r = await this.db
      .forAccount(product.accountId)
      .pubAiEvalRun.findFirst({
        where: { id: runId, productId: product.id },
        select: { id: true, configId: true, mode: true },
      });
    if (!r) throw new PubError('PUB_NOT_FOUND', { runId });
    if (r.configId !== configId || r.mode !== mode) {
      throw new Error('Повтор — только в прогон той же конфигурации и режима');
    }
    return r.id;
  }

  private inputOf(
    task: EvalTask,
    ids: Readonly<Record<FixtureCode, string>>,
  ): {
    generatorInput: unknown;
    record: Record<string, unknown>;
  } {
    const record = {
      prompt: task.input.prompt,
      mode: task.mode,
      language: task.language,
      generator: task.generator,
      allowedSources: task.allowedSources,
      ...(task.input.format ? { format: task.input.format } : {}),
      ...(task.input.parentVersion
        ? { parentVersion: task.input.parentVersion }
        : {}),
    };
    switch (task.schema) {
      case 'answer':
        return {
          generatorInput: { question: task.input.prompt, audience: task.mode },
          record,
        };
      case 'brief':
        return {
          generatorInput: { question: task.input.prompt, notes: null },
          record,
        };
      case 'qa':
        return {
          generatorInput: {
            versionLabel: 'S3',
            title: null,
            body: task.input.prompt,
          },
          record,
        };
      case 'adaptation':
        return {
          generatorInput: {
            parentVersion: task.input.parentVersion,
            format: task.input.format,
            request: task.input.prompt,
            parentTitle: null,
            parentBody: null,
          },
          record,
        };
      case 'reddit': {
        // P-R M2 (AI-31…AI-42): источники тезисов — id фикстур продукта.
        const r = task.input.reddit!;
        return {
          generatorInput: {
            ...r,
            brief: {
              ...r.brief,
              keyPoints: r.brief.keyPoints.map((k) => ({
                text: k.text,
                sourceIds:
                  k.sources === 'needs_verification'
                    ? k.sources
                    : k.sources.map((c) => ids[c]),
              })),
            },
            rewrite: null,
          },
          record: { ...record, reddit: r },
        };
      }
    }
  }

  /** Итог прогона: время окончания, сводка, протокол. */
  async finish(product: ProductCtx, runId: string): Promise<Protocol> {
    const p = await this.protocol(product, runId);
    await this.tx(product.accountId, async (tx) => {
      await tx.pubAiEvalRun.updateMany({
        where: { id: runId },
        data: {
          finishedAt: new Date(),
          totals: {
            ...p.totals,
            fixtureSetHash: EVAL_FIXTURE_SET_HASH,
            callParams: currentCallParams(this.set),
          } as unknown as object,
        },
      });
    });
    return {
      ...p,
      totals: {
        ...p.totals,
        fixtureSetHash: EVAL_FIXTURE_SET_HASH,
        callParams: currentCallParams(this.set),
      },
      run: { ...p.run, finishedAt: new Date().toISOString() },
    };
  }

  async protocol(product: ProductCtx, runId: string): Promise<Protocol> {
    return loadProtocol(
      this.db.forAccount(product.accountId) as unknown as PubTx,
      product.id,
      runId,
    );
  }
}

/** Протокол прогона из базы (CLI и маршрут кабинета eval-продукта). */
export async function loadProtocol(
  db: PubTx,
  productId: string,
  runId: string,
): Promise<Protocol> {
  const run = await db.pubAiEvalRun.findFirst({
    where: { id: runId, productId },
    include: { config: true },
  });
  if (!run) throw new PubError('PUB_NOT_FOUND');
  const rows = await db.pubAiEvalResult.findMany({
    where: { runId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const info: RunInfo = {
    id: run.id,
    mode: run.mode as 'fake' | 'live',
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    config: {
      id: run.config.id,
      provider: run.config.provider,
      model: run.config.model,
      configHash: run.config.configHash,
      instructionVersions: (run.config.instructionVersions ?? {}) as Record<
        string,
        string
      >,
      contextRulesVersion: run.config.contextRulesVersion,
      schemaSetVersion: run.config.schemaSetVersion,
      evalSetVersion: run.config.evalSetVersion,
      evalStatus: run.config.evalStatus,
    },
  };
  const p = protocolOf(info, rows.map(resultRowOf));
  const recorded = (run.totals ?? null) as {
    fixtureSetHash?: unknown;
    callParams?: unknown;
  } | null;
  if (typeof recorded?.fixtureSetHash === 'string') {
    p.totals.fixtureSetHash = recorded.fixtureSetHash;
  }
  if (recorded?.callParams && typeof recorded.callParams === 'object') {
    p.totals.callParams =
      recorded.callParams as Protocol['totals']['callParams'];
  }
  return p;
}

type DbResult = Awaited<
  ReturnType<PubTx['pubAiEvalResult']['findMany']>
>[number];

export function resultRowOf(r: DbResult): ResultRow {
  return {
    id: r.id,
    taskCode: r.taskCode,
    schema: r.schema,
    input: r.input,
    allowedSourceIds: (r.allowedSourceIds ?? []) as string[],
    firstAnswer: r.firstAnswer,
    firstAnswerRaw: r.firstAnswerRaw,
    claimSources: r.claimSources,
    autoHardFail: (r.autoHardFail ?? []) as ResultRow['autoHardFail'],
    autoFlags: (r.autoFlags ?? []) as ResultRow['autoFlags'],
    flagResolutions: (r.flagResolutions ??
      []) as unknown as ResultRow['flagResolutions'],
    criticalPass: r.criticalPass,
    usefulnessPass: r.usefulnessPass,
    explanation: r.explanation,
    reviewerMemberId: r.reviewerMemberId,
    secondReviewerMemberId: r.secondReviewerMemberId,
    costMicroUsd: r.costMicroUsd === null ? null : r.costMicroUsd.toString(),
    costStatus: r.costStatus,
    retryOfResultId: r.retryOfResultId,
    createdAt: r.createdAt.toISOString(),
  };
}

export { totalsOf };
