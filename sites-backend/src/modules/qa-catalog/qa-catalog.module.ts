import { QaInventoryController } from './qa-inventory.controller';
import { QaInventoryService } from './qa-inventory.service';
import { QaPlanController } from './qa-plan.controller';
import { QaPlanService } from './qa-plan.service';
import {
  QaArtifactController,
  QaArtifactRetentionController,
} from './qa-artifact.controller';
import { QaArtifactService, QaArtifactStorage } from './qa-artifact.service';
import {
  Body,
  Controller,
  Get,
  Headers,
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
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { QaCiService } from './qa-ci.service';
import { QaRunService } from './qa-run.service';
import { QaFindingService } from './qa-finding.service';
import { QA_RUN_EVIDENCE_TOKEN, QaRunEvidenceReader } from './qa-run-evidence';
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
@Controller('qa/sites/:siteId/findings')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaFindingsController {
  constructor(private readonly findings: QaFindingService) {}
  @Get()
  @RequireProductRoles(QA_READ)
  list(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('before') before?: string,
  ) {
    return this.findings.list(m, site, before);
  }
  @Post()
  @RequireProductRoles(QA_WRITE)
  create(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.findings.create(m, site, body);
  }
  @Get(':id')
  @RequireProductRoles(QA_READ)
  get(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return this.findings.get(m, site, id);
  }
  @Get(':id/history')
  @RequireProductRoles(QA_READ)
  history(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('before') before?: string,
  ) {
    return this.findings.history(m, site, id, before);
  }
  @Put(':id')
  @RequireProductRoles(QA_WRITE)
  replace(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.findings.replace(m, site, id, body);
  }
}
@Controller('qa/ci')
@PublicRoute(
  'GitHub OIDC identity is verified by QaCiService; no Telegram session accepted.',
)
export class QaCiController {
  constructor(private readonly ci: QaCiService) {}
  @Post('reports')
  deliver(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    return this.ci.deliver(authorization, body);
  }
}
@Module({
  imports: [SiteCoreModule],
  exports: [QaCatalogService, QaFindingService],
  controllers: [
    QaCatalogController,
    QaCiController,
    QaFindingsController,
    QaArtifactController,
    QaPlanController,
    QaInventoryController,
    QaArtifactRetentionController,
  ],
  providers: [
    QaCatalogService,
    QaRunService,
    QaCiService,
    QaFindingService,
    QaArtifactService,
    QaPlanService,
    QaInventoryService,
    QaArtifactStorage,
    // Сводка прогона для гейтов запуска AI Publisher (Р-PUB-Z2-27).
    { provide: QA_RUN_EVIDENCE_TOKEN, useClass: QaRunEvidenceReader },
  ],
})
export class QaCatalogModule {}
