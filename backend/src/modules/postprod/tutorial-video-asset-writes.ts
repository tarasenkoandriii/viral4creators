/**
 * Записи в строку ролика обучалки из постпродакшена (темп, 06.10.2026) —
 * отдельным файлом и намеренно короткие.
 *
 * Строку `TutorialVideoAsset` читают синхронизация сайта помощника,
 * консультант, лендинг и экран мастера. Постпродакшен меняет в ней ровно
 * две вещи: монтажный manifest (исходники перенесены из транзита) и
 * активную версию — файл, длительность и указатель. Всё остальное —
 * статус сборки, одобрение, отпечаток — остаётся за сборкой и
 * оператором.
 *
 * Длительность пишется только из плана версии (`plan.durationMs`) —
 * тот же шов, что у обоих писателей сборки (`scripts/check-docs.mjs`).
 */

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ActivationPlan,
  TutorialTimelineManifest,
} from '../tutorial-runner/tutorial-manifest';

/**
 * Сделать файл версии (или исходный, `versionId: null`) тем, что отдаётся
 * потребителям ролика. Compare-and-set по статусу: несобранный или
 * проваленный ролик активацией не «оживает».
 */
export async function activateOnAsset(
  prisma: PrismaService,
  assetId: string,
  target: { versionId: string | null; blobUrl: string; plan: ActivationPlan },
): Promise<boolean> {
  const { plan } = target;
  const res = (await prisma.tutorialVideoAsset.updateMany({
    where: { id: assetId, assemblyStatus: 'complete', blobUrl: { not: null } },
    data: {
      blobUrl: target.blobUrl,
      activeVersionId: target.versionId,
      durationMs: plan.durationMs,
    },
  })) as { count: number };
  return res.count > 0;
}

/**
 * Ролик собран сразу с унаследованным темпом пары (заход 7): его файл уже
 * и есть версия — только указатель, файл и длительность не меняются.
 * Compare-and-set: активная версия, выбранная раньше, не затирается.
 */
export async function markActiveVersionIfUnset(
  prisma: PrismaService,
  assetId: string,
  versionId: string,
): Promise<boolean> {
  const res = (await prisma.tutorialVideoAsset.updateMany({
    where: { id: assetId, activeVersionId: null },
    data: { activeVersionId: versionId },
  })) as { count: number };
  return res.count > 0;
}

/** Записать (или снять) монтажный manifest ролика. */
export async function writeAssetManifest(
  prisma: PrismaService,
  assetId: string,
  manifest: TutorialTimelineManifest | null,
): Promise<void> {
  await prisma.tutorialVideoAsset.update({
    where: { id: assetId },
    data: {
      tempoManifest:
        manifest === null
          ? Prisma.DbNull
          : (manifest as unknown as Prisma.InputJsonValue),
    },
  });
}
