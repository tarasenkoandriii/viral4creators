/**
 * AI Publisher — маршруты AI кабинета (P-B2, проектный документ §11.3,
 * строки «AI»; контракт `contracts/ai-api.ts`).
 *
 * Старт AI-операции — асинхронно (§11.1, аудит P2-11): шлюз создаёт или
 * находит вызов по `opKey` короткой транзакцией, модель идёт вне
 * транзакции; маршрут ждёт готовности не дольше 25 с, иначе 202 и экран
 * опрашивает `GET …/ai/calls/:callId`. Блокирующие и неуспешные итоги —
 * коды §11.2 с `details.callId`. Предметные проверки входа (вопрос,
 * версия, согласованная версия статьи) — чтением таблиц P-B1 (§16.0
 * «чтение чужих таблиц разрешено»), записи в них нет.
 *
 * Флага прогона набора (`evalRun`) у маршрутов нет и быть не может:
 * шлюз здесь — только режим кабинета (тест `ai-eval-fake.spec`).
 */
import { Body, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import { GENERATOR_IDS, type GeneratorId } from '../contracts/ai';
import type {
  AiCallListItem,
  AiStartResponse,
  AiTaskView,
} from '../contracts/ai-api';
import { OP_KEY_RE, type ProductCtx } from '../contracts/common';
import type { AiCallStatus, AiCostStatus } from '../contracts/states';
import { canonicalJson, sha256Hex } from '../core/content-hash';
import {
  PUB_NO_STORE,
  PubError,
  assertNoIssues,
  validationError,
} from '../core/errors';
import { PubOperations } from '../core/operation';
import { piiIssues } from '../core/pii-guard';
import type { PubTx } from '../core/ports';
import { actorsOf } from '../core/product.controller';
import { can } from '../core/roles';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { AiGatewayService, type CabinetStart } from './ai-gateway.service';
import { AiTasksService } from './ai-tasks.service';
import { AiConfigsService } from './configs.service';
import { sendCsv, sendEnvelope } from '../content/http';
import { usableSourceIds, type ContextRequest } from './context';
import { EvalReviewService } from './eval/eval-review.service';
import { protocolMarkdown } from './eval/protocol';
import { aiBudgetReasonOf, errorCodeOfStatus } from './gateway-core';

type Body = Record<string, unknown>;

const ADAPTATION_FORMATS = [
  'post',
  'cards',
  'checklist',
  'video_script',
] as const;
const MAX_TEXT = 2000;

function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

function product(ctx: PubRequestCtx): ProductCtx {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

function opKeyOf(body: Body): string {
  if (typeof body.opKey !== 'string' || !OP_KEY_RE.test(body.opKey)) {
    throw validationError([
      {
        field: 'opKey',
        code: body.opKey === undefined ? 'required' : 'format',
      },
    ]);
  }
  return body.opKey;
}

/** Свободный текст запроса: длина и «не контакт» (в модель ПД не уходят). */
function textOf(
  body: Body,
  field: string,
  required: boolean,
  max = MAX_TEXT,
): string | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw validationError([{ field, code: 'required' }]);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length === 0 || [...v].length > max) {
    throw validationError([
      { field, code: typeof v === 'string' ? 'length' : 'type' },
    ]);
  }
  assertNoIssues(piiIssues({ [field]: v }));
  return v.trim();
}

function idListOf(body: Body, field: string): string[] | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.length > 60 ||
    v.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x))
  ) {
    throw validationError([{ field, code: 'format' }]);
  }
  return v as string[];
}

const hash16 = (v: unknown): string => sha256Hex(canonicalJson(v)).slice(0, 16);

/**
 * Вопрос помощника для ключа задачи (аудит S3-4): лимит двух генераций —
 * на вопрос, а не на его написание. NFKC, нижний регистр, без знаков
 * препинания, пробелы схлопнуты: «Скільки коштує?» и «скільки  коштує» —
 * одна задача.
 */
