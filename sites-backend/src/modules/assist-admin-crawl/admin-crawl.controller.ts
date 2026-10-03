/**
 * Обход админки за логином (opt-in, ТЗ §5.3) — Э7:
 *   GET|PUT /assist/sites/:id/admin-mode/private-crawl
 *   POST    /assist/sites/:id/admin-mode/private-crawl/run   задание воркеру Ш3
 * Только `assistAdmin: owner`.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { PutPrivateCrawlDto } from '../assist-admin-mode/admin-mode.dto';
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
import { AdminCrawlService } from './admin-crawl.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminCrawlController {
  constructor(private readonly svc: AdminCrawlService) {}

  @Get(':id/admin-mode/private-crawl')
  view(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.view(m, id);
  }

  @Put(':id/admin-mode/private-crawl')
  put(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: PutPrivateCrawlDto,
  ) {
    return this.svc.put(m, id, dto);
  }

  @Post(':id/admin-mode/private-crawl/run')
  @HttpCode(200)
  run(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.request(m, id);
  }
}
