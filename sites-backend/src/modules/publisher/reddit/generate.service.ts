/**
 * AI Publisher, P-R M2 — генерация черновиков Reddit `pub.reddit.draft`
 * (reddit-manual-mvp-adapted.md §M2.3; Р-RD-15…17, Р-RD-56). Маршрут
 * `POST …/reddit/briefs/:id/generate` (`ai.generate`: PO, ED).
 *
 * Порядок (до вызова шлюза ничего не пишется):
 *  1. флаг `PUBLISHER_REDDIT_AI_ENABLED` выключен → 409 `PUB_AI_DISABLED
 *     {generator, manual:true}` без записи вызова (ручной редактор);
 *  2. бриф готов (`ready`, `missing` пуст) — иначе `PUB_BRIEF_NOT_READY`;
 *  3. гейт правил сообщества сейчас `ok` — иначе `PUB_TRANSITION_INVALID
 *     {reason:'policy_block'|'policy_recheck', reasons}` (деньги не тратим);
 *  4. шлюз P-B2 (`AiGatewayService.startSync`): генератор выключен в коде
 *     до eval 2.3 (`disabled` → `PUB_AI_DISABLED {manual:true}`; на стенде
 *     E2E — fake-провайдер `PUBLISHER_STAND_FAKE_AI`, Р-RD-73), гейт
 *     `ai_use`, лимит генераций задачи, бюджет (`PUB_AI_BUDGET {reason:
 *     month_not_open|cap_exhausted}`, Р-RD-ADM-15), маска ПД, схема, находки.
 *     Задача генерации — бриф (`reddit_brief`); «перегенерировать абзац» —
 *     ОТДЕЛЬНАЯ задача черновика (`content_version`, id версии; раунд 2
 *     M2, Р-RD-83): выбор варианта закрывает задачу брифа, а переписывание
 *     абзаца после этого остаётся доступным и списывает генерацию по общим
 *     правилам.
 * Результат — предложение: варианты в `pub_ai_calls.output`, версию создаёт
 * человек (`POST …/contents/:cid/versions` с `aiCallId` + `variantIndex`).
 * Ошибка модели черновиков не трогает: вызов в журнале, версии нет (§M2.7).
 */
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import { publisherRedditAiEnabled } from '../../../config/publisher-env';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { aiBudgetReasonOf, errorCodeOfStatus } from '../ai/gateway-core';
import {
  REDDIT_DRAFT_TEMPLATES,
  type RedditDraftInput,
  type RedditDraftTemplate,
} from '../ai/generators/reddit-draft.generator';
import { OP_KEY_RE, type ProductCtx } from '../contracts/common';
import type { RedditGenerateResponse } from '../contracts/reddit-api';
import type { RedditAffiliation, RedditContentType } from '../contracts/states';
import { has, Issues, type Body } from '../content/input';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { keyPointSourceIds } from './brief-rules';
import { profileRefIssue } from './guards';
import { policyGate } from './policy';
import { briefState } from './reddit-port';
import { currentRules, policySnapshotOf, staleDaysFor } from './views';

const GENERATOR = 'pub.reddit.draft' as const;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Абзацы markdown-текста (разделитель — пустая строка). */
export function paragraphsOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

@Injectable()
export class RedditGenerateService {
  constructor(
    private readonly db: SitesDb,
    private readonly gateway: AiGatewayService,
  ) {}

