/**
 * Уборка аудиокеша советника (ТЗ Greeting 2.0 §4А.4, K1; аудит волны 1).
 *
 * Без неё `wizard_hint_audio` и файлы под `wizard-hint-audio/` росли бы
 * вечно: ключ подсказки меняется с каждым деплоем корпуса знаний и с
 * каждым новым состоянием мастера, а метла `sweep-orphans` этот префикс
 * не видит — файлы не принадлежат ни сессии, ни проекту.
 *
 * Критерий — «не звучало 30 дней» (`lastUsedAt`), а не возраст: живая
 * реплика на популярном шаге синтезирована однажды и отдаётся месяцами,
 * и удалять её по дате рождения значило бы платить за тот же синтез
 * снова.
 *
 * Зовётся суточным кроном `cleanup-sessions` под его же замком
 * (`CronJobLock`), как и остальные уборки советника.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { BlobService } from '../storage/blob.service';

export const HINT_AUDIO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Строк за партию; партий за прогон — `HINT_AUDIO_PRUNE_MAX_BATCHES`. */
export const HINT_AUDIO_PRUNE_BATCH = 500;
export const HINT_AUDIO_PRUNE_MAX_BATCHES = 10;

export async function pruneWizardHintAudio(
  prisma: PrismaService,
  blob: Pick<BlobService, 'deleteMany'>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - HINT_AUDIO_RETENTION_MS);
  let removed = 0;
  for (let batch = 0; batch < HINT_AUDIO_PRUNE_MAX_BATCHES; batch++) {
    const stale: Array<{ key: string; pathname: string }> =
      await prisma.wizardHintAudio.findMany({
        where: { lastUsedAt: { lt: cutoff } },
        select: { key: true, pathname: true },
        take: HINT_AUDIO_PRUNE_BATCH,
      });
    if (!stale.length) break;
    const keys = stale.map((r) => r.key);
    // Условие на `lastUsedAt` повторяется в самом удалении: строку могли
    // выдать из кеша между выборкой и удалением — она снова живая.
    const { count } = await prisma.wizardHintAudio.deleteMany({
      where: { key: { in: keys }, lastUsedAt: { lt: cutoff } },
    });
    removed += count;
    // Файлы — только у строк, которых больше нет. Ожившая строка
    // осталась и ссылается на свой файл: удалить его значило бы отдавать
    // из кеша ссылку в пустоту.
    const survived = new Set(
      (
        await prisma.wizardHintAudio.findMany({
          where: { key: { in: keys } },
          select: { key: true },
        })
      ).map((r: { key: string }) => r.key),
    );
    await blob.deleteMany(
      stale.filter((r) => !survived.has(r.key)).map((r) => r.pathname),
    );
    if (stale.length < HINT_AUDIO_PRUNE_BATCH) break;
  }
  return removed;
}
