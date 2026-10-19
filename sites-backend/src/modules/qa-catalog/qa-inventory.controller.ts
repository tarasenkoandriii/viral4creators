import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { QaInventoryService } from './qa-inventory.service';
@Controller('qa/sites/:siteId/inventory')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaInventoryController {
  constructor(private readonly inventory: QaInventoryService) {}
  @Get()
  @RequireProductRoles(QA_READ)
  get(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('search') search?: string,
  ) {
    return this.inventory.get(m, site, search);
  }
  @Post('import')
  @RequireProductRoles(QA_WRITE)
  import(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.inventory.import(m, site, body);
  }
}
