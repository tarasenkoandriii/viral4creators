import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Header,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { assertCronSecret } from '../../common/cron-secret';
import { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps, PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { QA_READ, QA_WRITE } from './qa-catalog.service';
import { QaArtifactService } from './qa-artifact.service';
@Controller('qa/sites/:siteId/findings/:findingId/artifacts')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaArtifactController {
  constructor(private readonly artifacts: QaArtifactService) {}
  @Get()
  @RequireProductRoles(QA_READ)
  list(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('findingId') finding: string,
  ) {
    return this.artifacts.list(m, site, finding);
  }
  @Post()
  @RequireProductRoles(QA_WRITE)
  upload(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('findingId') finding: string,
    @Body() body: unknown,
  ) {
    return this.artifacts.upload(m, site, finding, body);
  }
  @Get(':id/download')
  @RequireProductRoles(QA_READ)
  download(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('findingId') finding: string,
    @Param('id') id: string,
  ) {
    return this.artifacts.download(m, site, finding, id);
  }
  @Get(':id/content')
  @Header('Cache-Control', 'private, no-store')
  @RequireProductRoles(QA_READ)
  content(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('findingId') finding: string,
    @Param('id') id: string,
  ) {
    return this.artifacts.content(m, site, finding, id);
  }
  @Delete(':id')
  @RequireProductRoles(QA_WRITE)
  remove(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('findingId') finding: string,
    @Param('id') id: string,
  ) {
    return this.artifacts.remove(m, site, finding, id);
  }
}
@Controller('cron')
@PublicRoute('Vercel QA artifact retention: CRON_SECRET only')
export class QaArtifactRetentionController {
  constructor(private readonly artifacts: QaArtifactService) {}
  @Get('qa-artifact-retention')
  retain(@Headers('authorization') auth?: string) {
    assertCronSecret(auth);
    return this.artifacts.retain();
  }
}
