/**
 * Очередь «Обучение (посетители)» — L (§4-тер.3, §4-тер.13): список
 * кластеров и кандидатов, решение (golden → проверенный ответ ЧЕРЕЗ
 * ModeKnowledgeCore FAQ Э1 — тот же индекс и версия знаний; source; out_of_scope
 * → кейс eval «вне знаний»; ignore), черновик по знаниям (№4, бюджет
 * обучения, операция `assist-learn`), кандидат оператора (Р-33: никогда не
 * знание без принятия manager/owner). Права: чтение и кандидат — assist:
 * manager|operator (оператор видит только СВОИ кандидаты); решение —
 * manager/owner.
 *
 * Уточнения реализации (L):
 *  - элемент очереди на экране — кластер (строит крон assist-learn-rollup)
 *    или кандидат оператора (`operator_fix`: по кнопке — `proposed`,
 *    автоматический по закрытой передаче — `new`, на экране — тоже
 *    «предложен»); `operator_fix` не кластеризуется;
 *  - «Ответить» по кластеру: варианты, совпавшие с примерами кластера
 *    (маскированные вопросы посетителей), запоминаются в variantRefs с
 *    диалогом — их снимет хвост forget (§4-тер.12); `faqId` — дополнить
 *    существующий проверенный ответ;
 *  - «Правильно отказал» — кейс eval kind=manual без эталона (ждёт отказа,
 *    как judgeSiteCase W3), `fromConversationId` — диалог первого примера:
 *    forget посетителя уносит кейс каскадом (О-15);
 *  - решение кластера закрывает и его элементы (status=resolved|ignored);
 *    решённый кластер можно решить заново (например, после переоткрытия),
 *    решённого кандидата — нет (LEARNING_RESOLVE_INVALID 409);
 *  - кандидат из TMA и из бота — одна логика (`proposeCandidate`):
 *    сообщение role=operator этого сайта, вопрос — последний вопрос
 *    посетителя до него; оператор (не менеджер) предлагает только СВОЙ
 *    ответ; повтор — тот же элемент (идемпотентно), автоматический `new`
 *    по нажатию становится `proposed`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEARNING_DEFAULTS } from '../../config/assist-defaults';
import { SitesDb } from '../../prisma/sites-db.service';
import { AnswerEngine } from '../assist-knowledge-core/answer/answer-engine';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { SiteKnowledgeService } from '../assist-site-knowledge/site-knowledge.service';
import { LearningBudget } from '../site-ai/learning-budget';
import { spentOf, type TextModelSpent } from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountMembership,
} from '../site-core/account/roles';
import { notFoundSite } from '../site-core/site-core.constants';
import {
  LEARNING_KINDS,
  type CandidateRequest,
  type LearningKind,
  type QueueDraftView,
  type QueueEntryView,
  type QueueView,
  type ResolveRequest,
  type ResolveResult,
} from './api-types';
import { GoldenAnswersService, type VariantRef } from './golden.service';
import {
  GOLDEN_LIMITS,
  cleanText,
  isManager,
  learningError,
  pageOf,
  requireAssistAny,
  requireManager,
  stripSourceMarkers,
} from './learning-common';

/** Кластеров/кандидатов на экране за раз. */
export const QUEUE_PAGE = 100;

interface ItemRow {
  id: string;
  accountId: string;
  siteId: string;
  kind: string;
  conversationId: string | null;
  messageId: string | null;
  questionMasked: string;
  answerMasked: string | null;
  lang: string | null;
  clusterId: string | null;
  proposedAnswer: string | null;
  proposedByTelegramId: bigint | null;
  proposedAt: Date | null;
  status: string;
  createdAt: Date;
}

interface ClusterRow {
  id: string;
  accountId: string;
  siteId: string;
  label: string;
  kind: string;
  size: number;
  distinctVisitors: number;
  lang: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  status: string;
  reopenedAt: Date | null;
}

type Actor = {
  accountId: string;
  memberId: string;
  telegramId: bigint;
  role: AccountMembership['role'];
  productRoles: AccountMembership['productRoles'];
};

export type ProposeOutcome =
  | { result: 'proposed' | 'duplicate'; itemId: string }
  | { result: 'forbidden' | 'not_found' | 'invalid' };

