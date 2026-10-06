/**
 * Кабинет: мемо из шагов одобренной обучалки (Э6-тер (к), ТЗ §5-бис.17 п.6):
 *   GET  /assist/sites/:id/memo-tutorials            одобренные обучалки сайта + мемо из них
 *   POST /assist/sites/:id/memo-tutorials/:draftId   шаги у генератора → черновик мемо
 * Права — как у мемо: @AllowApps('assist'), SiteAccountGuard,
 * productRoles.assist = manager (владелец или менеджер).
 */
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
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
import { MemoFromTutorialService } from './memo-from-tutorial.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class MemoFromTutorialController {
  constructor(private readonly svc: MemoFromTutorialService) {}

  @Get(':id/memo-tutorials')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.list(m, id);
  }

  @Post(':id/memo-tutorials/:draftId')
  @HttpCode(200)
  create(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('draftId') draftId: string,
  ) {
    return this.svc.create(m, id, draftId);
  }
}
