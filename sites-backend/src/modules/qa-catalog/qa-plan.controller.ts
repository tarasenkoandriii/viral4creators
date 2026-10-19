import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { QA_READ, QA_WRITE } from './qa-catalog.service';
import { QaPlanService } from './qa-plan.service';
@Controller('qa/sites/:siteId/plans')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaPlanController {
  constructor(private readonly plans: QaPlanService) {}
  @Get()
  @RequireProductRoles(QA_READ)
  list(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('before') before?: string,
  ) {
    return this.plans.list(m, site, before);
  }
  @Post()
  @RequireProductRoles(QA_WRITE)
  create(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.plans.create(m, site, body);
  }
  @Get(':id')
  @RequireProductRoles(QA_READ)
  get(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return this.plans.get(m, site, id);
  }
  @Get(':id/history')
  @RequireProductRoles(QA_READ)
  history(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    return this.plans.history(m, site, id, before);
  }
  @Put(':id')
  @RequireProductRoles(QA_WRITE)
  replace(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.plans.replace(m, site, id, body);
  }
  @Post(':id/runs')
  @RequireProductRoles(QA_WRITE)
  start(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.plans.start(m, site, id, body);
  }
}
