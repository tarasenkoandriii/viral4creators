/**
 * GET /cron/site-credentials-retention — сроки тестовых учёток и секретов
 * (Э-С Ш2), расписание — sites-backend/vercel.json. Доступ по CRON_SECRET.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { assertCronSecret } from '../../common/cron-secret';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { SiteCredentialsService } from './site-credentials.service';

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class SiteCredentialsRetentionController {
  constructor(private readonly svc: SiteCredentialsService) {}

  @Get('site-credentials-retention')
  async run(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.svc.runRetention();
  }
}
