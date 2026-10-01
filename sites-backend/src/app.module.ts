/**
 * Корневой модуль sites-backend.
 *
 * Каркас Э0: база и здоровье. Модули site-core (кабинет, сайты, хосты,
 * подтверждение владения), авторизация двух ботов и вебхуки подключаются
 * сюда же своими этапами.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { TelegramAuthModule } from './modules/telegram-auth/telegram-auth.module';
import { TelegramWebhookModule } from './modules/telegram-webhook/telegram-webhook.module';
import { SiteCoreModule } from './modules/site-core/site-core.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    // Глобальный гвард двух ботов: маршрут без @AllowApps/@PublicRoute закрыт.
    TelegramAuthModule,
    TelegramWebhookModule,
    // Ядро: кабинет, сайты, хосты, подтверждение владения, крон перепроверки.
    SiteCoreModule,
  ],
})
export class AppModule {}
