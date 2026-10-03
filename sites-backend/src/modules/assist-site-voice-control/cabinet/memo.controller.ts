/**
 * Кабинет: мемо «Сайта» — Э6-бис (е) (ТЗ §5-бис.17 п.12):
 *   GET    /assist/sites/:id/memos                         список, лимит, кандидаты
 *   POST   /assist/sites/:id/memos                         { name, lang?, key?, draft? } → черновик
 *   POST   /assist/sites/:id/ui-plans/:planId/save-as-memo из удачного плана
 *   GET    /assist/sites/:id/memo-suggestions              кандидаты из боя (В-73)
 *   POST   /assist/sites/:id/memo-suggestions/:planId      кандидат → черновик
 *   GET    /assist/sites/:id/memos/:n                      карточка (черновик, ворота, версии)
 *   PATCH  /assist/sites/:id/memos/:n/draft                { expectedRevision, ops[] } → 409
 *   GET    /assist/sites/:id/memos/:n/history              история операций
 *   POST   /assist/sites/:id/memos/:n/versions             собрать → ворота
 *   GET    /assist/sites/:id/memos/:n/versions/:v          версия
 *   POST   /assist/sites/:id/memos/:n/check-token          ссылка мастера (30 мин)
 *   POST   /assist/sites/:id/memos/:n/versions/:v/publish | /discard | /rollback
 *   GET    /assist/sites/:id/memos/:n/stats?days=7|30
 *   POST   /assist/sites/:id/memos/:n/disable | /enable ; DELETE …/memos/:n
 * Права: @AllowApps('assist'), SiteAccountGuard, productRoles.assist =
 * manager (владелец или менеджер, как голосовая карта, В-49). Мемо
 * «Админки» — Э8 (`…/admin-mode/memos/*`, только assistAdmin: owner).
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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type { MemoCreateRequest, MemoDraftPatch } from '../api-types';
import { MemoService } from './memo.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class MemoController {
  constructor(private readonly memos: MemoService) {}

  @Get(':id/memos')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.memos.list(m, id);
  }

  @Post(':id/memos')
  @HttpCode(200)
  create(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: MemoCreateRequest,
  ) {
    return this.memos.create(m, id, body);
  }

  @Post(':id/ui-plans/:planId/save-as-memo')
  @HttpCode(200)
  saveAsMemo(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('planId') planId: string,
  ) {
    return this.memos.saveAsMemo(m, id, planId, 'plan');
  }

  @Get(':id/memo-suggestions')
  async suggestions(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ) {
    return { items: await this.memos.suggestions(m, id) };
  }

  @Post(':id/memo-suggestions/:planId')
  @HttpCode(200)
  fromSuggestion(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('planId') planId: string,
  ) {
    return this.memos.saveAsMemo(m, id, planId, 'suggestion');
  }

  @Get(':id/memos/:n')
  get(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.get(m, id, n);
  }

  @Patch(':id/memos/:n/draft')
  patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Body() body: MemoDraftPatch,
  ) {
    return this.memos.patchDraft(m, id, n, body);
  }

  @Get(':id/memos/:n/history')
  history(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.history(m, id, n);
  }

  @Post(':id/memos/:n/versions')
  @HttpCode(200)
  build(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.buildVersion(m, id, n);
  }

  @Get(':id/memos/:n/versions/:v')
  version(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Param('v') v: string,
  ) {
    return this.memos.getVersion(m, id, n, v);
  }

  @Post(':id/memos/:n/check-token')
  @HttpCode(200)
  checkToken(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Body() body: { host?: string },
  ) {
    return this.memos.checkToken(m, id, n, body);
  }

  @Post(':id/memos/:n/versions/:v/publish')
  @HttpCode(200)
  publish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Param('v') v: string,
  ) {
    return this.memos.publish(m, id, n, v);
  }

  @Post(':id/memos/:n/versions/:v/discard')
  @HttpCode(200)
  discard(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Param('v') v: string,
  ) {
    return this.memos.discard(m, id, n, v);
  }

  @Post(':id/memos/:n/versions/:v/rollback')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Param('v') v: string,
  ) {
    return this.memos.rollback(m, id, n, v);
  }

  @Get(':id/memos/:n/stats')
  stats(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Query('days') days: string | undefined,
  ) {
    return this.memos.stats(m, id, n, days);
  }

  @Post(':id/memos/:n/disable')
  @HttpCode(200)
  disable(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.disable(m, id, n);
  }

  @Post(':id/memos/:n/enable')
  @HttpCode(200)
  enable(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.enable(m, id, n);
  }

  @Delete(':id/memos/:n')
  remove(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.memos.remove(m, id, n);
  }
}
