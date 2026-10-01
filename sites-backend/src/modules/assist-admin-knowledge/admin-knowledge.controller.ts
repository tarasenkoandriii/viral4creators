/**
 * Маршруты знаний «Админки» — K3 (контракт Э1 §«REST»; ТЗ §4.16):
 *   GET    /assist/sites/:id/knowledge/admin/summary
 *   GET|POST            /assist/sites/:id/knowledge/admin/sources
 *   PATCH|DELETE        /assist/sites/:id/knowledge/admin/sources/:sid
 *   POST   /assist/sites/:id/knowledge/admin/sources/:sid/uploaded
 *   GET    /assist/sites/:id/knowledge/admin/documents
 *   GET|POST            /assist/sites/:id/knowledge/admin/faq
 *   PATCH|DELETE        /assist/sites/:id/knowledge/admin/faq/:fid
 *   GET|PATCH           /assist/sites/:id/knowledge/admin/settings
 * Права: ТОЛЬКО productRoles.assistAdmin = owner (§3.2, К-9): `assist`
 * к данным «Админки» не даёт ничего (тест: manager «Сайта» → 403).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AdminKnowledgeSettingsDto,
  CreateFaqDto,
  CreateSourceDto,
  DocumentsQueryDto,
  PatchFaqDto,
  PatchSourceDto,
} from '../assist-knowledge-core/documents/knowledge.dto';
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
import { AdminSourcesService } from './admin-sources.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
export class AdminKnowledgeController {
  constructor(private readonly svc: AdminSourcesService) {}

  @Get(':id/knowledge/admin/summary')
  summary(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.summary(m, id);
  }

  @Get(':id/knowledge/admin/sources')
  sources(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listSources(m, id);
  }

  @Post(':id/knowledge/admin/sources')
  createSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateSourceDto,
  ) {
    return this.svc.core.createSource(m, id, dto);
  }

  @Post(':id/knowledge/admin/sources/:sid/uploaded')
  @HttpCode(200)
  uploaded(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.svc.core.markUploaded(m, id, sid);
  }

  @Patch(':id/knowledge/admin/sources/:sid')
  patchSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() dto: PatchSourceDto,
  ) {
    return this.svc.core.patchSource(m, id, sid, dto);
  }

  @Delete(':id/knowledge/admin/sources/:sid')
  deleteSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.svc.core.deleteSource(m, id, sid);
  }

  @Get(':id/knowledge/admin/documents')
  documents(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: DocumentsQueryDto,
  ) {
    return this.svc.core.listDocuments(m, id, q);
  }

  @Get(':id/knowledge/admin/faq')
  faq(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listFaq(m, id);
  }

  @Post(':id/knowledge/admin/faq')
  createFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateFaqDto,
  ) {
    return this.svc.core.createFaq(m, id, dto);
  }

  @Patch(':id/knowledge/admin/faq/:fid')
  patchFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Body() dto: PatchFaqDto,
  ) {
    return this.svc.core.patchFaq(m, id, fid, dto);
  }

  @Delete(':id/knowledge/admin/faq/:fid')
  deleteFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('fid') fid: string,
  ) {
    return this.svc.core.deleteFaq(m, id, fid);
  }

  @Get(':id/knowledge/admin/settings')
  getSettings(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.getSettings(m, id);
  }

  @Patch(':id/knowledge/admin/settings')
  settings(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: AdminKnowledgeSettingsDto,
  ) {
    return this.svc.updateSettings(m, id, dto);
  }
}
