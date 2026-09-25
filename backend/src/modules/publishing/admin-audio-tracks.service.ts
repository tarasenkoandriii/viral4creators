/**
 * AdminAudioTracksService — экран передачи звуковых дорожек оператору
 * (этап 139, ТЗ TZ-Multilingual-YouTube.md).
 *
 * ## Почему экран в админке, а не в мини-аппе
 *
 * Мультиязычным делается НАШ собственный канал (решение владельца
 * 24.09.2026), значит в Studio заходит наш же оператор — человек, у
 * которого доступ есть. Была бы речь о клиентских каналах, этот экран
 * пришлось бы писать вдвое больше: объяснять Studio человеку, который о
 * нём не слышал.
 *
 * ## Почему отметку ставит человек
 *
 * API звуковых дорожек у YouTube нет вовсе — ни загрузить, ни
 * проверить. Отметка оператора честно называется отметкой, а не
 * проверкой: соврать в интерфейсе здесь было бы легко и бессмысленно.
 *
 * ## Почему сборка идёт ПО ОДНОЙ дорожке за запрос
 *
 * Найдено аудитом этапа. Сборка одной дорожки — это перевод, синтез,
 * загрузка файла и постановка задачи ffmpeg, то есть десятки секунд.
 * Четыре подряд в одном запросе не укладывались в таймаут функции, и
 * оператор получал оборванный запрос вместо дорожек. Уйти в фон нельзя:
 * у serverless фона нет — обещанная «потом» работа умирает вместе с
 * ответом (это уже записано в `wizard-guide/translation.service.ts`).
 * Поэтому запрос строит ровно одну локаль, а экран идёт по списку сам и
 * показывает прогресс.
 *
 * ## Почему список сам дозабирает сборку
 *
 * Сборка полного звука — асинхронная задача ffmpeg. Отдельного крона
 * для неё нет намеренно: дорожек в сутки единицы, а экран открывает
 * тот же человек, который их и ждёт, — дешевле дозабрать готовое в
 * момент открытия, чем будить крон каждые две минуты ради пустого
 * прогона.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AudioTrackService } from './audio-track.service';
import { SUPPORTED_LOCALES, normalizeLocale } from '../../common/locale';
import { SessionService } from '../../common/session.service';

export interface AudioTrackRow {
  id: string;
  sessionId: string;
  /** Версия ролика, под которую собрана дорожка. */
  generatedVideoId: string | null;
  locale: string;
  status: string;
  speech: string | null;
  voiceUrl: string | null;
  trackUrl: string | null;
  voiceSeconds: number | null;
  overflowSeconds: number | null;
  tempoRate: number | null;
  attempts: number;
  note: string | null;
  mixError: string | null;
  mixJobId: string | null;
  subtitlesSrt: string | null;
  uploadedAt: Date | null;
  uploadedById: string | null;
  updatedAt: Date;
}

export interface AudioTrackView {
  id: string;
  locale: string;
  status: string;
  /** Что произносит дорожка — оператору это единственный способ понять, что он заливает. */
  speech: string | null;
  /** Готовый полный звук; пока его нет — дорожку заливать нечем. */
  trackUrl: string | null;
  /** Только голос: полезен, когда сборка не удалась, а речь есть. */
  voiceUrl: string | null;
  /** Собирается прямо сейчас. */
  mixing: boolean;
  /** Собрана для прежней версии ролика — заливать её нельзя. */
  stale: boolean;
  voiceSeconds: number | null;
  overflowSeconds: number | null;
  tempoRate: number | null;
  attempts: number;
  note: string | null;
  mixError: string | null;
  /** Субтитры дорожки (этап 141) — оператор заливает их в Studio тем же заходом. */
  subtitlesSrt: string | null;
  uploadedAt: string | null;
  uploadedById: string | null;
}

export function toView(
  row: AudioTrackRow,
  currentVideoId?: string | null,
): AudioTrackView {
  return {
    id: row.id,
    locale: row.locale,
    status: row.status,
    // Дорожка от ПРЕЖНЕЙ версии ролика (аудит этапа 139). Поле
    // `generatedVideoId` писалось с самого начала — и не читалось
    // никем: перегенерация меняет картинку, а иногда и реплики, и
    // старая дорожка перестаёт им соответствовать. Молча показывать её
    // готовой значило бы дать оператору залить звук от другого ролика.
    stale: isStale(row, currentVideoId),
    speech: row.speech,
    trackUrl: row.trackUrl,
    voiceUrl: row.voiceUrl,
    // «Задача есть, файла нет» — это и значит «собирается»; отдельного
    // статуса для этого не заводили (см. миграцию 94).
    mixing: !!row.mixJobId && !row.trackUrl,
    voiceSeconds: row.voiceSeconds,
    overflowSeconds: row.overflowSeconds,
    tempoRate: row.tempoRate,
    attempts: row.attempts,
    note: row.note,
    mixError: row.mixError,
    // `?? null`, а не как есть: у дорожек, собранных до миграции 98,
    // колонки в ответе Prisma может не быть вовсе, и `undefined`
    // выпал бы из JSON — экран получил бы поле, которого нет.
    subtitlesSrt: row.subtitlesSrt ?? null,
    uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
    uploadedById: row.uploadedById ?? null,
  };
}

