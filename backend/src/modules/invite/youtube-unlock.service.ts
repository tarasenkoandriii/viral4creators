/**
 * Проверка подписки на наш YouTube-канал — «Условно бесплатный Lite»
 * §6.3, этап 140. Второй способ заплатить за вторую генерацию; первый
 * (подписка на Telegram-канал) сделан этапом 133 и работает рядом.
 *
 * ## Чем это отличается от подключения канала (этап 61)
 *
 * Там человек отдаёт продукту долгоживущее право ЗАГРУЖАТЬ ролики на
 * свой канал. Здесь — разовое право прочитать список своих подписок, на
 * десять минут. Поэтому и токен живёт в своей короткой таблице
 * (`YoutubeUnlockSession`), и refresh-токен не запрашивается вовсе:
 * продлить эту сессию нечем даже по ошибке.
 *
 * ## Второго экрана согласия у тех, кто уже подключил канал, нет
 *
 * Находка аудита ТЗ: `publishing-channel` просит `youtube.readonly`
 * УЖЕ СЕЙЧАС, вместе с `youtube.upload`. У человека с подключённым
 * каналом нужное право есть, и `subscriptions.list?mine=true` работает
 * тем же токеном. Показывать ему второй экран согласия значило бы
 * терять конверсию ровно той воронки, ради которой всё и делается.
 *
 * ## Что именно спрашиваем у Google
 *
 * `subscriptions.list?mine=true&forChannelId=<наш канал>` — один вызов
 * в одну единицу квоты, отвечает «подписан/нет» без выгрузки всех
 * подписок. Если подписки нет, а стенд настроил ролик для лайка —
 * `videos.getRating`, тоже одна единица. Оба ответа однозначны, и
 * хранить после проверки нечего, кроме факта.
 *
 * Квота: 10 000 единиц в сутки на весь проект, и опасен здесь не этот
 * вызов, а `search.list` (100 вызовов в сутки, их делят генератор блога
 * и поиск референсов). Выберут её они — встанут они, а не разблокировка.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { decryptToken, encryptToken } from '../../common/token-crypto';
import { GoogleOAuthService } from '../publishing-channel/google-oauth.service';
import { PublishingChannelService } from '../publishing-channel/publishing-channel.service';
import {
  signOAuthState,
  verifyOAuthState,
} from '../publishing-channel/oauth-state.util';

const API = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 10_000;

/** Десять минут: проверка делается сразу после возврата из Google. */
export const UNLOCK_SESSION_TTL_MS = 10 * 60 * 1000;

/** Чем человек заплатил — совпадает с `UnlockKind` в схеме. */
export type YoutubeUnlockKind = 'YOUTUBE_SUBSCRIPTION' | 'YOUTUBE_VIDEO_LIKE';

export interface UnlockTokenSource {
  accessToken: string;
  /** Канал Google-аккаунта: им проверяется «один аккаунт — один доступ». */
  googleChannelId: string;
  /** Взяли у уже подключённого канала, а не у короткой сессии. */
  fromConnectedChannel: boolean;
}

@Injectable()
export class YoutubeUnlockService {
  private readonly logger = new Logger(YoutubeUnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleOAuthService,
    private readonly channels: PublishingChannelService,
  ) {}

  /** Канал, подписка на который засчитывается. Пусто — способ выключен. */
  channelId(): string | undefined {
    return process.env.YOUTUBE_UNLOCK_CHANNEL_ID?.trim() || undefined;
  }

  /** Ролик, лайк которого засчитывается вместо подписки. Необязателен. */
  videoId(): string | undefined {
    return process.env.YOUTUBE_UNLOCK_VIDEO_ID?.trim() || undefined;
  }

  configured(): boolean {
    return !!this.channelId() && this.google.configured();
  }

  private tokenKey(): string {
    return loadConfiguration().publishing.channelTokenKey;
  }

  /** Ссылка на согласие Google — только чтение, без права загрузки. */
  authUrl(userId: string): string {
    return this.google.buildUnlockAuthUrl(
      signOAuthState(userId, 'YOUTUBE', this.tokenKey()),
    );
  }

  /**
   * Обмен кода на токен и запись короткой сессии. Возвращает id
   * пользователя — публичному маршруту он нужен только для лога.
   */
  async handleCallback(
    code: string | undefined,
    state: string | undefined,
  ): Promise<string> {
    const payload = verifyOAuthState(state, this.tokenKey());
    if (!payload) {
      throw new Error('Ссылка входа устарела или недействительна');
    }
    if (!code) throw new Error('Google не вернул код авторизации');

    const tokens = await this.google.exchangeUnlockCode(code);
    // Своя формулировка, а не чужая (аудит этапа 140): сообщение
    // `fetchChannelInfo` написано для ПОДКЛЮЧЕНИЯ канала выгрузки и
    // советует «создать канал перед подключением» — человеку, который
    // всего лишь подтверждает подписку, это совет не про его задачу.
    // Своего канала у него и не требуется: подписка заводит его сама.
    const info = await this.google
      .fetchChannelInfo(tokens.accessToken)
      .catch(() => {
        throw new Error(
          'У этого Google-аккаунта нет YouTube-канала — подпишитесь на канал в YouTube и войдите снова',
        );
      });

    await this.prisma.youtubeUnlockSession.upsert({
      where: { userId: payload.userId },
      create: {
        userId: payload.userId,
        accessTokenEnc: encryptToken(tokens.accessToken, this.tokenKey()),
        googleChannelId: info.externalId,
        expiresAt: new Date(Date.now() + UNLOCK_SESSION_TTL_MS),
      },
      // Повторный вход до истечения прежней сессии — обычное дело:
      // человек нажал «Войти» дважды. Правим строку на месте.
      update: {
        accessTokenEnc: encryptToken(tokens.accessToken, this.tokenKey()),
        googleChannelId: info.externalId,
        expiresAt: new Date(Date.now() + UNLOCK_SESSION_TTL_MS),
      },
    });
    return payload.userId;
  }

