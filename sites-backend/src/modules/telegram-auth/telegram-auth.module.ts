import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TelegramIdentityGuard } from './telegram-identity.guard';
import { WebAuthController } from './web/web-auth.controller';
import { WebSessionService } from './web/web-session.service';
import {
  PrismaWebSessionStore,
  WebSessionStore,
} from './web/web-session.store';

/**
 * Авторизация двух ботов (ТЗ помощника §4.1). Гвард регистрируется
 * глобально: маршрут без `@AllowApps`/`@PublicRoute` закрыт, и
 * подключать гвард в каждом контроллере не нужно (а забыть — нельзя).
 *
 * Э0-W: веб-кабинет — вход виджетом Telegram в обычном браузере, сессия в
 * HttpOnly-cookie (web/). Гвард принимает её, когда в запросе нет initData.
 * Хранилище сессий — за абстракцией `WebSessionStore`: тесты подменяют его
 * памятью (`overrideProvider(WebSessionStore)`).
 */
@Module({
  controllers: [WebAuthController],
  providers: [
    TelegramIdentityGuard,
    { provide: APP_GUARD, useExisting: TelegramIdentityGuard },
    WebSessionService,
    { provide: WebSessionStore, useClass: PrismaWebSessionStore },
  ],
  exports: [TelegramIdentityGuard, WebSessionService],
})
export class TelegramAuthModule {}
