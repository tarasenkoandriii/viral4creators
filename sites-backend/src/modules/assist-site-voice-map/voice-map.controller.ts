/**
 * Кабинет (TMA): голосовая карта «Сайта» — Э6-тер (ТЗ §5-кватер.13):
 *   GET    /assist/sites/:id/voice-map/site                      сводка: версии, черновик, сессии, шаблоны
 *   GET    /assist/sites/:id/voice-map/site/draft                черновик + draftRevision
 *   PATCH  /assist/sites/:id/voice-map/site/draft                { expectedRevision, ops[] } → 409/422
 *   POST   /assist/sites/:id/voice-map/site/editor-link          одноразовая ссылка ?v4c_edit= (10 мин) [+ host, path, focus]
 *   GET    /assist/sites/:id/voice-map/site/editor-sessions
 *   DELETE /assist/sites/:id/voice-map/site/editor-sessions[/:sid]  «завершить все» / одну
 *   POST   /assist/sites/:id/voice-map/site/versions             собрать версию → checking | held
 *   GET    /assist/sites/:id/voice-map/site/versions[/:n]        список / дифф и отчёт ворот
 *   POST   /assist/sites/:id/voice-map/site/versions/:n/publish | /discard | /rollback
 *   POST   /assist/sites/:id/voice-map/site/platform-template   { platform: woocommerce, expectedRevision } → цели в черновик
 *   GET    /assist/sites/:id/voice-map/site/export ; POST …/import
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist =
 * manager (владелец или менеджер, В-49); оператор — 403. Карта «Админки» —
 * после Э6-бис (б) (`…/admin-mode/voice-map/*`, только assistAdmin: owner).
 * Режим «Снимок» (`…/snapshots`) — с браузерным воркером Ш3 (В-58).
 */
import {
  Body,
  Controller,
  Delete,
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
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { VoiceMapService } from './voice-map.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceMapController {
  constructor(private readonly maps: VoiceMapService) {}

  @Get(':id/voice-map/site')
  summary(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.summary(m, id);
  }

  @Get(':id/voice-map/site/draft')
  draft(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.draft(m, id);
  }

  @Patch(':id/voice-map/site/draft')
  async patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.maps.draft(m, id);
    return this.maps.patch(
      { accountId: m.accountId, memberId: m.memberId },
      id,
      body,
      'tma',
    );
  }

  @Post(':id/voice-map/site/editor-link')
  @HttpCode(200)
  link(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.maps.editorLink(m, id, body);
  }

  @Get(':id/voice-map/site/editor-sessions')
  sessions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.sessions(m, id);
  }

  @Delete(':id/voice-map/site/editor-sessions')
  revokeAll(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.revokeSessions(m, id, null);
  }

  @Delete(':id/voice-map/site/editor-sessions/:sid')
  revokeOne(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.maps.revokeSessions(m, id, sid);
  }

  @Post(':id/voice-map/site/versions')
  @HttpCode(200)
  async build(@Membership() m: AccountMembership, @Param('id') id: string) {
    await this.maps.draft(m, id);
    return this.maps.buildVersion(
      { accountId: m.accountId, memberId: m.memberId },
      id,
      'tma',
    );
  }

  @Get(':id/voice-map/site/versions')
  versions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.versions(m, id);
  }

  @Get(':id/voice-map/site/versions/:n')
  version(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.getVersion(m, id, n);
  }

  @Post(':id/voice-map/site/versions/:n/publish')
  @HttpCode(200)
  publish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.publish(m, id, n);
  }

  @Post(':id/voice-map/site/versions/:n/discard')
  @HttpCode(200)
  discard(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.discard(m, id, n);
  }

  @Post(':id/voice-map/site/versions/:n/rollback')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.rollback(m, id, n);
  }

  @Post(':id/voice-map/site/platform-template')
  @HttpCode(200)
  platformTemplate(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.maps.platformTemplate(m, id, body);
  }

  @Get(':id/voice-map/site/export')
  exportFile(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.exportFile(m, id);
  }

  @Post(':id/voice-map/site/import')
  @HttpCode(200)
  importFile(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.maps.importFile(m, id, body);
  }
}
