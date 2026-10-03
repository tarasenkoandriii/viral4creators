/**
 * «Да» сотрудника — Э8 (ТЗ §4.16, §5.4 п.6, §4-бис.5, §5-бис.15 п.14):
 *
 * Встраивание (сессия `X-Assist-Admin-Session`, тот же `sub`):
 *   GET  /assist-admin/v1/proposals/:id              карточка (восстановление)
 *   POST /assist-admin/v1/proposals/:id/confirm      «Да» { paramsHash, phrase?, acknowledgeRisk? }
 *   POST /assist-admin/v1/proposals/:id/reject       «Нет»
 *   POST /assist-admin/v1/proposals/:id/check        «Проверить» (после unknown, read)
 *   POST /assist-admin/v1/proposals/:id/compensate   предложить объявленную компенсацию
 *
 * TMA (7a, участник с `assistAdmin: owner|employee`):
 *   те же действия под /assist/sites/:id/admin-chat/proposals/:pid/*
 *
 * «Да» — ВСЕГДА отдельный запрос (не тот, где модель предложила); роль —
 * из текущей сессии (JWT мог смениться — права перепроверяются); чужая
 * карточка — 404, как несуществующая.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ADMIN_SESSION_HEADER } from '../../brand';
import type { ActionLang } from '../assist-admin-actions/action-core';
import { ConfirmProposalDto } from '../assist-admin-actions/actions.dto';
import { ProposalsService } from '../assist-admin-actions/proposals.service';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import {
  AccountMembership,
  REQUIRE_ASSIST_ADMIN_ANY,
  REQUIRE_ASSIST_ADMIN_OWNER,
  satisfiesProductRoles,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps, PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  AdminChatService,
  type EmployeeCtx,
  actorOf,
} from './admin-chat.service';
import { AdminSessionService } from './admin-session.service';

const HEADER = ADMIN_SESSION_HEADER.toLowerCase();
/** «Да»/«Нет»/«Проверить» сотрудника в минуту — сверх лимитов действий. */
export const ADMIN_DECISIONS_PER_MIN = 20;

function langOf(v: unknown): ActionLang {
  return v === 'ru' || v === 'en' ? v : 'uk';
}

/** Общий минутный лимит решений сотрудника — встраивание и TMA. */
async function decisionRate(sessions: AdminSessionService, ctx: EmployeeCtx) {
  if (
    !(await sessions.rateHit(
      'admin-decision-min',
      `${ctx.siteId}:${ctx.employeeRef}`.slice(0, 200),
      ADMIN_DECISIONS_PER_MIN,
      60_000,
    ))
  ) {
    throw adminError(
      429,
      'ADMIN_RATE_LIMITED',
      'Слишком часто — подождите минуту',
    );
  }
}

