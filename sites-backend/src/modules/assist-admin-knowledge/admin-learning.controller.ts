/**
 * Версии, исключения, карантин «Админки» — K3 (ТЗ §4-тер.14):
 *   GET    /assist/sites/:id/learning/admin/versions
 *   POST   /assist/sites/:id/learning/admin/versions/:n/publish | /discard | /rollback
 *   GET|POST            /assist/sites/:id/learning/admin/exclusions
 *   DELETE /assist/sites/:id/learning/admin/exclusions/:eid
 *   GET    /assist/sites/:id/learning/admin/quarantine
 *   POST   /assist/sites/:id/learning/admin/quarantine/:chunkId/allow
 *   GET    /assist/sites/:id/learning/admin/queue?status=new|accepted|rejected   (Э7, контур (г))
 *   POST   /assist/sites/:id/learning/admin/queue/:itemId/accept | /reject
 * Права — ТОЛЬКО assistAdmin: owner (§3.2, К-9): manager «Сайта» и оператор — 403.
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateExclusionDto } from '../assist-knowledge-core/documents/knowledge.dto';
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
import { AdminLearningQueueService } from './admin-learning-queue.service';
import { AdminSourcesService } from './admin-sources.service';

/** Э7: принять кандидата очереди «Админки» — ответ пишет владелец. */
export class AcceptAdminLearningDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question?: string;

  @IsString()
  @IsNotEmpty({ message: 'Укажите проверенный ответ' })
  @MaxLength(5000)
  answer!: string;
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminLearningController {
  constructor(
    private readonly svc: AdminSourcesService,
    private readonly queue: AdminLearningQueueService,
  ) {}

  @Get(':id/learning/admin/queue')
  queueList(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    const st = status === 'accepted' || status === 'rejected' ? status : 'new';
    return this.queue.list(m, id, st);
  }

  @Post(':id/learning/admin/queue/:itemId/accept')
  @HttpCode(200)
  queueAccept(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: AcceptAdminLearningDto,
  ) {
    return this.queue.accept(m, id, itemId, dto);
  }

  @Post(':id/learning/admin/queue/:itemId/reject')
  @HttpCode(200)
  queueReject(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.queue.reject(m, id, itemId);
  }

  @Get(':id/learning/admin/versions')
  versions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listVersions(m, id);
  }

  @Post(':id/learning/admin/versions/:n/publish')
  @HttpCode(200)
  publish(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.publishVersion(m, id, n);
  }

  @Post(':id/learning/admin/versions/:n/discard')
  @HttpCode(200)
  discard(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.discardVersion(m, id, n);
  }

  @Post(':id/learning/admin/versions/:n/rollback')
  @HttpCode(200)
  rollback(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.svc.core.rollbackVersion(m, id, n);
  }

  @Get(':id/learning/admin/exclusions')
  exclusions(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listExclusions(m, id);
  }

  @Post(':id/learning/admin/exclusions')
  createExclusion(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateExclusionDto,
  ) {
    return this.svc.core.createExclusion(m, id, dto);
  }

  @Delete(':id/learning/admin/exclusions/:eid')
  deleteExclusion(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('eid') eid: string,
  ) {
    return this.svc.core.deleteExclusion(m, id, eid);
  }

  @Get(':id/learning/admin/quarantine')
  quarantine(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listQuarantine(m, id);
  }

  @Post(':id/learning/admin/quarantine/:chunkId/allow')
  @HttpCode(200)
  allow(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('chunkId') chunkId: string,
  ) {
    return this.svc.core.allowQuarantined(m, id, chunkId);
  }
}
