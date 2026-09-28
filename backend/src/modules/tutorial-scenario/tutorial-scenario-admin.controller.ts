/**
 * TutorialScenarioAdminController — тот же приём, что
 * `AssistantAdminController` (см. его доккомментарий): собственный
 * контроллер внутри фиче-модуля, не добавка в `AdminPanelController`,
 * `AdminPanelModule` не импортируется в обратную сторону.
 *
 * Список сценариев и одобрение costly=true (§4.11 ТЗ, этап 94).
 * Эндпоинты существовали и были покрыты тестами с этапа 94; страница
 * админки («Система» → «Сценарии обучалки»,
 * admin/src/app/tutorial-scenarios/page.tsx) подключена этапом 105.
 * `DELETE :id` (этап 106) — чистка сломанных/устаревших сгенерированных
 * сценариев, см. доккомментарий `TutorialScenarioAdminService.remove`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { TutorialScenarioAdminService } from './tutorial-scenario-admin.service';

/**
 * Шаги приходят СТРОКОЙ с JSON внутри, а не разобранным массивом:
 * оператор правит их в текстовом поле, и его форматирование — часть
 * ввода. Тот же приём, что у каталога музыки
 * (`SetMusicCatalogDto`). Разбор и валидация — в контроллере и
 * сервисе, а не в DTO: правила те же, что для ответа модели, и жить
 * им положено в одном месте.
 */
export class ReplaceScenarioStepsDto {
  @IsString()
  @MaxLength(64 * 1024)
  steps!: string;
}

/**
 * Отметка о вычитке реплик (§3-бис.5 ТЗ, этап D). Булево, а не
 * «поставить» отдельным маршрутом: отметка СНИМАЕМАЯ (перечитал,
 * передумал), и два маршрута под одно поле разошлись бы в правах.
 */
export class SetNarrationReviewedDto {
  @IsBoolean()
  reviewed!: boolean;
}
function parseBool(v?: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

@Controller('admin/tutorial-scenarios')
@UseGuards(AdminSessionGuard)
export class TutorialScenarioAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly scenarioAdmin: TutorialScenarioAdminService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('subjectKey') subjectKey?: string,
    @Query('locale') locale?: string,
    @Query('costly') costly?: string,
    @Query('approved') approved?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.scenarioAdmin.list({
      subjectKey: subjectKey?.trim() || undefined,
      locale: locale?.trim() || undefined,
      costly: parseBool(costly),
      approved: parseBool(approved),
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // PATCH, не POST — тот же выбор, что PATCH /admin/settings/assistant
  // (`AssistantAdminController`): меняет одно поле уже существующей
  // строки, не создаёт новый ресурс.
  @Patch(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.scenarioAdmin.approve(id, req.userId);
  }

  /**
   * Правка шагов оператором — тот самый рычаг, без которого
   * сгенерированный сценарий не мог дойти до кадра: промпт нарочно
   * отдаёт плейсхолдеры селекторов, «которые оператор поправит на
   * настоящие», а поправить их было нечем (находка сквозного аудита
   * A+B+C). `PATCH`, как и `approve`: меняет поля существующей
   * строки. Шаги валидируются тем же `parseScenarioSteps`, что и
   * ответ модели.
   */
  @Patch(':id/steps')
  async replaceSteps(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ReplaceScenarioStepsDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.steps);
    } catch {
      throw new BadRequestException(
        'Это не JSON — проверьте кавычки и запятые',
      );
    }
    return this.scenarioAdmin.replaceSteps(id, parsed, req.userId);
  }

  /**
   * «Реплики прочитаны» (§3-бис.5 ТЗ, этап D).
   *
   * Отдельный маршрут, а не поле в `PATCH :id/steps`: правка шагов
   * отметку СБРАСЫВАЕТ, и отправить их одним запросом значило бы
   * «поправил и сам себе подписал» — ровно то разделение, которое
   * вычитка и заводит.
   */
  @Patch(':id/narration-reviewed')
  async setNarrationReviewed(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetNarrationReviewedDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.scenarioAdmin.setNarrationReviewed(
      id,
      dto.reviewed,
      req.userId,
    );
  }

  /**
   * DELETE, не PATCH с флагом — сценарий целиком лишний, не «отключён»
   * (§4.10/этап 106: очистка сломанных/устаревших сгенерированных
   * сценариев, см. доккомментарий `TutorialScenarioAdminService.remove`).
   */
  @Delete(':id')
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.scenarioAdmin.remove(id);
  }
}
