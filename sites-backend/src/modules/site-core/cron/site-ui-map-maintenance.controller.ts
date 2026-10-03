/**
 * GET /cron/site-ui-map-maintenance — обслуживание общей карты интерфейса
 * (Э-С Ш4): ретенция истории и журнала промахов, срок «устарел», достройка
 * слитых элементов. Расписание — sites-backend/vercel.json, доступ по
 * CRON_SECRET (common/cron-secret.ts).
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { UiMapMaintenanceService } from '../ui-map/ui-map-maintenance.service';
import type { UiMapMaintenanceResult } from '../ui-map/ui-map-store';

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class SiteUiMapMaintenanceController {
  constructor(private readonly svc: UiMapMaintenanceService) {}

  @Get('site-ui-map-maintenance')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<UiMapMaintenanceResult> {
    assertCronSecret(authHeader);
    return this.svc.run();
  }
}
