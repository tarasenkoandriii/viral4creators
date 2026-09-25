/**
 * PublishWorkerService — крон-воркер выгрузки одобренных заявок в
 * YouTube/TikTok (этап 61, ТЗ §14.5). Вызывается `GET /api/cron/publish`
 * каждые 1-2 минуты (`backend/vercel.json`, требует план Vercel Pro — см.
 * doc/DEPLOYMENT.md).
 *
 * Один прогон (`runBatch`) берёт до `publishing.cronBatch` заявок
 * `APPROVED` с назначенным каналом, чьё время следующей попытки настало,
 * и обрабатывает их по одной — так один медленный/битый канал не
 * блокирует остальные заявки в этом же тике.
 *
 * ## Claim перед обработкой (Г-2.11 аудита round4, этап 64)
 *
 * Заливка ролика в YouTube длится минуты (весь файл одним PUT), а cron
 * тикает каждые 1-2 минуты — перекрытие двух тиков одной и той же
 * строки штатно (второй тик стартует до того, как первый успел
 * завершиться и сменить статус). Раньше это означало вторую сессию
 * загрузки и второй одинаковый ролик на канале клиента. Теперь перед
 * обработкой каждой строки — атомарный `updateMany` claim
 * (`lockedUntil = now + 15m`, условие `lockedUntil IS NULL OR < now`);
 * строка, которую уже держит другой тик, просто пропускается. Лок
 * снимается явно по завершении обработки строки в ЭТОМ тике (успех,
 * неудача или «ещё обрабатывается площадкой» у TikTok) — 15 минут это
 * предохранитель на случай, если сам процесс упадёт посреди обработки
 * (та же идея, что `STALE_CLAIM_MS` у `wayforpay-renewal.service.ts`), а
 * не обычная длительность лока.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import {
  PublicationPrivacy,
  PublicationStatus,
} from '../../common/types/publication.types';
import { PublishingChannelService } from '../publishing-channel/publishing-channel.service';
import { YoutubeUploadService } from './youtube-upload.service';
import { TiktokUploadService } from './tiktok-upload.service';
import { PublicationTranslationService } from './publication-translation.service';
import { YoutubeCaptionsService } from './youtube-captions.service';
import { hasCaptionsScope } from '../publishing-channel/google-oauth.service';
import { normalizeLocale } from '../../common/locale';

/** Структурный тип строки — та же причина, что у PublicationRow в
 * publication.service.ts; здесь только поля, нужные воркеру. */
interface PublishableRow {
  id: string;
  channelId: string | null;
  title: string;
  description: string;
  tags: string[];
  privacy: PublicationPrivacy;
  videoUrl: string;
  /** Язык ролика из снимка заявки (этап 137). */
  language?: string | null;
  /** Субтитры оригинального языка, снимком (этап 137). */
  subtitlesSrt?: string | null;
  /** Нужен только затем, чтобы расход на перевод лёг на владельца. */
  sessionId?: string | null;
  userId?: string;
  externalId: string | null;
  externalUrl: string | null;
  uploadJobId: string | null;
  attempts: number;
  status: PublicationStatus;
  /** Момент одобрения — точка отсчёта дедлайна опроса TikTok (М-6.3). */
  moderatedAt?: Date | null;
}

/** М-6.3 седьмого аудита: у стадии опроса TikTok не было дедлайна —
 * протухший `publish_id` (байты не залились, заявка старая) давал
 * вечный «в процессе» каждые 2 минуты. Сутки — с запасом сверх
 * реального времени обработки площадки. */
const TIKTOK_POLL_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** Г-2.11: claim держим не дольше самой долгой реалистичной заливки, с
 * запасом. */
const LOCK_MS = 15 * 60 * 1000;

