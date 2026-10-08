/**
 * Кабинет «Админки» — Э7 (ТЗ §3.8, §4.16):
 *   GET|PATCH /assist/sites/:id/admin-mode
 *   POST      /assist/sites/:id/admin-mode/identity-secret   секрет подписи JWT (показ 1 раз)
 *   GET       /assist/sites/:id/admin-mode/stats?days=7|30   «Статистика (сотрудники)»
 *   GET|POST  /assist/sites/:id/connectors                   (OpenAPI url|файл)
 *   GET|PATCH|DELETE /assist/sites/:id/connectors/:cn
 *   PATCH     /assist/sites/:id/connectors/:cn/operations/:op
 *   PUT|DELETE /assist/sites/:id/connectors/:cn/secret
 *   POST      /assist/sites/:id/connectors/:cn/signing-secret  Э8: подпись X-V4C-Signature
 *   GET       /assist/sites/:id/action-log
 * Права — ТОЛЬКО `assistAdmin: owner` (§3.2, К-9): менеджер и оператор
 * «Сайта», сотрудник «Админки» — 403.
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
  Put,
  Query,
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
import { AdminActionLogService } from './action-log.service';
import {
  ActionLogQueryDto,
  CreateConnectorDto,
  PatchAdminModeDto,
  PatchConnectorDto,
  PatchOperationDto,
  PutConnectorSecretDto,
  IssueSecretDto,
} from './admin-mode.dto';
import { AdminModeService } from './admin-mode.service';
import { AdminStatsService } from './admin-stats.service';
import { ConnectorsService } from './connectors.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminModeController {
  constructor(
    private readonly mode: AdminModeService,
    private readonly connectors: ConnectorsService,
    private readonly log: AdminActionLogService,
    private readonly stats: AdminStatsService,
  ) {}

  @Get(':id/admin-mode')
  view(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.mode.view(m, id);
  }

  @Patch(':id/admin-mode')
  patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: PatchAdminModeDto,
  ) {
    return this.mode.patch(m, id, dto);
  }

  @Post(':id/admin-mode/identity-secret')
  @HttpCode(200)
  // Открытый секрет — один раз и мимо любых кэшей (аудит Э7).
  @Header('Cache-Control', 'no-store')
  identitySecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: IssueSecretDto,
  ) {
    return this.mode.issueIdentitySecret(m, id, dto?.expectedSetAt);
  }

  @Get(':id/admin-mode/stats')
  adminStats(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.stats.stats(m, id, days === '30' ? 30 : 7);
  }

  @Get(':id/connectors')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.connectors.list(m, id);
  }

  @Post(':id/connectors')
  create(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateConnectorDto,
  ) {
    return this.connectors.create(m, id, dto);
  }

  @Get(':id/connectors/:cn')
  get(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
  ) {
    return this.connectors.get(m, id, cn);
  }

  @Patch(':id/connectors/:cn')
  patchConnector(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
    @Body() dto: PatchConnectorDto,
  ) {
    return this.connectors.patch(m, id, cn, dto);
  }

  @Delete(':id/connectors/:cn')
  remove(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
  ) {
    return this.connectors.remove(m, id, cn);
  }

  @Patch(':id/connectors/:cn/operations/:op')
  patchOperation(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
    @Param('op') op: string,
    @Body() dto: PatchOperationDto,
  ) {
    return this.connectors.patchOperation(m, id, cn, op, dto);
  }

  @Put(':id/connectors/:cn/secret')
  putSecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
    @Body() dto: PutConnectorSecretDto,
  ) {
    return this.connectors.putSecret(m, id, cn, dto);
  }

  /** Э8: секрет подписи изменяющих запросов `X-V4C-Signature` (показ 1 раз). */
  @Post(':id/connectors/:cn/signing-secret')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  signingSecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
    @Body() dto: IssueSecretDto,
  ) {
    return this.connectors.issueSigningSecret(m, id, cn, dto?.expectedSetAt);
  }

  @Delete(':id/connectors/:cn/secret')
  deleteSecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('cn') cn: string,
  ) {
    return this.connectors.deleteSecret(m, id, cn);
  }

  @Get(':id/action-log')
  async actionLog(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: ActionLogQueryDto,
  ) {
    await this.mode.requireSite(m.accountId, id);
    return this.log.list(m.accountId, id, q);
  }
}
