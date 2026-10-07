/**
 * VoiceUploadService — голосовая запись удаляется в пределах часа, даже
 * если её никто не обработал (финальный аудит ветки K ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`, 30.09.2026).
 *
 * ## Зачем
 *
 * Запись удаляет `finally` обработки — но только если обработка БЫЛА.
 * Клиент, получивший ссылку и загрузивший файл, но не позвавший разбор
 * (закрыл вкладку, упала сеть), оставлял запись в хранилище. Суточная
 * метла (`sweep-orphans`, правило `isTransientVoiceRecording`) должна
 * была её подобрать, но она ходит по листингу всего префикса
 * `sessions/`/`projects/` порциями и за один суточный прогон до голосовых
 * файлов на реальном объёме не доходит — а Условия (3.4) обещают, что
 * звук не хранится.
 *
 * Поэтому каждая выданная ссылка записывается строкой (`remember`), строка
 * удаляется в том же `finally`, что удаляет файл (`forget`), а крон
 * `voice-uploads-sweep` каждые 15 минут удаляет файлы и строки старше
 * часа (`sweepExpired`). Час — с запасом больше срока ссылки (15 минут) и
 * любой обработки (минуты): живую запись метла не заденет. Суточная метла
 * остаётся страховкой.
 *
 * ## Очередь неудалённого у Soniox
 *
 * Тем же тиком метла повторяет удаление у Soniox того, что распознавание
 * не смогло удалить сразу (транскрипция ещё обрабатывалась — `409`, сеть,
 * 5xx): очередь `soniox-pending-delete` в `PlatformSetting`, правила — в
 * `voice/soniox-stt.client.ts` (`drainSonioxPendingDeletes`). Своего
 * срока хранения у Soniox нет, так что без повтора транскрипт оставался
 * бы у провайдера навсегда (C4 захода 8, ТЗ поздравлений 2.0 стр. 1622).
 * Отдельный крон не заведён: расписание и замок `voice-uploads-sweep` уже
 * есть, а частота (15 минут) та же, что нужна очереди.
 *
 * Очередь видит только то, что заметил `finally` распознавания; если
 * функцию убили раньше, id никуда не попал. Поэтому следом — уборка по
 * списку Soniox (`common/soniox-sweep.ts`): только объекты с меткой
 * генератора (`v4c-gen`) старше часа; чужое (общий ключ с другими
 * продуктами) не трогается и только считается.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { VOICE_RECORDING_MAX_AGE_MS } from '../../common/orphan-sweep';
import {
  drainSonioxPendingDeletes,
  type SonioxPendingDrainResult,
} from '../voice/soniox-stt.client';
import { sonioxApiKey } from '../../common/soniox';
import {
  SONIOX_TAG_GENERATOR,
  sweepOwnStaleSoniox,
  type SonioxSweepResult,
} from '../../common/soniox-sweep';

/** Строк за одну выборку; выборок за прогон — `SWEEP_MAX_BATCHES`. */
export const VOICE_UPLOAD_SWEEP_BATCH = 200;
export const VOICE_UPLOAD_SWEEP_MAX_BATCHES = 10;
/** Порция одного `del()` хранилища. */
const DELETE_CHUNK = 50;

export interface VoiceUploadSweepResult {
  /** Файлов (и строк) удалено. */
  deleted: number;
  /** Файлов, которые хранилище не приняло к удалению — строки остались до следующего тика. */
  failed: number;
  /** Остались ли просроченные строки после прогона. */
  hasMore: boolean;
  skipped?: boolean;
  /** Повтор удаления у Soniox тем же тиком — см. шапку. */
  soniox?: SonioxPendingDrainResult;
  /** Своё у Soniox старше часа по списку провайдера — см. шапку. */
  sonioxStale?: SonioxSweepResult;
}

/** Граница возраста: строки, заведённые раньше неё, — не обработанные записи. */
export function voiceUploadCutoff(now: Date): Date {
  return new Date(now.getTime() - VOICE_RECORDING_MAX_AGE_MS);
}

