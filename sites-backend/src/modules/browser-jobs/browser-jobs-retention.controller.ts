/**
 * Кроны очереди браузерного воркера (Э-С Ш3), расписание —
 * sites-backend/vercel.json, доступ по CRON_SECRET:
 *
 *   GET /cron/browser-jobs-retention — раз в сутки: уборка + сроки заданий
 *     и их артефактов в приватном Blob;
 *   GET /cron/browser-jobs-reap — каждые 5 минут (аудит Ш3 P2): истёкшие
 *     аренды (в том числе при выключенном воркере), ожидающие с отменой,
 *     оборванные обработчики продуктов и сверка продуктов — без проверки
 *     выключателя, иначе задания и записи продуктов висят `running`.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { assertCronSecret } from '../../common/cron-secret';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { BrowserJobsService } from './browser-jobs.service';

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class BrowserJobsRetentionController {
  constructor(private readonly svc: BrowserJobsService) {}

  @Get('browser-jobs-retention')
  async run(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.svc.runRetention();
  }

  @Get('browser-jobs-reap')
  async reap(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.svc.reap();
  }
}
