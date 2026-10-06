/**
 * TutorialVideoAdminController — тот же приём, что
 * `TutorialScenarioAdminController`/`AssistantAdminController` (см. их
 * доккомментарии): собственный контроллер внутри фиче-модуля.
 *
 * Вкладка «Видео-контент»/«Состояние данных» (§4.9 ТЗ, этап 99) —
 * последний недостающий кусок Фазы 2: без него собранные видео
 * (этап 98) физически недоступны никому, кроме прямого запроса к базе.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { PublicationService } from '../publication/publication.service';
import { PublishTutorialVideoDto } from '../publication/dto/publication.dto';
import { SetTutorialVideoReviewedDto } from './dto/set-tutorial-video-reviewed.dto';
import { SetTutorialVideoSiteTutorialDemoDto } from './dto/set-tutorial-video-site-tutorial-demo.dto';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';
import { TutorialVideoVersionsService } from '../postprod/tutorial-video-versions.service';
import { TutorialTempoRequestDto } from '../postprod/dto/tutorial-tempo.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

@Controller('admin/tutorial-video-assets')
@UseGuards(AdminSessionGuard)
export class TutorialVideoAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly videoAdmin: TutorialVideoAdminService,
    private readonly publication: PublicationService,
    private readonly versions: TutorialVideoVersionsService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('subjectKey') subjectKey?: string,
    @Query('locale') locale?: string,
    @Query('reviewed') reviewed?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.videoAdmin.list({
      subjectKey: subjectKey?.trim() || undefined,
      locale: locale?.trim() || undefined,
      reviewed: parseBool(reviewed),
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // Отдельный статический путь ДО динамического ':id/review' ниже —
  // Nest матчит по объявленному пути, не по порядку сегментов, поэтому
  // коллизии нет, но стоит рядом для читаемости (тот же порядок, что и
  // объявление ниже).
  @Get('data-status')
  async dataStatus(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.videoAdmin.dataStatus();
  }

  // PATCH, не POST — тот же выбор, что у остальных admin-переключателей
  // одного поля (см. TutorialScenarioAdminController.approve).
  @Patch(':id/review')
  async review(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetTutorialVideoReviewedDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.videoAdmin.setReviewed(id, dto.reviewed);
  }

  /**
   * Галочка «В демо обучающего лендинга» (решение владельца 06.10.2026,
   * путь А). Годность строки проверяет сервис — см.
   * `TutorialVideoAdminService.setSiteTutorialDemo`.
   */
  @Patch(':id/site-tutorial-demo')
  async siteTutorialDemo(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetTutorialVideoSiteTutorialDemoDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.videoAdmin.setSiteTutorialDemo(id, dto.marked, req.userId);
  }

  /**
   * POST /admin/tutorial-video-assets/:id/publish (этап 101, ТЗ §4.7,
   * Фаза 3) — публикация одобренного (`reviewed:true`) видео на
   * YouTube/TikTok, тем же конвейером, что рекламные ролики (см.
   * доккомментарий `PublicationService.publishTutorialVideo`).
   */
  @Post(':id/publish')
  async publish(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: PublishTutorialVideoDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.publication.publishTutorialVideo(id, req.userId, dto);
  }

  // ── Темп в постпродакшене (06.10.2026) ─────────────────────────────
  //
  // Тот же API, что у пользователя (`postprod/tutorials`), под защитой
  // админки. Для публичного (сценарного) демо версия становится
  // активной ТОЛЬКО по «Одобрить версию» — это и есть повторное
  // одобрение оператором (решение владельца).

  @Get(':id/tempo')
  async tempo(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Query('factor') factor?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.versions.estimate(
      { kind: 'operator', userId: req.userId },
      id,
      factor === undefined ? 1 : Number(factor),
    );
  }

  @Get(':id/versions')
  async listVersions(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.versions.listVersions(
      { kind: 'operator', userId: req.userId },
      id,
    );
  }

  @Post(':id/versions')
  async requestVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: TutorialTempoRequestDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.versions.requestVersion(
      { kind: 'operator', userId: req.userId },
      id,
      dto.factor,
    );
  }

  @Post(':id/versions/:versionId/approve')
  async approveVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.versions.activate(
      { kind: 'operator', userId: req.userId },
      id,
      versionId,
    );
  }

  @Post(':id/revert')
  async revert(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    await this.adminPanel.assertOperator(req.userId);
    return this.versions.revert({ kind: 'operator', userId: req.userId }, id);
  }
}