function candidateStatus(s: string): 'proposed' | 'resolved' | 'ignored' {
  return s === 'resolved'
    ? 'resolved'
    : s === 'ignored'
      ? 'ignored'
      : 'proposed';
}

function candidateView(r: ItemRow, me: bigint): QueueEntryView {
  return {
    entry: 'candidate',
    id: r.id,
    kind: 'operator_fix',
    questionMasked: r.questionMasked,
    proposedAnswer: r.proposedAnswer ?? '',
    proposedByMe:
      r.proposedByTelegramId !== null && r.proposedByTelegramId === me,
    proposedAt: (r.proposedAt ?? r.createdAt).toISOString(),
    conversationId: r.conversationId,
    status: candidateStatus(r.status),
  };
}

function asKind(k: string): LearningKind {
  return (LEARNING_KINDS as readonly string[]).includes(k)
    ? (k as LearningKind)
    : 'unknown';
}

/**
 * Предложить ответ оператора кандидатом (Р-33) — общая часть TMA и бота.
 * Основная роль: сообщения оператора и посетителя роли виджета не нужны.
 */
export async function proposeCandidate(
  sitesDb: SitesDb,
  p: {
    actor: Actor;
    /** Сайт маршрута (TMA); бот сайт не знает — берётся из сообщения. */
    siteId: string | null;
    messageId: string;
    answer: string | null;
    now: Date;
  },
): Promise<ProposeOutcome> {
  if (
    typeof p.messageId !== 'string' ||
    !p.messageId ||
    p.messageId.length > 64
  ) {
    return { result: 'not_found' };
  }
  const t = sitesDb.forAccount(p.actor.accountId);
  const msg = await t.assistSiteMessage.findFirst({
    where: {
      id: p.messageId,
      ...(p.siteId ? { siteId: p.siteId } : {}),
    },
    select: {
      id: true,
      siteId: true,
      conversationId: true,
      role: true,
      text: true,
      lang: true,
      authorMemberId: true,
      createdAt: true,
    },
  });
  if (!msg || msg.role !== 'operator') return { result: 'not_found' };
  const manager = isManager(p.actor as AccountMembership);
  const operator = !manager && p.actor.productRoles.assist === 'operator';
  if (!manager && !operator) return { result: 'forbidden' };
  // Оператор предлагает только СВОЙ ответ из своей передачи (§4-тер.13).
  if (!manager && msg.authorMemberId !== p.actor.memberId) {
    return { result: 'forbidden' };
  }
  const answer =
    p.answer === null ? cleanText(msg.text, GOLDEN_LIMITS.answer) : p.answer;
  if (!answer) return { result: 'invalid' };
  const question = await t.assistSiteMessage.findFirst({
    where: {
      conversationId: msg.conversationId,
      role: 'visitor',
      createdAt: { lte: msg.createdAt },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { text: true, lang: true },
  });
  if (!question?.text.trim()) return { result: 'invalid' };

  const existing = await t.assistSiteLearningItem.findFirst({
    where: { messageId: msg.id, kind: 'operator_fix' },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status !== 'new') {
      return { result: 'duplicate', itemId: existing.id };
    }
    await t.assistSiteLearningItem.updateMany({
      where: { id: existing.id, status: 'new' },
      data: {
        status: 'proposed',
        proposedAnswer: answer,
        proposedByTelegramId: p.actor.telegramId,
        proposedAt: p.now,
      },
    });
    return { result: 'proposed', itemId: existing.id };
  }
  try {
    const row = await t.assistSiteLearningItem.create({
      data: {
        accountId: p.actor.accountId,
        siteId: msg.siteId,
        kind: 'operator_fix',
        signal: 'operator',
        conversationId: msg.conversationId,
        messageId: msg.id,
        questionMasked: question.text,
        lang: question.lang ?? msg.lang ?? null,
        proposedAnswer: answer,
        proposedByTelegramId: p.actor.telegramId,
        proposedAt: p.now,
        status: 'proposed',
      },
      select: { id: true },
    });
    return { result: 'proposed', itemId: row.id };
  } catch (e) {
    // Гонка двух нажатий — уникальный (messageId, kind): второе — повтор.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const again = await t.assistSiteLearningItem.findFirst({
        where: { messageId: msg.id, kind: 'operator_fix' },
        select: { id: true },
      });
      if (again) return { result: 'duplicate', itemId: again.id };
    }
    throw e;
  }
}

