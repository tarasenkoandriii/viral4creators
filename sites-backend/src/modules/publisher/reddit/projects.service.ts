/**
 * AI Publisher, P-R — проекты Reddit и ключевые запросы (reddit-manual-mvp-
 * adapted.md §M1.1, §M1.5; Р-RD-1). Мутации — внутри `runOperation`
 * (идемпотентность, CAS, аудит в той же транзакции); пишут только свои
 * таблицы `pub_reddit_projects`, `pub_reddit_keywords`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  RedditKeywordView,
  RedditProjectView,
} from '../contracts/reddit-api';
import {
  REDDIT_INTENTS,
  REDDIT_KEYWORD_STATUSES,
  type RedditIntent,
} from '../contracts/states';
import { PubError } from '../core/errors';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { has, Issues, type Body } from '../content/input';
import { assertParentsActive, insertOrDuplicate } from './guards';
import { phraseNorm } from './normalize';
import { keywordView, projectRow, projectView } from './views';

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

export interface OpOut<T> {
  body: T;
  audit: AuditInput[];
}

/** Поле «неизвестное» в теле — 400 `unknown_field` (опечатка не теряется молча). */
export function onlyFields(is: Issues, b: Body, allowed: readonly string[]) {
  for (const k of Object.keys(b))
    if (!allowed.includes(k)) is.add(k, 'unknown_field');
}

export function localeField(
  is: Issues,
  b: Body,
  field: string,
  required: boolean,
): string | null | undefined {
  return is.str(b, field, { required, max: 16, re: BCP47 });
}

