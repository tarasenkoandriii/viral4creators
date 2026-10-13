/**
 * AI Publisher, P-B1 — стенд и построители предметных данных TD-03…TD-05
 * (проектный документ §16.3, план внешнего аудита): бренд и оффер,
 * исследование (вопросы, брифы, источники разных разрешений, отозванный
 * источник, claims с поддерживающим и неподдерживающим доказательством),
 * материалы (согласованный материал, изменённый черновик, адаптация старой
 * версии, исторический кейс).
 *
 * Стенд — модуль ядра + модуль P-B1 (+ публичное чтение) на тестовой базе;
 * фейки портов соседей (P-C, P-B2, P-D, P-E) — кроме `ContentPort` и вклада
 * `member-reassign:contents`, которые даёт сам пакет. Мутации идут через
 * НАСТОЯЩИЙ `runOperation` (роль, ключ идемпотентности, аудит в
 * транзакции); публикации P-C имитируются записью `pub_publications` +
 * `ContentPort.markPublished` (как это делает P-C в своей транзакции).
 */
import { randomUUID } from 'crypto';
import type { PubTx } from '../../core/ports';
import { PubOperations, type OperationStep } from '../../core/operation';
import { accessOf, type PubAccess, type PubAction } from '../../core/roles';
import type { Actor } from '../../core/state-machines';
import {
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import type { FakePorts } from '../../core/testing/fake-ports';
import type {
  SeededAccount,
  SeededMember,
  SeededProduct,
} from '../../testing/fixtures.testing';
import type { PubRole } from '../../contracts/states';
import { PublisherContentPublicModule } from '../../public/content-public.module';
import { ApprovalsPublishService } from '../approvals-publish.service';
import { BrandService } from '../brand.service';
import { BriefsService } from '../briefs.service';
import { ClaimsService } from '../claims.service';
import { PublisherContentModule } from '../content.module';
import { ContentPortImpl } from '../content-port';
import { ContentsService } from '../contents.service';
import { QaChecksService } from '../qa-checks.service';
import { QuestionsService } from '../questions.service';
import { RevocationService } from '../revocation.service';
import { SourcesService, type OpOut } from '../sources.service';
import { loadContent, loadGroup, loadVersion } from '../views';
import type {
  ApprovalView,
  BriefView,
  ClaimView,
  ContentView,
  QuestionView,
  SourceView,
  VersionView,
} from '../../contracts/content-api';
import { testSlug } from '../../testing/fixtures.testing';

export interface ContentStack extends CoreStack {
  fakes: FakePorts;
}

/** Стенд P-B1: свои `ContentPort` и вклад `contents`, фейки соседей. */
export async function contentStack(
  opts: { http?: boolean } = {},
): Promise<ContentStack> {
  // Фейки `ContentPort` и вклада `contents` убирает сам `coreStack`
  // (настоящие — в модуле P-B1; `fakesBesides`, интеграция Z-1).
  return coreStack({
    http: opts.http,
    imports: [PublisherContentModule, PublisherContentPublicModule],
  });
}

export interface Who {
  member: SeededMember;
  access: PubAccess;
  actors: Actor[];
  actor: string;
}

export function whoOf(member: SeededMember, roles: PubRole[] | 'owner'): Who {
  const owner = roles === 'owner';
  const access = accessOf({
    memberId: member.memberId,
    grants: owner ? [] : roles,
    admin: false,
    accountOwner: owner,
  });
  return {
    member,
    access,
    actors: [...access.roles, ...(access.admin ? (['admin'] as const) : [])],
    actor: `member:${member.memberId}`,
  };
}

/** Набор сервисов P-B1 и операция «как в маршруте». */
export class Kit {
  readonly ops: PubOperations;
  readonly sources: SourcesService;
  readonly revocation: RevocationService;
  readonly questions: QuestionsService;
  readonly brand: BrandService;
  readonly briefs: BriefsService;
  readonly contents: ContentsService;
  readonly claims: ClaimsService;
  readonly qa: QaChecksService;
  readonly approvals: ApprovalsPublishService;
  readonly port: ContentPortImpl;

  constructor(
    readonly s: ContentStack,
    readonly acc: SeededAccount,
    readonly p: SeededProduct,
    public who: Who = whoOf(acc.owner, 'owner'),
  ) {
    const g = <T>(c: new (...a: never[]) => T): T =>
      s.mod.get(c, { strict: false });
    this.ops = g(PubOperations);
    this.sources = g(SourcesService);
    this.revocation = g(RevocationService);
    this.questions = g(QuestionsService);
    this.brand = g(BrandService);
    this.briefs = g(BriefsService);
    this.contents = g(ContentsService);
    this.claims = g(ClaimsService);
    this.qa = g(QaChecksService);
    this.approvals = g(ApprovalsPublishService);
    this.port = g(ContentPortImpl);
  }

  as(who: Who): Kit {
    return new Kit(this.s, this.acc, this.p, who);
  }

  /** Мутация через `runOperation` (роль, ключ, аудит). */
  async op<T>(
    action: PubAction,
    fn: (tx: PubTx, step: OperationStep) => Promise<OpOut<T>>,
    opts: {
      noStore?: (tx: PubTx) => Promise<T>;
      opKey?: string;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const r = await this.ops.run<T>(
      {
        m: this.who.member.membership,
        access: this.who.access,
        product: this.p,
        action,
        opKey: opts.opKey ?? randomUUID(),
        scope: `test.${action}`,
        pathParams: { pid: this.p.id },
        body: opts.body ?? { n: randomUUID() },
        ...(opts.noStore
          ? { storeResponse: false, rebuild: (tx: PubTx) => opts.noStore!(tx) }
          : {}),
      },
      async (tx, step) => {
        const o = await fn(tx, step);
        return { status: 200, body: o.body, audit: o.audit };
      },
    );
    return r.body;
  }

  /** Чтение в транзакции кабинета. */
  tx<T>(fn: (tx: PubTx) => Promise<T>): Promise<T> {
    return this.s.db.forAccount(this.acc.accountId).$transaction(fn);
  }

  // ── Короткие действия ──────────────────────────────────────────────────

  source(over: Record<string, unknown> = {}): Promise<SourceView> {
    return this.op('source.manage', (tx, st) =>
      this.sources.create(
        tx,
        this.p,
        {
          kind: 'interview',
          title: `Джерело ${randomUUID().slice(0, 6)}`,
          fragment: 'Клієнти питають, як обрати агенцію для контенту.',
          visibility: 'public',
          usage: 'allowed',
          url: `https://example.org/s/${randomUUID().slice(0, 8)}`,
          ...over,
        },
        st.actor,
      ),
    );
  }

  question(over: Record<string, unknown> = {}): Promise<QuestionView> {
    return this.op('question.manage', (tx, st) =>
      this.questions.create(
        tx,
        this.p,
        { text: 'Як оцінити агенцію?', stage: 'consideration', ...over },
        st.actor,
      ),
    );
  }

  async selectQuestion(
    q: QuestionView,
    rank: number,
    sourceId: string,
  ): Promise<QuestionView> {
    const why = (k: string) => ({ score: 2, why: `Пояснення ${k}` });
    return this.op('question.manage', (tx, st) =>
      this.questions.patch(
        tx,
        this.p,
        q.id,
        {
          expectedRevision: q.revision,
          scores: {
            offer_fit: why('offer'),
            confirmed_task: why('task'),
            own_answer: why('own'),
            cost: { score: 1, why: 'Пояснення cost' },
          },
          sources: [{ sourceId, fragment: 'Фрагмент запитання' }],
          status: 'selected',
          selectedRank: rank,
        },
        st.actor,
      ),
    );
  }

  group(body: Record<string, unknown>) {
    return this.op(
      'question.manage',
      (tx, st) =>
        this.questions.createGroup(tx, this.p, body, st.actor, this.who.actors),
      {
        noStore: async (tx) =>
          loadGroup(
            tx,
            this.p.id,
            (
              await tx.pubQuestionGroup.findFirstOrThrow({
                where: { productId: this.p.id, key: String(body.key) },
              })
            ).id,
          ),
      },
    );
  }

  fact(body: Record<string, unknown>) {
    return this.op('brand.draft', (tx, st) =>
      this.brand.createFact(tx, this.p, body, st.actor),
    );
  }

  activateFact(id: string) {
    return this.op('brand.activate', (tx, st) =>
      this.brand.activateFact(
        tx,
        this.p,
        id,
        { basis: 'Перевірено власником' },
        st.actor,
        st.now,
      ),
    );
  }

  async offer(over: Record<string, unknown> = {}, activate = true) {
    const o = await this.op('brand.activate', (tx, st) =>
      this.brand.createOffer(
        tx,
        this.p,
        {
          title: 'Оффер пілоту',
          text: 'Повний цикл контенту',
          priceNote: '10 000 грн',
          ...over,
        },
        st.actor,
      ),
    );
    if (!activate) return o;
    const r = await this.op('brand.activate', (tx, st) =>
      this.brand.activateOffer(
        tx,
        this.p,
        o.id,
        { basis: 'Затверджено власником продукту' },
        st.actor,
        this.who.actors,
        st.now,
      ),
    );
    return r.offer;
  }

  brief(body: Record<string, unknown>): Promise<BriefView> {
    return this.op('brief.manage', (tx, st) =>
      this.briefs.create(tx, this.p, body, st.actor, this.who.actors),
    );
  }

  briefReady(b: BriefView): Promise<BriefView> {
    return this.op('brief.manage', (tx) =>
      this.briefs.ready(tx, this.p, b.id, { expectedRevision: b.revision }),
    );
  }

  content(body: Record<string, unknown>): Promise<ContentView> {
    return this.op('version.manage', (tx, st) =>
      this.contents.create(tx, this.p, body, st.actor),
    );
  }

  version(
    contentId: string,
    body: Record<string, unknown>,
  ): Promise<VersionView> {
    return this.op('version.manage', (tx, st) =>
      this.contents.createVersion(
        tx,
        this.p,
        contentId,
        body,
        {
          memberId: this.who.member.memberId,
          actor: st.actor,
          actors: this.who.actors,
        },
        st.now,
      ),
    );
  }

  submit(v: VersionView): Promise<VersionView> {
    return this.op('version.manage', (tx, st) =>
      this.contents.submit(
        tx,
        this.p,
        v.contentId,
        v.id,
        { expectedRevision: v.revision },
        this.who.actors,
        st.now,
      ),
    );
  }

  claim(body: Record<string, unknown>): Promise<ClaimView> {
    return this.op('version.manage', (tx, st) =>
      this.claims.create(tx, this.p, body, st.actor, this.who.actors),
    );
  }

  claimSource(
    claimId: string,
    sourceId: string,
    supports: string,
  ): Promise<ClaimView> {
    return this.op('claim.verify', (tx, st) =>
      this.claims.linkSource(
        tx,
        this.p,
        claimId,
        { sourceId, supports },
        st.actor,
        st.now,
      ),
    );
  }

  verify(c: ClaimView, status: string): Promise<ClaimView> {
    return this.op('claim.verify', (tx, st) =>
      this.claims.verify(
        tx,
        this.p,
        c.id,
        { status, expectedRevision: c.revision },
        this.who.access,
        st.actor,
        st.now,
      ),
    );
  }

  qaPass(
    versionId: string,
    kind = 'editorial',
    result = 'pass',
    blockers: unknown[] = [],
  ) {
    return this.op(
      kind === 'technical' ? 'qa.technical' : 'qa.editorial',
      (tx, st) =>
        this.qa.create(
          tx,
          this.p,
          versionId,
          { kind, result, blockers },
          this.who.access,
          st.actor,
          st.now,
        ),
    );
  }

  approve(v: VersionView): Promise<ApprovalView> {
    return this.op('version.approve', (tx, st) =>
      this.approvals.approve(
        tx,
        this.p,
        v.id,
        { versionHash: v.hash },
        {
          memberId: this.who.member.memberId,
          access: this.who.access,
          actors: this.who.actors,
        },
        st.now,
      ),
    );
  }

  transition(
    c: ContentView,
    to: string,
    extra: Record<string, unknown> = {},
  ): Promise<ContentView> {
    const action: PubAction = 'version.manage';
    return this.op(action, (tx, st) =>
      this.contents.transition(
        tx,
        this.p,
        c.id,
        { to, expectedRevision: c.revision, ...extra },
        this.who.actors,
        st.now,
      ),
    );
  }

  getVersion(id: string): Promise<VersionView> {
    return this.tx((tx) => loadVersion(tx, this.p.id, id));
  }

  getContent(id: string): Promise<ContentView> {
    return this.tx((tx) => loadContent(tx, this.p.id, id));
  }

  /**
   * Завершённый вызов AI на фейке (как его запишет шлюз P-B2): задача +
   * `pub_ai_calls(status=ok, output)`. Принять предложение — мутация
   * человека со ссылкой `aiCallId`.
   */
  async aiCall(
    generator: string,
    output: unknown,
    objectType = 'product',
    objectId = this.p.id,
    status = 'ok',
  ): Promise<string> {
    const task = await this.s.prisma.pubAiTask.upsert({
      where: {
        productId_generator_objectType_objectId: {
          productId: this.p.id,
          generator,
          objectType,
          objectId,
        },
      },
      create: {
        accountId: this.acc.accountId,
        productId: this.p.id,
        generator,
        objectType,
        objectId,
        generationsUsed: 1,
        createdBy: this.who.actor,
      },
      update: {},
    });
    const n = await this.s.prisma.pubAiCall.count({
      where: { taskId: task.id },
    });
    const call = await this.s.prisma.pubAiCall.create({
      data: {
        accountId: this.acc.accountId,
        productId: this.p.id,
        taskId: task.id,
        attemptNo: n + 1,
        generator,
        purpose: 'test',
        instructionVersion: `${generator}@1`,
        contextRulesVersion: 'ctx@1',
        sourceIds: [],
        provider: 'fake',
        model: 'fake',
        opKey: randomUUID(),
        finishedAt: new Date(),
        status,
        costStatus: 'unknown',
        ...(output === null ? {} : { output: output as never }),
        requestedBy: this.who.actor,
        createdBy: this.who.actor,
      },
    });
    return call.id;
  }

  /** Имитация публикации P-C: канал `site`, строка публикации, порт. */
  async publish(
    versionId: string,
    stage: 'test' | 'live',
    slug: string,
    at = new Date(),
  ): Promise<string> {
    return this.tx(async (tx) => {
      let ch = await tx.pubChannel.findFirst({
        where: { productId: this.p.id, code: 'site' },
      });
      if (!ch) {
        ch = await tx.pubChannel.create({
          data: {
            accountId: this.acc.accountId,
            productId: this.p.id,
            code: 'site',
            name: 'Сайт',
            kind: 'site',
            utmSource: 'site',
            utmMedium: 'owned',
            createdBy: 'system:test',
          },
        });
      }
      const approval = await tx.pubApproval.findFirstOrThrow({
        where: {
          productId: this.p.id,
          objectId: versionId,
          status: 'active',
          type: 'publish_version',
        },
      });
      const url = `https://pub-test.example/${slug}`;
      // Публикация N+1 по тому же URL: прежняя → replaced (это делает P-C).
      await tx.pubPublication.updateMany({
        where: {
          productId: this.p.id,
          channelId: ch.id,
          finalUrl: url,
          stage,
          status: 'published',
        },
        data: { status: 'replaced' },
      });
      const pub = await tx.pubPublication.create({
        data: {
          accountId: this.acc.accountId,
          productId: this.p.id,
          versionId,
          channelId: ch.id,
          approvalId: approval.id,
          stage,
          finalUrl: url,
          publishedAt: at,
          status: 'published',
          opKey: randomUUID(),
          createdBy: 'system:test-publication',
        },
      });
      await this.port.markPublished(tx, this.p, versionId, pub.id, stage, at);
      return pub.id;
    });
  }
}

/** Цепочка до согласованной статьи (TD-05 «согласованный материал»). */
export interface ApprovedArticle {
  source: SourceView;
  question: QuestionView;
  brief: BriefView;
  content: ContentView;
  claim: ClaimView;
  version: VersionView;
  approval: ApprovalView;
  offerId: string;
  factId: string | null;
}

export async function approvedArticle(
  k: Kit,
  opts: {
    slug?: string;
    rank?: number;
    factId?: string | null;
    offerId?: string;
  } = {},
): Promise<ApprovedArticle> {
  const offerId = opts.offerId ?? (await k.offer()).id;
  const source = await k.source();
  const q = await k.question({ text: `Питання ${randomUUID().slice(0, 6)}` });
  const question = await k.selectQuestion(q, opts.rank ?? 1, source.id);
  let brief = await k.brief({
    questionId: question.id,
    goal: 'Пояснити вибір',
    format: 'choice_guide',
    ownContribution: 'Власний досвід 12 запусків',
    cta: 'Обговорити задачу',
    ctaIntentNote:
      'Читач уже порівнює варіанти — доречно запропонувати розмову',
    sourceIds: [source.id],
  });
  brief = await k.briefReady(brief);
  const content = await k.content({
    kind: 'article',
    briefId: brief.id,
    slug: opts.slug ?? testSlug('art'),
  });
  let claim = await k.claim({
    statement: 'Вартість пілоту 10 000 грн',
    type: 'fact',
    risk: 'critical',
  });
  claim = await k.claimSource(claim.id, source.id, 'yes');
  let version = await k.version(content.id, {
    title: 'Як обрати агенцію',
    body: 'Короткий текст.\n\nДругий абзац.',
    meta: {
      description: 'Опис',
      shortAnswer: 'Коротко',
      cta: 'Обговорити задачу',
      editor: 'Редакторка',
    },
    sourceIds: [source.id],
    claimIds: [claim.id],
    factIds: opts.factId ? [opts.factId] : [],
    offerVersionId: offerId,
  });
  version = await k.submit(version);
  claim = await k.verify(claim, 'supported');
  await k.qaPass(version.id, 'editorial');
  await k.qaPass(version.id, 'technical');
  const approval = await k.approve(version);
  return {
    source,
    question,
    brief,
    content: await k.getContent(content.id),
    claim,
    version: await k.tx((tx) => loadVersion(tx, k.p.id, version.id)),
    approval,
    offerId,
    factId: opts.factId ?? null,
  };
}

/** Код ошибки Publisher из отклонённого промиса. */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    const x = e as { code?: string; details?: unknown };
    return typeof x.code === 'string' ? x.code : String(e);
  }
}

export async function errOf(
  p: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await p;
    return { code: 'OK', details: {} };
  } catch (e) {
    const x = e as { code?: string; details?: Record<string, unknown> };
    return { code: String(x.code ?? e), details: x.details ?? {} };
  }
}
