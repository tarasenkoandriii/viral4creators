/**
 * Маршруты ядра `site-core` — дословно ТЗ помощника §4.16 / QA-ТЗ §4.8
 * (+ три маршрута помощника, согласованные с QA 01.10). Принимают initData
 * ЛЮБОГО из двух ботов (`@AllowApps('any')`): помощник и QA — два окна в
 * один кабинет.
 *
 *   GET    /sites/account                          мой кабинет (создаётся при первом входе)
 *   POST   /sites/account/invites                  приглашение участника (владелец)
 *   POST   /sites/account/invites/accept           принять приглашение (startapp=inv_…)
 *   PATCH  /sites/account/members/:memberId        роль и права участника (владелец; Э3, H)
 *   DELETE /sites/account/members/:memberId        удалить участника (владелец) / выйти (сам)
 *   GET    /sites                                  сайты кабинета
 *   POST   /sites                                  создать сайт (имя) + первый хост
 *   POST   /sites/:id/hosts                        добавить хост
 *   DELETE /sites/:id/hosts/:hostId                удалить хост
 *   GET    /sites/:id/hosts/suggest                подсказка поддоменов
 *   POST   /sites/hosts/:hostId/challenge          выдать токен/инструкцию
 *   POST   /sites/hosts/:hostId/verify             проверить один хост сейчас
 *   POST   /sites/:id/verify-all                   пакетная проверка
 *   GET    /sites/hosts/:hostId/authorizations     кто ещё подтвердил хост
 *   POST   /sites/hosts/:hostId/authorizations/revoke                 отозвать все чужие
 *   POST   /sites/hosts/:hostId/authorizations/:otherHostId/unblock   снять блокировку
 *
 * Права: смотреть — любой участник; добавлять/подтверждать — владелец и
 * менеджер (QA §1.5: «Подтверждать владение могут owner и manager»);
 * приглашать и отзывать чужих — владелец.
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import type { IdentifiedRequest } from '../telegram-auth/identity';
import { clientIp } from '../telegram-auth/web/web-request';
import { AccountService } from './account/account.service';
import { InviteAcceptLimiter } from './account/invite-rate-limit';
import type { AccountMembership } from './account/roles';
import {
  Membership,
  RequireAccountRoles,
  SiteAccountGuard,
  requestedAccountId,
} from './account/site-account.guard';
import { OwnershipService } from './ownership/ownership.service';
import {
  AcceptInviteDto,
  AddHostDto,
  ChallengeDto,
  CreateInviteDto,
  CreateSiteDto,
  MemberPatchDto,
  MethodDto,
} from './site-core.dto';
import { SitesService } from './sites/sites.service';

@Controller('sites/account')
@AllowApps('any')
export class SiteAccountController {
  /** Окна принятия приглашения — одни на инстанс (см. invite-rate-limit.ts). */
  private readonly acceptLimiter = new InviteAcceptLimiter();

  constructor(private readonly accounts: AccountService) {}

  @Get()
  async account(@Req() req: IdentifiedRequest) {
    const { membership, created } = await this.accounts.ensureAccount(
      req.identity,
      requestedAccountId(req),
    );
    return this.accounts.accountInfo(membership, created);
  }

  @Post('invites')
  @UseGuards(SiteAccountGuard)
  @RequireAccountRoles('owner')
  createInvite(
    @Membership() m: AccountMembership,
    @Body() dto: CreateInviteDto,
    @Req() req: IdentifiedRequest,
  ) {
    // Имя пригласившего — из проверенной личности (initData/веб-сессия):
    // превью покажет его и тем, кто ни разу не входил в веб-кабинет.
    return this.accounts.createInvite(m, dto, new Date(), req.identity);
  }

  /** Лимит: 30/мин на человека и шире на адрес (invite-rate-limit.ts). */
  @Post('invites/accept')
  @HttpCode(200)
  async acceptInvite(
    @Req() req: IdentifiedRequest,
    @Body() dto: AcceptInviteDto,
  ) {
    this.acceptLimiter.check(req.identity.telegramId, clientIp(req));
    const m = await this.accounts.acceptInvite(req.identity, dto.token);
    return this.accounts.accountInfo(m, false);
  }

  /** Э3 (H, план Э3 «роли кабинета»): смена роли/прав — владелец. */
  @Patch('members/:memberId')
  @UseGuards(SiteAccountGuard)
  @RequireAccountRoles('owner')
  updateMember(
    @Membership() m: AccountMembership,
    @Param('memberId') memberId: string,
    @Body() dto: MemberPatchDto,
  ) {
    return this.accounts.updateMember(m, memberId, dto);
  }

  /** Э3 (H): удалить участника (владелец) или выйти из кабинета (сам). */
  @Delete('members/:memberId')
  @UseGuards(SiteAccountGuard)
  deleteMember(
    @Membership() m: AccountMembership,
    @Param('memberId') memberId: string,
    @Req() req: IdentifiedRequest,
  ) {
    return this.accounts.deleteMember(m, memberId, req.identity);
  }
}