export function normalizedQuestion(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Сколько строк журнала вызовов отдаёт CSV за раз (все строки — курсором). */
export const CALLS_CSV_LIMIT = 5000;

/** CSV без формул (аудит P3-27). */
export function csvOf(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): string {
  const esc = (v: unknown): string => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => esc(r[c])).join(',')),
  ].join('\n');
}

@PubCabinetController()
export class PublisherAiController {
  constructor(
    private readonly db: SitesDb,
    private readonly gateway: AiGatewayService,
    private readonly ops: PubOperations,
    private readonly tasks: AiTasksService,
    private readonly configs: AiConfigsService,
    private readonly evalReview: EvalReviewService,
  ) {}

  private tenant(p: ProductCtx): PubTx {
    return this.db.forAccount(p.accountId) as unknown as PubTx;
  }

  /**
   * Старт + синхронный путь ≤ 25 с (аудит S2-1): модель исполняется в этом
   * запросе; окно вышло — 202, вызов исполнит задание очереди
   * `ai-calls-run`, экран опрашивает `GET …/ai/calls/:callId`. Повтор
   * `opKey` при `running` — 202 сразу (исполняет первый запрос/очередь).
   * Блокирующие/неуспешные итоги — коды §11.2.
   */
  private async start(
    ctx: PubRequestCtx,
    res: Response,
    s: Omit<CabinetStart, 'product' | 'memberId'>,
  ): Promise<AiStartResponse> {
    const p = product(ctx);
    const opened = await this.gateway.startSync({
      ...s,
      product: p,
      memberId: ctx.m.memberId,
    });
    const view = await this.gateway.view(p, opened.callId);
    const missing = opened.missing ?? [];
    const code = errorCodeOfStatus(view.status, missing);
    if (code) {
      throw new PubError(code, {
        callId: view.callId,
        status: view.status,
        taskId: view.taskId,
        generator: view.generator,
        ...(code === 'PUB_GATE_CLOSED' ? { gate: 'ai_use' } : {}),
        ...(code === 'PUB_AI_BUDGET'
          ? { reason: aiBudgetReasonOf(view.errorCode) }
          : {}),
        ...(missing.length ? { missing } : {}),
      });
    }
    if (view.status === 'running') {
      res.status(202);
      return { callId: view.callId, status: view.status, call: null };
    }
    res.status(200);
    return { callId: view.callId, status: view.status, call: view };
  }

  // ── AI-операции ─────────────────────────────────────────────────────────

  @Post('products/:pid/helper/answer')
  @PubAllow('ai.helper')
  async helperAnswer(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    const question = textOf(body, 'question', true)!;
    const audience = body.audience ?? 'internal';
    if (audience !== 'internal' && audience !== 'public') {
      throw validationError([{ field: 'audience', code: 'enum' }]);
    }
    const sourceIds = idListOf(body, 'sourceIds');
    const context: ContextRequest = { audience, sourceIds, allowAll: true };
    return this.start(ctx, res, {
      generator: 'pub.helper.answer',
      opKey,
      objectType: 'product',
      objectId: `helper:${hash16({ q: normalizedQuestion(question), audience })}`,
      input: { question, audience },
      context,
    });
  }

  @Post('products/:pid/briefs/draft')
  @PubAllow('ai.generate')
  async briefDraft(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    const p = product(ctx);
    if (typeof body.questionId !== 'string') {
      throw validationError([{ field: 'questionId', code: 'required' }]);
    }
    const notes = textOf(body, 'notes', false);
    const db = this.tenant(p);
    const q = await db.pubQuestion.findFirst({
      where: { id: body.questionId, productId: p.id },
      select: { id: true, text: true },
    });
    if (!q)
      throw new PubError('PUB_NOT_FOUND', { questionId: body.questionId });
    let sourceIds = idListOf(body, 'sourceIds');
    if (sourceIds === undefined) {
      const links = await db.pubQuestionSource.findMany({
        where: { questionId: q.id },
        select: { sourceId: true },
      });
      sourceIds = await this.usableOnly(
        db,
        p.id,
        links.map((l) => l.sourceId),
      );
    }
    if (sourceIds.length === 0) {
      // Бриф без разрешённого источника готовым не станет (F03, AT-F03-02).
      throw validationError([{ field: 'sourceIds', code: 'required' }]);
    }
    return this.start(ctx, res, {
      generator: 'pub.brief.draft',
      opKey,
      objectType: 'question',
      objectId: q.id,
      input: { question: q.text, notes },
      context: { audience: 'internal', sourceIds },
    });
  }

