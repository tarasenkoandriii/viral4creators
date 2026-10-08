/**
 * Кабинет Э3-бис «Аналитика с ИИ» (ТЗ §5-тер.3–6, §5-тер.14; права
 * §5-тер.13):
 *   GET   /assist/sites/:id/ai/summary?from=&to=
 *   GET   /assist/sites/:id/ai/dialogs?from=&to=&bucket=&intent=&stage=&failure=&cursor=
 *   PATCH /assist/sites/:id/conversations/:cid/label
 *   GET   /assist/sites/:id/stats/insights?week=&lang=   (lang uk|ru|en, иначе — язык Telegram читателя)
 *   PATCH /assist/sites/:id/insights/:iid
 *   GET   /assist/sites/:id/stats/behavior?from=&to=
 *   GET   /assist/sites/:id/experiments
 *   POST  /assist/sites/:id/experiments/preview
 *   POST  /assist/sites/:id/experiments              (владелец)
 *   POST  /assist/sites/:id/experiments/:eid/stop    (владелец)
 * Весь контроллер — assist: manager (оператор помощника — 403, как вся
 * статистика Э3); владелец — проверкой в сервисе экспериментов.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { AiCabinetService } from './ai/ai-cabinet.service';
import { ExperimentsService } from './exp/experiments.service';

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class AiAnalyticsController {
  constructor(
    readonly ai: AiCabinetService,
    readonly experiments: ExperimentsService,
  ) {}

  @Get('sites/:id/ai/summary')
  summary(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: Record<string, unknown>,
  ) {
    return this.ai.summary(m, id, q);
  }

  @Get('sites/:id/ai/dialogs')
  dialogs(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: Record<string, unknown>,
  ) {
    return this.ai.dialogs(m, id, q);
  }

  @Patch('sites/:id/conversations/:cid/label')
  label(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() body: unknown,
  ) {
    return this.ai.overrideLabel(m, id, cid, body);
  }

  @Get('sites/:id/stats/insights')
  insights(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('week') week?: string,
    @Query('lang') lang?: string,
  ) {
    return this.ai.insights(m, id, week, lang);
  }

  @Patch('sites/:id/insights/:iid')
  patchInsight(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('iid') iid: string,
    @Body() body: unknown,
  ) {
    return this.ai.patchInsight(m, id, iid, body);
  }

  @Get('sites/:id/stats/behavior')
  behavior(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: Record<string, unknown>,
  ) {
    return this.ai.behavior(m, id, q);
  }

  @Get('sites/:id/experiments')
  listExperiments(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.experiments.list(m, id);
  }

  @Post('sites/:id/experiments/preview')
  @HttpCode(200)
  preview(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.experiments.preview(m, id, body);
  }

  @Post('sites/:id/experiments')
  start(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.experiments.start(m, id, body);
  }

  @Post('sites/:id/experiments/:eid/stop')
  @HttpCode(200)
  stop(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('eid') eid: string,
  ) {
    return this.experiments.stop(m, id, eid);
  }
}
