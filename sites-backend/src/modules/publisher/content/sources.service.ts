/**
 * AI Publisher, P-B1 — источники (проектный документ §6.3 `pub_sources`,
 * §11.3; F01–F04): ручной ввод разрешённого текста, сохранение импорта
 * URL (`usage=restricted` до решения редактора), метаданные и
 * `restricted → allowed`, неизменяемость содержимого после связи.
 *
 * Правка содержимого (`url`, `fragment`) источника, связанного с
 * замороженной версией или подтверждённым claim, — НОВАЯ строка с
 * `supersedesId` и задачи `claim_changed` по версиям, которые ссылаются на
 * прежнюю (§6.3). Правка метаданных, которые входят в hash версии
 * (`title`, `visibility`), у связанного источника снимает согласования
 * неопубликованных версий и открывает задачу `stale_check`: прежний hash
 * их больше не описывает (контракт P-A1 P2-5).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, PubSource } from '@prisma/client';
import type { SourceKind, SourceView } from '../contracts/content-api';
import {
  SOURCE_FRESHNESS,
  SOURCE_KINDS,
  SOURCE_VISIBILITIES,
} from '../contracts/states';
import { sourceContentHash } from '../core/content-hash';
import { PubError } from '../core/errors';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { ContentCascades } from './cascades';
import { injectionFlagOf, sourceInjectionText } from './command-flags';
import { has, httpsUrl, Issues, type Body } from './input';
import type { ImportedPage } from './source-import';
import { loadSource, sourceLocked } from './views';

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

export interface OpOut<T> {
  body: T;
  audit: AuditInput[];
}

/**
 * Пометка команды в источнике — тот же детектор, что у вызова модели
 * (`content/command-flags.ts`: общий `detectInjection` + правила
 * издателя), по заголовку и фрагменту, как их видит модель (предаудит
 * D1-01): `injectionFlag` в базе и на экране «что увидит AI» совпадает с
 * пометкой в промпте.
 */
function injectionOf(
  title: string | null | undefined,
  fragment: string,
): string | null {
  return injectionFlagOf(sourceInjectionText(title, fragment));
}