  /**
   * Есть ли чем проверить подписку — БЕЗ похода к Google (аудит этапа
   * 140).
   *
   * Кабинет открывается часто, и `tokenFor` в нём был плохим выбором:
   * у человека с подключённым каналом он зовёт `ensureFreshToken`, а тот
   * при протухшем токене идёт обновлять его в Google. Экран, который
   * просто показывает кнопку, не должен ради этого ходить в чужой
   * сервис: право спрашивают, когда человек нажал «Проверить», а не
   * когда он открыл страницу.
   */
  async hasSource(
    userId: string,
  ): Promise<{ ready: boolean; viaConnectedChannel: boolean }> {
    const connected = await this.prisma.publishingChannel.count({
      where: { userId, platform: 'YOUTUBE', status: 'ACTIVE' },
    });
    if (connected > 0) return { ready: true, viaConnectedChannel: true };

    const session = (await this.prisma.youtubeUnlockSession.findUnique({
      where: { userId },
      select: { expiresAt: true },
    })) as { expiresAt: Date } | null;
    return {
      ready: !!session && session.expiresAt.getTime() > Date.now(),
      viaConnectedChannel: false,
    };
  }

  /**
   * Чем проверять подписку: уже подключённым каналом (согласие есть) или
   * короткой сессией. `null` — входить ещё надо.
   */
  async tokenFor(userId: string): Promise<UnlockTokenSource | null> {
    const connected = (await this.prisma.publishingChannel.findFirst({
      where: { userId, platform: 'YOUTUBE', status: 'ACTIVE' },
      select: { id: true, externalId: true },
    })) as { id: string; externalId: string } | null;

    if (connected) {
      try {
        const { accessToken } = await this.channels.ensureFreshToken(
          connected.id,
        );
        return {
          accessToken,
          googleChannelId: connected.externalId,
          fromConnectedChannel: true,
        };
      } catch (e) {
        // Отозванный или протухший грант — не повод отказывать: у
        // человека остаётся обычный вход через Google.
        this.logger.warn(
          `токен подключённого канала не подошёл: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const session = (await this.prisma.youtubeUnlockSession.findUnique({
      where: { userId },
    })) as {
      accessTokenEnc: string;
      googleChannelId: string;
      expiresAt: Date;
    } | null;
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      // Просроченную стираем ЗДЕСЬ, а не ждём суточной уборки: приёмка
      // этапа обещает, что запись входа исчезает сама через десять
      // минут, и хранить зашифрованный чужой токен лишние часы только
      // потому, что крон ходит раз в сутки, — не то, что мы обещали.
      await this.forget(userId);
      return null;
    }

    return {
      accessToken: decryptToken(session.accessTokenEnc, this.tokenKey()),
      googleChannelId: session.googleChannelId,
      fromConnectedChannel: false,
    };
  }

  /**
   * Подписан ли на наш канал, а если нет — не лайкнул ли наш ролик.
   * `null` — спросить не удалось: это НЕ «не подписан», и отказывать по
   * нему нельзя (то же правило, что у Telegram-проверки этапа 133).
   */
  async check(accessToken: string): Promise<YoutubeUnlockKind | null | false> {
    const channelId = this.channelId();
    if (!channelId) return false;

    try {
      const res = await axios.get<{ items?: unknown[] }>(
        `${API}/subscriptions`,
        {
          timeout: TIMEOUT_MS,
          params: { part: 'id', mine: 'true', forChannelId: channelId },
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if ((res.data.items ?? []).length > 0) return 'YOUTUBE_SUBSCRIPTION';
    } catch (e) {
      this.logger.warn(
        `subscriptions.list не ответил: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }

    const videoId = this.videoId();
    if (!videoId) return false;
    try {
      const res = await axios.get<{ items?: { rating?: string }[] }>(
        `${API}/videos/getRating`,
        {
          timeout: TIMEOUT_MS,
          params: { id: videoId },
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const rating = res.data.items?.[0]?.rating;
      return rating === 'like' ? 'YOUTUBE_VIDEO_LIKE' : false;
    } catch (e) {
      this.logger.warn(
        `videos.getRating не ответил: ${e instanceof Error ? e.message : String(e)}`,
      );
      // Подписки нет, лайк спросить не удалось — честнее сказать «не
      // нашли», чем «сервис недоступен»: половина ответа у нас есть.
      return false;
    }
  }

  /** Убрать короткую сессию — сразу после проверки и по TTL. */
  async forget(userId: string): Promise<void> {
    await this.prisma.youtubeUnlockSession
      .deleteMany({ where: { userId } })
      .catch(() => undefined);
  }

  /** Уборка забытых входов: человек начал и не закончил. */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.youtubeUnlockSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
}
