/**
 * GET /cron/browser-jobs-retention — сроки заданий браузерного воркера и их
 * артефактов в приватном Blob (Э-С Ш3), расписание — sites-backend/vercel.json.
 * Доступ по CRON_SECRET.
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
}
