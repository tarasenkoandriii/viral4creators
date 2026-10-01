/**
 * GET /health — «жив ли сервис и видит ли он базу» (как у backend).
 *
 * Без авторизации (`@PublicRoute` — глобальный гвард двух ботов иначе
 * закрыл бы маршрут): это первое, что дёргают снаружи. Наружу — только факт связи
 * с БД, без версий, хостов и строк подключения; причина сбоя — в лог
 * человеческой строкой (shared/db-error.ts, без пароля).
 *
 * Возвращает голые данные — конверт `{success,data,meta}` добавляет
 * ResponseInterceptor.
 */

import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { describeDbFailure } from '../shared/db-error';
import { PublicRoute } from '../modules/telegram-auth/allow-apps.decorator';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  uptimeSeconds: number;
}

@Controller('health')
@PublicRoute('здоровье сервиса дёргают снаружи без Telegram')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(): Promise<HealthResponse> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch (error) {
      const info = describeDbFailure(error, process.env.SITES_DATABASE_URL);
      this.logger.error(info.message);
      this.logger.error(`Что делать: ${info.hint}`);
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
