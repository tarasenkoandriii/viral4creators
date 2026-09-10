/**
 * PublishingChannelService — YouTube/TikTok каналы, подключённые
 * пользователем через OAuth (этап 61, ТЗ §14.2-14.4). Канал принадлежит
 * ПОЛЬЗОВАТЕЛЮ (кто прошёл OAuth), не проекту/сессии — один и тот же
 * канал можно назначить как источник выгрузки для нескольких проектов.
 *
 * Токены хранятся только зашифрованными (token-crypto.ts) — сервис
 * никогда не отдаёт их наружу, `toView()` физически не включает
 * соответствующие поля.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { loadConfiguration } from '../../config/configuration';
import { decryptToken, encryptToken } from '../../common/token-crypto';
import { PublicationPlatform } from '../../common/types/publication.types';
import {
  ChannelStatus,
  PublishingChannelView,
} from '../../common/types/publishing-channel.types';
import { signOAuthState, verifyOAuthState } from './oauth-state.util';
import { GoogleOAuthService } from './google-oauth.service';
import { TiktokOAuthService } from './tiktok-oauth.service';

/** Структурный тип строки — та же причина, что у PublicationRow. */
export interface PublishingChannelRow {
  id: string;
  userId: string;
  platform: PublicationPlatform;
  externalId: string;
  title: string;
  avatarUrl: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: Date | null;
  scopes: string[];
  status: ChannelStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function toView(row: PublishingChannelRow): PublishingChannelView {
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.externalId,
    title: row.title,
    avatarUrl: row.avatarUrl,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function isPlatform(v: string): v is PublicationPlatform {
  return v === 'YOUTUBE' || v === 'TIKTOK';
}

@Injectable()
export class PublishingChannelService {
  private readonly logger = new Logger(PublishingChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly google: GoogleOAuthService,
    private readonly tiktok: TiktokOAuthService,
  ) {}

  private tokenKey(): string {
    return loadConfiguration().publishing.channelTokenKey;
  }

  // ── OAuth start/callback ────────────────────────────────────────────────

  /** POST /channels/oauth/:platform/start. */
  async buildAuthUrl(userId: string, platformRaw: string): Promise<string> {
    if (!isPlatform(platformRaw)) {
      throw new NotFoundException(`Unknown platform ${platformRaw}`);
    }
    // Подключение канала имеет смысл ровно для тех, кому доступна очередь
    // публикации (§23) — тот же гейт, что у самой публикации.
    await this.plans.assertUser(userId, 'publication');
    const provider = this.providerFor(platformRaw);
    if (!provider.configured()) {
      throw new ForbiddenException(
        `${platformRaw} не настроен на сервере — обратитесь к владельцу продукта`,
      );
    }
    const state = signOAuthState(userId, platformRaw, this.tokenKey());
    return provider.buildAuthUrl(state);
  }

  /**
   * GET /channels/oauth/:platform/callback — ПУБЛИЧНЫЙ маршрут, его
   * дёргает сам Google/TikTok. userId достаётся из `state`, не из
   * заголовков (их здесь нет и быть не может).
   */
  async handleCallback(
    platformRaw: string,
    code: string | undefined,
    state: string | undefined,
  ): Promise<PublishingChannelView> {
    if (!isPlatform(platformRaw)) {
      throw new NotFoundException(`Unknown platform ${platformRaw}`);
    }
    const payload = verifyOAuthState(state, this.tokenKey());
    if (!payload || payload.platform !== platformRaw) {
      throw new ForbiddenException(
        'Ссылка подключения канала устарела или недействительна — начните заново',
      );
    }
    if (!code) {
      throw new ForbiddenException('Площадка не вернула код авторизации');
    }
    const provider = this.providerFor(platformRaw);
    const tokens = await provider.exchangeCode(code);
    const info = await provider.fetchChannelInfo(tokens.accessToken);

    const data = {
      userId: payload.userId,
      platform: platformRaw,
      externalId: info.externalId,
      title: info.title,
      avatarUrl: info.avatarUrl,
      accessTokenEnc: encryptToken(tokens.accessToken, this.tokenKey()),
      refreshTokenEnc: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, this.tokenKey())
        : null,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      status: 'ACTIVE' as const,
    };
    // Апсерт по [platform, externalId]: повторное подключение того же
    // канала (например, после истечения refresh-токена) обновляет токены
    // на месте, а не плодит вторую строку на тот же канал.
    const row = (await this.prisma.publishingChannel.upsert({
      where: {
        platform_externalId: {
          platform: platformRaw,
          externalId: info.externalId,
        },
      },
      create: data,
      update: {
        // userId НЕ трогаем при переподключении с другого аккаунта —
        // канал уже кому-то принадлежит, чужой OAuth не должен его
        // угонять. Если это правда владелец — данные и так совпадут.
        title: data.title,
        avatarUrl: data.avatarUrl,
        accessTokenEnc: data.accessTokenEnc,
        refreshTokenEnc: data.refreshTokenEnc,
        expiresAt: data.expiresAt,
        scopes: data.scopes,
        status: 'ACTIVE',
      },
    })) as PublishingChannelRow;
    return toView(row);
  }

  // ── User side ────────────────────────────────────────────────────────────

  async listForUser(userId: string): Promise<PublishingChannelView[]> {
    const rows: PublishingChannelRow[] =
      await this.prisma.publishingChannel.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
    return rows.map(toView);
  }

  async disconnect(userId: string, id: string): Promise<void> {
    const row: PublishingChannelRow | null =
      await this.prisma.publishingChannel.findUnique({
        where: { id },
      });
    if (!row || row.userId !== userId) {
      throw new NotFoundException(`Channel ${id} not found`);
    }
    // Best-effort отзыв гранта у провайдера — не блокирует удаление строки.
    try {
      const accessToken = decryptToken(row.accessTokenEnc, this.tokenKey());
      await this.providerFor(row.platform).revoke(accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Не удалось отозвать грант канала ${id} у провайдера: ${message}`,
      );
    }
    // SetNull на PublicationRequest.channelId/Project/BrandManifest —
    // заявки и назначения по умолчанию остаются, просто теряют канал.
    await this.prisma.publishingChannel.delete({ where: { id } });
  }

  // ── Used by PublishWorkerService ────────────────────────────────────────

  /**
   * Ленивый refresh access-токена перед выгрузкой. Невалидный refresh
   * (грант отозван пользователем на стороне площадки) переводит канал в
   * REVOKED — заявки этого канала остаются APPROVED с понятной причиной
   * в publishError, воркер их больше не берёт, пока канал не переподключат.
   */
  async ensureFreshToken(
    channelId: string,
  ): Promise<{ accessToken: string; channel: PublishingChannelRow }> {
    const row: PublishingChannelRow | null =
      await this.prisma.publishingChannel.findUnique({
        where: { id: channelId },
      });
    if (!row) throw new NotFoundException(`Channel ${channelId} not found`);
    if (row.status !== 'ACTIVE') {
      throw new ForbiddenException(
        `Канал ${row.title} отключён (${row.status}) — переподключите его`,
      );
    }
    const stillFresh =
      row.expiresAt && row.expiresAt.getTime() > Date.now() + 60_000;
    if (stillFresh) {
      return {
        accessToken: decryptToken(row.accessTokenEnc, this.tokenKey()),
        channel: row,
      };
    }
    if (!row.refreshTokenEnc) {
      await this.markRevoked(row.id);
      throw new ForbiddenException(
        `У канала ${row.title} нет refresh-токена и срок доступа истёк — переподключите канал`,
      );
    }
    try {
      const refreshToken = decryptToken(row.refreshTokenEnc, this.tokenKey());
      const refreshed = await this.providerFor(row.platform).refreshAccessToken(
        refreshToken,
      );
      const updated = (await this.prisma.publishingChannel.update({
        where: { id: row.id },
        data: {
          accessTokenEnc: encryptToken(refreshed.accessToken, this.tokenKey()),
          expiresAt: refreshed.expiresAt,
        },
      })) as PublishingChannelRow;
      return { accessToken: refreshed.accessToken, channel: updated };
    } catch (error) {
      await this.markRevoked(row.id);
      const message = error instanceof Error ? error.message : String(error);
      throw new ForbiddenException(
        `Не удалось обновить токен канала ${row.title}: ${message} — переподключите канал`,
      );
    }
  }

  private async markRevoked(id: string): Promise<void> {
    await this.prisma.publishingChannel.update({
      where: { id },
      data: { status: 'REVOKED' },
    });
  }

  private providerFor(
    platform: PublicationPlatform,
  ): GoogleOAuthService | TiktokOAuthService {
    return platform === 'YOUTUBE' ? this.google : this.tiktok;
  }
}
