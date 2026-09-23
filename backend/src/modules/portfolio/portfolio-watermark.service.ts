/**
 * PortfolioWatermarkService — вплавление водяного знака в публичное
 * превью (ТЗ на маркетплейс §9/§22, защита от пиратства). Применяется
 * к PortfolioItem напрямую — AuctionListing показывает то же самое
 * готовое превью через тот же PortfolioItem, отдельного пайплайна под
 * аукцион заводить не нужно.
 *
 * Тот же хостед-ffmpeg (FfmpegApiService, @Global() из postprod), что
 * уже используется для обрезки кадра (common/reframe.ts) — submit +
 * поллинг статуса, не синхронный вызов: перекодировка занимает время
 * (тот же принцип, что у AuctionAiAssessmentService — одна операция за
 * тик, не блокируя запрос исполнителя).
 *
 * WatermarkMode.NONE вообще не доходит до ffmpeg-сервиса — платного
 * вызова просто не происходит, ровно как просили.
 *
 * Найдено при аудите: до этой правки FAILED был терминальным статусом —
 * `runTick()` опрашивал только PENDING/PROCESSING, а `publicVideoUrl()`
 * (common/watermark.ts) на FAILED отдаёт настоящий оригинал публично.
 * Значит один-единственный транзиентный сбой (сетевой обрыв к
 * ffmpeg-api, разовая ошибка рендера) навсегда снимал защиту с ролика
 * на витрине — ровно то, от чего вся эта система должна защищать.
 * Теперь FAILED-записи с `watermarkAttempts < MAX_WATERMARK_ATTEMPTS`,
 * не трогавшиеся дольше `RETRY_COOLDOWN_MS`, повторно ставятся в
 * очередь — с задержкой между попытками (не долбить внешний API сразу
 * же после отказа) и с потолком (чтобы генуинно сломанный вход —
 * например, videoUrl, который никогда не станет доступным — не крутился
 * бы вызовами вечно). После исчерпания попыток запись остаётся FAILED
 * так же, как и раньше — это уже сигнал на ручное вмешательство
 * оператора/исполнителя, а не то, что можно решить ещё одним тиком.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  buildWatermarkPlan,
  WatermarkIntensityValue,
} from '../../common/watermark';

/** Имя площадки — дефолтный текст знака (WatermarkMode.SITE_NAME). */
const SITE_NAME = 'viral4creators';

/** Задача, зависшая в PROCESSING дольше этого, считается сбойной — не опрашивается вечно. */
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

/** Сколько раз автоматически повторить сбойную обработку, прежде чем
 * оставить FAILED окончательно (аудит-фикс — см. доккомментарий класса). */
const MAX_WATERMARK_ATTEMPTS = 5;
/** Пауза между попытками — не долбить внешний ffmpeg-api сразу после отказа. */
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

