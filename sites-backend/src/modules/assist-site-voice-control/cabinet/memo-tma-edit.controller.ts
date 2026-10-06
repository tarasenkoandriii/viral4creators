/**
 * Кабинет: правка мемо «Сайта» с телефона в TMA и ИИ-предложения фраз
 * (Э6-бис (е) хвост (4), Э6-тер-хвост (6) для мемо):
 *   GET  /assist/sites/:id/memos/:n/elements?step=<с 0>|page=<путь/маска>
 *        элементы Ш4 страницы шага с отпечатком `pin` (хосты «Сайта»)
 *   POST /assist/sites/:id/memos/:n/steps/element
 *        { expectedRevision, uiElementId, mode: add|replace, index?, page? }
 *        «добавить шаг» / «заменить цель» → карточка мемо (ворота те же)
 *   POST /assist/sites/:id/memos/:n/suggest-phrases { expectedRevision }
 *        3–5 фраз запуска на язык сайта в `suggested` (бюджет обучения)
 * Права — как у мемо: @AllowApps('assist'), SiteAccountGuard,
 * productRoles.assist = manager (владелец или менеджер, В-49).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import {
  MemoElementsService,
  type MemoElementApplyBody,
} from './memo-elements.service';
import { MemoPhraseSuggestService } from './memo-phrase-suggest.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class MemoTmaEditController {
  constructor(
    private readonly elements: MemoElementsService,
    private readonly phrases: MemoPhraseSuggestService,
  ) {}

  @Get(':id/memos/:n/elements')
  list(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Query('step') step: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    return this.elements.elements(m, id, n, { step, page });
  }

  @Post(':id/memos/:n/steps/element')
  @HttpCode(200)
  apply(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Body() body: MemoElementApplyBody,
  ) {
    return this.elements.apply(m, id, n, body);
  }

  @Post(':id/memos/:n/suggest-phrases')
  @HttpCode(200)
  suggest(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
    @Body() body: { expectedRevision?: unknown },
  ) {
    return this.phrases.suggest(m, id, n, body);
  }
}
