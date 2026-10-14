/**
 * AI Publisher, P-B1 × P-R M2 — Reddit-материалы (reddit-manual-mvp-
 * adapted.md §M2.1, §M2.4–M2.6; Р-RD-49…54). Таблицы материалов, версий,
 * QA и согласований принадлежат P-B1, поэтому записи — здесь; что известно
 * о брифе, сообществе и правилах, P-R отдаёт через `REDDIT_PORT`. Маршруты —
 * в разделе Reddit (`reddit/reddit.controller.ts`).
 *
 *  - `createMaterial` — материал `reddit_post|reddit_comment` по брифу (один
 *    на бриф; бриф — не архивный);
 *  - `recheck` — ручной перезапуск `reddit_policy` (фиксируется всегда;
 *    отрицательный итог после согласования — каскад `stale_check`);
 *  - `copy` — копирование утверждённого текста (гейт `reddit_publish`,
 *    снимок правил, свежая проверка, согласование и hash; `approved →
 *    scheduled` один раз, повтор — только аудит `copy`);
 *  - `onRulesChanged` — каскад материалов сообщества при новом снимке
 *    правил или отзыве первоисточника (хвост M2 (3)).
 * Сети нет: копирование возвращает текст, Reddit сервер не открывает (A11).
 */
import { Injectable } from '@nestjs/common';
import type { ContentView, QaCheckView } from '../contracts/content-api';
import type { RedditCopyView } from '../contracts/reddit-api';
import {
  isRedditContentKind,
  type ContentStatus,
  type RedditContentType,
} from '../contracts/states';
import { sha256Hex } from '../core/content-hash';
import { PubError } from '../core/errors';
import {
  PubPorts,
  type AuditInput,
  type ProductRef,
  type PubTx,
} from '../core/ports';
import {
  CONTENT_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { ContentCascades, decidedVersionIds } from './cascades';
import { ContentsService } from './contents.service';
import { Issues, type Body } from './input';
import {
  ackCodes,
  assertRedditBriefReadyFor,
  assertRedditRulesFresh,
  writeRedditPolicyCheck,
} from './reddit-policy-check';
import type { OpOut } from './sources.service';
import { loadContent } from './views';

const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Статусы, из которых можно копировать утверждённый текст. */
export const COPY_FROM: readonly ContentStatus[] = [
  'approved',
  'scheduled',
  'published',
  'revised',
];

/**
 * Версии Reddit-материалов сообществ, по которым уже принято решение
 * (активное согласование или показ) — вход каскада при смене правил.
 */
export async function redditDecidedVersions(
  tx: PubTx,
  productId: string,
  communityIds: readonly string[],
): Promise<string[]> {
  if (!communityIds.length) return [];
  const contents = await tx.pubContent.findMany({
    where: {
      productId,
      kind: { in: ['reddit_post', 'reddit_comment'] },
      redditBrief: { communityId: { in: [...communityIds] } },
    },
    select: { id: true },
  });
  if (!contents.length) return [];
  const versions = await tx.pubContentVersion.findMany({
    where: { productId, contentId: { in: contents.map((c) => c.id) } },
    select: { id: true },
  });
  return decidedVersionIds(
    tx,
    productId,
    versions.map((v) => v.id),
  );
}

@Injectable()
export class RedditMaterialsService {
  constructor(
    private readonly ports: PubPorts,
    private readonly cascades: ContentCascades,
    private readonly contents: ContentsService,
  ) {}

  async createMaterial(
    tx: PubTx,
    product: ProductRef,
    briefId: string,
    b: Body,
    actor: string,
  ): Promise<OpOut<ContentView>> {
    const is = new Issues();
    const ownerMemberId = is.str(b, 'ownerMemberId', {
      max: 64,
      re: MEMBER_ID_RE,
    });
    is.throwIfAny();
    // Строка брифа под блокировкой: два параллельных создания — один материал.
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_reddit_briefs" WHERE "id" = ${briefId} AND "productId" = ${product.id} FOR UPDATE`;
    const ctx = await this.ports.reddit().materialContext(tx, product, briefId);
    if (ctx.briefStatus === 'archived')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: ctx.briefStatus,
      });
    // Материал — только из готового брифа (как версия и генерация).
    if (ctx.briefStatus !== 'ready' || ctx.briefMissing.length)
      throw new PubError('PUB_BRIEF_NOT_READY', {
        missing:
          ctx.briefStatus !== 'ready'
            ? ['brief_ready', ...ctx.briefMissing]
            : ctx.briefMissing,
      });
    const existing = await tx.pubContent.findFirst({
      where: {
        productId: product.id,
        redditBriefId: briefId,
        status: { not: 'withdrawn' },
      },
      select: { id: true },
    });
    if (existing)
      throw new PubError('PUB_CONFLICT', {
        reason: 'duplicate',
        existingId: existing.id,
      });
    const row = await tx.pubContent.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: ctx.kind,
        redditBriefId: briefId,
        status: 'brief',
        ownerMemberId: ownerMemberId ?? null,
        createdBy: actor,
      },
    });
    return {
      body: await loadContent(tx, product.id, row.id),
      audit: [
        {
          objectType: 'content',
          objectId: row.id,
          action: 'create',
          toStatus: 'brief',
          meta: { kind: row.kind, redditBriefId: briefId },
        },
      ],
    };
  }

  /** Материал Reddit этого продукта (иначе 404). */
  private async material(tx: PubTx, productId: string, contentId: string) {
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId },
    });
    if (!c || !isRedditContentKind(c.kind) || !c.redditBriefId)
      throw new PubError('PUB_NOT_FOUND');
    return c;
  }

  /**
   * Ручной перезапуск `reddit_policy` (`POST …/reddit/contents/:cid/check`):
   * текущая замороженная версия, иначе согласованная.
   */
  async recheck(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    actor: string,
    now: Date,
  ): Promise<OpOut<QaCheckView>> {
    const c = await this.material(tx, product.id, contentId);
    const ids = [c.currentVersionId, c.approvedVersionId].filter(
      (x): x is string => !!x,
    );
    const frozen = ids.length
      ? await tx.pubContentVersion.findMany({
          where: {
            id: { in: ids },
            productId: product.id,
            frozenAt: { not: null },
          },
          select: { id: true },
        })
      : [];
    const versionId = ids.find((id) => frozen.some((f) => f.id === id));
    if (!versionId)
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content_version',
        from: 'draft',
        to: 'qa',
        allowed: [],
        hint: 'submit_first',
      });
    const w = await writeRedditPolicyCheck(
      this.ports,
      tx,
      product,
      versionId,
      now,
      'manual',
    );
    // Отрицательный итог ПОСЛЕ согласования — как отрицательный QA человека
    // (аудит P-B1 S0-1): каскад `stale_check` по решённой версии.
    let tasksOpened = 0;
    if (w.check.result !== 'pass') {
      const decided = await decidedVersionIds(tx, product.id, [versionId]);
      if (decided.length) {
        const r = await this.cascades.run(tx, product, {
          reason: 'stale_check',
          triggerRef: `qa:${w.view.id}`,
          versionIds: decided,
          critical: false,
          actor,
          now,
        });
        tasksOpened = r.tasksOpened;
      }
    }
    return {
      body: w.view,
      audit: [{ ...w.audit, meta: { ...(w.audit.meta ?? {}), tasksOpened } }],
    };
  }

  /**
   * Копирование утверждённого текста (§M2.6, Р-RD-54): точный текст
   * согласованной версии + `copyToken`; первое копирование — переход
   * `schedule` (PO/OP), повторное — только аудит `copy`. Исходящих
   * запросов нет (A11).
   */
  async copy(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    actors: Actor[],
    now: Date,
    b: Body = {},
  ): Promise<OpOut<RedditCopyView>> {
    const is = new Issues();
    for (const k of Object.keys(b))
      if (!['opKey', 'acknowledgedWarnings'].includes(k))
        is.add(k, 'unknown_field');
    const ack = ackCodes(is, b.acknowledgedWarnings);
    is.throwIfAny();
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_contents" WHERE "id" = ${contentId} AND "productId" = ${product.id} FOR UPDATE`;
    const c = await this.material(tx, product.id, contentId);
    const from = c.status as ContentStatus;
    if (!COPY_FROM.includes(from) || !c.approvedVersionId)
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from,
      });
    // Гейт копирования (Р-RD-9): параметры продукта, не сайта.
    await this.ports.gates().assertOpen(tx, product, 'reddit_publish', now);
    const versionId = c.approvedVersionId;
    // Р-RD-66: бриф `draft`/`archived` — копирование остановлено.
    await assertRedditBriefReadyFor(this.ports, tx, product, versionId);
    await assertRedditRulesFresh(this.ports, tx, product, versionId, now);
    const policy = await writeRedditPolicyCheck(
      this.ports,
      tx,
      product,
      versionId,
      now,
      'copy',
    );
    // Согласование активно, hash актуален, блокеры (в т. ч. свежая
    // `reddit_policy`) — те же, что при согласовании и публикации.
    const { approvalId, hash } = await this.contents.recheckPublishable(
      tx,
      product,
      versionId,
    );
    // Аудит M2 S3-3 (Р-RD-69): WARN, появившиеся после согласования
    // (дубль, новый снимок…), подтверждает копирующий: коды проверки ⊆
    // подтверждённых при согласовании ∪ `acknowledgedWarnings` копирования.
    const approvedAck = await this.approvalAck(tx, product.id, approvalId);
    const missingAck = policy.check.warnings
      .map((w) => w.code)
      .filter((code) => !approvedAck.has(code) && !(ack ?? []).includes(code))
      .sort();
    if (missingAck.length) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'warnings_not_acknowledged',
        codes: missingAck,
        // раунд 4 (аудит экранов S3-4): состав с параметрами, не текст
        warnings: policy.check.warnings
          .filter((w) => missingAck.includes(w.code))
          .map((w) => ({ code: w.code, params: w.params ?? {} })),
      });
    }
    const ctx = await this.ports
      .reddit()
      .materialContext(tx, product, c.redditBriefId!);
    const v = await tx.pubContentVersion.findFirstOrThrow({
      where: { id: versionId, productId: product.id },
      select: { title: true, body: true, meta: true },
    });
    const audit: AuditInput[] = [policy.audit];
    let scheduled = false;
    if (from === 'approved') {
      assertTransition(CONTENT_MACHINE, from, 'scheduled', { actors });
      const n = await tx.pubContent.updateMany({
        where: { id: c.id, revision: c.revision, status: 'approved' },
        data: { status: 'scheduled', revision: { increment: 1 } },
      });
      if (n.count !== 1)
        throw new PubError('PUB_CONFLICT', { currentRevision: c.revision + 1 });
      scheduled = true;
      audit.push({
        objectType: 'content',
        objectId: c.id,
        action: 'transition',
        fromStatus: from,
        toStatus: 'scheduled',
        meta: { cause: 'reddit_copy', versionId },
        occurredAt: now,
      });
    }
    const copyToken = sha256Hex(`${hash}:${now.toISOString()}`);
    const meta = (v.meta ?? {}) as Record<string, unknown>;
    const snapshot = await this.snapshotOf(
      tx,
      product.id,
      ctx.currentSnapshotId,
    );
    audit.push({
      objectType: 'content',
      objectId: c.id,
      action: 'copy',
      meta: {
        versionId,
        versionHash: hash,
        approvalId,
        // Ключ `token` запрещён в meta аудита, значения-хеши — под `…Hash`
        // (pii-guard); то же значение, что `copyToken` ответа.
        copyHash: copyToken,
        policyCheckId: policy.view.id,
        ruleSnapshotId: ctx.currentSnapshotId,
        scheduled,
        acknowledgedWarnings: [...new Set(ack ?? [])].sort(),
      },
      occurredAt: now,
    });
    const contentType: RedditContentType =
      c.kind === 'reddit_post' ? 'post' : 'comment';
    return {
      body: {
        contentId: c.id,
        versionId,
        versionHash: hash,
        contentType,
        title: contentType === 'post' ? v.title : null,
        body: v.body,
        flairSuggestion:
          typeof meta.flairSuggestion === 'string'
            ? meta.flairSuggestion
            : null,
        disclosure: typeof meta.disclosure === 'string' ? meta.disclosure : '',
        openUrl:
          contentType === 'comment' && ctx.threadUrl
            ? ctx.threadUrl
            : ctx.canonicalUrl,
        copyToken,
        copiedAt: now.toISOString(),
        scheduled,
        policyCheckId: policy.view.id,
        rules: snapshot,
      },
      audit,
    };
  }

  /** Коды WARN, подтверждённые при согласовании (meta аудита `approve`). */
  private async approvalAck(
    tx: PubTx,
    productId: string,
    approvalId: string,
  ): Promise<Set<string>> {
    const e = await tx.pubAuditEvent.findFirst({
      where: {
        productId,
        objectType: 'approval',
        objectId: approvalId,
        action: 'approve',
      },
      select: { meta: true },
    });
    const a = (e?.meta as { acknowledgedWarnings?: unknown } | null)
      ?.acknowledgedWarnings;
    return new Set(
      Array.isArray(a)
        ? a.filter((x): x is string => typeof x === 'string')
        : [],
    );
  }

  private async snapshotOf(
    tx: PubTx,
    productId: string,
    id: string | null,
  ): Promise<RedditCopyView['rules']> {
    if (!id)
      throw new PubError('PUB_BLOCKERS_OPEN', {
        blockers: [{ code: 'reddit_policy_block' }],
      });
    const s = await tx.pubRedditRuleSnapshot.findFirstOrThrow({
      where: { id, productId },
      select: { id: true, version: true, checkedAt: true },
    });
    return {
      snapshotId: s.id,
      version: s.version,
      checkedAt: s.checkedAt.toISOString(),
    };
  }

  /**
   * Каскад Reddit-материалов сообществ при новом снимке правил или отзыве
   * первоисточника текущего снимка (хвост M2 (3), Р-RD-50): решённые версии
   * — общий `stale_check` (согласование неопубликованной → `superseded`,
   * опубликованный материал → `correction_required` + задача). Аудит
   * переходов пишет каскад; возвращается сводка.
   */
  async onRulesChanged(
    tx: PubTx,
    product: ProductRef,
    communityIds: readonly string[],
    triggerRef: string,
    actor: string,
    now: Date,
  ): Promise<{ approvalsSuperseded: number; correctionRequired: number }> {
    const decided = await redditDecidedVersions(tx, product.id, communityIds);
    if (!decided.length)
      return { approvalsSuperseded: 0, correctionRequired: 0 };
    const r = await this.cascades.run(tx, product, {
      reason: 'stale_check',
      triggerRef,
      versionIds: decided,
      critical: false,
      actor,
      now,
    });
    return {
      approvalsSuperseded: r.approvalsSuperseded.length,
      correctionRequired: r.correctionRequired.length,
    };
  }
}
