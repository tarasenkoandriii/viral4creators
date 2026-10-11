import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { QaRunService } from './qa-run.service';
import { QA_READ, QA_WRITE, QaCatalogService } from './qa-catalog.service';
@Controller('qa/sites')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaCatalogController {
  constructor(
    private readonly catalog: QaCatalogService,
    private readonly runs: QaRunService,
  ) {}
  @Post(':siteId/runs')
  @RequireProductRoles(QA_WRITE)
  createRun(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.runs.create(m, site, body);
  }
  @Get(':siteId/runs')
  @RequireProductRoles(QA_READ)
  listRuns(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('before') before?: string,
  ) {
    return this.runs.list(m, site, before);
  }
  @Get(':siteId/runs/:id')
  @RequireProductRoles(QA_READ)
  getRun(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return this.runs.get(m, site, id);
  }
  @Post(':siteId/runs/:id/reports')
  @RequireProductRoles(QA_WRITE)
  importReport(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.runs.importReport(m, site, id, body);
  }
  @Get(':siteId/runs/:id/attempts')
  @RequireProductRoles(QA_READ)
  listAttempts(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    return this.runs.attempts(m, site, id, before);
  }
  @Post(':siteId/runs/:id/attempts')
  @RequireProductRoles(QA_WRITE)
  recordAttempt(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.runs.record(m, site, id, body);
  }
  @Get(':siteId/cases')
  @RequireProductRoles(QA_READ)
  list(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('after') after?: string,
  ) {
    return this.catalog.list(m, site, after);
  }
  @Get(':siteId/cases/:id')
  @RequireProductRoles(QA_READ)
  get(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return this.catalog.get(m, site, id);
  }
  @Get(':siteId/cases/:id/history')
  @RequireProductRoles(QA_READ)
  history(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    return this.catalog.history(m, site, id, before);
  }
  @Post(':siteId/cases')
  @RequireProductRoles(QA_WRITE)
  create(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.catalog.create(m, site, body);
  }
  @Put(':siteId/cases/:id')
  @RequireProductRoles(QA_WRITE)
  replace(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.replace(m, site, id, body);
  }
}
@Module({
  imports: [SiteCoreModule],
  controllers: [QaCatalogController],
  providers: [QaCatalogService, QaRunService],
})
export class QaCatalogModule {}
