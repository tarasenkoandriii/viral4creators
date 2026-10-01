/**
 * Версии, исключения, карантин «Сайта» — K3 (ТЗ §4-тер.14):
 *   GET    /assist/sites/:id/learning/site/versions
 *   POST   /assist/sites/:id/learning/site/versions/:n/publish | /discard | /rollback
 *   GET|POST            /assist/sites/:id/learning/site/exclusions
 *   DELETE /assist/sites/:id/learning/site/exclusions/:eid
 *   GET    /assist/sites/:id/learning/site/quarantine
 *   POST   /assist/sites/:id/learning/site/quarantine/:chunkId/allow
 * Права — assist: manager (§4-тер.13).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateExclusionDto } from '../assist-knowledge-core/documents/knowledge.dto';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { SiteSourcesService } from './site-sources.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class SiteLearningController {
  constructor(private readonly svc: SiteSourcesService) {}

  @Get(':id/learning/site/versions')
  versions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listVersions(m, id);
  }

  @Post(':id/learning/site/versions/:n/publish')
  @HttpCode(200)
  publish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.publishVersion(m, id, n);
  }

  @Post(':id/learning/site/versions/:n/discard')
  @HttpCode(200)
  discard(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.discardVersion(m, id, n);
  }

  @Post(':id/learning/site/versions/:n/rollback')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.rollbackVersion(m, id, n);
  }

  @Get(':id/learning/site/exclusions')
  exclusions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listExclusions(m, id);
  }

  @Post(':id/learning/site/exclusions')
  createExclusion(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateExclusionDto,
  ) {
    return this.svc.core.createExclusion(m, id, dto);
  }

  @Delete(':id/learning/site/exclusions/:eid')
  deleteExclusion(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('eid') eid: string,
  ) {
    return this.svc.core.deleteExclusion(m, id, eid);
  }

  @Get(':id/learning/site/quarantine')
  quarantine(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listQuarantine(m, id);
  }

  @Post(':id/learning/site/quarantine/:chunkId/allow')
  @HttpCode(200)
  allow(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('chunkId') chunkId: string,
  ) {
    return this.svc.core.allowQuarantined(m, id, chunkId);
  }
}