@Injectable()
export class SourcesService {
  constructor(private readonly cascades: ContentCascades) {}

  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
    /**
     * Пакет P-R: доказательство Reddit (`origin='reddit'` — первоисточник
     * правил, выдержка треда) и новая редакция (`supersedesId`). Такие строки
     * скрыты из общих `/sources` и неизменны (триггер `pub_reddit_sources_guard`).
     */
    opts: { origin?: 'content' | 'reddit'; supersedesId?: string } = {},
  ): Promise<OpOut<SourceView>> {
    const is = new Issues();
    const kind = is.oneOf(b, 'kind', SOURCE_KINDS, true) as
      SourceKind | undefined;
    const rawUrl = is.str(b, 'url', { max: 2048 });
    let url: string | null = null;
    if (rawUrl) {
      url = httpsUrl(rawUrl);
      if (!url) is.add('url', 'https');
    }
    if (kind === 'url' && !rawUrl) is.add('url', 'required');
    // Р-PUB-Z2-18 (z-pii-scan): заголовок — поле, которое вводит человек;
    // контакт в нём — 400 `pii` (материал источника — `fragment` — нет).
    const title = is.str(b, 'title', { required: true, max: 300, pii: true });
    const author = is.str(b, 'author', { max: 300 });
    const externalRef = is.str(b, 'externalRef', { max: 2000 });
    const publishedOn = is.date(b, 'publishedOn');
    const fragment = is.str(b, 'fragment', {
      required: true,
      max: 20_000,
      trim: false,
    });
    const language = is.str(b, 'language', { max: 35, re: BCP47 });
    const visibility = is.oneOf(b, 'visibility', SOURCE_VISIBILITIES, true);
    const usage = is.oneOf(
      b,
      'usage',
      ['allowed', 'restricted'] as const,
      true,
    );
    is.throwIfAny();
    const row = await tx.pubSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: kind!,
        url,
        externalRef: externalRef ?? null,
        title: title!,
        author: author ?? null,
        publishedOn: publishedOn ?? null,
        fragment: fragment!,
        language: language ?? null,
        usage: usage!,
        visibility: visibility!,
        importedVia: 'manual',
        contentHash: sourceContentHash(url, fragment!),
        injectionFlag: injectionOf(title, fragment!),
        origin: opts.origin ?? 'content',
        supersedesId: opts.supersedesId ?? null,
        createdBy: actor,
      },
    });
    return {
      body: await loadSource(tx, product.id, row.id),
      audit: [
        {
          objectType: 'source',
          objectId: row.id,
          action: 'create',
          toStatus: row.usage,
          meta: {
            kind: row.kind,
            visibility: row.visibility,
            ...(row.origin !== 'content' ? { origin: row.origin } : {}),
            ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
          },
        },
      ],
    };
  }

  /** Запись импорта (страница уже загружена ВНЕ транзакции). */
  async storeImport(
    tx: PubTx,
    product: ProductRef,
    page: ImportedPage,
    visibility: 'public' | 'private',
    actor: string,
  ): Promise<OpOut<SourceView>> {
    const row = await tx.pubSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: 'url',
        url: page.url,
        title: page.title,
        fragment: page.fragment,
        language: page.language,
        usage: 'restricted',
        visibility,
        importedVia: 'url_import',
        freshness: 'current',
        checkedAt: new Date(),
        contentHash: sourceContentHash(page.url, page.fragment),
        injectionFlag: injectionOf(page.title, page.fragment),
        createdBy: actor,
      },
    });
    return {
      body: await loadSource(tx, product.id, row.id),
      audit: [
        {
          objectType: 'source',
          objectId: row.id,
          action: 'import',
          toStatus: 'restricted',
          meta: { truncated: page.truncated, injection: !!row.injectionFlag },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<SourceView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubSource.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    // Аудит P-R S1-1/S1-2: доказательство Reddit (первоисточник правил,
    // выдержка треда) меняется только новой редакцией через маршруты P-R
    // (новый снимок правил, `PATCH …/reddit/opportunities/:id`), не здесь.
    if (cur.origin === 'reddit') {
      throw new PubError('PUB_CONFLICT', { reason: 'reddit_evidence_locked' });
    }
    const is = new Issues();
    const data: Prisma.PubSourceUpdateManyMutationInput = {};
    if (has(b, 'title'))
      data.title = is.str(b, 'title', { max: 300, pii: true }) ?? null;
    if (has(b, 'author'))
      data.author = is.str(b, 'author', { max: 300 }) ?? null;
    if (has(b, 'externalRef')) {
      data.externalRef = is.str(b, 'externalRef', { max: 2000 }) ?? null;
    }
    if (has(b, 'publishedOn'))
      data.publishedOn = is.date(b, 'publishedOn') ?? null;
    if (has(b, 'checkedAt')) data.checkedAt = is.date(b, 'checkedAt') ?? null;
    if (has(b, 'language')) {
      data.language = is.str(b, 'language', { max: 35, re: BCP47 }) ?? null;
    }
    if (has(b, 'visibility')) {
      data.visibility = is.oneOf(b, 'visibility', SOURCE_VISIBILITIES, true);
    }
    if (has(b, 'freshness')) {
      data.freshness = is.oneOf(b, 'freshness', SOURCE_FRESHNESS, true);
    }
    if (has(b, 'usage')) {
      const u = is.oneOf(b, 'usage', ['allowed'] as const, true);
      if (u && cur.usage !== 'restricted' && cur.usage !== 'allowed') {
        // revoked необратим (триггер); allowed → restricted — не здесь.
        throw new PubError('PUB_TRANSITION_INVALID', {
          machine: 'source_usage',
          from: cur.usage,
          to: u,
          allowed: [],
        });
      }
      data.usage = u;
    }
    let newUrl: string | null | undefined;
    if (has(b, 'url')) {
      const raw = is.str(b, 'url', { max: 2048 });
      newUrl = raw ? httpsUrl(raw) : null;
      if (raw && !newUrl) is.add('url', 'https');
    }
    const newFragment = has(b, 'fragment')
      ? is.str(b, 'fragment', { required: true, max: 20_000, trim: false })
      : undefined;
    is.throwIfAny();
    if (cur.usage === 'revoked') {
      throw new PubError('PUB_SOURCE_NOT_ALLOWED', {
        sourceIds: [id],
        reason: 'revoked',
      });
    }
    const url = newUrl !== undefined ? newUrl : cur.url;
    const fragment = newFragment ?? cur.fragment;
    if (cur.kind === 'url' && !url) {
      throw new PubError('PUB_VALIDATION', {
        fields: [{ field: 'url', code: 'required' }],
      });
    }
    const contentChanged = url !== cur.url || fragment !== cur.fragment;
    // Метаданные, которые показывает страница и которые входят в hash версии
    // (аудит P-B1 S1-2): у источника замороженной версии — только новой
    // редакцией, иначе опубликованная страница менялась бы без согласования.
    const shownChanged =
      (data.title !== undefined && data.title !== cur.title) ||
      (data.visibility !== undefined && data.visibility !== cur.visibility);
    if (contentChanged || shownChanged) {
      const newer = await tx.pubSource.findFirst({
        where: { productId: product.id, supersedesId: id },
        select: { id: true },
      });
      if (newer) {
        throw new PubError('PUB_CONFLICT', {
          reason: 'source_superseded',
          sourceId: newer.id,
        });
      }
    }
    const locked = await sourceLocked(tx, id);
    const frozenLinked =
      (await tx.pubVersionSource.count({
        where: { sourceId: id, version: { frozenAt: { not: null } } },
      })) > 0;

    if ((contentChanged && locked) || (shownChanged && frozenLinked)) {
      // Новая редакция — новая строка; прежняя остаётся в истории (и на
      // уже согласованных страницах — без изменений).
      return this.supersede(
        tx,
        product,
        cur,
        { ...data, url, fragment },
        contentChanged,
        expected,
        actor,
        now,
      );
    }
    if (contentChanged) {
      data.url = url;
      data.fragment = fragment;
      data.contentHash = sourceContentHash(url, fragment);
    }
    if (contentChanged || data.title !== undefined) {
      data.injectionFlag = injectionOf(
        data.title !== undefined ? (data.title as string | null) : cur.title,
        fragment,
      );
    }
    await casUpdate(
      tx.pubSource,
      id,
      expected,
      data as Record<string, unknown>,
    );
    const audit: AuditInput[] = [
      {
        objectType: 'source',
        objectId: id,
        action: 'update',
        fromStatus: cur.usage,
        toStatus: (data.usage as string | undefined) ?? cur.usage,
        meta: { fields: Object.keys(data).sort() },
      },
    ];
    return { body: await loadSource(tx, product.id, id), audit };
  }

  private async supersede(
    tx: PubTx,
    product: ProductRef,
    cur: PubSource,
    data: Prisma.PubSourceUpdateManyMutationInput & {
      url: string | null;
      fragment: string;
    },
    contentChanged: boolean,
    expected: number,
    actor: string,
    now: Date,
  ): Promise<OpOut<SourceView>> {
    // Аудит P-B1 S2-3: CAS прежней строки (двигает ревизию, держит
    // блокировку) — параллельная вторая редакция с той же ревизией → 409.
    // `updatedAt` прежней строки не трогаем: её содержимое не менялось
    // (проверки claim → источник по ней остаются действительными).
    await casUpdate(tx.pubSource, cur.id, expected, {
      updatedAt: cur.updatedAt,
    });
    const newer = await tx.pubSource.findFirst({
      where: { productId: product.id, supersedesId: cur.id },
      select: { id: true },
    });
    if (newer) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'source_superseded',
        sourceId: newer.id,
      });
    }
    const pick = <T>(k: keyof typeof data, fallback: T): T =>
      (data[k] !== undefined ? data[k] : fallback) as T;
    const row = await tx.pubSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: cur.kind,
        url: data.url,
        externalRef: pick('externalRef', cur.externalRef),
        title: pick('title', cur.title),
        author: pick('author', cur.author),
        publishedOn: pick('publishedOn', cur.publishedOn),
        fragment: data.fragment,
        language: pick('language', cur.language),
        // Новый текст — снова решение редактора о праве использования;
        // только метаданные (название, видимость) — то же право.
        usage: contentChanged ? 'restricted' : cur.usage,
        visibility: pick('visibility', cur.visibility),
        checkedAt: pick('checkedAt', cur.checkedAt),
        freshness: pick('freshness', cur.freshness),
        importedVia: cur.importedVia,
        contentHash: sourceContentHash(data.url, data.fragment),
        supersedesId: cur.id,
        injectionFlag: injectionOf(
          pick('title', cur.title) as string | null,
          data.fragment,
        ),
        createdBy: actor,
      },
    });
    if (!contentChanged) {
      return {
        body: await loadSource(tx, product.id, row.id),
        audit: [
          {
            objectType: 'source',
            objectId: row.id,
            action: 'create',
            toStatus: row.usage,
            meta: { supersedesId: cur.id, metadataOnly: true },
          },
        ],
      };
    }
    const versionLinks = await tx.pubVersionSource.findMany({
      where: { productId: product.id, sourceId: cur.id },
      select: { versionId: true },
    });
    const claimLinks = await tx.pubClaimSource.findMany({
      where: { productId: product.id, sourceId: cur.id },
      select: { claimId: true },
    });
    const claimVersions = await tx.pubVersionClaim.findMany({
      where: {
        productId: product.id,
        claimId: { in: claimLinks.map((c) => c.claimId) },
      },
      select: { versionId: true },
    });
    await this.cascades.run(tx, product, {
      reason: 'claim_changed',
      triggerRef: `source:${row.id}`,
      versionIds: [
        ...versionLinks.map((l) => l.versionId),
        ...claimVersions.map((l) => l.versionId),
      ],
      critical: false,
      actor,
      now,
    });
    return {
      body: await loadSource(tx, product.id, row.id),
      audit: [
        {
          objectType: 'source',
          objectId: row.id,
          action: 'create',
          toStatus: 'restricted',
          meta: { supersedesId: cur.id },
        },
      ],
    };
  }
}
