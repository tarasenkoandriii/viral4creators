/**
 * GET /api/health — «жив ли сервис и видит ли он базу».
 *
 * Эндпоинт был обещан в четырёх документах, печатался при старте в
 * main.ts и стоял пунктом в чеклисте приёмки — но его не существовало
 * (находка сквозной сверки этапа 28). Проще добавить его, чем вычистить
 * упоминания: healthcheck нужен и docker-compose, и деплою.
 *
 * Без гвардов: это первое, что дёргают снаружи, и оно не должно зависеть
 * ни от идентичности, ни от секретов. Наружу отдаём только факт связи с
 * БД — ни версий, ни имён хостов, ни строк подключения. Зато В ЛОГИ при
 * сбое уходит понятная диагностика (`prisma/db-error.ts`): куда стучались,
 * какого рода сбой и что с ним делать.
 */

import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { describeDbFailure } from '../../prisma/db-error';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  /** Ответила ли база на тривиальный запрос. */
  database: 'up' | 'down';
  uptimeSeconds: number;
}

@Controller('health')
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
      // Наружу — только «down»: причина сбоя не дело внешнего клиента.
      // Но в логи она обязана попасть человеческой строкой, иначе
      // «degraded» невозможно расследовать (этап 29).
      const info = describeDbFailure(error);
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
