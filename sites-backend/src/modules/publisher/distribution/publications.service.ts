/**
 * AI Publisher, P-C — публикации (проектный документ §6.4 `pub_publications`,
 * §7.1, §7.5, §3.2; ДТ-1; аудит P1-1, P2-7, P2-12).
 *
 *  - запись публикации — по ДЕЙСТВУЮЩЕМУ согласованию этой версии
 *    (`ContentPort.publishableVersion`; триггер ещё раз проверяет hash и
 *    `FOR SHARE` согласования);
 *  - стадия: `live` — только рабочий продукт в режиме `live` (+ гейт
 *    `public_publish` для любого канала и для автоперевода pending →
 *    published); иначе `test` — тестовая публикация не
 *    меняет статус материала на live и не запускает 7 дней наблюдения;
 *  - новая версия по тому же URL: прежняя публикация `published` →
 *    `replaced` (ожидающая → `withdrawn`) в той же транзакции;
 *  - первая live-публикация на сайте ставит t0 эксперимента `pilot`
 *    (`PilotClockPort.setT0Once`), статус материала и `firstPublishedAt` —
 *    `ContentPort.markPublished`;
 *  - автопроверка URL (`publications-verify`) пишет `verifyStatus` и на
 *    показ страницы НЕ влияет; 3 неудачи подряд — задача оператору;
 *  - `PublicationsPort.withdrawForContent` (интеграция Z-1, Р-PUB-Z1-1):
 *    снятие материала редактором (P-B1) снимает все его активные
 *    публикации в той же транзакции.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PUBLISHER_VERSION_META } from '../../../brand';
import { evaluateHostAccess } from '../../site-core/ownership/host-access';
import { pinnedFetch } from '../../site-crawl/net/pinned-fetch';
import type { ProductCtx } from '../contracts/common';
import type { PublicationView } from '../contracts/distribution-api';
import type { PublicationStatus } from '../contracts/states';
import { PubContribution } from '../core/contributions';
import { PubError, validationError } from '../core/errors';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type ProductRef,
  type PubCronContext,
  type PubTx,
  type PublicationsPort,
} from '../core/ports';
import { assertRevision, parseExpectedRevision } from '../core/revision';
import type { PubAccess } from '../core/roles';
import {
  PUBLICATION_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { versionTarget } from './content-read';
import { Fields, canonicalUrl, type Body } from './input';
import { actorsOf, type OpResult, type Step } from './placements.service';

type PublicationRow = Prisma.PubPublicationGetPayload<object>;

export function publicationView(p: PublicationRow): PublicationView {
  return {
    id: p.id,
    versionId: p.versionId,
    channelId: p.channelId,
    approvalId: p.approvalId,
    stage: p.stage as PublicationView['stage'],
    finalUrl: p.finalUrl,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    status: p.status as PublicationView['status'],
    verifyStatus: p.verifyStatus as PublicationView['verifyStatus'],
    evidenceUrl: p.evidenceUrl,
    lastVerifiedAt: p.lastVerifiedAt?.toISOString() ?? null,
    verifiedBy: p.verifiedBy,
    verifyResult: p.verifyResult,
    revision: p.revision,
  };
}

@Injectable()
export class PublicationsService implements PublicationsPort {
  constructor(private readonly ports: PubPorts) {}

  /**
   * Материал снят редактором (§7.1 «публикации переводятся в withdrawn»):
   * все `pending|published` публикации его версий и версий его адаптаций
   * → `withdrawn` (машина 7.3
   * с ролями решающего; стадии и каналы — все). Материал не трогает —
   * его переводит вызывающий (P-B1). Повтор — пустой список.
   */
  async withdrawForContent(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    input: { reason: string; actors: Actor[] },
  ): Promise<Array<{ publicationId: string; fromStatus: string }>> {
    // Адаптации снятой статьи (посты, карточки…) ведут на её страницу —
    // их публикации снимаются вместе с ней (S3-6).
    const children = await tx.pubContent.findMany({
      where: { productId: product.id, parentContentId: contentId },
      select: { id: true },
    });
    const active = await tx.pubPublication.findMany({
      where: {
        productId: product.id,
        status: { in: ['pending', 'published'] },
        version: {
          contentId: { in: [contentId, ...children.map((c) => c.id)] },
        },
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    });
    const out: Array<{ publicationId: string; fromStatus: string }> = [];
    for (const p of active) {
      assertTransition(
        PUBLICATION_MACHINE,
        p.status as PublicationStatus,
        'withdrawn',
        { actors: input.actors },
      );
      const n = await tx.pubPublication.updateMany({
        where: { id: p.id, status: p.status },
        data: { status: 'withdrawn', revision: { increment: 1 } },
      });
      if (n.count === 1)
        out.push({ publicationId: p.id, fromStatus: p.status });
    }
    return out;
  }

  async row(tx: PubTx, productId: string, id: string): Promise<PublicationRow> {
    const p = await tx.pubPublication.findFirst({ where: { id, productId } });
    if (!p) throw new PubError('PUB_NOT_FOUND');
    return p;
  }

  async list(
    tx: PubTx,
    productId: string,
    q: {
      versionId?: string;
      channelId?: string;
      status?: string;
      before?: string;
      limit: number;
    },
  ): Promise<PublicationView[]> {
    const rows = await tx.pubPublication.findMany({
      where: {
        productId,
        ...(q.versionId ? { versionId: q.versionId } : {}),
        ...(q.channelId ? { channelId: q.channelId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    return rows.map(publicationView);
  }

  /** Публикация переведена в `published`: статус материала и t0 (§3.2, ДТ-1). */
  async onPublished(
    tx: PubTx,
    product: ProductRef,
    p: { id: string; versionId: string; stage: string; channelKind: string },
    at: Date,
  ): Promise<void> {
    await this.ports
      .content()
      .markPublished(
        tx,
        product,
        p.versionId,
        p.id,
        p.stage as 'test' | 'live',
        at,
      );
    if (p.stage === 'live' && p.channelKind === 'site') {
      await this.ports.pilotClock().setT0Once(tx, product, at);
    }
  }

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
    opKey: string,
  ): Promise<OpResult<PublicationView>> {
    const f = new Fields();
    const versionId = f.id(b, 'versionId');
    const channelId = f.id(b, 'channelId');
    const finalUrlIn = f.https(b, 'finalUrl', { optional: true });
    const pending = f.bool(b, 'pending') === true;
    f.done();
    if (!versionId || !channelId) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    const target = await versionTarget(tx, product.id, versionId);
    if (!target) throw new PubError('PUB_NOT_FOUND', { field: 'versionId' });
    const channel = await tx.pubChannel.findFirst({
      where: { id: channelId, productId: product.id },
    });
    if (!channel) throw new PubError('PUB_NOT_FOUND', { field: 'channelId' });
    const stage =
      product.kind === 'working' && product.mode === 'live' ? 'live' : 'test';
    let finalUrl: string | null;
    if (channel.kind === 'site') {
      finalUrl = target.siteUrl;
      if (!finalUrl) {
        throw validationError([
          { field: 'finalUrl', code: 'site_url_unknown' },
        ]);
      }
    } else {
      finalUrl = finalUrlIn;
      if (!finalUrl)
        throw validationError([{ field: 'finalUrl', code: 'required' }]);
    }
    // Любая live-публикация — сайт и внешние каналы — под гейтом
    // `public_publish` (§10: гейт блокирует запись Publication(stage=live), S3-3).
    if (stage === 'live') {
      await this.ports
        .gates()
        .assertOpen(tx, product, 'public_publish', step.now);
    }
    finalUrl = canonicalUrl(finalUrl);
    const pv = await this.ports
      .content()
      .publishableVersion(tx, product, versionId);
    if (pv.criticalStale)
      throw new PubError('PUB_CONTENT_STALE', { versionId });
    if (!pv.approvalActive)
      throw new PubError('PUB_APPROVAL_REQUIRED', { versionId });
    if (stage === 'live' && !pv.offerActive) {
      throw new PubError('PUB_APPROVAL_STALE', { reason: 'offer_inactive' });
    }
    if (stage === 'live' && pv.openChangeTasks > 0) {
      throw new PubError('PUB_BLOCKERS_OPEN', {
        openChangeTasks: pv.openChangeTasks,
      });
    }
    const audit: OpResult<PublicationView>['audit'] = [];
    const active = await tx.pubPublication.findMany({
      where: {
        productId: product.id,
        channelId,
        finalUrl,
        stage,
        status: { in: ['pending', 'published'] },
      },
    });
    for (const old of active) {
      if (old.versionId === versionId) {
        throw new PubError('PUB_CONFLICT', {
          publicationId: old.id,
          reason: 'already_published',
        });
      }
      const to: PublicationStatus =
        old.status === 'published' ? 'replaced' : 'withdrawn';
      await tx.pubPublication.updateMany({
        where: { id: old.id, status: old.status },
        data: { status: to, revision: { increment: 1 } },
      });
      audit.push({
        objectType: 'publication',
        objectId: old.id,
        action: 'transition',
        fromStatus: old.status,
        toStatus: to,
        meta: { replacedByVersionId: versionId },
      });
    }
    const row = await tx.pubPublication.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        versionId,
        channelId,
        approvalId: pv.approvalId,
        stage,
        finalUrl,
        publishedAt: pending ? null : step.now,
        status: pending ? 'pending' : 'published',
        opKey,
        createdBy: step.actor,
      },
    });
    if (!pending) {
      await this.onPublished(
        tx,
        product,
        { id: row.id, versionId, stage, channelKind: channel.kind },
        step.now,
      );
    }
    audit.push({
      objectType: 'publication',
      objectId: row.id,
      action: 'create',
      toStatus: row.status,
      meta: { versionId, channelId, stage, approvalId: pv.approvalId },
    });
    return { body: publicationView(row), audit };
  }

  async transition(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PublicationView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const f = new Fields();
    const to = f.oneOf(b, 'to', ['published', 'failed', 'withdrawn'] as const);
    const reason = f.str(b, 'reason', 2000, { optional: true });
    f.done();
    const p = await this.row(tx, product.id, id);
    assertTransition(PUBLICATION_MACHINE, p.status as PublicationStatus, to!, {
      actors: actorsOf(access),
    });
    assertRevision(p.revision, expected);
    if (to === 'withdrawn' && !reason) {
      throw validationError([{ field: 'reason', code: 'required' }]);
    }
    const channel = await tx.pubChannel.findFirst({
      where: { id: p.channelId },
      select: { kind: true },
    });
    if (to === 'published' && p.stage === 'live') {
      await this.ports
        .gates()
        .assertOpen(tx, product, 'public_publish', step.now);
    }
    const r = await tx.pubPublication.updateMany({
      where: { id, revision: expected, status: p.status },
      data: {
        status: to!,
        ...(to === 'published' ? { publishedAt: step.now } : {}),
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    if (to === 'published') {
      await this.onPublished(
        tx,
        product,
        {
          id,
          versionId: p.versionId,
          stage: p.stage,
          channelKind: channel?.kind ?? '',
        },
        step.now,
      );
    }
    if (to === 'withdrawn' && channel?.kind === 'site') {
      // Снять страницу сайта = снять материал (§7.1 «withdrawn»; 410).
      await this.ports
        .content()
        .markWithdrawn(tx, product, p.versionId, reason!);
    }
    return {
      body: publicationView(await this.row(tx, product.id, id)),
      audit: [
        {
          objectType: 'publication',
          objectId: id,
          action: 'transition',
          fromStatus: p.status,
          toStatus: to,
          reason,
        },
      ],
    };
  }

  /** Ручная проверка URL (другие каналы; сайт — ещё и задание). */
  async verify(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PublicationView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const f = new Fields();
    const result = f.oneOf(b, 'result', [
      'ok',
      'mismatch',
      'unreachable',
    ] as const);
    const evidenceUrl = f.https(b, 'evidenceUrl', { optional: true });
    const note = f.str(b, 'note', 2000, { optional: true });
    f.done();
    const p = await this.row(tx, product.id, id);
    assertRevision(p.revision, expected);
    const r = await tx.pubPublication.updateMany({
      where: { id, revision: expected },
      data: {
        verifyStatus: result!,
        lastVerifiedAt: step.now,
        verifiedBy: step.actor,
        verifyResult: note ?? `manual:${result}`,
        ...(evidenceUrl ? { evidenceUrl: canonicalUrl(evidenceUrl) } : {}),
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    return {
      body: publicationView(await this.row(tx, product.id, id)),
      audit: [
        {
          objectType: 'publication',
          objectId: id,
          action: 'update',
          meta: { verifyStatus: result },
        },
      ],
    };
  }
}

// ── Автопроверка страниц сайта (`publications-verify`, tick) ─────────────

export interface PageReadResult {
  ok: boolean;
  status?: number;
  html?: string;
  error?: string;
}

/** Чтение своей страницы; в тестах подменяется (`PUB_PAGE_READER`). */
export interface PublicationPageReader {
  read(url: string): Promise<PageReadResult>;
}
export const PUB_PAGE_READER = 'PUB_PAGE_READER';

/** По умолчанию — `pinnedFetch` (IP-pin, SSRF-проверка, без редиректов наружу). */
export class PinnedPageReader implements PublicationPageReader {
  async read(url: string): Promise<PageReadResult> {
    try {
      const r = await pinnedFetch(url, {
        maxBytes: 512 * 1024,
        timeoutMs: 8000,
        maxRedirects: 2,
        sameOrigin: true,
        truncateAtMaxBytes: true,
        headers: { accept: 'text/html' },
      });
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        html: r.body.toString('utf8'),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).name || 'fetch_error' };
    }
  }
}

/** `<meta name="pub-version" content="<hash>">` страницы (§13.5). */
export function pageVersionOf(html: string): string | null {
  const re = new RegExp(
    `<meta\\s+[^>]*name=["']${PUBLISHER_VERSION_META}["'][^>]*>`,
    'i',
  );
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  return (
    /content=["']([0-9a-f]{64})["']/i.exec(tag)?.[1]?.toLowerCase() ?? null
  );
}

export const VERIFY_FAILS_FOR_TASK = 3;
const RECHECK_MS = 6 * 3_600_000;
const BATCH = 20;

@Injectable()
@PubContribution('cron-job')
export class PublicationsVerifyJob implements CronJob {
  readonly key = 'publications-verify';
  readonly schedule = 'tick' as const;
  private readonly reader: PublicationPageReader;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
    private readonly publications: PublicationsService,
    @Optional() @Inject(PUB_PAGE_READER) reader?: PublicationPageReader,
  ) {
    this.reader = reader ?? new PinnedPageReader();
  }

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher publications-verify: публикации сайта всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const due = await system.$queryRaw<
      Array<{ id: string; accountId: string; productId: string }>
    >`
      SELECT pb."id", pb."accountId", pb."productId"
        FROM "sites"."pub_publications" pb
        JOIN "sites"."pub_channels" ch ON ch."id" = pb."channelId" AND ch."kind" = 'site'
        JOIN "sites"."pub_products" p ON p."id" = pb."productId"
       WHERE pb."status" IN ('pending', 'published')
         AND p."kind" IN ('working', 'test') AND p."status" = 'active'
         AND (pb."lastVerifiedAt" IS NULL OR pb."lastVerifiedAt" < ${new Date(ctx.now.getTime() - RECHECK_MS)}
              OR pb."verifyStatus" <> 'ok')
         ${scope}
       ORDER BY pb."lastVerifiedAt" NULLS FIRST
       LIMIT ${BATCH}`;
    let processed = 0;
    let tasks = 0;
    for (const d of due) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const r = await this.checkOne(d, ctx.now);
      processed++;
      tasks += r ? 1 : 0;
    }
    return { processed, details: { checked: processed, tasks } };
  }

  /** Проверка одной публикации; true — открыта задача оператору. */
  async checkOne(
    d: { id: string; accountId: string; productId: string },
    now: Date,
  ): Promise<boolean> {
    const tenant = this.db.forAccount(d.accountId);
    const pub = await tenant.pubPublication.findFirst({ where: { id: d.id } });
    if (!pub) return false;
    const product = await tenant.pubProduct.findFirst({
      where: { id: d.productId },
      select: { id: true, accountId: true, siteId: true, kind: true },
    });
    if (!product) return false;
    const version = await tenant.pubContentVersion.findFirst({
      where: { id: pub.versionId },
      select: { hash: true },
    });
    const host = new URL(pub.finalUrl).hostname;
    const allowed = await this.hostAllowed(
      tenant,
      product,
      host,
      pub.stage,
      now,
    );
    // Сеть — вне транзакции.
    const page: PageReadResult = allowed
      ? await this.reader.read(pub.finalUrl)
      : { ok: false, error: 'host_not_allowed' };
    const seen = page.ok && page.html ? pageVersionOf(page.html) : null;
    const status = !page.ok
      ? 'unreachable'
      : seen === version?.hash
        ? 'ok'
        : 'mismatch';
    const prevFails = /^fail:(\d+):/.exec(pub.verifyResult ?? '')?.[1];
    const fails = status === 'ok' ? 0 : Number(prevFails ?? 0) + 1;
    const result =
      status === 'ok'
        ? 'ok'
        : `fail:${fails}:${status === 'mismatch' ? `version ${seen ?? 'absent'}` : (page.error ?? `http_${page.status ?? 0}`)}`.slice(
            0,
            2000,
          );
    return tenant.$transaction(async (tx) => {
      const ref = { id: product.id, accountId: product.accountId };
      // Автоперевод pending → published live-публикации — под гейтом
      // `public_publish` (S3-3): при закрытом гейте пишется только
      // результат проверки, публикация остаётся pending.
      const promote =
        status === 'ok' &&
        pub.status === 'pending' &&
        (pub.stage !== 'live' ||
          (await this.ports.gates().evaluate(tx, ref, 'public_publish', now))
            .open);
      const r = await tx.pubPublication.updateMany({
        where: { id: pub.id, revision: pub.revision },
        data: {
          verifyStatus: status,
          lastVerifiedAt: now,
          verifiedBy: 'system:publications-verify',
          verifyResult: result,
          ...(promote ? { status: 'published', publishedAt: now } : {}),
          revision: { increment: 1 },
        },
      });
      if (r.count !== 1) return false;
      if (promote) {
        await this.publications.onPublished(
          tx,
          ref,
          {
            id: pub.id,
            versionId: pub.versionId,
            stage: pub.stage,
            channelKind: 'site',
          },
          now,
        );
        await this.ports.audit().write(tx, {
          accountId: product.accountId,
          productId: product.id,
          actor: 'system:publications-verify',
          objectType: 'publication',
          objectId: pub.id,
          action: 'transition',
          fromStatus: 'pending',
          toStatus: 'published',
          occurredAt: now,
        });
      }
      if (fails >= VERIFY_FAILS_FOR_TASK) {
        const n = await this.ports.review().open(
          tx,
          ref,
          [
            {
              objectType: 'publication',
              objectId: pub.id,
              reason: 'publication_unverified',
              triggerRef: `publications-verify:${pub.id}`,
              severity: 'normal',
            },
          ],
          { actor: 'system:publications-verify' },
        );
        return n > 0;
      }
      return false;
    });
  }

  private async hostAllowed(
    tenant: ReturnType<SitesDb['forAccount']>,
    product: { id: string; siteId: string },
    host: string,
    stage: string,
    now: Date,
  ): Promise<boolean> {
    const hosts = await tenant.siteHost.findMany({
      where: { siteId: product.siteId, host },
      select: {
        id: true,
        accountId: true,
        host: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
        reverifyBlockedAt: true,
        scheme: true,
      },
    });
    if (
      hosts.some(
        (h) =>
          h.scheme === 'https' &&
          evaluateHostAccess(h, 'publisher-public', now).ok,
      )
    ) {
      return true;
    }
    if (stage !== 'test') return false;
    const p = await tenant.pubParameter.findFirst({
      where: { productId: product.id, key: 'test_hosts' },
      select: { value: true },
    });
    const list = Array.isArray(p?.value) ? (p.value as unknown[]) : [];
    return list.some((o) => {
      try {
        return typeof o === 'string' && new URL(o).hostname === host;
      } catch {
        return false;
      }
    });
  }
}
