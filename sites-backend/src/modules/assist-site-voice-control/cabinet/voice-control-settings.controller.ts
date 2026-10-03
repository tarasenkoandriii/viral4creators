/**
 * Кабинет голосового управления «Сайтом» — Э6-бис (а) (ТЗ §5-бис.2,
 * §5-бис.9 «один маршрут на режим»):
 *   GET   /assist/sites/:id/voice-control/site
 *   PATCH /assist/sites/:id/voice-control/site   { state, rules?, risksVersion? }
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist =
 * manager (владелец или менеджер кабинета, §5-бис.2; оператор — 403).
 * «Админка» — свой маршрут `…/admin-mode/voice-control` (Э6-бис (б)).
 */
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import type { VoiceControlSettingsPatch } from '../api-types';
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
}
