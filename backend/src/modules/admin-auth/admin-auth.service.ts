// AdminAuthService — единственное место, создающее/удаляющее
// AdminSession. Аутентификация сама по себе не требует isOperator — любой
// Telegram-пользователь может пройти /admin/auth/*, но данные (сессии,
// телеметрия — см. modules/admin-panel) отдельно проверяют флаг и честно
// отвечают 403, а не ошибкой входа.
//
// Перенесено из Devil's Advocate (apps/api/src/admin-auth/admin-auth.service.ts),
// урезано до единственного флага isOperator — isLibraryModerator/
// isVenueModerator там были про модерацию контента, которой в этом
// продукте не существует.

import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  validateTelegramLoginWidgetPayload,
  TelegramLoginWidgetInvalidError,
  TelegramLoginWidgetPayload,
} from './telegram-login-widget.util';
import { devTelegramId, isDevAuthAllowed } from './dev-login';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

export interface AdminSessionResult {
  token: string;
  expiresAt: Date;
}

export interface AdminMeResult {
  userId: string;
  isOperator: boolean;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Docker dev-запуск: вход в админку без Telegram Login Widget. Widget
   * физически не работает на http://localhost (домен виджета задаётся
   * боту через @BotFather /setdomain, localhost туда не принимается) —
   * без dev-входа локальная админка недоступна в принципе.
   *
   * Пользователю принудительно выставляется isOperator: true — иначе
   * dev-вход был бы бесполезен (единственная защищённая часть админки —
   * список сессий/телеметрия — требует этот флаг).
   */
  async devLogin(rawDevUserId: string): Promise<AdminSessionResult> {
    if (!isDevAuthAllowed()) {
      // 404, а не 403 — эндпоинт не должен выглядеть существующим наружу.
      throw new NotFoundException('Cannot POST /admin/auth/dev-login');
    }

    const telegramId = devTelegramId(rawDevUserId.trim() || '123');

    this.logger.warn(
      `ADMIN DEV LOGIN — выдана сессия админки для ${telegramId} без проверки Telegram. ` +
        'Убедиться, что ALLOW_DEV_AUTH не выставлен в проде.',
    );

    const user = await this.prisma.user.upsert({
      where: { telegramId },
      update: { isOperator: true },
      create: { telegramId, isOperator: true },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.pruneExpiredSessions();
    await this.prisma.adminSession.create({
      data: { userId: user.id, token, expiresAt },
    });

    return { token, expiresAt };
  }

  private adminLoginBotToken(): string {
    const dedicated = process.env.ADMIN_LOGIN_BOT_TOKEN?.trim();
    if (dedicated) return dedicated;
    const fallback = process.env.TELEGRAM_BOT_TOKEN;
    if (!fallback) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return fallback;
  }

  async loginWithTelegram(
    payload: TelegramLoginWidgetPayload,
  ): Promise<AdminSessionResult> {
    const botToken = this.adminLoginBotToken();

    let parsed;
    try {
      parsed = validateTelegramLoginWidgetPayload(payload, { botToken });
    } catch (err) {
      if (err instanceof TelegramLoginWidgetInvalidError) {
        throw new UnauthorizedException(
          'Invalid Telegram Login Widget payload',
        );
      }
      throw err;
    }

    // Тот же telegramId-неймспейс, что у TMA-пользователей — вход через
    // админку не заводит параллельного "admin-пользователя".
    const user = await this.prisma.user.upsert({
      where: { telegramId: String(parsed.id) },
      update: {},
      create: { telegramId: String(parsed.id) },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.pruneExpiredSessions();
    await this.prisma.adminSession.create({
      data: { userId: user.id, token, expiresAt },
    });

    return { token, expiresAt };
  }

  /** Просроченные AdminSession чистятся оппортунистически при каждом
   * логине (логины редки, чистка идемпотентна) — отдельный cron не
   * заводится ради этого. */
  private async pruneExpiredSessions(): Promise<void> {
    await this.prisma.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  async logout(token: string): Promise<{ ok: true }> {
    await this.prisma.adminSession.deleteMany({ where: { token } });
    return { ok: true };
  }

  async me(userId: string): Promise<AdminMeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isOperator: true },
    });
    if (!user) {
      throw new UnauthorizedException('User not found for this admin session');
    }
    return { userId, isOperator: user.isOperator };
  }
}
