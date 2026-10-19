/**
 * AI Publisher, P-B1 × P-R M2 — запись проверки `reddit_policy`
 * (reddit-manual-mvp-adapted.md §M2.4, Р-RD-8, Р-RD-50/51). Правила
 * считает P-R (`REDDIT_PORT` → `reddit/checks.ts`, детерминированно, без
 * LLM), строку `pub_qa_checks` пишет пакет-владелец таблицы (P-B1): актёр
 * `system:reddit-policy`, BLOCK — `blockers` + `fail`, WARN — `warnings`,
 * версия словарей (`markers@N`) — `rulesVersion` (IA-AB-08, Р-IA-FXC-4).
 *
 * Пишется при заморозке версии (`submit`), перед согласованием и перед
 * копированием (в транзакции операции: отказ откатывает и строку) и по
 * `POST …/reddit/contents/:cid/check` (фиксируется всегда).
 */
import type { Prisma } from '@prisma/client';
import type { QaCheckView } from '../contracts/content-api';
import { PubError } from '../core/errors';
import type { Issues } from './input';
import type {
  AuditInput,
  ProductRef,
  PubPorts,
  PubTx,
  RedditPolicyCheck,
  RedditRulesStale,
} from '../core/ports';
import { qaView } from './views';

export const REDDIT_POLICY_ACTOR = 'system:reddit-policy';

export interface WrittenPolicyCheck {
  check: RedditPolicyCheck;
  view: QaCheckView;
  audit: AuditInput;
}

export async function writeRedditPolicyCheck(
  ports: PubPorts,
  tx: PubTx,
  product: ProductRef,
  versionId: string,
  now: Date,
  trigger: 'submit' | 'approve' | 'copy' | 'manual',
): Promise<WrittenPolicyCheck> {
  const check = await ports.reddit().check(tx, product, versionId, now);
  const row = await tx.pubQaCheck.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      versionId,
      kind: 'reddit_policy',
      result: check.result,
      blockers: check.blockers as unknown as Prisma.InputJsonArray,
      warnings: check.warnings as unknown as Prisma.InputJsonArray,
      // IA-AB-08: какими словарями получен BLOCK/WARN (markers@N).
      rulesVersion: check.rulesVersion,
      checkedBy: REDDIT_POLICY_ACTOR,
      checkedAt: now,
      selfReview: false,
      createdBy: REDDIT_POLICY_ACTOR,
    },
  });
  return {
    check,
    view: qaView(row),
    audit: {
      objectType: 'qa_check',
      objectId: row.id,
      action: 'create',
      toStatus: row.result,
      meta: {
        versionId,
        kind: 'reddit_policy',
        trigger,
        ruleSnapshotId: check.snapshotId,
        blockers: check.blockers.map((b) => b.code),
        warnings: check.warnings.map((w) => w.code),
      },
    },
  };
}

/**
 * Снимок правил версии всё ещё действует (§M2.6): иначе согласование и
 * копирование недействительны — нужна новая версия на текущем снимке
 * (`PUB_APPROVAL_STALE {reason:'rules_changed'|'rules_stale'}`).
 */
export async function assertRedditRulesFresh(
  ports: PubPorts,
  tx: PubTx,
  product: ProductRef,
  versionId: string,
  now: Date,
): Promise<void> {
  const stale: RedditRulesStale | null = await ports
    .reddit()
    .rulesStale(tx, product, versionId, now);
  if (stale) {
    throw new PubError('PUB_APPROVAL_STALE', {
      reason: stale.reason,
      versionId,
      ruleSnapshotId: stale.ruleSnapshotId,
      currentSnapshotId: stale.currentSnapshotId,
    });
  }
}

/**
 * Р-RD-66 (аудит M2 S2-1, S3-5, S3-6): заморозка, согласование и
 * копирование Reddit-версии — только при готовом брифе (`ready`, `missing`
 * пуст): бриф в `draft` (правка после версии) или `archived` — 409
 * `PUB_BRIEF_NOT_READY {missing:['brief_ready', …]}`.
 */
export async function assertRedditBriefReadyFor(
  ports: PubPorts,
  tx: PubTx,
  product: ProductRef,
  versionId: string,
): Promise<void> {
  const v = await tx.pubContentVersion.findFirst({
    where: { id: versionId, productId: product.id },
    select: { content: { select: { redditBriefId: true } } },
  });
  if (!v?.content.redditBriefId) throw new PubError('PUB_NOT_FOUND');
  const ctx = await ports
    .reddit()
    .materialContext(tx, product, v.content.redditBriefId);
  if (ctx.briefStatus !== 'ready' || ctx.briefMissing.length) {
    throw new PubError('PUB_BRIEF_NOT_READY', {
      missing:
        ctx.briefStatus !== 'ready'
          ? ['brief_ready', ...ctx.briefMissing]
          : ctx.briefMissing,
    });
  }
}

/** `acknowledgedWarnings`: ≤ 20 кодов WARN (`reddit_*`). */
export function ackCodes(is: Issues, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > 20 ||
    !raw.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x))
  ) {
    is.add('acknowledgedWarnings', 'type');
    return undefined;
  }
  return raw as string[];
}
