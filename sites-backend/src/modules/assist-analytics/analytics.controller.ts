/**
 * Кабинет целей и статистики — A (ТЗ §5-тер.14; права §5-тер.13):
 *   GET|POST   /assist/sites/:id/goals                     (manager)
 *   PATCH|DELETE /assist/sites/:id/goals/:gid              (manager)
 *   POST  /assist/sites/:id/goals/picker-token  { hostId, path? }  (manager)
 *   GET   /assist/sites/:id/goals/picker/:tokenId          (manager)
 *   GET   /assist/sites/:id/goals/:gid/recent              (manager)
 *   DELETE /assist/sites/:id/goal-events?orderId=          (владелец)
 *   GET   /assist/sites/:id/stats/overview|conversions|topics ?from=&to=&compare=
 *   GET   /assist/stats/sites?from=&to=                    (сводная по кабинету)
 *   GET|PATCH /assist/sites/:id/analytics-settings         (manager)
 *   GET   /assist/sites/:id/integrations                   (manager)
 *   POST  /assist/sites/:id/integrations/goal-webhook/secret   (владелец)
 *   POST  /assist/sites/:id/integrations/identity/secret       (владелец)
 *   DELETE /assist/sites/:id/integrations/:kind            (владелец)
 *   POST  /assist/sites/:id/exports  ExportRequest         (manager; withText — владелец)
 *   GET   /assist/sites/:id/exports ; GET …/exports/:xid   (manager)
 *   GET|PATCH /assist/sites/:id/reports/subscription       (owner|manager — своя подписка)
 * «Админка» (`…/admin-mode/stats/*`) — Э7, здесь нет (К-9, У-23).
 *
 * Права (решение A): весь контроллер — assist: manager (владелец — всегда);
 * оператор помощника — 403 на всё, включая статистику (О-12: его экран —
 * лента своих передач H). Владелец — проверкой в сервисе (секреты,
 * удаление событий по заказу, экспорт с текстом).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { analyticsError } from './analytics-errors';
import { AnalyticsSettingsService } from './analytics-settings.service';
import type { ExportRequest } from './api-types';
import { ExportsService } from './exports.service';
import { GoalsService } from './goals.service';
import { IntegrationsService } from './integrations.service';
import { StatsService, type StatsQuery } from './stats.service';

function integrationKind(kind: string): 'goal_webhook' | 'identity' {
  const k = kind === 'goal-webhook' ? 'goal_webhook' : kind;
  if (k !== 'goal_webhook' && k !== 'identity') {
    throw analyticsError(
      HttpStatus.NOT_FOUND,
      'INTEGRATION_NOT_FOUND',
      'Нет такой интеграции',
    );
  }
  return k;
}

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class AnalyticsController {
  constructor(
    readonly goals: GoalsService,
    readonly stats: StatsService,
    readonly integrations: IntegrationsService,
    readonly exports: ExportsService,
    readonly settings: AnalyticsSettingsService,
  ) {}

  // ── Цели ──────────────────────────────────────────────────────────────

  @Get('sites/:id/goals')
  listGoals(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.goals.list(m, id);
  }

  @Post('sites/:id/goals')
  createGoal(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.goals.create(m, id, body);
  }

  @Post('sites/:id/goals/picker-token')
  pickerToken(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { hostId: string; path?: string | null },
  ) {
    return this.goals.pickerToken(m, id, {
      hostId: body?.hostId,
      path: body?.path ?? null,
    });
  }

  @Get('sites/:id/goals/picker/:tokenId')
  pickerStatus(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
  ) {
    return this.goals.pickerStatus(m, id, tokenId);
  }

  @Get('sites/:id/goals/:gid/recent')
  recent(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('gid') gid: string,
  ) {
    return this.goals.recent(m, id, gid);
  }

  @Patch('sites/:id/goals/:gid')
  patchGoal(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('gid') gid: string,
    @Body() body: unknown,
  ) {
    return this.goals.patch(m, id, gid, body);
  }

  @Delete('sites/:id/goals/:gid')
  async removeGoal(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('gid') gid: string,
  ) {
    await this.goals.remove(m, id, gid);
    return { ok: true };
  }

  @Delete('sites/:id/goal-events')
  deleteByOrder(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('orderId') orderId: string,
  ) {
    return this.goals.deleteEventsByOrder(m, id, orderId);
  }

  // ── Статистика ───────────────────────────────────────────────────────

  @Get('sites/:id/stats/overview')
  overview(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: StatsQuery,
  ) {
    return this.stats.overview(m, id, q);
  }

  @Get('sites/:id/stats/conversions')
  conversions(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: StatsQuery,
  ) {
    return this.stats.conversions(m, id, q);
  }

  @Get('sites/:id/stats/topics')
  topics(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: StatsQuery,
  ) {
    return this.stats.topics(m, id, q);
  }

  @Get('stats/sites')
  sites(@Membership() m: AccountMembership, @Query() q: StatsQuery) {
    return this.stats.sites(m, q);
  }

  // ── Настройки ────────────────────────────────────────────────────────

  @Get('sites/:id/analytics-settings')
  getSettings(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.get(m, id);
  }

  @Patch('sites/:id/analytics-settings')
  patchSettings(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.settings.patch(m, id, body);
  }

  @Get('sites/:id/reports/subscription')
  getSubscription(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.settings.subscription(m, id);
  }

  @Patch('sites/:id/reports/subscription')
  patchSubscription(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.settings.patchSubscription(m, id, body);
  }

  // ── Интеграции ───────────────────────────────────────────────────────

  @Get('sites/:id/integrations')
  integrationsView(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ) {
    return this.integrations.view(m, id);
  }

  @Post('sites/:id/integrations/:kind/secret')
  issueSecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('kind') kind: string,
  ) {
    return this.integrations.issue(m, id, integrationKind(kind));
  }

  @Delete('sites/:id/integrations/:kind')
  async revokeSecret(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('kind') kind: string,
  ) {
    await this.integrations.revoke(m, id, integrationKind(kind));
    return { ok: true };
  }

  // ── Экспорт ──────────────────────────────────────────────────────────

  @Post('sites/:id/exports')
  @HttpCode(202)
  requestExport(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: ExportRequest,
  ) {
    return this.exports.request(m, id, body);
  }

  @Get('sites/:id/exports')
  listExports(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.exports.list(m, id);
  }

  @Get('sites/:id/exports/:xid')
  getExport(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('xid') xid: string,
  ) {
    return this.exports.get(m, id, xid);
  }
}
