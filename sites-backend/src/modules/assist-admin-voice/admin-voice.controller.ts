/**
 * Кабинет голосового управления «Админкой» — Э6-бис (б) (ТЗ §5-бис.2,
 * §5-бис.9, §5-бис.13):
 *   GET|PATCH /assist/sites/:id/admin-mode/voice-control
 *   POST      /assist/sites/:id/admin-mode/voice-control/test-token
 *   GET       /assist/sites/:id/admin-mode/voice-control/tests
 *   GET       /assist/sites/:id/admin-mode/voice-control/tests/:tid
 * Права — ТОЛЬКО `assistAdmin: owner` (§5-бис.2 «только владелец»; §5-бис.10
 * п.6: менеджер получает 403; К-9).
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_ADMIN_OWNER,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { AdminVoiceSettingsService } from './admin-voice-settings.service';
import type { AdminVoiceSettingsPatch } from './api-types';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminVoiceController {
  constructor(private readonly settings: AdminVoiceSettingsService) {}

  @Get(':id/admin-mode/voice-control')
  get(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.get(m, id);
  }

  @Patch(':id/admin-mode/voice-control')
  patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: AdminVoiceSettingsPatch,
  ) {
    return this.settings.save(m, id, body);
  }

  /** Одноразовая ссылка мастера — мимо кэшей (в ней токен). */
  @Post(':id/admin-mode/voice-control/test-token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  testToken(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { hostId?: unknown; path?: unknown },
  ) {
    return this.settings.testToken(m, id, body);
  }

  @Get(':id/admin-mode/voice-control/tests')
  tests(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.tests(m, id);
  }

  @Get(':id/admin-mode/voice-control/tests/:tid')
  test(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('tid') tid: string,
  ) {
    return this.settings.test(m, id, tid);
  }
}