  @Post('products/:pid/versions/:vid/qa-checks/ai-review')
  @PubAllow('ai.generate')
  async qaReview(
    @PubRequest() ctx: PubRequestCtx,
    @Param('vid') vid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    const p = product(ctx);
    const db = this.tenant(p);
    const v = await db.pubContentVersion.findFirst({
      where: { id: vid, productId: p.id },
      select: { id: true, number: true, title: true, body: true },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    const links = await db.pubVersionSource.findMany({
      where: { versionId: v.id },
      select: { sourceId: true },
    });
    const sourceIds = await this.usableOnly(
      db,
      p.id,
      links.map((l) => l.sourceId),
    );
    return this.start(ctx, res, {
      generator: 'pub.qa.review',
      opKey,
      objectType: 'content_version',
      objectId: v.id,
      input: { versionLabel: `v${v.number}`, title: v.title, body: v.body },
      context: { audience: 'internal', sourceIds },
    });
  }

  @Post('products/:pid/contents/:cid/adaptations/draft')
  @PubAllow('ai.generate')
  async adaptationDraft(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    const p = product(ctx);
    const format = body.format;
    if (!(ADAPTATION_FORMATS as readonly unknown[]).includes(format)) {
      throw validationError([{ field: 'format', code: 'enum' }]);
    }
    const request = textOf(body, 'request', false);
    const db = this.tenant(p);
    const content = await db.pubContent.findFirst({
      where: { id: cid, productId: p.id },
      select: { id: true, kind: true, slug: true, approvedVersionId: true },
    });
    if (!content) throw new PubError('PUB_NOT_FOUND');
    if (content.kind !== 'article') {
      throw validationError([{ field: 'cid', code: 'not_article' }]);
    }
    if (!content.approvedVersionId) {
      // Адаптация — от согласованной версии статьи (§7.1, F06).
      throw new PubError('PUB_APPROVAL_REQUIRED', { contentId: content.id });
    }
    const parent = await db.pubContentVersion.findFirst({
      where: { id: content.approvedVersionId, productId: p.id },
      select: { id: true, number: true, title: true, body: true },
    });
    if (!parent)
      throw new PubError('PUB_APPROVAL_REQUIRED', { contentId: content.id });
    let sourceIds = idListOf(body, 'sourceIds');
    if (sourceIds === undefined) {
      const links = await db.pubVersionSource.findMany({
        where: { versionId: parent.id },
        select: { sourceId: true },
      });
      sourceIds = await this.usableOnly(
        db,
        p.id,
        links.map((l) => l.sourceId),
      );
    }
    return this.start(ctx, res, {
      generator: 'pub.adaptation.make',
      opKey,
      objectType: 'content',
      objectId: `${content.id}:${format as string}`,
      input: {
        parentVersion: `${content.slug ?? content.id}@v${parent.number}`,
        format,
        request:
          request ?? `Адаптуй погоджену версію у формат ${format as string}.`,
        parentTitle: parent.title,
        parentBody: parent.body,
      },
      context: { audience: 'internal', sourceIds },
    });
  }

  /** Выключенные в P0 генераторы (ДТ-2, Р-PUB-31): запись `disabled`, 409. */
  @Post('products/:pid/questions/cluster')
  @PubAllow('ai.generate')
  async questionsCluster(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    const questionIds = idListOf(body, 'questionIds');
    if (!questionIds?.length)
      throw validationError([{ field: 'questionIds', code: 'required' }]);
    return this.start(ctx, res, {
      generator: 'pub.questions.cluster',
      opKey,
      objectType: 'product',
      objectId: `cluster:${hash16([...questionIds].sort())}`,
      input: { questionIds },
      context: { audience: 'internal', sourceIds: [] },
    });
  }

  @Post('products/:pid/contents/:cid/versions/draft')
  @PubAllow('ai.generate')
  async draftWrite(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    // Р-PUB-Z2-17 (z-isolation): материал — этого продукта, иначе 404 без
    // записи задачи/вызова (как у адаптации).
    const p = product(ctx);
    const content = await this.tenant(p).pubContent.findFirst({
      where: { id: cid, productId: p.id },
      select: { id: true },
    });
    if (!content) throw new PubError('PUB_NOT_FOUND');
    return this.start(ctx, res, {
      generator: 'pub.draft.write',
      opKey: opKeyOf(body),
      objectType: 'content',
      objectId: cid.slice(0, 100),
      input: { contentId: cid },
      context: { audience: 'internal', sourceIds: [] },
    });
  }

  @Post('products/:pid/claims/extract')
  @PubAllow('ai.generate')
  async claimsExtract(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const opKey = opKeyOf(body);
    if (
      typeof body.versionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(body.versionId)
    ) {
      throw validationError([{ field: 'versionId', code: 'required' }]);
    }
    // Р-PUB-Z2-17: версия — этого продукта, иначе 404 без записи вызова.
    const pc = product(ctx);
    const version = await this.tenant(pc).pubContentVersion.findFirst({
      where: { id: body.versionId, productId: pc.id },
      select: { id: true },
    });
    if (!version) throw new PubError('PUB_NOT_FOUND');
    return this.start(ctx, res, {
      generator: 'pub.claims.extract',
      opKey,
      objectType: 'content_version',
      objectId: body.versionId,
      input: { versionId: body.versionId },
      context: { audience: 'internal', sourceIds: [] },
    });
  }

  /**
   * Явный список проверяет шлюз (недопустимый — 422), а производный (связи
   * вопроса/версии) фильтруется по правилам P-B1 (аудит S1-2): только
   * ПОСЛЕДНЯЯ редакция цепочки `supersedesId`, `allowed`, без отзыва в
   * цепочке; связь со старой редакцией не тянет её в контекст.
   */
  private async usableOnly(
    db: PubTx,
    productId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const r = await usableSourceIds(db, productId, 'internal', [
      ...new Set(ids),
    ]);
    return r.ok.slice(0, 60);
  }

  // ── Журнал вызовов и задачи ─────────────────────────────────────────────

  /**
   * Журнал вызовов. JSON — конверт `{success, data}` со страницей; CSV
   * (аудит S2-2) — сырой файл `text/csv` с `Content-Disposition`, до
   * `CALLS_CSV_LIMIT` строк за запрос; если строк больше, заголовок
   * `X-Next-Before` даёт курсор следующей части (`?before=`).
   */
  @Get('products/:pid/ai/calls')
  @PubAllow('ai.generate', 'ai.helper')
  async listCalls(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const p = product(ctx);
    const db = this.tenant(p);
    if (q.format !== undefined && q.format !== 'json' && q.format !== 'csv') {
      throw validationError([{ field: 'format', code: 'enum' }]);
    }
    const csv = q.format === 'csv';
    const limit = csv
      ? CALLS_CSV_LIMIT
      : Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 100);
    if (
      q.generator &&
      !(GENERATOR_IDS as readonly string[]).includes(q.generator)
    ) {
      throw validationError([{ field: 'generator', code: 'enum' }]);
    }
    let cursor: { requestedAt: Date; id: string } | null = null;
    if (q.before) {
      cursor = await db.pubAiCall.findFirst({
        where: { id: q.before, productId: p.id },
        select: { id: true, requestedAt: true },
      });
    }
    const taskIds = q.objectId
      ? (
          await db.pubAiTask.findMany({
            where: { productId: p.id, objectId: q.objectId },
            select: { id: true },
          })
        ).map((t) => t.id)
      : null;
    const rows = await db.pubAiCall.findMany({
      where: {
        productId: p.id,
        ...(q.generator ? { generator: q.generator } : {}),
        ...(taskIds ? { taskId: { in: taskIds } } : {}),
        ...(cursor
          ? {
              OR: [
                { requestedAt: { lt: cursor.requestedAt } },
                { requestedAt: cursor.requestedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const items: AiCallListItem[] = page.map((r) => ({
      callId: r.id,
      generator: r.generator as GeneratorId,
      status: r.status as AiCallStatus,
      taskId: r.taskId,
      attemptNo: r.attemptNo,
      objectRef: r.purpose.split('#')[0],
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      costStatus: r.costStatus as AiCostStatus,
      costMicroUsd: r.costMicroUsd === null ? null : r.costMicroUsd.toString(),
      model: r.model,
      instructionVersion: r.instructionVersion,
      errorCode: r.errorCode,
    }));
    const nextBefore = rows.length > limit ? page[page.length - 1].id : null;
    if (csv) {
      // Предаудит D1-03: аудит экспорта — по действию, которое участнику
      // разрешено (оператор — `ai.helper`), а не по первому в списке.
      const action =
        ctx.actions.find((x) => can(ctx.access, x)) ?? ctx.actions[0];
      await this.ops.recordRead(ctx.m, ctx.access, p, action, {
        objectType: 'ai_call',
        objectId: p.id,
        action: 'export',
        meta: { rows: items.length },
      });
      if (nextBefore) res.setHeader('X-Next-Before', nextBefore);
      const text = csvOf(items as unknown as Array<Record<string, unknown>>, [
        'callId',
        'generator',
        'status',
        'attemptNo',
        'objectRef',
        'requestedAt',
        'finishedAt',
        'costStatus',
        'costMicroUsd',
        'model',
        'instructionVersion',
        'errorCode',
      ]);
      sendCsv(res, 'ai-calls', text);
      return;
    }
    sendEnvelope(res, { items, nextBefore });
  }

  @Get('products/:pid/ai/calls/:callId')
  @PubAllow('ai.generate', 'ai.helper')
  async getCall(
    @PubRequest() ctx: PubRequestCtx,
    @Param('callId') callId: string,
  ) {
    return this.gateway.view(product(ctx), callId);
  }

  @Get('products/:pid/ai/tasks/:id')
  @PubAllow('ai.generate', 'ai.helper')
  async getTask(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
  ): Promise<AiTaskView> {
    const p = product(ctx);
    return this.tasks.get(this.tenant(p), p.id, id);
  }

  @Post('products/:pid/ai/tasks/:id/extra')
  @PubAllow('ai.extra')
  async extra(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<AiTaskView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.extra',
        opKey: body.opKey,
        scope: 'ai.task.extra',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const out = await this.tasks.extra(tx, p, id, {
          reason: body.reason,
          memberId: ctx.m.memberId,
          actor: step.actor,
          now: step.now,
          actors: actorsOf(ctx.access),
        });
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  /** Результат вызова принят человеком: задача `open → done` (§7.5, Р-PUB-Z1-4). */
  @Post('products/:pid/ai/tasks/:id/accept')
  @PubAllow('ai.generate')
  async accept(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<AiTaskView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.generate',
        opKey: body.opKey,
        scope: 'ai.task.accept',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx) => {
        const out = await this.tasks.accept(tx, p, id, {
          callId: body.callId,
          actors: actorsOf(ctx.access),
        });
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  // ── Конфигурации и набор 30 задач (только eval-продукт) ─────────────────

  @Get('products/:pid/ai/configs')
  @PubAllow('ai.eval.review')
  async listConfigs(@PubRequest() ctx: PubRequestCtx) {
    const p = product(ctx);
    this.configs.assertEval(p);
    return this.configs.list(this.tenant(p), p.id);
  }

  @Post('products/:pid/ai/configs/:id/decision')
  @PubAllow('ai.bind')
  async decideConfig(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    this.configs.assertEval(p);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.bind',
        opKey: body.opKey,
        scope: 'ai.config.decision',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const out = await this.configs.decide(
          tx,
          p,
          id,
          {
            evalStatus: body.evalStatus,
            evalRunId: body.evalRunId,
            basis: body.basis,
          },
          step.actor,
          step.now,
        );
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('products/:pid/ai/eval-runs')
  @PubAllow('ai.eval.review')
  async evalRuns(@PubRequest() ctx: PubRequestCtx) {
    const p = product(ctx);
    this.configs.assertEval(p);
    return this.evalReview.runs(this.tenant(p), p.id);
  }

  @Get('products/:pid/ai/eval-runs/:id')
  @PubAllow('ai.eval.review')
  async evalRun(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    const p = product(ctx);
    this.configs.assertEval(p);
    return this.evalReview.protocol(this.tenant(p), p.id, id);
  }

  /**
   * Протокол прогона: JSON — конверт; `?format=md` (аудит S2-2) — сырой
   * файл `text/markdown` с `Content-Disposition`.
   */
  @Get('products/:pid/ai/eval-runs/:id/protocol')
  @PubAllow('ai.eval.review')
  async evalProtocol(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const p = product(ctx);
    this.configs.assertEval(p);
    if (format !== undefined && format !== 'json' && format !== 'md') {
      throw validationError([{ field: 'format', code: 'enum' }]);
    }
    const protocol = await this.evalReview.protocol(this.tenant(p), p.id, id);
    if (format === 'md') {
      res
        .status(200)
        .set({
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': PUB_NO_STORE,
          'Content-Disposition': `attachment; filename="publisher-eval-${id.replace(/[^A-Za-z0-9_-]/g, '')}.md"`,
        })
        .send(protocolMarkdown(protocol));
      return;
    }
    sendEnvelope(res, protocol);
  }

  @Post('products/:pid/ai/eval-runs/:id/results/:rid/flags/:fid')
  @PubAllow('ai.eval.review')
  async resolveFlag(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') runId: string,
    @Param('rid') rid: string,
    @Param('fid') fid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    this.configs.assertEval(p);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.eval.review',
        opKey: body.opKey,
        scope: 'ai.eval.flag',
        pathParams: { pid: p.id, id: runId, rid, fid },
        body,
      },
      async (tx, step) => {
        const out = await this.evalReview.resolveFlag(
          tx,
          p,
          runId,
          rid,
          fid,
          { resolution: body.resolution, explanation: body.explanation },
          ctx.m.memberId,
          step.now,
        );
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/ai/eval-runs/:id/results/:rid/review')
  @PubAllow('ai.eval.review')
  async reviewResult(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') runId: string,
    @Param('rid') rid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    this.configs.assertEval(p);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.eval.review',
        opKey: body.opKey,
        scope: 'ai.eval.review',
        pathParams: { pid: p.id, id: runId, rid },
        body,
      },
      async (tx) => {
        const out = await this.evalReview.review(
          tx,
          p,
          runId,
          rid,
          {
            criticalPass: body.criticalPass,
            usefulnessPass: body.usefulnessPass,
            explanation: body.explanation,
          },
          ctx.m.memberId,
        );
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  // ── Привязки рабочего продукта ──────────────────────────────────────────

  @Get('products/:pid/ai/bindings')
  @PubAllow('ai.bind')
  async bindings(@PubRequest() ctx: PubRequestCtx) {
    const p = product(ctx);
    return this.configs.bindings(this.tenant(p), p);
  }

  @Post('products/:pid/ai/bindings')
  @PubAllow('ai.bind')
  async bind(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.bind',
        opKey: body.opKey,
        scope: 'ai.binding.bind',
        pathParams: { pid: p.id },
        body,
      },
      async (tx, step) => {
        const out = await this.configs.bind(
          tx,
          p,
          { configId: body.configId, basis: body.basis },
          step.actor,
          step.now,
        );
        return { status: 201, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/ai/bindings/:id/unbind')
  @PubAllow('ai.bind')
  async unbind(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'ai.bind',
        opKey: body.opKey,
        scope: 'ai.binding.unbind',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const out = await this.configs.unbind(
          tx,
          p,
          id,
          body.reason,
          step.actor,
          step.now,
        );
        return { status: 200, body: out.view, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }
}
