/**
 * Кабинет голосового управления «Сайтом» — Э6-бис (а) (ТЗ §5-бис.2,
 * §5-бис.9 «один маршрут на режим»):
 *   GET   /assist/sites/:id/voice-control/site
 *   PATCH /assist/sites/:id/voice-control/site   { state, rules?, risksVersion?, partialAck? }
 * (г) мастер проверки Т-2 (§5-бис.13):
 *   POST  /assist/sites/:id/voice-control/site/test-token   { host?, testHost? }
 *   GET   /assist/sites/:id/voice-control/site/tests
 *   GET   /assist/sites/:id/voice-control/site/tests/:tid
 *   (Т-3 `…/autotest` — с общим QA-воркером, отложен.)
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist =
 * manager (владелец или менеджер кабинета, §5-бис.2; оператор — 403).
 * «Админка» — свой маршрут `…/admin-mode/voice-control` (Э6-бис (б)).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type {
  VoiceControlSettingsPatch,
  VoiceTestTokenRequest,
} from '../api-types';
import { VoiceControlSettingsService } from './voice-control-settings.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceControlSettingsController {
  constructor(private readonly settings: VoiceControlSettingsService) {}

  @Get(':id/voice-control/site')
  get(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.get(m, id);
  }

  @Patch(':id/voice-control/site')
  save(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: VoiceControlSettingsPatch,
  ) {
    return this.settings.save(m, id, body);
  }

  @Post(':id/voice-control/site/test-token')
  @HttpCode(200)
  testToken(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: VoiceTestTokenRequest,
  ) {
    return this.settings.testToken(m, id, body);
  }

  @Get(':id/voice-control/site/tests')
  tests(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.tests(m, id);
  }

  @Get(':id/voice-control/site/tests/:tid')
  test(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('tid') tid: string,
  ) {
    return this.settings.test(m, id, tid);
  }
}
