/**
 * Кабинетные маршруты виджета, персоны и лидов — W4 (ТЗ §4.16, контракт Э2 §6):
 *   GET    /assist/sites/:id/widget
 *   POST   /assist/sites/:id/widget/keys
 *   PATCH  /assist/sites/:id/widget/draft            { config }
 *   POST   /assist/sites/:id/widget/publish
 *   POST   /assist/sites/:id/widget/rollback/:ver
 *   POST   /assist/sites/:id/widget/preview-token    { purpose, hostId? }
 *   POST   /assist/sites/:id/widget/check-install
 *   PATCH  /assist/sites/:id/widget/controls         { chatPaused }
 *   POST   /assist/sites/:id/widget/assets           { kind, mime, dataBase64 }
 *   GET|PATCH /assist/sites/:id/persona              { persona }
 *   POST   /assist/sites/:id/persona/publish
 *   POST   /assist/sites/:id/persona/rollback/:ver
 *   GET|PATCH /assist/sites/:id/leads-config         { config }
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist = manager
 * (оператор — 403), как у знаний «Сайта» Э1.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
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
import { InstallCheckService } from './install-check.service';
import { PersonaService } from './persona.service';
import { WidgetSettingsService } from './widget-settings.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class SiteSetupController {
  constructor(
    private readonly widget: WidgetSettingsService,
    private readonly persona: PersonaService,
    private readonly install: InstallCheckService,
  ) {}

  @Get(':id/widget')
  getWidget(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.widget.get(m, id);
  }

  @Post(':id/widget/keys')
  @HttpCode(200)
  keys(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.widget.ensureKeys(m, id);
  }

  @Patch(':id/widget/draft')
  draft(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { config?: unknown },
  ) {
    return this.widget.saveDraft(m, id, body?.config);
  }

  @Post(':id/widget/publish')
  @HttpCode(200)
  publish(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.widget.publish(m, id);
  }

  @Post(':id/widget/rollback/:ver')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('ver', ParseIntPipe) ver: number,
  ) {
    return this.widget.rollback(m, id, ver);
  }

  @Post(':id/widget/preview-token')
  @HttpCode(200)
  previewToken(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { purpose: 'site'; hostId: string } | { purpose: 'tma' },
  ) {
    return this.widget.previewToken(m, id, body);
  }

  @Post(':id/widget/check-install')
  @HttpCode(200)
  checkInstall(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.install.check(m, id);
  }

  @Patch(':id/widget/controls')
  controls(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { chatPaused?: unknown },
  ) {
    return this.widget.setPaused(m, id, body?.chatPaused === true);
  }

  @Post(':id/widget/assets')
  @HttpCode(200)
  asset(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.widget.uploadAsset(m, id, body);
  }

  @Get(':id/persona')
  getPersona(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.persona.get(m, id);
  }

  @Patch(':id/persona')
  savePersona(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { persona?: unknown },
  ) {
    return this.persona.saveDraft(m, id, body?.persona);
  }

  @Post(':id/persona/publish')
  @HttpCode(200)
  publishPersona(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.persona.publish(m, id);
  }

  @Post(':id/persona/rollback/:ver')
  @HttpCode(200)
  rollbackPersona(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('ver', ParseIntPipe) ver: number,
  ) {
    return this.persona.rollback(m, id, ver);
  }

  @Get(':id/leads-config')
  getLeads(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.persona.getLeads(m, id);
  }

  @Patch(':id/leads-config')
  saveLeads(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { config?: unknown },
  ) {
    return this.persona.saveLeads(m, id, body?.config);
  }
}
