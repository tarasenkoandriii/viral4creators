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
import { QA_READ, QA_WRITE, QaCatalogService } from './qa-catalog.service';
@Controller('qa/sites')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaCatalogController {
  constructor(private readonly catalog: QaCatalogService) {}
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
  providers: [QaCatalogService],
})
export class QaCatalogModule {}
