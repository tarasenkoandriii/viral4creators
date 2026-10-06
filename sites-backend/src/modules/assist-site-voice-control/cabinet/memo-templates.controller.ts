/**
 * Кабинет: мемо «Сайта» из шаблона платформы и публикация пакетом — Э6-тер
 * (к) (ТЗ §5-бис.17 п.6, п.14):
 *   GET  /assist/sites/:id/memo-templates             шаблоны мемо и платформа сайта
 *   POST /assist/sites/:id/memo-templates             { platform, keys? } → черновики + версии на проверку
 *   POST /assist/sites/:id/memo-batch/publish         { numbers? } → публикация пакетом (прогон — обязателен)
 * Пути — вне `…/memos/:n` (тот маршрут ловит любой сегмент как номер).
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
import { MemoTemplatesService } from './memo-templates.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class MemoTemplatesController {
  constructor(private readonly templates: MemoTemplatesService) {}

  @Get(':id/memo-templates')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.templates.list(m, id);
  }

  @Post(':id/memo-templates')
  @HttpCode(200)
  apply(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { platform?: unknown; keys?: unknown },
  ) {
    return this.templates.apply(m, id, body);
  }

  @Post(':id/memo-batch/publish')
  @HttpCode(200)
  publishBatch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: { numbers?: unknown },
  ) {
    return this.templates.publishBatch(m, id, body);
  }
}
