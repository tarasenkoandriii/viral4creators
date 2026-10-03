/**
 * Помощник сотрудника в TMA — 7a (ТЗ §5.1 «Из TMA»): участник кабинета с
 * `assistAdmin: owner|employee` (initData бота помощника):
 *   GET  /assist/sites/:id/admin-chat/state
 *   POST /assist/sites/:id/admin-chat
 *   POST /assist/sites/:id/admin-chat/messages/:mid/feedback
 * Владелец «Админки» — все включённые read-операции; сотрудник — роль
 * `tmaEmployeeRole` (нет — только знания). Требует verified-хост сайта.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { AdminAskDto, AdminFeedbackDto } from './admin-chat.dto';
import { AdminChatService, type EmployeeCtx } from './admin-chat.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_ANY)
export class AdminTmaChatController {
  constructor(
    private readonly chat: AdminChatService,
    private readonly mode: AdminModeService,
  ) {}

  private async ctx(
    m: AccountMembership,
    siteId: string,
  ): Promise<EmployeeCtx> {
    await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const owner = satisfiesProductRoles(m, REQUIRE_ASSIST_ADMIN_OWNER);
    return {
      accountId: m.accountId,
      siteId,
      channel: 'tma',
      employeeRef: `tg:${m.telegramId.toString()}`,
      actorExternal: `tg:${m.telegramId.toString()}`,
      customerRole: owner ? 'owner' : 'employee',
      name: null,
      role: owner ? '*' : s.tmaEmployeeRole,
    };
  }

  @Get(':id/admin-chat/state')
  async state(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.chat.state(await this.ctx(m, id));
  }

  @Post(':id/admin-chat')
  @HttpCode(200)
  async ask(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: AdminAskDto,
  ) {
    return this.chat.ask(
      await this.ctx(m, id),
      dto.text,
      dto.clientRequestId ?? null,
    );
  }

  @Post(':id/admin-chat/messages/:mid/feedback')
  @HttpCode(200)
  async feedback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('mid') mid: string,
    @Body() dto: AdminFeedbackDto,
  ) {
    return this.chat.feedback(
      await this.ctx(m, id),
      mid,
      dto.rating,
      dto.correction ?? null,
    );
  }
}
