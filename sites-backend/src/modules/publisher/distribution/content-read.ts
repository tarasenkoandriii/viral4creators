/**
 * AI Publisher, P-C — чтение контента и параметров, нужных распространению
 * и закупкам (§6.8: читать чужие таблицы можно, писать — только через
 * порт). Статус материала и `firstPublishedAt` пишет P-B1 (`ContentPort`).
 */
import { addKyivCalendarDays } from '../core/kyiv-time';
import type { PubTx } from '../core/ports';

export interface VersionTarget {
  versionId: string;
  contentId: string;
  /** Статья, к которой относится материал (у адаптации — родитель). */
  rootContentId: string;
  slug: string | null;
  criticalStale: boolean;
  /** Страница материала на сайте продукта: https://<domain_host>/materials/<slug>. */
  siteUrl: string | null;
}

export async function domainHostOf(
  tx: PubTx,
  productId: string,
): Promise<string | null> {
  const p = await tx.pubParameter.findFirst({
    where: { productId, key: 'domain_host' },
    select: { value: true },
  });
  const host = (p?.value as { host?: unknown } | null)?.host;
  return typeof host === 'string' && /^[a-z0-9.-]+$/.test(host) ? host : null;
}

/** Версия продукта и её страница на сайте; null — версии в продукте нет. */
export async function versionTarget(
  tx: PubTx,
  productId: string,
  versionId: string,
): Promise<VersionTarget | null> {
  const v = await tx.pubContentVersion.findFirst({
    where: { id: versionId, productId },
    select: { id: true, contentId: true },
  });
  if (!v) return null;
  const c = await tx.pubContent.findFirst({
    where: { id: v.contentId },
    select: {
      id: true,
      slug: true,
      parentContentId: true,
      criticalStale: true,
    },
  });
  if (!c) return null;
  let slug = c.slug;
  let rootContentId = c.id;
  if (!slug && c.parentContentId) {
    const parent = await tx.pubContent.findFirst({
      where: { id: c.parentContentId },
      select: { id: true, slug: true },
    });
    slug = parent?.slug ?? null;
    rootContentId = parent?.id ?? c.id;
  }
  const host = await domainHostOf(tx, productId);
  return {
    versionId: v.id,
    contentId: c.id,
    rootContentId,
    slug,
    criticalStale: c.criticalStale,
    siteUrl: slug && host ? `https://${host}/materials/${slug}` : null,
  };
}

/**
 * Начало 7-дневного бесплатного наблюдения материала (§7.2, ДТ-1) — ОДНО
 * правило для обоих видов продукта (S3-5): самая ранняя первая публикация
 * среди материала и его статьи (адаптация продвигает статью — наблюдение
 * идёт с первой публикации любой из них):
 *  - рабочий продукт — первая live-публикация: `firstPublishedAt`
 *    материалов (пишет P-B1 при live-публикации) и `firstLivePublishedAt`
 *    продвигаемой версии (`ContentPort`);
 *  - продукт `kind=test` — live-публикаций не бывает (триггер), поэтому
 *    первая публикация тестовой стадии в реестре P-C (Р-PUB-C-6: иначе
 *    закупочные сценарии на тестовом стенде, ТЗ §28, невыполнимы).
 * Публикации тестовой стадии рабочего продукта и записи размещений
 * закупок (канал `paid_venue`) началом наблюдения не считаются.
 */
export async function observationStart(
  tx: PubTx,
  product: { id: string; kind: string },
  contentIds: readonly string[],
  firstLivePublishedAt: Date | null,
): Promise<Date | null> {
  if (product.kind !== 'test') {
    const rows = await tx.pubContent.findMany({
      where: {
        productId: product.id,
        id: { in: [...contentIds] },
        firstPublishedAt: { not: null },
      },
      select: { firstPublishedAt: true },
    });
    const dates = [
      firstLivePublishedAt,
      ...rows.map((r) => r.firstPublishedAt),
    ].filter((d): d is Date => d instanceof Date);
    return dates.length
      ? new Date(Math.min(...dates.map((d) => d.getTime())))
      : null;
  }
  const versions = await tx.pubContentVersion.findMany({
    where: { productId: product.id, contentId: { in: [...contentIds] } },
    select: { id: true },
  });
  const first = await tx.pubPublication.findFirst({
    where: {
      productId: product.id,
      versionId: { in: versions.map((v) => v.id) },
      stage: 'test',
      publishedAt: { not: null },
      channel: { kind: { not: 'paid_venue' } },
    },
    orderBy: { publishedAt: 'asc' },
    select: { publishedAt: true },
  });
  return first?.publishedAt ?? null;
}

/** ≥ 7 календарных дней Kyiv с начала наблюдения. */
export function observationPassed(start: Date | null, now: Date): boolean {
  return (
    start !== null && addKyivCalendarDays(start, 7).getTime() <= now.getTime()
  );
}

/** Материал входит в «заранее выбранные» эксперимента `pilot` (ТЗ §13). */
export async function inPilotExperiment(
  tx: PubTx,
  productId: string,
  contentIds: readonly string[],
): Promise<boolean> {
  const pilots = await tx.pubExperiment.findMany({
    where: {
      productId,
      kind: 'pilot',
      status: { in: ['registered', 'running'] },
    },
    select: { id: true },
  });
  if (!pilots.length) return false;
  const n = await tx.pubExperimentContent.count({
    where: {
      productId,
      experimentId: { in: pilots.map((x) => x.id) },
      contentId: { in: [...contentIds] },
    },
  });
  return n > 0;
}
