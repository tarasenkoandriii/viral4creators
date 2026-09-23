/**
 * SharedVideoPosterService — кадр-постер для публичной страницы ролика.
 *
 * ## Почему это делается при ПУБЛИКАЦИИ, а не в конвейере постобработки
 *
 * Кадр нужен ровно тем роликам, которые кто-то опубликовал, — их
 * заметно меньше, чем сгенерированных. Вынимать его всем в общем
 * конвейере значило бы платить за задачу ffmpeg для каждого ролика, в
 * том числе для тех, которые никто никогда не покажет.
 *
 * Вторая причина важнее денег. Общий конвейер — это то, без чего ролика
 * не будет вообще. Если чужой сервис однажды откажется отдавать `.jpg`
 * вторым выходом задачи, при таком устройстве сломалась бы сама
 * генерация. Здесь худшее, что может случиться, — у страницы не будет
 * постера, и она возьмёт запасную картинку. Поэтому ни один метод этого
 * сервиса НЕ БРОСАЕТ: отказ возвращается как `null`.
 *
 * ## Почему ожидание встроенное, а не отдельная фаза опроса
 *
 * Опрос постобработки в продукте ведёт клиент (`getVideoStatus` →
 * `postprod.poll`), и он прекращается, как только ролик готов. К моменту
 * публикации опрашивать уже некому, а заводить ради одной картинки
 * второй механизм с собственным полем статуса и собственным кроном —
 * дороже, чем сама задача. Вынуть один кадр из готового mp4 — работа на
 * секунды, поэтому здесь короткое ограниченное ожидание: не дождались —
 * страница просто публикуется без постера.
 */

import { Injectable, Logger } from '@nestjs/common';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { BlobService } from '../storage/blob.service';
import { planPosterFrame } from '../../common/poster-frame';

/** Сколько раз спросить статус задачи, прежде чем сдаться. */
export const POSTER_POLL_ATTEMPTS = 6;
/** Пауза между опросами, мс. */
export const POSTER_POLL_INTERVAL_MS = 1500;

export interface CapturedPoster {
  url: string;
  pathname: string;
}

@Injectable()
export class SharedVideoPosterService {
  private readonly logger = new Logger(SharedVideoPosterService.name);

  constructor(
    private readonly ffmpeg: FfmpegApiService,
    private readonly blob: BlobService,
  ) {}

  /**
   * Вынуть кадр из готового ролика и положить рядом с ним в наш Blob.
   *
   * `null` — постера не будет: сервис не настроен на стенде, задача не
   * успела, вернула ошибку или не отдала файл. Все четыре случая для
   * вызывающего одинаковы, и ни один не повод отменять публикацию.
   */
  async capture(
    videoUrl: string,
    pathname: string,
  ): Promise<CapturedPoster | null> {
    if (!this.ffmpeg.configured()) return null;
    try {
      const plan = planPosterFrame();
      const job = await this.ffmpeg.submit({
        inputs: { video: videoUrl },
        outputs: [plan.outputName],
        commands: [plan.command],
      });
      const url = await this.awaitOutput(job.jobId, plan.outputName);
      if (!url) return null;

      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`постер не скачался: HTTP ${res.status}`);
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const { url: ourUrl } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        'image/jpeg',
      );
      return { url: ourUrl, pathname };
    } catch (e) {
      // Именно warn, а не error: публикация состоялась, у страницы
      // просто не будет своего превью.
      this.logger.warn(
        `постер не сделан: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Ссылка на готовый файл, либо `null` — не дождались или не вышло. */
  private async awaitOutput(
    jobId: string,
    outputName: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < POSTER_POLL_ATTEMPTS; attempt++) {
      const status = await this.ffmpeg.status(jobId);
      if (status.status === 'failed') {
        this.logger.warn(`постер не сделан: ${status.error ?? 'без причины'}`);
        return null;
      }
      if (status.status === 'completed') {
        // По ИМЕНИ, а не «первый попавшийся выход»: имя мы задали сами,
        // и молча взять чужой файл, если сервис однажды вернёт их
        // несколько, значило бы положить в постер неизвестно что.
        return status.outputs?.[outputName] ?? null;
      }
      await this.sleep(POSTER_POLL_INTERVAL_MS);
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
