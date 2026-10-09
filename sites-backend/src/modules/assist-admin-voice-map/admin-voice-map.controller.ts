/**
 * Кабинет (TMA): голосовая карта «Админки» — заход 11 (№117; ТЗ §5-кватер.13
 * «карта „Админки“ — те же пути под …/admin-mode/voice-map/* (без snapshots)»):
 *   GET    /assist/sites/:id/admin-mode/voice-map                   сводка: версии, черновик, сессии, хосты админки, тариф
 *   GET    /assist/sites/:id/admin-mode/voice-map/draft             черновик + draftRevision + ворота
 *   PATCH  /assist/sites/:id/admin-mode/voice-map/draft             { expectedRevision, ops[] } → 409/422 (цели, шаблоны, термины)
 *   POST   /assist/sites/:id/admin-mode/voice-map/editor-link       одноразовая ссылка ?v4c_edit= на хост админки (10 мин) [+ host, path, focus]
 *   GET    /assist/sites/:id/admin-mode/voice-map/editor-sessions
 *   DELETE /assist/sites/:id/admin-mode/voice-map/editor-sessions[/:sid]
 *   POST   /assist/sites/:id/admin-mode/voice-map/versions          собрать версию → checking | held
 *   GET    /assist/sites/:id/admin-mode/voice-map/versions[/:n]
 *   POST   /assist/sites/:id/admin-mode/voice-map/versions/:n/publish | /discard | /rollback
 *   GET    /assist/sites/:id/admin-mode/voice-map/export ; POST …/import   файл `kind: admin`
 * Права — ТОЛЬКО `assistAdmin: owner` (§5-кватер.2, К-9; В-49 — делегирования
 * нет): менеджер и оператор «Сайта», сотрудник «Админки» — 403. Тариф Pro
 * (В-55) — на изменения (402 `ADMIN_VOICE_MAP_PLAN_REQUIRED`). Режима
 * «Снимок», шаблонов платформ и отчёта разработчику у «Админки» нет.
 */
import {
  Body,
  Controller,
  Delete,
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
import { actorOfMember, AdminVoiceMapService } from './admin-voice-map.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminVoiceMapController {
  constructor(private readonly maps: AdminVoiceMapService) {}

  @Get(':id/admin-mode/voice-map')
  summary(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.summary(m, id);
  }

  @Get(':id/admin-mode/voice-map/draft')
  draft(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.draft(m, id);
  }

  @Patch(':id/admin-mode/voice-map/draft')
  async patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.maps.site(m.accountId, id);
    return this.maps.patch(actorOfMember(m), id, body, 'tma');
  }

  /** Ссылка с токеном — мимо кэшей. */
  @Post(':id/admin-mode/voice-map/editor-link')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  link(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.maps.editorLink(m, id, body);
  }

  @Get(':id/admin-mode/voice-map/editor-sessions')
  sessions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.sessions(m, id);
  }

  @Delete(':id/admin-mode/voice-map/editor-sessions')
  revokeAll(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.revokeSessions(m, id, null);
  }

  @Delete(':id/admin-mode/voice-map/editor-sessions/:sid')
  revokeOne(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.maps.revokeSessions(m, id, sid);
  }

  @Post(':id/admin-mode/voice-map/versions')
  @HttpCode(200)
  async build(@Membership() m: AccountMembership, @Param('id') id: string) {
    await this.maps.site(m.accountId, id);
    return this.maps.buildVersion(actorOfMember(m), id, 'tma');
  }

  @Get(':id/admin-mode/voice-map/versions')
  versions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.versions(m, id);
  }

  @Get(':id/admin-mode/voice-map/versions/:n')
  version(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.getVersion(m, id, n);
  }

  @Post(':id/admin-mode/voice-map/versions/:n/publish')
  @HttpCode(200)
  publish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.publish(m, id, n);
  }

  @Post(':id/admin-mode/voice-map/versions/:n/discard')
  @HttpCode(200)
  discard(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.discard(m, id, n);
  }

  @Post(':id/admin-mode/voice-map/versions/:n/rollback')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.maps.rollback(m, id, n);
  }

  @Get(':id/admin-mode/voice-map/export')
  @Header('Cache-Control', 'no-store')
  exportFile(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.maps.exportFile(m, id);
  }

  @Post(':id/admin-mode/voice-map/import')
  @HttpCode(200)
  importFile(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.maps.importFile(m, id, body);
  }
}
