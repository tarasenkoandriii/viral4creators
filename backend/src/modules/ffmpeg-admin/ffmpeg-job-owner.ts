/**
 * Владелец задачи ffmpeg в продуктовой БД — для ссылки «к исходной
 * операции» в карточке вкладки «FFmpeg» (ТЗ v1.1 §13.1 п.3).
 *
 * Ищется только по индексированным колонкам с id задачи (индексы —
 * миграция 20270126090000). Задачи, чей id живёт в JSON сессии
 * (постобработка, субтитры аватара, автоэкспорт) или нигде не
 * сохраняется (постер публичной страницы), владельца не получают —
 * полный проход по сессиям ради ссылки не делается. Только чтение:
 * приёмка материалов и их статусы здесь не меняются.
 */

import { PrismaService } from '../../prisma/prisma.service';

export interface FfmpegJobOwner {
  kind:
    | 'story-render'
    | 'tutorial-asset'
    | 'tutorial-version'
    | 'tutorial-quality'
    | 'portfolio-item'
    | 'audio-track';
  id: string;
  label: string;
  /** Путь страницы админки (без хоста). */
  href: string;
}

type OwnerPrisma = Pick<
  PrismaService,
  | 'storyVideoRender'
  | 'tutorialVideoAsset'
  | 'tutorialVideoVersion'
  | 'tutorialDemoQualityCheck'
  | 'portfolioItem'
  | 'videoAudioTrack'
>;

export async function findFfmpegJobOwners(
  prisma: OwnerPrisma,
  jobId: string,
): Promise<FfmpegJobOwner[]> {
  const [story, asset, version, quality, portfolio, track] = await Promise.all([
    prisma.storyVideoRender.findFirst({
      where: { jobId },
      select: { id: true, giftId: true },
    }),
    prisma.tutorialVideoAsset.findFirst({
      where: { assemblyJobId: jobId },
      select: { id: true, clientSiteDraftId: true },
    }),
    prisma.tutorialVideoVersion.findFirst({
      where: { jobId },
      select: {
        id: true,
        assetId: true,
        asset: { select: { clientSiteDraftId: true } },
      },
    }),
    prisma.tutorialDemoQualityCheck.findFirst({
      where: { signalsJobId: jobId },
      select: {
        id: true,
        assetId: true,
        asset: { select: { clientSiteDraftId: true } },
      },
    }),
    prisma.portfolioItem.findFirst({
      where: { watermarkJobId: jobId },
      select: { id: true },
    }),
    prisma.videoAudioTrack.findFirst({
      where: { mixJobId: jobId },
      select: { id: true, sessionId: true, locale: true },
    }),
  ]);
  const owners: FfmpegJobOwner[] = [];
  if (story)
    owners.push({
      kind: 'story-render',
      id: story.id,
      label: `Story-Tales: сборка подарка ${story.giftId}`,
      href: `/story-tales?gift=${encodeURIComponent(story.giftId)}`,
    });
  if (asset)
    owners.push({
      kind: 'tutorial-asset',
      id: asset.id,
      label: asset.clientSiteDraftId
        ? `Tutorial сайта клиента: черновик ${asset.clientSiteDraftId}`
        : `Tutorial: ролик ${asset.id}`,
      href: asset.clientSiteDraftId
        ? `/site-tutorial-drafts?open=${encodeURIComponent(asset.clientSiteDraftId)}`
        : `/assistant?tab=videos&asset=${encodeURIComponent(asset.id)}`,
    });
  if (version)
    owners.push({
      kind: 'tutorial-version',
      id: version.id,
      label: `Tutorial: версия ${version.id} ролика ${version.assetId}`,
      href: version.asset?.clientSiteDraftId
        ? `/site-tutorial-drafts?open=${encodeURIComponent(version.asset.clientSiteDraftId)}`
        : `/assistant?tab=videos&asset=${encodeURIComponent(version.assetId)}`,
    });
  if (quality)
    owners.push({
      kind: 'tutorial-quality',
      id: quality.id,
      label: `Проверка качества демо ${quality.id}`,
      href: quality.asset?.clientSiteDraftId
        ? `/site-tutorial-drafts?open=${encodeURIComponent(quality.asset.clientSiteDraftId)}`
        : `/assistant?tab=videos&asset=${encodeURIComponent(quality.assetId)}`,
    });
  if (portfolio)
    owners.push({
      kind: 'portfolio-item',
      id: portfolio.id,
      label: `Портфолио: работа ${portfolio.id}`,
      href: `/portfolio-items?item=${encodeURIComponent(portfolio.id)}`,
    });
  if (track)
    owners.push({
      kind: 'audio-track',
      id: track.id,
      label: `Звуковая дорожка ${track.locale} сессии ${track.sessionId}`,
      href: `/sessions/${encodeURIComponent(track.sessionId)}`,
    });
  return owners;
}
