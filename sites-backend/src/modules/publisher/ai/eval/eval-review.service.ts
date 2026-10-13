/**
 * AI Publisher — разбор результатов набора 30 задач человеком (P-B2,
 * проектный документ §12.6, §11.3 «eval-runs»; аудит P2-20, P3-13).
 * Только в кабинете продукта `kind=eval` (ED, PO — `ai.eval.review`).
 *
 *  - флаг автопроверки: человек подтверждает (`confirmed`) или снимает
 *    (`dismissed`) с объяснением; решения дописываются (история), текущее
 *    — последнее по флагу;
 *  - оценка: только после разбора КАЖДОГО флага; при жёстком провале
 *    `criticalPass` может быть только `false` (провал без участия
 *    человека); объяснение обязательно; второй оценщик записывается
 *    отдельно (`secondReviewerMemberId`) и НЕ перезаписывает первого:
 *    оценки сводятся по «И», объяснение дописывается (аудит S3-2), третья
 *    оценка — 409; каждая оценка — в журнале;
 *  - первый ответ, жёсткие провалы и флаги не меняются (триггер
 *    append-only); прогон — основание `passed`-конфигурации — не меняется
 *    вовсе (триггер).
 */
import { Injectable } from '@nestjs/common';
import type { EvalRunSummary } from '../../contracts/ai-api';
import { PubError, assertNoIssues, validationError } from '../../core/errors';
import { piiIssues } from '../../core/pii-guard';
import type { AuditInput, ProductRef, PubTx } from '../../core/ports';
import { runSummary } from '../configs.service';
import { loadProtocol, resultRowOf } from './cli-gateway';
import {
  openFlags,
  type FlagResolution,
  type Protocol,
  type ResultRow,
} from './protocol';

function explanationIssues(v: unknown) {
  if (typeof v !== 'string' || v.trim().length < 3 || v.length > 4000) {
    return [
      { field: 'explanation', code: v === undefined ? 'required' : 'length' },
    ];
  }
  return piiIssues({ explanation: v });
}

@Injectable()
export class EvalReviewService {
  async runs(
    db: PubTx,
    productId: string,
  ): Promise<{ items: EvalRunSummary[] }> {
    const rows = await db.pubAiEvalRun.findMany({
      where: { productId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return { items: rows.map(runSummary) };
  }

  protocol(db: PubTx, productId: string, runId: string): Promise<Protocol> {
    return loadProtocol(db, productId, runId);
  }

  private async lockResult(
    tx: PubTx,
    product: ProductRef,
    runId: string,
    resultId: string,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sites"."pub_ai_eval_results"
       WHERE "id" = ${resultId} AND "runId" = ${runId}
         AND "productId" = ${product.id} AND "accountId" = ${product.accountId}
         FOR UPDATE`;
    if (!rows[0]) throw new PubError('PUB_NOT_FOUND');
    const r = await tx.pubAiEvalResult.findFirst({ where: { id: resultId } });
    return resultRowOf(r!);
  }

  async resolveFlag(
    tx: PubTx,
    product: ProductRef,
    runId: string,
    resultId: string,
    flagId: string,
    body: { resolution: unknown; explanation: unknown },
    memberId: string,
    now: Date,
  ): Promise<{ view: ResultRow; audit: AuditInput[] }> {
    if (body.resolution !== 'confirmed' && body.resolution !== 'dismissed') {
      throw validationError([{ field: 'resolution', code: 'enum' }]);
    }
    assertNoIssues(explanationIssues(body.explanation));
    const r = await this.lockResult(tx, product, runId, resultId);
    if (!r.autoFlags.some((f) => f.id === flagId))
      throw new PubError('PUB_NOT_FOUND', { flagId });
    const entry: FlagResolution = {
      flagId,
      resolution: body.resolution,
      explanation: (body.explanation as string).trim(),
      by: `member:${memberId}`,
      at: now.toISOString(),
    };
    await tx.pubAiEvalResult.updateMany({
      where: { id: r.id },
      data: {
        flagResolutions: [...r.flagResolutions, entry] as unknown as object,
      },
    });
    const after = await tx.pubAiEvalResult.findFirst({ where: { id: r.id } });
    return {
      view: resultRowOf(after!),
      audit: [
        {
          objectType: 'ai_eval_result',
          objectId: r.id,
          action: 'resolve',
          reason: entry.explanation,
          meta: { flagId, resolution: entry.resolution, taskCode: r.taskCode },
        },
      ],
    };
  }

  async review(
    tx: PubTx,
    product: ProductRef,
    runId: string,
    resultId: string,
    body: {
      criticalPass: unknown;
      usefulnessPass: unknown;
      explanation: unknown;
    },
    memberId: string,
  ): Promise<{ view: ResultRow; audit: AuditInput[] }> {
    if (typeof body.criticalPass !== 'boolean') {
      throw validationError([{ field: 'criticalPass', code: 'type' }]);
    }
    if (typeof body.usefulnessPass !== 'boolean') {
      throw validationError([{ field: 'usefulnessPass', code: 'type' }]);
    }
    assertNoIssues(explanationIssues(body.explanation));
    const r = await this.lockResult(tx, product, runId, resultId);
    const open = openFlags(r);
    if (open.length) {
      throw new PubError('PUB_VALIDATION', {
        fields: [{ field: 'flags', code: 'unresolved' }],
        openFlags: open,
      });
    }
    if (r.autoHardFail.length && body.criticalPass) {
      throw new PubError('PUB_VALIDATION', {
        fields: [{ field: 'criticalPass', code: 'hard_fail' }],
        hardFails: r.autoHardFail.map((h) => h.code),
      });
    }
    // Аудит S3-2: второй оценщик НЕ перезаписывает первого — оценки
    // сводятся строже (И: провал любого — провал), объяснения дописываются,
    // оба автора остаются. Третьего нет; после второго первый не правит.
    const explanation = (body.explanation as string).trim();
    const second =
      r.reviewerMemberId !== null && r.reviewerMemberId !== memberId;
    if (r.secondReviewerMemberId !== null) {
      throw new PubError('PUB_CONFLICT', {
        resultId: r.id,
        reason: 'already_reviewed_twice',
      });
    }
    const data = second
      ? {
          criticalPass: r.criticalPass === true && body.criticalPass,
          usefulnessPass: r.usefulnessPass === true && body.usefulnessPass,
          explanation:
            `${r.explanation ?? ''}\n— Другий оцінювач: ${explanation}`.slice(
              0,
              4000,
            ),
          secondReviewerMemberId: memberId,
        }
      : {
          criticalPass: body.criticalPass,
          usefulnessPass: body.usefulnessPass,
          explanation,
          reviewerMemberId: memberId,
        };
    const n = await tx.pubAiEvalResult.updateMany({
      where: {
        id: r.id,
        reviewerMemberId: r.reviewerMemberId,
        secondReviewerMemberId: null,
      },
      data,
    });
    if (n.count !== 1) throw new PubError('PUB_CONFLICT', { resultId: r.id });
    const after = await tx.pubAiEvalResult.findFirst({ where: { id: r.id } });
    return {
      view: resultRowOf(after!),
      audit: [
        {
          objectType: 'ai_eval_result',
          objectId: r.id,
          action: 'update',
          reason: explanation,
          meta: {
            taskCode: r.taskCode,
            criticalPass: data.criticalPass,
            usefulnessPass: data.usefulnessPass,
            secondReviewer: second,
          },
        },
      ],
    };
  }
}
