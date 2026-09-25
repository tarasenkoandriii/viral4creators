/**
 * UserAudioTracksService — ролик на других языках, для ВЛАДЕЛЬЦА ролика
 * (этап 148, TODO §III п.12).
 *
 * ## Чем это отличается от соседнего admin-сервиса
 *
 * Механизм тот же: перевод реплики под хронометраж, синтез, сборка
 * полного звука и субтитры (этапы 138–141). Разные у них не действия, а
 * то, кто их заказывает, и это меняет три вещи.
 *
 * **Владелец.** У оператора доступ ко всем сессиям по должности; у
 * пользователя — только к своим. Открыть admin-сервис пользователю «как
 * есть» значило бы дать любому собрать дорожки к чужому ролику, зная
 * один идентификатор.
 *
 * **Тариф.** Дорожки продаются как возможность (`multilingualTracks`,
 * Premium): один раз сняли — вышли на пять рынков.
 *
 * **Деньги.** И это главное. `AudioTrackService` писался admin-only и
 * потолок расхода НЕ проверяет — он только записывает израсходованное.
 * Для оператора это верно: он доверенный, и расход наш. Для
 * пользователя — дыра: каждая дорожка это перевод, синтез и задача
 * ffmpeg, то есть настоящие деньги, и без проверки один человек за
 * вечер выбрал бы бюджет, не встретив ни одного отказа. Поэтому
 * суточный потолок проверяется ЗДЕСЬ, до вызова.
 *
 * ## Почему заливает всё равно человек
 *
 * API звуковых дорожек у YouTube нет вовсе (этап 139): ни загрузить, ни
 * проверить. Пользователь получает готовые файлы и заливает их в Studio
 * сам — так же, как наш оператор. Обещать здесь автоматику значило бы
 * обещать чужой API, которого нет.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { AudioTrackService } from './audio-track.service';
import {
  AudioTrackRow,
  AudioTrackView,
  localesToBuild,
  toView,
} from './admin-audio-tracks.service';
import {
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from '../../common/locale';

@Injectable()
export class UserAudioTracksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly tracks: AudioTrackService,
  ) {}

  /** Дорожки своего ролика. Список читать можно и без Premium. */
  async list(
    userId: string,
    sessionId: string,
  ): Promise<{
    sourceLocale: string;
    toBuild: string[];
    tracks: AudioTrackView[];
  }> {
    const session = await this.own(userId, sessionId);

    const rows = (await this.prisma.videoAudioTrack.findMany({
      where: { sessionId },
      orderBy: { locale: 'asc' },
    })) as AudioTrackRow[];

    // Дозабор готовых сборок — до ответа, иначе человек увидит
    // «собирается» у дорожки, которая готова полчаса (тот же приём, что
    // на экране оператора).
    // ПАРАЛЛЕЛЬНО (аудит этапа 148). У оператора этот список открывают
    // раз в несколько минут, а экран пользователя будет опрашивать его
    // постоянно: четыре опроса чужого ffmpeg подряд на каждом тике —
    // это секунды ожидания там, где их никто не ждёт. Опросы
    // независимы и наружу не бросают.
    const pending = rows.filter((r) => r.mixJobId && !r.trackUrl);
    await Promise.all(
      pending.map((row) => this.tracks.pollMix(sessionId, row.locale)),
    );
    const fresh = pending.length
      ? ((await this.prisma.videoAudioTrack.findMany({
          where: { sessionId },
          orderBy: { locale: 'asc' },
        })) as AudioTrackRow[])
      : rows;

    const currentVideoId = session.generatedVideo?.generatedVideoId ?? null;
    const source = normalizeLocale(session.locale);
    return {
      sourceLocale: source,
      toBuild: localesToBuild(fresh, source, currentVideoId),
      tracks: fresh.map((row) => toView(row, currentVideoId)),
    };
  }

  /**
   * Собрать дорожку одного языка. По одной за запрос — у serverless нет
   * фона, и четыре подряд не укладываются в таймаут функции (находка
   * аудита этапа 139).
   */
  async build(
    userId: string,
    sessionId: string,
    localeRaw: string,
  ): Promise<AudioTrackView> {
    const session = await this.own(userId, sessionId);
    await this.plans.assertUser(userId, 'multilingualTracks');
    // Потолок — ДО платной работы. См. шапку: сам `AudioTrackService`
    // его не проверяет, он писался для доверенного оператора.
    await this.plans.assertCanSpendUser(userId, {
      projectId: session.projectId ?? null,
    });

    // Незнакомый язык — ОТКАЗ, а не молчаливый откат к умолчанию
    // (аудит этапа 148). `normalizeLocale` возвращает русский на любой
    // мусор: у ролика с украинским оригиналом опечатка в адресе
    // собрала бы и оплатила русскую дорожку, которую никто не просил, —
    // и узнать об этом можно было бы только по готовому файлу. Ровно
    // эту же ошибку нашёл аудит этапа 147 в поле `locale` внешнего API.
    if (!isSupportedLocale(localeRaw)) {
      throw new BadRequestException(
        `Язык дорожки: ${SUPPORTED_LOCALES.join(', ')}`,
      );
    }
    const locale = localeRaw;
    if (locale === normalizeLocale(session.locale)) {
      throw new ForbiddenException(
        'Это язык оригинала — отдельная дорожка не нужна',
      );
    }

    await this.tracks.build(sessionId, locale);

    const row = (await this.prisma.videoAudioTrack.findUnique({
      where: { sessionId_locale: { sessionId, locale } },
    })) as AudioTrackRow | null;
    if (!row) throw new NotFoundException('Дорожка не найдена');
    return toView(row, session.generatedVideo?.generatedVideoId ?? null);
  }

  /**
   * Своя сессия — или её для этого человека нет.
   *
   * Не «чужая», а «не найдена»: по ответу нельзя узнать, существует ли
   * чужой ролик с таким идентификатором.
   */
  private async own(userId: string, sessionId: string) {
    const session = await this.sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Ролик не найден');
    }
    return session;
  }
}