@Injectable()
export class RedditProjectsService {
  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<RedditProjectView>> {
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'title', 'locale', 'market']);
    const title = is.str(b, 'title', { required: true, max: 120, pii: true });
    const locale = localeField(is, b, 'locale', true);
    const market = is.str(b, 'market', { required: true, max: 64, pii: true });
    is.throwIfAny();
    const row = await tx.pubRedditProject.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        name: title!,
        locale: locale!,
        market: market!,
        createdBy: actor,
      },
    });
    return {
      body: projectView(row),
      audit: [
        {
          objectType: 'reddit_project',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { locale: row.locale },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<RedditProjectView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await projectRow(tx, product.id, id);
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'expectedRevision',
      'title',
      'locale',
      'market',
    ]);
    const data: Prisma.PubRedditProjectUpdateManyMutationInput = {};
    if (has(b, 'title'))
      data.name =
        is.str(b, 'title', { required: true, max: 120, pii: true }) ??
        undefined;
    if (has(b, 'locale'))
      data.locale = localeField(is, b, 'locale', true) ?? undefined;
    if (has(b, 'market'))
      data.market =
        is.str(b, 'market', { required: true, max: 64, pii: true }) ??
        undefined;
    is.throwIfAny();
    if (cur.status === 'archived') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    }
    await casUpdate(tx.pubRedditProject, id, expected, data);
    const after = await projectRow(tx, product.id, id);
    return {
      body: projectView(after),
      audit: [
        {
          objectType: 'reddit_project',
          objectId: id,
          action: 'update',
          meta: { fields: Object.keys(data) },
        },
      ],
    };
  }

  async archive(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<RedditProjectView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'expectedRevision']);
    is.throwIfAny();
    const cur = await projectRow(tx, product.id, id);
    if (cur.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    }
    await casUpdate(tx.pubRedditProject, id, expected, { status: 'archived' });
    const after = await projectRow(tx, product.id, id);
    return {
      body: projectView(after),
      audit: [
        {
          objectType: 'reddit_project',
          objectId: id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'archived',
        },
      ],
    };
  }

  // ── Ключевые запросы ───────────────────────────────────────────────────

  /** Id запроса с той же нормальной формой (`pub_reddit_phrase_norm`) или null. */
  private async duplicateOf(
    tx: PubTx,
    productId: string,
    projectId: string,
    phrase: string,
    exceptId: string | null,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sites"."pub_reddit_keywords"
       WHERE "productId" = ${productId} AND "projectId" = ${projectId}
         AND "phraseNorm" = "sites"."pub_reddit_phrase_norm"(${phrase})
         AND (${exceptId}::text IS NULL OR "id" <> ${exceptId}::text)
       LIMIT 1`;
    return rows[0]?.id ?? null;
  }

  /** Дубль по нормальной форме базы (`pub_reddit_phrase_norm`) → 409 `{existingId}`. */
  private async assertNoDuplicate(
    tx: PubTx,
    productId: string,
    projectId: string,
    phrase: string,
    exceptId: string | null,
  ): Promise<void> {
    const existingId = await this.duplicateOf(
      tx,
      productId,
      projectId,
      phrase,
      exceptId,
    );
    if (existingId) {
      throw new PubError('PUB_CONFLICT', { reason: 'duplicate', existingId });
    }
  }

  async createKeyword(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<RedditKeywordView>> {
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'projectId',
      'phrase',
      'intent',
      'locale',
      'priority',
    ]);
    const projectId = is.str(b, 'projectId', { required: true, max: 100 });
    const phrase = is.str(b, 'phrase', { required: true, max: 200, pii: true });
    const intent = is.oneOf(b, 'intent', REDDIT_INTENTS, true);
    const locale = localeField(is, b, 'locale', false);
    const priority = is.int(b, 'priority', { min: 1, max: 5, required: true });
    is.throwIfAny();
    const project = await projectRow(tx, product.id, projectId!);
    if (project.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'project_archived',
        from: project.status,
      });
    }
    await this.assertNoDuplicate(tx, product.id, project.id, phrase!, null);
    const row = await insertOrDuplicate(
      tx,
      () =>
        tx.pubRedditKeyword.create({
          data: {
            accountId: product.accountId,
            productId: product.id,
            projectId: project.id,
            phrase: phrase!,
            // Ставит триггер (`pub_reddit_phrase_norm`); здесь — та же форма.
            phraseNorm: phraseNorm(phrase!),
            intent: intent as RedditIntent,
            locale: locale ?? null,
            priority: priority!,
            createdBy: actor,
          },
        }),
      () => this.duplicateOf(tx, product.id, project.id, phrase!, null),
    );
    return {
      body: keywordView(row),
      audit: [
        {
          objectType: 'reddit_keyword',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { projectId: project.id, intent: row.intent },
        },
      ],
    };
  }

  async patchKeyword(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<RedditKeywordView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubRedditKeyword.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'expectedRevision',
      'phrase',
      'intent',
      'locale',
      'priority',
      'status',
    ]);
    const data: Prisma.PubRedditKeywordUpdateManyMutationInput = {};
    if (has(b, 'phrase')) {
      const phrase = is.str(b, 'phrase', {
        required: true,
        max: 200,
        pii: true,
      });
      if (phrase) {
        data.phrase = phrase;
        data.phraseNorm = phraseNorm(phrase);
      }
    }
    if (has(b, 'intent'))
      data.intent = is.oneOf(b, 'intent', REDDIT_INTENTS, true);
    if (has(b, 'locale'))
      data.locale = localeField(is, b, 'locale', false) ?? null;
    if (has(b, 'priority'))
      data.priority =
        is.int(b, 'priority', { min: 1, max: 5, required: true }) ?? undefined;
    if (has(b, 'status'))
      data.status = is.oneOf(b, 'status', REDDIT_KEYWORD_STATUSES, true);
    is.throwIfAny();
    // Запросы архивного проекта не правятся (S3-6).
    await assertParentsActive(tx, product.id, cur.projectId);
    if (typeof data.phrase === 'string') {
      await this.assertNoDuplicate(
        tx,
        product.id,
        cur.projectId,
        data.phrase,
        id,
      );
    }
    const phrase = typeof data.phrase === 'string' ? data.phrase : null;
    await insertOrDuplicate(
      tx,
      () => casUpdate(tx.pubRedditKeyword, id, expected, data),
      async () =>
        phrase
          ? this.duplicateOf(tx, product.id, cur.projectId, phrase, id)
          : null,
    );
    const after = await tx.pubRedditKeyword.findFirstOrThrow({
      where: { id, productId: product.id },
    });
    return {
      body: keywordView(after),
      audit: [
        {
          objectType: 'reddit_keyword',
          objectId: id,
          action: 'update',
          fromStatus: cur.status,
          toStatus: after.status,
          meta: { fields: Object.keys(data) },
        },
      ],
    };
  }
}