/** Дорожка собрана для другой версии ролика. */
function isStale(
  row: Pick<AudioTrackRow, 'generatedVideoId'>,
  currentVideoId?: string | null,
): boolean {
  return (
    !!currentVideoId &&
    !!row.generatedVideoId &&
    row.generatedVideoId !== currentVideoId
  );
}

/**
 * Какие локали есть смысл собирать. Чистая функция — правило важнее,
 * чем выглядит, и проверяется отдельно от базы.
 *
 * Не собираем: язык оригинала (дорожка уже в самом ролике), залитое
 * (подменять файл под отметкой нельзя) и то, что уже готово к заливке.
 * Прежняя редакция звала кнопку «собрать недостающие», а пересобирала
 * ВСЁ незалитое — то есть платила заново за готовые дорожки. Отданное
 * человеку (`HANDOVER`) скопом тоже не трогаем: там нужно его решение,
 * а не ещё одна попытка за те же деньги — для неё есть отдельная кнопка
 * в строке.
 */
export function localesToBuild(
  rows: Pick<
    AudioTrackRow,
    'locale' | 'status' | 'trackUrl' | 'uploadedAt' | 'generatedVideoId'
  >[],
  source: string,
  currentVideoId?: string | null,
): string[] {
  const byLocale = new Map(rows.map((r) => [r.locale, r]));
  return SUPPORTED_LOCALES.filter((locale) => {
    if (locale === source) return false;
    const row = byLocale.get(locale);
    if (!row) return true;
    if (row.uploadedAt) return false;
    // Устаревшую собираем заново, даже если она «готова»: готова она для
    // другого ролика.
    if (isStale(row, currentVideoId)) return true;
    if (row.status === 'HANDOVER') return false;
    return !row.trackUrl;
  });
}

@Injectable()
export class AdminAudioTracksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tracks: AudioTrackService,
    private readonly sessions: SessionService,
  ) {}

  /** Дорожки одного ролика — с дозабором готовых сборок. */
  async list(sessionId: string): Promise<{
    sessionId: string;
    sourceLocale: string;
    /** Локали, которые есть смысл собрать сейчас. */
    toBuild: string[];
    tracks: AudioTrackView[];
  }> {
    // 404, а не пустой список: у несуществующей сессии нет и языка
    // оригинала, а показать «дорожек нет, оригинал русский» — соврать
    // оператору, который ошибся ссылкой.
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);

    const rows = (await this.prisma.videoAudioTrack.findMany({
      where: { sessionId },
      orderBy: { locale: 'asc' },
    })) as AudioTrackRow[];

    // Дозабор ДО чтения ответа, иначе оператор увидел бы «собирается» у
    // дорожки, которая готова уже полчаса.
    const pending = rows.filter((r) => r.mixJobId && !r.trackUrl);
    for (const row of pending) {
      await this.tracks.pollMix(sessionId, row.locale);
    }
    const fresh = pending.length
      ? ((await this.prisma.videoAudioTrack.findMany({
          where: { sessionId },
          orderBy: { locale: 'asc' },
        })) as AudioTrackRow[])
      : rows;

    const currentVideoId = session.generatedVideo?.generatedVideoId ?? null;
    const source = normalizeLocale(session.locale);
    return {
      sessionId,
      sourceLocale: source,
      toBuild: localesToBuild(fresh, source, currentVideoId),
      tracks: fresh.map((row) => toView(row, currentVideoId)),
    };
  }

  /**
   * Собрать ОДНУ дорожку. По одной за запрос — см. шапку файла; экран
   * идёт по списку `toBuild` сам.
   */
  async buildOne(
    sessionId: string,
    localeRaw: string,
  ): Promise<AudioTrackView> {
    const locale = normalizeLocale(localeRaw);
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (locale === normalizeLocale(session.locale)) {
      throw new BadRequestException(
        'это язык оригинала — отдельная дорожка не нужна',
      );
    }

    await this.tracks.build(sessionId, locale);

    const row = (await this.prisma.videoAudioTrack.findUnique({
      where: { sessionId_locale: { sessionId, locale } },
    })) as AudioTrackRow | null;
    if (!row) throw new NotFoundException(`Audio track ${locale} not found`);
    return toView(row, session.generatedVideo?.generatedVideoId ?? null);
  }

  /** Отметить дорожку залитой (или снять отметку, если ошиблись). */
  async setUploaded(
    id: string,
    uploaded: boolean,
    operatorId: string,
  ): Promise<AudioTrackView> {
    const row = (await this.prisma.videoAudioTrack.findUnique({
      where: { id },
    })) as AudioTrackRow | null;
    if (!row) throw new NotFoundException(`Audio track ${id} not found`);

    const updated = (await this.prisma.videoAudioTrack.update({
      where: { id },
      data: uploaded
        ? { uploadedAt: new Date(), uploadedById: operatorId }
        : // Снятие стирает и след: отметка «залил Иван, но не залил» —
          // это не история, а мусор.
          { uploadedAt: null, uploadedById: null },
    })) as AudioTrackRow;
    return toView(updated);
  }
}