@Controller('sites')
@AllowApps('any')
@UseGuards(SiteAccountGuard)
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly ownership: OwnershipService,
  ) {}

  @Get()
  list(@Membership() m: AccountMembership) {
    return this.sites.listSites(m);
  }

  @Post()
  @RequireAccountRoles('owner', 'manager')
  create(@Membership() m: AccountMembership, @Body() dto: CreateSiteDto) {
    return this.sites.createSite(m, dto);
  }

  @Post(':id/hosts')
  @RequireAccountRoles('owner', 'manager')
  addHost(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Body() dto: AddHostDto,
  ) {
    return this.sites.addHost(m, siteId, dto.url);
  }

  @Delete(':id/hosts/:hostId')
  @RequireAccountRoles('owner', 'manager')
  deleteHost(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('hostId') hostId: string,
  ) {
    return this.sites.deleteHost(m, siteId, hostId);
  }

  @Get(':id/hosts/suggest')
  suggest(@Membership() m: AccountMembership, @Param('id') siteId: string) {
    return this.sites.suggestHosts(m, siteId);
  }

  @Post('hosts/:hostId/challenge')
  @HttpCode(200)
  @RequireAccountRoles('owner', 'manager')
  challenge(
    @Membership() m: AccountMembership,
    @Param('hostId') hostId: string,
    @Body() dto: ChallengeDto,
  ) {
    return this.ownership.challenge(m, hostId, dto.method);
  }

  @Post('hosts/:hostId/verify')
  @HttpCode(200)
  @RequireAccountRoles('owner', 'manager')
  verify(
    @Membership() m: AccountMembership,
    @Param('hostId') hostId: string,
    @Body() dto: MethodDto,
  ) {
    return this.ownership.verify(m, hostId, dto.method);
  }

  @Post(':id/verify-all')
  @HttpCode(200)
  @RequireAccountRoles('owner', 'manager')
  verifyAll(@Membership() m: AccountMembership, @Param('id') siteId: string) {
    return this.ownership.verifyAll(m, siteId);
  }

  @Get('hosts/:hostId/authorizations')
  @RequireAccountRoles('owner', 'manager')
  authorizations(
    @Membership() m: AccountMembership,
    @Param('hostId') hostId: string,
  ) {
    return this.ownership.authorizations(m, hostId);
  }

  @Post('hosts/:hostId/authorizations/revoke')
  @HttpCode(200)
  @RequireAccountRoles('owner')
  revoke(@Membership() m: AccountMembership, @Param('hostId') hostId: string) {
    return this.ownership.revokeForeign(m, hostId);
  }

  @Post('hosts/:hostId/authorizations/:otherHostId/unblock')
  @HttpCode(200)
  @RequireAccountRoles('owner')
  unblock(
    @Membership() m: AccountMembership,
    @Param('hostId') hostId: string,
    @Param('otherHostId') otherHostId: string,
  ) {
    return this.ownership.unblockForeign(m, hostId, otherHostId);
  }
}