/**
 * Сколько дорожек субтитров грузим за сутки (аудит субтитров этапа
 * 137).
 *
 * `captions.insert` стоит **400 единиц** — это самый дорогой вызов
 * продукта к YouTube при суточном пуле в 10 000 на ВЕСЬ проект, который
 * делят поиск референсов (100 за поиск), генератор блога и теги
 * исходника. Без потолка двадцать пять публикаций за день выносят квоту
 * в ноль, и первым это заметит не оператор, а пользователь, у которого
 * перестал работать поиск референсов.
 *
 * Десять дорожек — 4000 единиц, меньше половины пула. Упёрлись: ролик
 * публикуется как обычно, а в заявке записано, почему субтитров нет.
 */
const CAPTIONS_DAILY_LIMIT = 10;

export interface PublishBatchResult {
  processed: number;
  published: number;
  failed: number;
  stillPending: number;
}

@Injectable()
export class PublishWorkerService {
  private readonly logger = new Logger(PublishWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: PublishingChannelService,
    private readonly youtube: YoutubeUploadService,
    private readonly tiktok: TiktokUploadService,
    private readonly translations: PublicationTranslationService,
    private readonly captions: YoutubeCaptionsService,
  ) {}

  private cfg() {
    return loadConfiguration().publishing;
  }