  async generate(
    product: ProductCtx,
    memberId: string,
    briefId: string,
    raw: Body,
    res: Response,
  ): Promise<RedditGenerateResponse> {
    if (!publisherRedditAiEnabled()) {
      throw new PubError('PUB_AI_DISABLED', {
        generator: GENERATOR,
        manual: true,
      });
    }
    const is = new Issues();
    for (const k of Object.keys(raw))
      if (!['opKey', 'template', 'variants', 'request', 'rewrite'].includes(k))
        is.add(k, 'unknown_field');
    if (typeof raw.opKey !== 'string' || !OP_KEY_RE.test(raw.opKey))
      is.add('opKey', raw.opKey === undefined ? 'required' : 'format');
    const template = is.oneOf(raw, 'template', REDDIT_DRAFT_TEMPLATES, true) as
      RedditDraftTemplate | undefined;
    const variants = has(raw, 'variants')
      ? is.int(raw, 'variants', { min: 2, max: 3 })
      : 3;
    const request = is.str(raw, 'request', { max: 1000, pii: true });
    profileRefIssue(is, 'request', request);
    let rewrite: { versionId: string; paragraph: number } | null = null;
    if (raw.rewrite !== undefined && raw.rewrite !== null) {
      const r = raw.rewrite as Record<string, unknown>;
      if (
        typeof r !== 'object' ||
        Array.isArray(r) ||
        typeof r.versionId !== 'string' ||
        !Number.isSafeInteger(r.paragraph) ||
        (r.paragraph as number) < 0 ||
        (r.paragraph as number) > 199
      )
        is.add('rewrite', 'type');
      else
        rewrite = { versionId: r.versionId, paragraph: r.paragraph as number };
    }
    is.throwIfAny();
    const db = this.db.forAccount(product.accountId) as unknown as PubTx;
    const st = await briefState(db, product.id, briefId);
    if (st.brief.status !== 'ready' || st.missing.length) {
      throw new PubError('PUB_BRIEF_NOT_READY', {
        missing:
          st.brief.status !== 'ready'
            ? ['brief_ready', ...st.missing]
            : st.missing,
      });
    }
    const rules = (await currentRules(db, product.id, [st.community.id])).get(
      st.community.id,
    );
    const now = new Date();
    const contentType = st.brief.contentType as RedditContentType;
    const gate = policyGate(
      rules ? policySnapshotOf(rules.snap, rules.sourceRevoked) : null,
      now,
      await staleDaysFor(db, product.id),
      contentType,
      false,
    );
    if (gate.verdict !== 'ok') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: gate.verdict === 'block' ? 'policy_block' : 'policy_recheck',
        reasons: gate.reasons,
      });
    }
    let rewriteInput: RedditDraftInput['rewrite'] = null;
    if (rewrite) {
      const v = await db.pubContentVersion.findFirst({
        where: {
          id: rewrite.versionId,
          productId: product.id,
          status: 'draft',
          content: { redditBriefId: briefId },
        },
        select: { body: true },
      });
      if (!v)
        throw validationError([
          { field: 'rewrite.versionId', code: 'not_found' },
        ]);
      if (rewrite.paragraph >= paragraphsOf(v.body).length)
        throw validationError([{ field: 'rewrite.paragraph', code: 'range' }]);
      rewriteInput = { body: v.body, paragraph: rewrite.paragraph };
    }
    const excerpt = st.opportunity?.excerptSourceId
      ? await db.pubSource.findFirst({
          where: { id: st.opportunity.excerptSourceId, productId: product.id },
          select: { fragment: true, usage: true, injectionFlag: true },
        })
      : null;
    // Контекст — только разрешённые источники продукта из тезисов брифа;
    // выдержка треда — не источник (restricted, Р-RD-4), она в `thread`.
    const ids = keyPointSourceIds(st.keyPoints);
    const allowed = ids.length
      ? await db.pubSource.findMany({
          where: {
            productId: product.id,
            id: { in: ids },
            usage: 'allowed',
            origin: 'content',
          },
          select: { id: true },
        })
      : [];
    const input: RedditDraftInput = {
      template: template!,
      contentType,
      variants: (variants ?? 3) as 2 | 3,
      brief: {
        objective: st.brief.objective,
        audience: st.brief.audience,
        keyPoints: st.keyPoints,
        affiliation: st.brief.affiliation as RedditAffiliation,
        brand: st.brief.brand,
        tone: st.brief.tone,
        language: st.brief.language,
        constraints: strArray(st.brief.constraints),
        forbiddenClaims: strArray(st.brief.forbiddenClaims),
        cta: st.brief.cta,
        linksAllowed: st.brief.linksAllowed,
      },
      community: {
        name: st.community.name,
        rules: rules
          ? {
              promotionPolicy: rules.snap.promotionPolicy,
              linksPolicy: rules.snap.linksPolicy,
              flairRequired: rules.snap.flairRequired,
              conditions: strArray(rules.snap.conditions),
            }
          : null,
      },
      thread: st.opportunity
        ? {
            title: st.opportunity.titleManual,
            excerpt:
              excerpt && excerpt.usage !== 'revoked' ? excerpt.fragment : null,
            injectionFlag:
              excerpt && excerpt.usage !== 'revoked'
                ? excerpt.injectionFlag
                : null,
          }
        : null,
      request: request ?? null,
      rewrite: rewriteInput,
    };
    const opened = await this.gateway.startSync({
      product,
      memberId,
      generator: GENERATOR,
      opKey: raw.opKey as string,
      objectType: rewrite ? 'content_version' : 'reddit_brief',
      objectId: rewrite ? rewrite.versionId : briefId,
      input,
      context: { audience: 'internal', sourceIds: allowed.map((s) => s.id) },
    });
    const view = await this.gateway.view(product, opened.callId);
    const missing = opened.missing ?? [];
    const code = errorCodeOfStatus(view.status, missing);
    if (code) {
      throw new PubError(code, {
        callId: view.callId,
        status: view.status,
        taskId: view.taskId,
        generator: view.generator,
        ...(code === 'PUB_AI_DISABLED' ? { manual: true } : {}),
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
}