@Injectable()
export class VoiceUploadService {
  private readonly logger = new Logger(VoiceUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
  ) {}

  /**
   * Запомнить выданный путь — ДО выдачи ссылки. Бросает: ссылка без
   * строки — запись, которую удалит только суточная страховка, и лучше
   * не выдать ссылку, чем нарушить обещание Условий.
   */
  async remember(pathname: string): Promise<void> {
    await this.prisma.voiceUpload.upsert({
      where: { pathname },
      create: { pathname },
      update: { createdAt: new Date() },
    });
  }

  /**
   * Запись обработана и удалена — строка больше не нужна. Не бросает:
   * зовётся из `finally`, и сбой здесь не должен подменять ответ; не
   * удалённая строка значит лишь, что крон ещё раз попробует удалить
   * уже удалённый файл.
   */
  async forget(pathname: string): Promise<void> {
    try {
      await this.prisma.voiceUpload.deleteMany({ where: { pathname } });
    } catch (e) {
      this.logger.warn(
        `строка записи ${pathname} не удалена: ${e instanceof Error ? e.message : String(e)} — её уберёт крон voice-uploads-sweep`,
      );
    }
  }

  /**
   * Тик метлы: файлы и строки старше часа, затем очередь неудалённого у
   * Soniox. Очередь не бросает — её сбой не роняет уборку записей.
   */
  async sweepExpired(now: Date = new Date()): Promise<VoiceUploadSweepResult> {
    const files = await this.sweepFiles(now);
    const soniox = await drainSonioxPendingDeletes(
      this.prisma,
      this.logger,
      now,
    );
    const sonioxStale = await sweepOwnStaleSoniox({
      tag: SONIOX_TAG_GENERATOR,
      key: sonioxApiKey(),
      now,
      logger: this.logger,
    });
    return { ...files, soniox, sonioxStale };
  }

  /**
   * Удалить файлы и строки старше часа. Строка удаляется только после
   * того, как хранилище приняло удаление её файла: иначе сбой хранилища
   * молча оставил бы файл без учёта.
   */
  private async sweepFiles(now: Date): Promise<VoiceUploadSweepResult> {
    const cutoff = voiceUploadCutoff(now);
    let deleted = 0;
    let failed = 0;
    // Пути, которые хранилище не приняло в этом прогоне, — не выбирать
    // их снова, иначе одна сломанная порция крутилась бы до конца прогона.
    const stuck: string[] = [];
    for (let batch = 0; batch < VOICE_UPLOAD_SWEEP_MAX_BATCHES; batch++) {
      const rows: Array<{ pathname: string }> =
        await this.prisma.voiceUpload.findMany({
          where: {
            createdAt: { lt: cutoff },
            ...(stuck.length ? { pathname: { notIn: stuck } } : {}),
          },
          select: { pathname: true },
          orderBy: { createdAt: 'asc' },
          take: VOICE_UPLOAD_SWEEP_BATCH,
        });
      if (rows.length === 0) return this.done(deleted, failed, false);
      for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
        const chunk = rows.slice(i, i + DELETE_CHUNK).map((r) => r.pathname);
        const sent = await this.blobService.deleteMany(chunk, DELETE_CHUNK);
        if (sent === chunk.length) {
          await this.prisma.voiceUpload.deleteMany({
            where: { pathname: { in: chunk } },
          });
          deleted += chunk.length;
        } else {
          failed += chunk.length;
          stuck.push(...chunk);
        }
      }
      if (rows.length < VOICE_UPLOAD_SWEEP_BATCH) {
        return this.done(deleted, failed, false);
      }
    }
    return this.done(deleted, failed, true);
  }

  private done(
    deleted: number,
    failed: number,
    hasMore: boolean,
  ): VoiceUploadSweepResult {
    if (failed > 0) {
      this.logger.warn(
        `voice-uploads-sweep: ${failed} файлов хранилище не приняло к удалению — повтор на следующем тике`,
      );
    }
    return { deleted, failed, hasMore };
  }
}