  async runBatch(): Promise<PublishBatchResult> {
    const rows: PublishableRow[] =
      await this.prisma.publicationRequest.findMany({
        where: {
          status: 'APPROVED',
          channelId: { not: null },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: this.cfg().cronBatch,
      });

    let published = 0;
    let failed = 0;
    for (const row of rows) {
      // Claim (Г-2.11): атомарно, ДО любого сетевого вызова к площадке.
      // Строку, захваченную перекрывающимся тиком, просто пропускаем —
      // он сам доведёт её до конца или освободит лок.
      const claim = await this.prisma.publicationRequest.updateMany({
        where: {
          id: row.id,
          status: 'APPROVED',
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count === 0) {
        continue;
      }
      try {
        const done = await this.processOne(row);
        if (done) {
          published += 1;
        } else {
          // TikTok: init/uploadBytes сделаны, готовность — на
          // следующих тиках через poll. Снимаем лок сразу — иначе poll
          // ждал бы все 15 минут вместо обычного интервала крона.
          await this.releaseLock(row.id);
        }
      } catch (error) {
        failed += 1;
        await this.recordFailure(row, error);
      }
    }
    const result: PublishBatchResult = {
      processed: rows.length,
      published,
      failed,
      stillPending: rows.length - published - failed,
    };
    if (rows.length > 0) {
      this.logger.log(
        `Крон выгрузки: обработано ${result.processed}, опубликовано ${result.published}, ` +
          `ошибок ${result.failed}, в процессе ${result.stillPending}`,
      );
    }
    return result;
  }

  /** true — заявка дошла до PUBLISHED в этом тике. */
  private async processOne(row: PublishableRow): Promise<boolean> {
    // channelId проверен фильтром выборки, но TS об этом не знает.
    const { accessToken, channel } = await this.channels.ensureFreshToken(
      row.channelId as string,
    );
    return channel.platform === 'YOUTUBE'
      ? // Права канала едут сюда же: субтитры (этап 137) требуют
        // расширенного согласия, и решать по ним надо там, где ролик
        // уже опубликован, а не гадать в другом месте.
        this.processYoutube(row, accessToken, channel.scopes)
      : this.processTiktok(row, accessToken);
  }

  private async processYoutube(
    row: PublishableRow,
    accessToken: string,
    channelScopes: string[] = [],
  ): Promise<boolean> {
    if (row.externalId) {
      // Строка уже несёт результат прошлой попытки — статус просто не
      // успел записаться (например, процесс убило между PUT и update).
      await this.markPublished(
        row.id,
        row.externalId,
        row.externalUrl ?? `https://youtu.be/${row.externalId}`,
      );
      return true;
    }
    // Г-2.11: если прошлая попытка уже открыла сессию (обрыв процесса
    // между openSession и подтверждённым результатом), сперва спросим у
    // площадки её реальное состояние вместо слепого открытия новой —
    // см. шапку youtube-upload.service.ts.
    let sessionUri = row.uploadJobId;
    let offset = 0;
    if (sessionUri) {
      try {
        const status = await this.youtube.checkStatus(sessionUri, accessToken);
        if (status.done) {
          // Предыдущий PUT фактически долетел — просто не успели
          // записать externalId. Дозаливать нечего.
          await this.markPublished(
            row.id,
            status.externalId as string,
            `https://youtu.be/${status.externalId}`,
          );
          return true;
        }
        offset = status.bytesUploaded;
      } catch {
        // Сессия просрочена/недействительна — открываем новую с нуля,
        // как при первой попытке.
        sessionUri = null;
        offset = 0;
      }
    }
    if (!sessionUri) {
      // Локализации (этап 137) собираются ровно здесь — перед открытием
      // сессии, потому что уезжают тем же запросом, что и `snippet`.
      // Перевод — лучшая попытка: пустая карта означает «ролик уйдёт без
      // локализаций», а не «публикация не состоялась». Возобновление
      // сессии (ветка выше) сюда не заходит вовсе: у той сессии
      // `snippet` уже принят площадкой, и переводить заново было бы
      // деньгами на ветер.
      const language = normalizeLocale(row.language);
      // `catch` здесь не дублирует обещание сервиса не бросать, а
      // страхует от него: «локализация не роняет публикацию» — инвариант
      // ЭТОГО метода, и держать его на честном слове соседнего класса
      // нельзя. Иначе отказ Gemini стоил бы заявке попытки, а на
      // пятой — статуса FAILED.
      const localizations = await this.translations
        .translate(
          { title: row.title, description: row.description },
          language,
          { sessionId: row.sessionId ?? null, userId: row.userId ?? null },
        )
        .catch(() => ({}));
      sessionUri = await this.youtube.openSession(
        {
          title: row.title,
          description: row.description,
          tags: row.tags,
          privacy: row.privacy,
          videoUrl: row.videoUrl,
          language,
          localizations,
        },
        accessToken,
      );
      await this.prisma.publicationRequest.update({
        where: { id: row.id },
        data: { uploadJobId: sessionUri },
      });
    }
    const result = await this.youtube.uploadBytes(
      sessionUri,
      row.videoUrl,
      accessToken,
      offset,
    );
    await this.markPublished(row.id, result.externalId, result.externalUrl);
    await this.uploadCaptions(
      row,
      result.externalId,
      accessToken,
      channelScopes,
    );
    return true;
  }

  /**
   * Субтитры оригинального языка (этап 137) — ПОСЛЕ публикации и
   * лучшей попыткой.
   *
   * Отдельным вызовом, а не частью загрузки: `captions.insert` —
   * единственное место всего ТЗ, которому нужен скоуп
   * `youtube.force-ssl`. У канала без расширенного согласия шаг просто
   * не делается: ролик опубликован, заголовок с описанием на месте, а
   * на экране каналов стоит кнопка «Разрешить субтитры».
   *
   * Отказ площадки не отменяет публикацию и не возвращает заявку в
   * очередь: ролик уже на канале, повторная попытка залила бы его
   * второй раз. Причина пишется в заявку — чтобы «субтитров нет» имело
   * ответ в базе, а не только в логе.
   */
  private async uploadCaptions(
    row: PublishableRow,
    videoId: string,
    accessToken: string,
    channelScopes: string[],
  ): Promise<void> {
    const srt = row.subtitlesSrt?.trim();
    if (!srt) return;
    if (!hasCaptionsScope(channelScopes)) {
      await this.noteCaptions(
        row.id,
        'у канала нет расширенного согласия — субтитры не загружались',
      );
      return;
    }

    // Потолок проверяется ПЕРЕД вызовом, а не после: 400 единиц
    // списываются самим обращением, и «проверить, а потом пожалеть»
    // здесь ничего не экономит.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const uploadedToday = await this.prisma.publicationRequest.count({
      where: { captionsUploadedAt: { gte: today } },
    });
    if (uploadedToday >= CAPTIONS_DAILY_LIMIT) {
      await this.noteCaptions(
        row.id,
        `суточный потолок субтитров исчерпан (${CAPTIONS_DAILY_LIMIT} за сутки: ` +
          `каждая дорожка стоит 400 единиц квоты YouTube из 10 000 на весь проект)`,
      );
      return;
    }

    try {
      await this.captions.insert(
        {
          videoId,
          language: normalizeLocale(row.language),
          name: 'Original',
          srt,
        },
        accessToken,
      );
      await this.prisma.publicationRequest.update({
        where: { id: row.id },
        data: { captionsUploadedAt: new Date(), captionsError: null },
      });
    } catch (e) {
      await this.noteCaptions(
        row.id,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  private async noteCaptions(id: string, message: string): Promise<void> {
    this.logger.warn(`субтитры не загружены (${id}): ${message}`);
    await this.prisma.publicationRequest
      .update({ where: { id }, data: { captionsError: message.slice(0, 500) } })
      .catch(() => undefined);
  }

  private async processTiktok(
    row: PublishableRow,
    accessToken: string,
  ): Promise<boolean> {
    if (row.externalId) {
      await this.markPublished(row.id, row.externalId, row.externalUrl);
      return true;
    }
    if (!row.uploadJobId) {
      const init = await this.tiktok.init(
        {
          title: row.title,
          description: row.description,
          videoUrl: row.videoUrl,
        },
        accessToken,
      );
      // publish_id сохраняем ДО заливки байт: TikTok не даёт отменить уже
      // открытую публикацию, повторный init на следующем тике плодил бы
      // вторую заявку на площадке, если оборвётся именно uploadBytes.
      await this.prisma.publicationRequest.update({
        where: { id: row.id },
        data: { uploadJobId: init.publishId },
      });
      await this.tiktok.uploadBytes(init.uploadUrl, row.videoUrl);
      return false; // готовность — на следующих тиках, через poll
    }
    const poll = await this.tiktok.pollStatus(row.uploadJobId, accessToken);
    if (
      poll.status === 'processing' &&
      row.moderatedAt &&
      Date.now() - new Date(row.moderatedAt).getTime() > TIKTOK_POLL_DEADLINE_MS
    ) {
      throw new Error(
        `TikTok: публикация не завершилась за ${TIKTOK_POLL_DEADLINE_MS / 3_600_000} часов (publish_id ${row.uploadJobId})`,
      );
    }
    if (poll.status === 'published') {
      // TikTok SELF_ONLY не даёт публичной ссылки — открыть ролик может
      // только сам автор, из приложения/Studio.
      await this.markPublished(
        row.id,
        poll.externalId ?? row.uploadJobId,
        null,
      );
      return true;
    }
    if (poll.status === 'failed') {
      throw new Error(poll.error ?? 'TikTok: публикация не удалась');
    }
    return false; // ещё обрабатывается площадкой
  }

  private async markPublished(
    id: string,
    externalId: string,
    externalUrl: string | null,
  ): Promise<void> {
    await this.prisma.publicationRequest.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        externalId,
        externalUrl,
        publishedAt: new Date(),
        publishError: null,
        lockedUntil: null,
      },
    });
  }

  /** Г-2.11: явно освободить claim, когда строка остаётся APPROVED
   * (TikTok — «ещё обрабатывается площадкой», следующий тик поллит). */
  private async releaseLock(id: string): Promise<void> {
    await this.prisma.publicationRequest.update({
      where: { id },
      data: { lockedUntil: null },
    });
  }

  /** Backoff (§14.5): attempts++, nextAttemptAt = now + 2^attempts мин;
   * после maxAttempts — FAILED, дальше воркер строку не берёт. */
  private async recordFailure(
    row: PublishableRow,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = row.attempts + 1;
    const maxAttempts = this.cfg().maxAttempts;
    const exhausted = attempts >= maxAttempts;
    await this.prisma.publicationRequest.update({
      where: { id: row.id },
      data: {
        attempts,
        publishError: message.slice(0, 2000),
        status: exhausted ? 'FAILED' : 'APPROVED',
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + 2 ** attempts * 60_000),
        lockedUntil: null,
      },
    });
    this.logger.warn(
      `Заявка ${row.id}: попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (exhausted ? ', попытки исчерпаны → FAILED' : ''),
    );
  }
}
