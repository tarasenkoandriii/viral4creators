/**
 * Кабинет «Видео» — Э6 (ТЗ §4.11, §8 API: `GET /assist/sites/:id/videos ;
 * PATCH …/videos/:vid`; Э-С Ш4 — `GET /assist/sites/:id/ui-map`). Права: @AllowApps('assist'), SiteAccountGuard,
 * productRoles.assist = manager (как голос и персона; оператор — 403).
 */
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import { SiteVideosService } from './site-videos.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class SiteVideosController {
  constructor(private readonly videos: SiteVideosService) {}

  @Get(':id/videos')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.videos.list(m, id);
  }

  /** Э-С Ш4: сводка общей карты интерфейса сайта. */
  @Get(':id/ui-map')
  uiMap(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.videos.uiMap(m, id);
  }

  @Patch(':id/videos/:vid')
  patch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('vid') vid: string,
    @Body() body: unknown,
  ) {
    return this.videos.patch(m, id, vid, body);
  }
}
