/**
 * Кабинет «Админки: действия» — Э8 (ТЗ §3.8 п.4, п.6; §5-бис.17 п.12, п.14).
 * Только `assistAdmin: owner` (§3.2, К-9):
 *   GET  /assist/sites/:id/action-log/proposals?chain=review  действия сайта (журнал с откатом)
 *   POST /assist/sites/:id/action-log/:pid/rollback           предложить компенсацию (своё «Да» в TMA)
 *   GET  /assist/sites/:id/action-log/export                  CSV журнала (маска, без секретов)
 *   GET  /assist/sites/:id/action-log/verify                  проверка цепочки хешей
 *   GET|POST /assist/sites/:id/admin-mode/memos               мемо АМ-N
 *   GET  /assist/sites/:id/admin-mode/memos/:n
 *   PATCH /assist/sites/:id/admin-mode/memos/:n/draft         { expectedRevision, draft } → 409
 *   POST /assist/sites/:id/admin-mode/memos/:n/versions       собрать (ворота + каталог)
 *   POST /assist/sites/:id/admin-mode/memos/:n/versions/:v/publish | /rollback
 *   POST /assist/sites/:id/admin-mode/memos/:n/disable | /enable
 *   DELETE /assist/sites/:id/admin-mode/memos/:n                мягко (номер не освобождается)
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
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
import {
  CreateMemoDto,
  PatchMemoDraftDto,
  ProposalsQueryDto,
} from './actions.dto';
import { AdminMemoService } from './admin-memo.service';
import { type ActorCtx, ProposalsService } from './proposals.service';

export function ownerActor(m: AccountMembership, siteId: string): ActorCtx {
  const tg = `tg:${m.telegramId.toString()}`;
  return {
    accountId: m.accountId,
    siteId,
    actor: tg,
    actorRole: 'owner',
    actorExternal: tg,
    channel: 'tma',
    conversationId: null,
    assistRole: '*',
    lang: 'uk',
  };
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminActionsController {
  constructor(
    private readonly mode: AdminModeService,
    private readonly proposals: ProposalsService,
    private readonly memos: AdminMemoService,
    private readonly log: AdminActionLogService,
  ) {}

  @Get(':id/action-log/proposals')
  async list(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: ProposalsQueryDto,
  ) {
    await this.mode.requireSite(m.accountId, id);
    return this.proposals.listForOwner(m.accountId, id, {
      chain: q.chain ?? null,
    });
  }

  @Post(':id/action-log/:pid/rollback')
  @HttpCode(200)
  async rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('pid') pid: string,
  ) {
    await this.mode.requireSite(m.accountId, id);
    const r = await this.proposals.compensate(ownerActor(m, id), pid, {
      anyActor: true,
    });
    return r.ok
      ? { proposal: r.proposal, text: r.text }
      : { proposal: null, text: r.text, code: r.code };
  }

  @Get(':id/action-log/export')
  async exportCsv(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    await this.mode.requireSite(m.accountId, id);
    const csv = await this.log.exportCsv(m.accountId, id);
    // Файл как есть (мимо конверта ответа API), без кэша.
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="admin-action-log.csv"',
      })
      .send(csv);
  }

  @Get(':id/action-log/verify')
  async verify(@Membership() m: AccountMembership, @Param('id') id: string) {
    await this.mode.requireSite(m.accountId, id);
    const broken = await this.log.verifyChain(m.accountId, id);
    return { ok: broken === -1, brokenAt: broken === -1 ? null : broken };
  }

  // ── мемо АМ-N ──
  @Get(':id/admin-mode/memos')
  memoList(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.memos.list(m, id);
  }

  @Post(':id/admin-mode/memos')
  memoCreate(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateMemoDto,
  ) {
    return this.memos.create(m, id, dto);
  }

  @Get(':id/admin-mode/memos/:n')
  memoGet(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.memos.get(m, id, n);
  }

  @Patch(':id/admin-mode/memos/:n/draft')
  memoDraft(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
    @Body() dto: PatchMemoDraftDto,
  ) {
    return this.memos.patchDraft(m, id, n, dto);
  }

  @Post(':id/admin-mode/memos/:n/versions')
  @HttpCode(200)
  memoBuild(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.memos.buildVersion(m, id, n);
  }

  @Post(':id/admin-mode/memos/:n/versions/:v/publish')
  @HttpCode(200)
  memoPublish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
    @Param('v', ParseIntPipe) v: number,
  ) {
    return this.memos.publish(m, id, n, v);
  }

  @Post(':id/admin-mode/memos/:n/versions/:v/rollback')
  @HttpCode(200)
  memoRollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
    @Param('v', ParseIntPipe) v: number,
  ) {
    return this.memos.buildVersion(m, id, n, { rollbackOf: v });
  }

  @Post(':id/admin-mode/memos/:n/disable')
  @HttpCode(200)
  memoDisable(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.memos.setEnabled(m, id, n, false);
  }

  @Post(':id/admin-mode/memos/:n/enable')
  @HttpCode(200)
  memoEnable(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.memos.setEnabled(m, id, n, true);
  }

  @Delete(':id/admin-mode/memos/:n')
  memoRemove(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.memos.remove(m, id, n);
  }
}
