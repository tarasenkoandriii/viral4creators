/**
 * Кабинет (TMA): инструменты голосовой карты «Сайта» (заход 9; Э6-тер (9),
 * (12); ТЗ §5-кватер.4, §5-кватер.10, §5-кватер.13):
 *   POST   /assist/sites/:id/voice-map/site/dev-report   выдать ссылку «отчёт для разработчика» (7 дней; прежние гаснут)
 *   GET    /assist/sites/:id/voice-map/site/dev-report   есть ли живая ссылка: срок, просмотры
 *   DELETE /assist/sites/:id/voice-map/site/dev-report   отозвать сразу
 *   GET    /assist/sites/:id/voice-map/site/misses       промахи Т-4 по целям карты за 7 дней
 * Чтение отчёта по ссылке — публичный `dev-report.controller.ts`.
 * Права — как у карты: владелец или `assist: manager` (В-49); оператор — 403.
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { DevReportService } from './dev-report.service';
import { MapMissesService } from './map-misses';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceMapToolsController {
  constructor(
    private readonly reports: DevReportService,
    private readonly misses: MapMissesService,
  ) {}

  @Post(':id/voice-map/site/dev-report')
  @HttpCode(200)
  createReport(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.reports.create(m, id);
  }

  @Get(':id/voice-map/site/dev-report')
  reportStatus(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.reports.status(m, id);
  }

  @Delete(':id/voice-map/site/dev-report')
  revokeReport(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.reports.revoke(m, id);
  }

  @Get(':id/voice-map/site/misses')
  mapMisses(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.misses.misses(m, id);
  }
}