@Controller('assist-admin/v1/proposals')
@PublicRoute(
  '«Да» сотрудника «Админки»: доступ по нашей сессии сотрудника (employee-JWT), не по initData',
)
export class AdminEmbedProposalsController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly chat: AdminChatService,
    private readonly proposals: ProposalsService,
  ) {}

  private async ctx(token: string | undefined): Promise<EmployeeCtx> {
    const s = await this.sessions.resolve(token);
    const ctx: EmployeeCtx = {
      accountId: s.accountId,
      siteId: s.siteId,
      channel: 'embed',
      employeeRef: s.employeeRef,
      actorExternal: s.sub,
      customerRole: s.customerRole,
      name: s.name,
      role: s.role,
    };
    await this.chat.assertUsable(ctx);
    return ctx;
  }

  private async limited(ctx: EmployeeCtx) {
    await decisionRate(this.sessions, ctx);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Headers(HEADER) token?: string,
    @Query('lang') lang?: string,
  ) {
    const ctx = await this.ctx(token);
    return this.proposals.get(actorOf(ctx, null, langOf(lang)), id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmProposalDto,
    @Headers(HEADER) token?: string,
    @Query('lang') lang?: string,
  ) {
    const ctx = await this.ctx(token);
    await this.limited(ctx);
    return this.proposals.confirm(actorOf(ctx, null, langOf(lang)), id, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @Headers(HEADER) token?: string,
    @Query('lang') lang?: string,
  ) {
    const ctx = await this.ctx(token);
    await this.limited(ctx);
    return this.proposals.reject(actorOf(ctx, null, langOf(lang)), id);
  }

  @Post(':id/check')
  @HttpCode(200)
  async check(
    @Param('id') id: string,
    @Headers(HEADER) token?: string,
    @Query('lang') lang?: string,
  ) {
    const ctx = await this.ctx(token);
    await this.limited(ctx);
    return this.proposals.check(actorOf(ctx, null, langOf(lang)), id);
  }

  @Post(':id/compensate')
  @HttpCode(200)
  async compensate(
    @Param('id') id: string,
    @Headers(HEADER) token?: string,
    @Query('lang') lang?: string,
  ) {
    const ctx = await this.ctx(token);
    await this.limited(ctx);
    const r = await this.proposals.compensate(
      actorOf(ctx, null, langOf(lang)),
      id,
    );
    return r.ok
      ? { proposal: r.proposal, text: r.text }
      : { proposal: null, text: r.text, code: r.code };
  }
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_ANY)
export class AdminTmaProposalsController {
  constructor(
    private readonly chat: AdminChatService,
    private readonly mode: AdminModeService,
    private readonly proposals: ProposalsService,
    private readonly sessions: AdminSessionService,
  ) {}

  /**
   * Тот же минутный лимит решений, что у встраивания (аудит Э8: в TMA его
   * не было, а «Проверить» без диалога — read к API заказчика без
   * поминутного лимита диалога).
   */
  private async limitedCtx(m: AccountMembership, siteId: string) {
    const ctx = await this.ctx(m, siteId);
    await decisionRate(this.sessions, ctx);
    return ctx;
  }

  private async ctx(
    m: AccountMembership,
    siteId: string,
  ): Promise<EmployeeCtx> {
    await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const owner = satisfiesProductRoles(m, REQUIRE_ASSIST_ADMIN_OWNER);
    const tg = `tg:${m.telegramId.toString()}`;
    const ctx: EmployeeCtx = {
      accountId: m.accountId,
      siteId,
      channel: 'tma',
      employeeRef: tg,
      actorExternal: tg,
      customerRole: owner ? 'owner' : 'employee',
      name: null,
      role: owner ? '*' : s.tmaEmployeeRole,
    };
    // Владелец подтверждает компенсацию из журнала и без включённого 7a.
    if (!owner) await this.chat.assertUsable(ctx);
    return ctx;
  }

  @Get(':id/admin-chat/proposals/:pid')
  async get(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Query('lang') lang?: string,
  ) {
    return this.proposals.get(
      actorOf(await this.ctx(m, id), null, langOf(lang)),
      pid,
    );
  }

  @Post(':id/admin-chat/proposals/:pid/confirm')
  @HttpCode(200)
  async confirm(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Body() dto: ConfirmProposalDto,
    @Query('lang') lang?: string,
  ) {
    return this.proposals.confirm(
      actorOf(await this.limitedCtx(m, id), null, langOf(lang)),
      pid,
      dto,
    );
  }

  @Post(':id/admin-chat/proposals/:pid/reject')
  @HttpCode(200)
  async reject(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Query('lang') lang?: string,
  ) {
    return this.proposals.reject(
      actorOf(await this.limitedCtx(m, id), null, langOf(lang)),
      pid,
    );
  }

  @Post(':id/admin-chat/proposals/:pid/check')
  @HttpCode(200)
  async check(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Query('lang') lang?: string,
  ) {
    return this.proposals.check(
      actorOf(await this.limitedCtx(m, id), null, langOf(lang)),
      pid,
    );
  }

  @Post(':id/admin-chat/proposals/:pid/compensate')
  @HttpCode(200)
  async compensate(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Query('lang') lang?: string,
  ) {
    const r = await this.proposals.compensate(
      actorOf(await this.limitedCtx(m, id), null, langOf(lang)),
      pid,
    );
    return r.ok
      ? { proposal: r.proposal, text: r.text }
      : { proposal: null, text: r.text, code: r.code };
  }
}
