/**
 * TelegramLoginService — постоянный (30 дней) Telegram-логин для
 * обычного браузерного frontend/ (вне Telegram). Кнопка «Войти через
 * Telegram» на frontend — по просьбе пользователя, зеркально уже
 * существующей кнопке в admin/ (Telegram Login Widget), но с другим
 * назначением: здесь вход НЕ даёт никаких прав (нет проверки
 * isOperator), он только привязывает браузер к Telegram-пользователю,
 * чтобы последующие сессии создавались с userId, а не анонимно — то же
 * самое, что и так происходит автоматически внутри Telegram через
 * initData, просто доступно и в обычном браузере.
 *
 * Третий, независимый механизм идентификации в проекте — не путать с:
 *  - TelegramIdentityMiddleware (modules/telegram-auth) — заголовок
 *    X-Telegram-Init-Data внутри Telegram, без состояния на сервере;
 *  - AdminAuthService (modules/admin-auth) — httpOnly cookie
 *    admin_session, 7 дней, доступ к /admin гейтится isOperator.
 * Здесь — httpOnly cookie user_session, 30 дней (дольше, потому что
 * это чистая идентификация без привилегий, а не вход в защищённую
 * панель), никакого isOperator-гейта нет вообще.
 *
 * См. doc/TELEGRAM-ADMIN.md.
 */

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
} from '../admin-auth/telegram-login-widget.util';
import { devTelegramId, isDevAuthAllowed } from '../admin-auth/dev-login';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

export interface UserSessionResult {
  token: string;
  expiresAt: Date;
}

export interface TelegramLoginMeResult {
  telegramId: string;
  firstName: string | null;
  username: string | null;
}

@Injectable()
export class TelegramLoginService {
  private readonly logger = new Logger(TelegramLoginService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Telegram Login Widget использует ТОТ ЖЕ бот, что и TMA
   * (TELEGRAM_BOT_TOKEN) — в отличие от админки, которой из-за
   * ограничения /setdomain (один домен на бота) может понадобиться
   * отдельный ADMIN_LOGIN_BOT_TOKEN. Здесь второй бот не нужен: TMA
   * сама по себе не требует привязки домена (initData валидируется
   * подписью, не доменом виджета), поэтому /setdomain основного бота
   * можно смело указывать на домен frontend/ — см. doc/DEPLOYMENT.md.
   */
  async loginWithTelegram(
    payload: TelegramLoginWidgetPayload,
  ): Promise<UserSessionResult> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

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

    const user = await this.prisma.user.upsert({
      where: { telegramId: String(parsed.id) },
      update: {
        firstName: parsed.firstName ?? null,
        username: parsed.username ?? null,
      },
      create: {
        telegramId: String(parsed.id),
        firstName: parsed.firstName ?? null,
        username: parsed.username ?? null,
      },
    });

    return this.createSession(user.id);
  }

  /**
   * Docker dev-запуск: Telegram Login Widget физически не работает на
   * http://localhost (см. modules/admin-auth/admin-auth.service.ts —
   * тот же аргумент), поэтому у постоянного cookie-логина тоже есть
   * dev-обход. Тот же префикс "dev-" и тот же devUserId по умолчанию
   * ("123"), что у TMA-заголовка X-Dev-User-Id и у admin dev-login —
   * все три dev-входа резолвятся в одного пользователя.
   */
  async devLogin(rawDevUserId: string): Promise<UserSessionResult> {
    if (!isDevAuthAllowed()) {
      throw new NotFoundException('Cannot POST /telegram-login/dev-login');
    }

    const telegramId = devTelegramId(rawDevUserId.trim() || '123');
    this.logger.warn(
      `DEV LOGIN — постоянная cookie-сессия frontend выдана для ${telegramId} без проверки Telegram.`,
    );

    const user = await this.prisma.user.upsert({
      where: { telegramId },
      update: {},
      create: { telegramId },
    });

    return this.createSession(user.id);
  }

  private async createSession(userId: string): Promise<UserSessionResult> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.pruneExpiredSessions();
    await this.prisma.userSession.create({
      data: { userId, token, expiresAt },
    });
    return { token, expiresAt };
  }

  /** Просроченные UserSession чистятся оппортунистически при каждом
   * логине — то же решение, что у AdminAuthService, отдельный cron не
   * заводится ради этого. */
  private async pruneExpiredSessions(): Promise<void> {
    await this.prisma.userSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  async logout(token: string): Promise<{ ok: true }> {
    await this.prisma.userSession.deleteMany({ where: { token } });
    return { ok: true };
  }

  /** Резолвит cookie-токен в User.id, или null если токена нет/просрочен —
   * НИКОГДА не бросает (используется и из /telegram-login/me, и из
   * TelegramIdentityMiddleware, оба обязаны оставаться не блокирующими). */
  async resolveToken(token: string): Promise<string | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { token },
    });
    if (!session || session.expiresAt <= new Date()) return null;
    return session.userId;
  }

  async me(userId: string): Promise<TelegramLoginMeResult | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, firstName: true, username: true },
    });
    return user ?? null;
  }
}
