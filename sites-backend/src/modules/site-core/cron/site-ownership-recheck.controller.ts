/**
 * GET /cron/site-ownership-recheck — крон ядра (ТЗ помощника §4.15, QA-ТЗ
 * §4.9), расписание — sites-backend/vercel.json.
 *
 * Без Telegram (`@PublicRoute`): его вызывает Vercel Cron с
 * `Authorization: Bearer <CRON_SECRET>` (common/cron-secret.ts — правило
 * то же, что у кронов backend). Логика — в OwnershipRecheckService.
 */

import { Controller, Get, Headers } from '@nestjs/common';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  OwnershipRecheckService,
  RecheckResult,
} from '../ownership/ownership-recheck.service';

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class SiteOwnershipRecheckController {
  constructor(private readonly recheck: OwnershipRecheckService) {}

  @Get('site-ownership-recheck')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<RecheckResult> {
    assertCronSecret(authHeader);
    return this.recheck.run();
  }
}