@Injectable()
export class PortfolioWatermarkService {
  private readonly logger = new Logger(PortfolioWatermarkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /**
   * Один тик — одно действие: либо опрос уже отправленной задачи, либо
   * отправка новой. Не оба сразу — тот же принцип предсказуемой
   * стоимости шага, что у AuctionAiAssessmentService.runTick.
   */
  async runTick(): Promise<{ action: string }> {
    const stuckSince = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
    const stuck = await this.prisma.portfolioItem.findFirst({
      where: { watermarkStatus: 'PROCESSING', updatedAt: { lt: stuckSince } },
    });
    if (stuck) {
      await this.markFailed(stuck.id, stuck.watermarkAttempts);
      return { action: 'timed-out' };
    }

    const processing = await this.prisma.portfolioItem.findFirst({
      where: { watermarkStatus: 'PROCESSING' },
      orderBy: { updatedAt: 'asc' },
      include: { creatorProfile: true },
    });
    if (processing) return this.pollJob(processing);

    const pending = await this.prisma.portfolioItem.findFirst({
      where: { watermarkStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    if (pending) return this.submitJob(pending);

    // Аудит-фикс: FAILED больше не терминален навсегда — записи с
    // запасом попыток и остывшие дольше RETRY_COOLDOWN_MS встают в
    // очередь снова, но только когда для этого тика нет более свежей
    // работы (PROCESSING/PENDING) — повтор сбойного элемента не должен
    // отбирать крон-тик у элемента, который вообще ещё не пытались
    // обработать.
    const retryCutoff = new Date(Date.now() - RETRY_COOLDOWN_MS);
    const retryable = await this.prisma.portfolioItem.findFirst({
      where: {
        watermarkStatus: 'FAILED',
        watermarkAttempts: { lt: MAX_WATERMARK_ATTEMPTS },
        updatedAt: { lt: retryCutoff },
      },
      orderBy: { updatedAt: 'asc' },
    });
    if (retryable) return this.submitJob(retryable);

    return { action: 'idle' };
  }

  /** Общий переход в FAILED — увеличивает счётчик попыток (аудит-фикс), не только сам статус. */
  private async markFailed(
    id: string,
    previousAttempts: number,
  ): Promise<void> {
    await this.prisma.portfolioItem.update({
      where: { id },
      data: {
        watermarkStatus: 'FAILED',
        watermarkJobId: null,
        watermarkAttempts: previousAttempts + 1,
      },
    });
  }

  private async submitJob(item: {
    id: string;
    videoUrl: string;
    watermarkMode: string;
    watermarkText: string | null;
    watermarkIntensity: string;
    watermarkAttempts: number;
  }): Promise<{ action: string }> {
    if (item.watermarkMode === 'NONE') {
      await this.prisma.portfolioItem.update({
        where: { id: item.id },
        data: { watermarkStatus: 'SKIPPED' },
      });
      return { action: 'skipped' };
    }

    const text =
      item.watermarkMode === 'CUSTOM' && item.watermarkText
        ? item.watermarkText
        : SITE_NAME;
    try {
      const plan = buildWatermarkPlan(
        text,
        item.watermarkIntensity as WatermarkIntensityValue,
      );
      const job = await this.ffmpeg.submit({
        inputs: { input: item.videoUrl },
        outputs: [plan.outputName],
        commands: [plan.command],
      });
      await this.prisma.portfolioItem.update({
        where: { id: item.id },
        data: { watermarkStatus: 'PROCESSING', watermarkJobId: job.jobId },
      });
      return { action: 'submitted' };
    } catch (e) {
      this.logger.warn(
        `Отправка задачи водяного знака не удалась (item=${item.id}): ${(e as Error).message}`,
      );
      await this.markFailed(item.id, item.watermarkAttempts);
      return { action: 'failed-submit' };
    }
  }

  private async pollJob(item: {
    id: string;
    watermarkJobId: string | null;
    watermarkAttempts: number;
    creatorProfile: { userId: string };
  }): Promise<{ action: string }> {
    if (!item.watermarkJobId) {
      await this.markFailed(item.id, item.watermarkAttempts);
      return { action: 'failed-missing-job' };
    }

    let jobStatus;
    try {
      jobStatus = await this.ffmpeg.status(item.watermarkJobId);
    } catch (e) {
      this.logger.warn(
        `Опрос задачи водяного знака не удался (item=${item.id}): ${(e as Error).message}`,
      );
      return { action: 'poll-error' }; // не FAILED сразу — попробуем на следующем тике, transient-сбой сети
    }

    if (jobStatus.status === 'pending') return { action: 'still-processing' };

    if (jobStatus.status === 'failed') {
      await this.markFailed(item.id, item.watermarkAttempts);
      return { action: 'failed' };
    }

    // completed
    const outputUrl = Object.values(jobStatus.outputs ?? {})[0];
    if (!outputUrl) {
      await this.markFailed(item.id, item.watermarkAttempts);
      return { action: 'failed-no-output' };
    }

    const res = await fetch(outputUrl);
    if (!res.ok) {
      await this.markFailed(item.id, item.watermarkAttempts);
      return { action: 'failed-download' };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // Стабильный путь по id, не с меткой времени — allowOverwrite: true
    // (BlobService.uploadBuffer) сам заменит старый файл при повторной
    // обработке (правка videoUrl/текста знака), не копит мусор.
    const pathname = `portfolio-watermarks/${item.id}.mp4`;
    const { url } = await this.blob.uploadBuffer(pathname, buffer, 'video/mp4');

    await this.aiUsage.record({
      operation: 'watermark',
      model: 'ffmpeg-api',
      userId: item.creatorProfile.userId,
    });

    await this.prisma.portfolioItem.update({
      where: { id: item.id },
      data: {
        watermarkStatus: 'READY',
        watermarkedVideoUrl: url,
        watermarkJobId: null,
      },
    });
    return { action: 'ready' };
  }
}
