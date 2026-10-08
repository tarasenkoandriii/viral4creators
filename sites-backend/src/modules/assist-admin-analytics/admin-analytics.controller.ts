/**
 * Кабинет аналитики «Админки» (заход 10, №57; ТЗ §5-тер.13–14):
 *   GET   /assist/sites/:id/admin-mode/stats/labels?days=7|30   разметка агрегатами
 *   GET   /assist/sites/:id/admin-mode/stats/insights           выводы недели
 *   PATCH /assist/sites/:id/admin-mode/stats/insights/:iid      done|dismissed|👍👎
 *   POST  /assist/sites/:id/admin-mode/exports                  выгрузка CSV (очередь)
 *   GET   /assist/sites/:id/admin-mode/exports[/:xid]           журнал и ссылка 24 ч
 * Права — ТОЛЬКО `assistAdmin: owner` (§5-тер.13 «Кто что видит», У-23,
 * У-25): менеджер и оператор «Сайта», сотрудник «Админки» — 403.
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
import { IsIn, IsOptional, Matches } from 'class-validator';
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
import { AdminAnalyticsCabinet } from './admin-analytics.service';
import { ADMIN_EXPORT_KINDS, AdminExports } from './admin-exports.service';

export class CreateAdminExportDto {
  @IsIn(ADMIN_EXPORT_KINDS as unknown as string[], {
    message: 'kind: daily | labels | actions',
  })
  kind!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;
}

export class PatchAdminInsightDto {
  @IsOptional()
  @IsIn(['new', 'done', 'dismissed'])
  status?: 'new' | 'done' | 'dismissed';

  @IsOptional()
  @IsIn([-1, 0, 1])
  feedback?: -1 | 0 | 1;
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminAnalyticsController {
  constructor(
    private readonly cabinet: AdminAnalyticsCabinet,
    private readonly exports: AdminExports,
  ) {}

  @Get(':id/admin-mode/stats/labels')
  labels(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.cabinet.labels(m, id, days === '30' ? 30 : 7);
  }

  @Get(':id/admin-mode/stats/insights')
  insights(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.cabinet.insights(m, id);
  }

  @Patch(':id/admin-mode/stats/insights/:iid')
  patchInsight(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('iid') iid: string,
    @Body() dto: PatchAdminInsightDto,
  ) {
    return this.cabinet.patchInsight(m, id, iid, dto);
  }

  @Post(':id/admin-mode/exports')
  @HttpCode(202)
  requestExport(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateAdminExportDto,
  ) {
    return this.exports.request(m, id, dto);
  }

  @Get(':id/admin-mode/exports')
  listExports(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.exports.list(m, id);
  }

  @Get(':id/admin-mode/exports/:xid')
  getExport(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('xid') xid: string,
  ) {
    return this.exports.get(m, id, xid);
  }
}