@Injectable()
export class LearningQueueService {
  now: () => Date = () => new Date();
  private readonly logger = new Logger(LearningQueueService.name);

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly golden: GoldenAnswersService,
    private readonly knowledge: SiteKnowledgeService,
    private readonly answers: AnswerEngine,
    private readonly usage: AiUsageRecorder,
    private readonly budget: LearningBudget,
  ) {}

  private db(m: { accountId: string }) {
    return this.sitesDb.forAccount(m.accountId);
  }

  private async requireSite(m: AccountMembership, siteId: string) {
    const site = await this.db(m).site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
  }

  private notFound() {
    return learningError(
      404,
      'LEARNING_ITEM_NOT_FOUND',
      'Элемент очереди не найден',
    );
  }

  private invalid(message: string, status: 400 | 409 = 400) {
    return learningError(status, 'LEARNING_RESOLVE_INVALID', message);
  }

  async list(
    m: AccountMembership,
    siteId: string,
    q: { kind: LearningKind | null; status: 'open' | 'resolved' | 'all' },
  ): Promise<QueueView> {
    requireAssistAny(m);
    await this.requireSite(m, siteId);
    const t = this.db(m);
    const kind =
      q?.kind && (LEARNING_KINDS as readonly string[]).includes(q.kind)
        ? q.kind
        : null;
    const status =
      q?.status === 'resolved' || q?.status === 'all' ? q.status : 'open';
    const manager = isManager(m);

    const counts = Object.fromEntries(
      LEARNING_KINDS.map((k) => [k, 0]),
    ) as QueueView['counts'];
    counts.candidates = 0;

    const entries: QueueEntryView[] = [];
    // ── кластеры (только менеджер: оператору очередь не видна, §4-тер.13) ──
    if (manager) {
      const open = await t.assistSiteLearningCluster.groupBy({
        by: ['kind'],
        where: { siteId, status: 'open' },
        _count: { _all: true },
      });
      for (const g of open) {
        const k = asKind(g.kind);
        if (k !== 'operator_fix') counts[k] += g._count._all;
      }
      if (kind !== 'operator_fix') {
        const clusters = (await t.assistSiteLearningCluster.findMany({
          where: {
            siteId,
            ...(kind ? { kind } : {}),
            ...(status === 'open'
              ? { status: 'open' }
              : status === 'resolved'
                ? { status: { in: ['resolved', 'ignored'] } }
                : {}),
          },
          orderBy: [
            { distinctVisitors: 'desc' },
            { size: 'desc' },
            { lastSeenAt: 'desc' },
            { id: 'asc' },
          ],
          take: QUEUE_PAGE,
        })) as ClusterRow[];
        entries.push(...(await this.clusterViews(m, siteId, clusters)));
      }
    }

    // ── кандидаты оператора ──
    const mine = manager ? {} : { proposedByTelegramId: m.telegramId };
    const openCandidateStatus = manager ? ['new', 'proposed'] : ['proposed'];
    counts.candidates = await t.assistSiteLearningItem.count({
      where: {
        siteId,
        kind: 'operator_fix',
        status: { in: openCandidateStatus },
        ...mine,
      },
    });
    counts.operator_fix = counts.candidates;
    if (!kind || kind === 'operator_fix') {
      const items = (await t.assistSiteLearningItem.findMany({
        where: {
          siteId,
          kind: 'operator_fix',
          ...mine,
          ...(status === 'open'
            ? { status: { in: openCandidateStatus } }
            : status === 'resolved'
              ? { status: { in: ['resolved', 'ignored'] } }
              : manager
                ? {}
                : { status: { not: 'new' } }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: QUEUE_PAGE,
      })) as ItemRow[];
      entries.push(...items.map((r) => candidateView(r, m.telegramId)));
    }
    return { entries, counts };
  }

  private async clusterViews(
    m: AccountMembership,
    siteId: string,
    clusters: ClusterRow[],
  ): Promise<QueueEntryView[]> {
    if (!clusters.length) return [];
    const t = this.db(m);
    const items = await t.assistSiteLearningItem.findMany({
      where: { siteId, clusterId: { in: clusters.map((c) => c.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { clusterId: true, questionMasked: true, conversationId: true },
      take: 5000,
    });
    const convIds = [
      ...new Set(
        items.map((i) => i.conversationId).filter((x): x is string => !!x),
      ),
    ];
    const convs = convIds.length
      ? await t.assistSiteConversation.findMany({
          where: { siteId, id: { in: convIds } },
          select: { id: true, pageUrl: true },
        })
      : [];
    const pageOfConv = new Map(convs.map((c) => [c.id, pageOf(c.pageUrl)]));
    return clusters.map((c) => {
      const own = items.filter((i) => i.clusterId === c.id);
      const examples: string[] = [];
      for (const i of own) {
        if (examples.length >= LEARNING_DEFAULTS.maxExamples) break;
        if (!examples.includes(i.questionMasked))
          examples.push(i.questionMasked);
      }
      const pages: string[] = [];
      for (const i of own) {
        if (pages.length >= 3) break;
        const pg = i.conversationId ? pageOfConv.get(i.conversationId) : null;
        if (pg && !pages.includes(pg)) pages.push(pg);
      }
      const status =
        c.status === 'resolved' || c.status === 'ignored' ? c.status : 'open';
      return {
        entry: 'cluster' as const,
        id: c.id,
        label: c.label,
        kind: asKind(c.kind),
        size: c.size,
        distinctVisitors: c.distinctVisitors,
        examples,
        pages,
        lang: c.lang,
        firstSeenAt: c.firstSeenAt.toISOString(),
        lastSeenAt: c.lastSeenAt.toISOString(),
        status,
        reopened: status === 'open' && c.reopenedAt !== null,
      };
    });
  }

  private async findEntry(
    m: AccountMembership,
    siteId: string,
    itemId: string,
  ): Promise<
    | { cluster: ClusterRow; item?: undefined }
    | { item: ItemRow; cluster?: undefined }
  > {
    if (typeof itemId !== 'string' || !itemId || itemId.length > 64) {
      throw this.notFound();
    }
    const t = this.db(m);
    const cluster = (await t.assistSiteLearningCluster.findFirst({
      where: { id: itemId, siteId },
    })) as ClusterRow | null;
    if (cluster) return { cluster };
    const item = (await t.assistSiteLearningItem.findFirst({
      where: { id: itemId, siteId, kind: 'operator_fix' },
    })) as ItemRow | null;
    if (item) return { item };
    throw this.notFound();
  }

  async resolve(
    m: AccountMembership,
    siteId: string,
    itemId: string,
    body: ResolveRequest,
  ): Promise<ResolveResult> {
    requireManager(m);
    await this.requireSite(m, siteId);
    const found = await this.findEntry(m, siteId, itemId);
    const action = (body as { action?: unknown } | null)?.action;
    if (found.cluster) {
      return this.resolveCluster(m, siteId, found.cluster, action, body);
    }
    return this.resolveCandidate(m, siteId, found.item, action, body);
  }

  private async closeCluster(
    m: AccountMembership,
    siteId: string,
    clusterId: string,
    p: {
      status: 'resolved' | 'ignored';
      resolution: string;
      faqId: string | null;
    },
  ): Promise<void> {
    const t = this.db(m);
    const now = this.now();
    await t.assistSiteLearningCluster.updateMany({
      where: { id: clusterId, siteId },
      data: {
        status: p.status,
        resolution: p.resolution,
        faqId: p.faqId,
        resolvedByTelegramId: m.telegramId,
        resolvedAt: now,
      },
    });
    await t.assistSiteLearningItem.updateMany({
      where: { siteId, clusterId },
      data: {
        status: p.status,
        resolution: p.resolution,
        faqId: p.faqId,
        resolvedByTelegramId: m.telegramId,
        resolvedAt: now,
      },
    });
  }

  private async resolveCluster(
    m: AccountMembership,
    siteId: string,
    cluster: ClusterRow,
    action: unknown,
    body: ResolveRequest,
  ): Promise<ResolveResult> {
    const t = this.db(m);
    if (action === 'ignore') {
      await this.closeCluster(m, siteId, cluster.id, {
        status: 'ignored',
        resolution: 'ignore',
        faqId: null,
      });
      return { status: 'ignored', faqId: null, evalCaseId: null };
    }
    if (action === 'source') {
      const note = (body as { note?: unknown }).note;
      if (note !== undefined && note !== null && !cleanText(note, 500)) {
        throw this.invalid('Примечание — до 500 символов');
      }
      await this.closeCluster(m, siteId, cluster.id, {
        status: 'resolved',
        resolution: 'source',
        faqId: null,
      });
      return { status: 'resolved', faqId: null, evalCaseId: null };
    }
    const items = await t.assistSiteLearningItem.findMany({
      where: { siteId, clusterId: cluster.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { questionMasked: true, conversationId: true },
      take: 1000,
    });
    if (action === 'out_of_scope') {
      // Кейс «вне знаний»: эталона нет — ждём честного отказа. Живёт не
      // дольше диалога-примера (каскад FK, О-15).
      const from = items.find((i) => i.conversationId)?.conversationId ?? null;
      const c = await t.assistSiteEvalCase.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind: 'manual',
          question: cluster.label,
          expected: null,
          mustCite: [],
          mustNotSay: [],
          lang: cluster.lang,
          status: 'active',
          fromConversationId: from,
        },
        select: { id: true },
      });
      await this.closeCluster(m, siteId, cluster.id, {
        status: 'resolved',
        resolution: 'out_of_scope',
        faqId: null,
      });
      return { status: 'resolved', faqId: null, evalCaseId: c.id };
    }
    if (action !== 'golden') {
      throw this.invalid(
        'Действие для кластера: golden, source, out_of_scope или ignore',
      );
    }
    const b = body as Extract<ResolveRequest, { action: 'golden' }> & {
      sourceRefs?: unknown;
    };
    const question = this.golden.parseQuestion(b.question);
    const answer = this.golden.parseAnswer(b.answer);
    const variants = this.golden.parseVariantsOrThrow(b.variants);
    const lang =
      b.lang === undefined
        ? cluster.lang
        : this.golden.parseLangOrThrow(b.lang);
    // Вариант, совпавший с вопросом посетителя из кластера, — цитата: она
    // привязывается к диалогу и уйдёт по его forget (§4-тер.12).
    const variantRefs: VariantRef[] = [];
    for (const v of variants) {
      for (const i of items) {
        if (i.conversationId && i.questionMasked.trim() === v) {
          variantRefs.push({ variant: v, conversationId: i.conversationId });
        }
      }
    }
    const fromConversationId =
      items.find((i) => i.conversationId)?.conversationId ?? null;
    let res;
    if (b.faqId) {
      if (typeof b.faqId !== 'string')
        throw this.golden.invalid('faqId — строка');
      res = await this.golden.extendGolden(m, siteId, b.faqId, {
        answer,
        lang,
        variants,
        variantRefs,
      });
    } else {
      res = await this.golden.createGolden(m, siteId, {
        question,
        answer,
        variants,
        lang,
        origin: 'gap',
        sourceRefs: await this.golden.validateSourceRefs(
          m.accountId,
          siteId,
          b.sourceRefs,
        ),
        variantRefs,
        fromConversationId,
      });
    }
    await this.closeCluster(m, siteId, cluster.id, {
      status: 'resolved',
      resolution: 'golden',
      faqId: res.row.id,
    });
    return {
      status: 'resolved',
      faqId: res.row.id,
      evalCaseId: res.evalCaseId,
    };
  }

  private async resolveCandidate(
    m: AccountMembership,
    siteId: string,
    item: ItemRow,
    action: unknown,
    body: ResolveRequest,
  ): Promise<ResolveResult> {
    if (item.status === 'resolved' || item.status === 'ignored') {
      throw this.invalid('Кандидат уже рассмотрен', 409);
    }
    const t = this.db(m);
    const now = this.now();
    if (action === 'reject' || action === 'ignore') {
      await t.assistSiteLearningItem.updateMany({
        where: { id: item.id, siteId, status: { in: ['new', 'proposed'] } },
        data: {
          status: 'ignored',
          resolution: 'rejected',
          resolvedByTelegramId: m.telegramId,
          resolvedAt: now,
        },
      });
      return { status: 'ignored', faqId: null, evalCaseId: null };
    }
    if (action !== 'accept') {
      throw this.invalid('Действие для кандидата: accept или reject');
    }
    const b = body as Extract<ResolveRequest, { action: 'accept' }>;
    const question = this.golden.parseQuestion(
      b.question ?? item.questionMasked,
    );
    const answer = this.golden.parseAnswer(b.answer ?? item.proposedAnswer);
    const lang =
      item.lang && ['uk', 'ru', 'en'].includes(item.lang.slice(0, 2))
        ? item.lang.slice(0, 2)
        : null;
    const res = await this.golden.createGolden(m, siteId, {
      question,
      answer,
      variants: [],
      lang,
      origin: 'operator_candidate',
      sourceRefs: [],
      variantRefs: [],
      fromConversationId: item.conversationId,
    });
    await t.assistSiteLearningItem.updateMany({
      where: { id: item.id, siteId },
      data: {
        status: 'resolved',
        resolution: 'accepted',
        faqId: res.row.id,
        resolvedByTelegramId: m.telegramId,
        resolvedAt: now,
      },
    });
    return {
      status: 'resolved',
      faqId: res.row.id,
      evalCaseId: res.evalCaseId,
    };
  }

  async draft(
    m: AccountMembership,
    siteId: string,
    itemId: string,
  ): Promise<QueueDraftView> {
    requireManager(m);
    await this.requireSite(m, siteId);
    const found = await this.findEntry(m, siteId, itemId);
    const question = found.cluster
      ? found.cluster.label
      : found.item.questionMasked;
    const lang =
      (found.cluster ? found.cluster.lang : found.item.lang) ??
      questionLang(question, null);
    const est = LEARNING_DEFAULTS.draftEstimateMicroUsd;
    if (!(await this.budget.reserve(m.accountId, siteId, est))) {
      return { text: '', lang, sources: [], status: 'budget' };
    }
    let spent = 0;
    const record = async (r: TextModelSpent) => {
      const u = await this.usage.record(this.db(m), {
        accountId: m.accountId,
        siteId,
        operation: 'assist-learn',
        model: r.model,
        units: {
          inputTokens: r.inputTokens,
          cachedInputTokens: r.cachedInputTokens,
          outputTokens: r.outputTokens,
        },
      });
      spent = u.costMicroUsd;
    };
    try {
      // UGC — не источник черновика (§4-тер.7).
      const hits = (
        await this.knowledge.search({
          siteId,
          query: question,
          includeUgc: false,
        })
      ).filter((h) => !h.ugc);
      const r = await this.answers.answer({ question, hits, lang });
      if (r.model) await record(r);
      // Без источников — пусто: модель не выдумывает ответ владельцу (§4-тер.3).
      if (r.refused || !r.sources.length) {
        return { text: '', lang, sources: [], status: 'no_sources' };
      }
      return {
        text: stripSourceMarkers(r.text),
        lang,
        sources: r.sources.map((s) => ({ n: s.n, url: s.url, title: s.title })),
        status: 'ok',
      };
    } catch (e) {
      this.logger.warn(
        `черновик проверенного ответа не получен (site ${siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
      // empty/truncated оплачены: расход — как у черновика, в бюджет обучения.
      const paid = spentOf(e);
      if (paid) await record(paid).catch(() => undefined);
      return { text: '', lang, sources: [], status: 'no_sources' };
    } finally {
      await this.budget
        .adjust(m.accountId, siteId, spent - est)
        .catch(() => undefined);
    }
  }

  async propose(
    m: AccountMembership,
    siteId: string,
    body: CandidateRequest,
  ): Promise<QueueEntryView> {
    requireAssistAny(m);
    await this.requireSite(m, siteId);
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    if (typeof b.messageId !== 'string' || !b.messageId) {
      throw learningError(
        400,
        'CANDIDATE_INVALID',
        'Укажите сообщение оператора',
      );
    }
    let answer: string | null = null;
    if (b.answer !== undefined && b.answer !== null) {
      answer = cleanText(b.answer, GOLDEN_LIMITS.answer);
      if (!answer) {
        throw learningError(
          400,
          'CANDIDATE_INVALID',
          'Ответ пустой или длиннее 5000 символов',
        );
      }
    }
    const out = await proposeCandidate(this.sitesDb, {
      actor: m,
      siteId,
      messageId: b.messageId,
      answer,
      now: this.now(),
    });
    if (out.result === 'forbidden') {
      throw learningError(
        403,
        'FORBIDDEN',
        'Предложить можно только свой ответ из своей передачи',
      );
    }
    if (!('itemId' in out)) {
      throw learningError(
        400,
        'CANDIDATE_INVALID',
        'Это не ответ оператора в диалоге этого сайта',
      );
    }
    const row = (await this.db(m).assistSiteLearningItem.findFirst({
      where: { id: out.itemId, siteId },
    })) as ItemRow;
    return candidateView(row, m.telegramId);
  }
}

/**
 * Кандидат оператора из бота (H → L): кнопка «Предложить как проверенный
 * ответ» под ответом оператора. Основная роль; права — участник кабинета
 * сайта сообщения с assist: operator|manager или владелец.
 */
@Injectable()
export class LearningCandidates {
  now: () => Date = () => new Date();
  private readonly logger = new Logger(LearningCandidates.name);

  constructor(private readonly sitesDb: SitesDb) {}

  async proposeFromOperator(p: {
    telegramId: bigint;
    messageId: string;
  }): Promise<'proposed' | 'duplicate' | 'forbidden' | 'not_found'> {
    if (
      typeof p?.messageId !== 'string' ||
      !p.messageId ||
      p.messageId.length > 64
    ) {
      return 'not_found';
    }
    // Кабинет — по сообщению (бот сайт не знает): единственный «системный» шаг.
    const msg = await this.sitesDb
      .system('кандидат оператора из бота: кабинет по id сообщения')
      .assistSiteMessage.findUnique({
        where: { id: p.messageId },
        select: { accountId: true, role: true },
      });
    if (!msg || msg.role !== 'operator') return 'not_found';
    const member = await this.sitesDb
      .forAccount(msg.accountId)
      .siteAccountMember.findFirst({
        where: { telegramId: p.telegramId },
        select: { id: true, role: true, productRoles: true },
      });
    const role = member ? parseAccountRole(member.role) : null;
    if (!member || !role) return 'forbidden';
    const out = await proposeCandidate(this.sitesDb, {
      actor: {
        accountId: msg.accountId,
        memberId: member.id,
        telegramId: p.telegramId,
        role,
        productRoles: parseProductRoles(member.productRoles),
      },
      siteId: null,
      messageId: p.messageId,
      answer: null,
      now: this.now(),
    });
    return out.result === 'invalid' ? 'not_found' : out.result;
  }

  /**
   * operator_fix без кнопки (H, по закрытой передаче): оператор ответил
   * после ответа модели — элемент `new` (решает человек в очереди).
   */
  async recordOperatorFix(p: {
    accountId: string;
    siteId: string;
    conversationId: string;
    operatorMessageId: string;
  }): Promise<void> {
    try {
      const t = this.sitesDb.forAccount(p.accountId);
      const op = await t.assistSiteMessage.findFirst({
        where: {
          id: p.operatorMessageId,
          siteId: p.siteId,
          conversationId: p.conversationId,
          role: 'operator',
        },
        select: { id: true, text: true, lang: true, createdAt: true },
      });
      if (!op) return;
      const before = await t.assistSiteMessage.findMany({
        where: {
          conversationId: p.conversationId,
          role: { in: ['visitor', 'assistant'] },
          createdAt: { lte: op.createdAt },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { role: true, text: true, lang: true },
        take: 20,
      });
      const question = before.find((x) => x.role === 'visitor');
      const modelAnswer = before.find((x) => x.role === 'assistant');
      const answer = cleanText(op.text, GOLDEN_LIMITS.answer);
      if (!question?.text.trim() || !answer) return;
      await t.assistSiteLearningItem.createMany({
        data: [
          {
            accountId: p.accountId,
            siteId: p.siteId,
            kind: 'operator_fix',
            signal: 'operator',
            conversationId: p.conversationId,
            messageId: op.id,
            questionMasked: question.text,
            answerMasked: modelAnswer?.text ?? null,
            lang: question.lang ?? op.lang ?? null,
            // «Предложил» — только тот, кто нажал кнопку: автоматический
            // элемент ничей, пока оператор или менеджер его не предложит.
            proposedAnswer: answer,
            status: 'new',
          },
        ],
        skipDuplicates: true,
      });
    } catch (e) {
      this.logger.warn(
        `operator_fix не записан (site ${p.siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
    }
  }
}
