/**
 * Маршруты знаний «Сайта» — K3 (контракт Э1 §«REST»; ТЗ §4.16, §4-тер.14):
 *   POST   /assist/sites/:id/enable
 *   GET    /assist/sites/:id/knowledge/site/summary
 *   GET|POST            /assist/sites/:id/knowledge/site/sources
 *   PATCH|DELETE        /assist/sites/:id/knowledge/site/sources/:sid
 *   POST   /assist/sites/:id/knowledge/site/sources/:sid/uploaded
 *   GET    /assist/sites/:id/knowledge/site/documents
 *   GET|POST            /assist/sites/:id/knowledge/site/faq
 *   PATCH|DELETE        /assist/sites/:id/knowledge/site/faq/:fid
 *   PUT    /assist/sites/:id/knowledge/site/hot-pages
 *   GET|PATCH           /assist/sites/:id/knowledge/site/settings
 *     (GET — сверх таблицы контракта: экрану нужен AssistSettingsView без побочных действий)
 *   POST   /assist/sites/:id/knowledge/site/recrawl
 * Права: @AllowApps('assist'), SiteAccountGuard; знания «Сайта» — только
 * productRoles.assist = manager (владелец кабинета — manager по умолчанию),
 * оператор — 403 (§3.2: оператору — только передача человеку).
 *
 * Режим «site» зашит в путь и в сервис — тело его не выбирает (слой 5).
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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateFaqDto,
  CreateSourceDto,
  DocumentsQueryDto,
  HotPagesDto,
  PatchFaqDto,
  PatchSourceDto,
  SiteKnowledgeSettingsDto,
} from '../assist-knowledge-core/documents/knowledge.dto';
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
export class SiteKnowledgeController {
  constructor(private readonly svc: SiteSourcesService) {}

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.enable(m, id);
  }

  @Get(':id/knowledge/site/summary')
  summary(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.summary(m, id);
  }

  @Get(':id/knowledge/site/sources')
  sources(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listSources(m, id);
  }

  @Post(':id/knowledge/site/sources')
  createSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateSourceDto,
  ) {
    return this.svc.core.createSource(m, id, dto);
  }

  @Post(':id/knowledge/site/sources/:sid/uploaded')
  @HttpCode(200)
  uploaded(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.svc.core.markUploaded(m, id, sid);
  }

  @Patch(':id/knowledge/site/sources/:sid')
  patchSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() dto: PatchSourceDto,
  ) {
    return this.svc.core.patchSource(m, id, sid, dto);
  }

  @Delete(':id/knowledge/site/sources/:sid')
  deleteSource(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.svc.core.deleteSource(m, id, sid);
  }

  @Get(':id/knowledge/site/documents')
  documents(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query() q: DocumentsQueryDto,
  ) {
    return this.svc.core.listDocuments(m, id, q);
  }

  @Get(':id/knowledge/site/faq')
  faq(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.core.listFaq(m, id);
  }

  @Post(':id/knowledge/site/faq')
  createFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: CreateFaqDto,
  ) {
    return this.svc.core.createFaq(m, id, dto);
  }

  @Patch(':id/knowledge/site/faq/:fid')
  patchFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Body() dto: PatchFaqDto,
  ) {
    return this.svc.core.patchFaq(m, id, fid, dto);
  }

  @Delete(':id/knowledge/site/faq/:fid')
  deleteFaq(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('fid') fid: string,
  ) {
    return this.svc.core.deleteFaq(m, id, fid);
  }

  @Put(':id/knowledge/site/hot-pages')
  hotPages(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: HotPagesDto,
  ) {
    return this.svc.setHotPages(m, id, dto.urls);
  }

  @Get(':id/knowledge/site/settings')
  getSettings(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.settingsView(m, id);
  }

  @Patch(':id/knowledge/site/settings')
  settings(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: SiteKnowledgeSettingsDto,
  ) {
    return this.svc.updateSettings(m, id, dto.recrawlEvery);
  }

  @Post(':id/knowledge/site/recrawl')
  @HttpCode(200)
  recrawl(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.svc.recrawl(m, id);
  }
}
