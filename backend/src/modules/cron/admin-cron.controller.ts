/**
 * AdminCronController — вкладка «Кроны» в админке (этап 69, доп. ТЗ
 * «Кроны в админке», аналогично Solar Shop): реестр десяти джобов,
 * история прогонов, ручной запуск с необязательным debug.
 *
 * `AdminSessionGuard` — валидная admin-сессия, `assertOperator` внутри
 * каждого маршрута — то же двойное правило, что у всех остальных
 * маршрутов `admin-panel.controller.ts` (сессия сама по себе не значит
 * «оператор»). Ручной запуск дополнительно ограничен `RateLimitGuard`
 * (5 запросов/15с) — кроны дёргают платные внешние API
 * (YouTube/TikTok, xAI, WayForPay), спам-клики по кнопке «Запустить»
 * не должны превращаться в спам-вызовы этих API.
 */

import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { AdminCronService } from './admin-cron.service';

@Controller('admin/cron')
@UseGuards(AdminSessionGuard)
export class AdminCronController {
  constructor(
    private readonly adminCron: AdminCronService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get('registry')
  async registry(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminCron.getRegistry();
  }

  @Get('history')
  async history(
    @Req() req: AdminAuthenticatedRequest,
    @Query('jobKey') jobKey?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminCron.getHistory(jobKey);
  }

  @Post(':jobKey/run')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'admin-cron-run', limit: 5, windowSec: 15 })
  async run(
    @Req() req: AdminAuthenticatedRequest,
    @Param('jobKey') jobKey: string,
    @Query('debug') debug?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const debugMode = debug === 'true' || debug === '1';
    return this.adminCron.run(jobKey, req.userId, debugMode);
  }
}
