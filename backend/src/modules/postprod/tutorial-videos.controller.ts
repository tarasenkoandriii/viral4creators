import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  TutorialTempoEstimate,
  TutorialVersionView,
  TutorialVideoVersionsService,
  UserTutorialItem,
  VersionRequestResult,
} from './tutorial-video-versions.service';
import { TutorialTempoRequestDto } from './dto/tutorial-tempo.dto';

/**
 * Обучалки пользователя во вкладке «Постпрод» (темп, 06.10.2026).
 *
 * Отдельный маршрут, а не ветка `postprod/videos`: тот перечисляет
 * сессии генерации (`sessionId`), а обучалка — `TutorialVideoAsset`
 * черновика по сайту клиента, со своей проверкой владения
 * (`draft.project.userId`). Дискриминированный тип «сессия | обучалка»
 * на фронтенде — по маршруту, а не подменой `sessionId`.
 *
 * Чужой ролик — 404 на всех путях (не «нет прав»): существование чужого
 * id не подтверждается.
 */
@Controller('postprod/tutorials')
@UseGuards(TelegramIdentityGuard)
export class TutorialVideosController {
  constructor(private readonly versions: TutorialVideoVersionsService) {}

  @Get()
  async list(
    @Req() req: IdentifiedRequest,
  ): Promise<{ items: UserTutorialItem[] }> {
    return { items: await this.versions.listForUser(req.telegramUserId) };
  }

  /** Бесплатный расчёт: длительность, предупреждения, предпросмотр. */
  @Get(':assetId/tempo')
  estimate(
    @Req() req: IdentifiedRequest,
    @Param('assetId') assetId: string,
    @Query('factor') factor?: string,
  ): Promise<TutorialTempoEstimate> {
    return this.versions.estimate(
      { kind: 'user', userId: req.telegramUserId },
      assetId,
      factor === undefined ? 1 : Number(factor),
    );
  }

  @Get(':assetId/versions')
  listVersions(
    @Req() req: IdentifiedRequest,
    @Param('assetId') assetId: string,
  ): Promise<TutorialVersionView[]> {
    return this.versions.listVersions(
      { kind: 'user', userId: req.telegramUserId },
      assetId,
    );
  }

  /** «Сохранить»: одна платная сборка версии (×1 — возврат без сборки). */
  @Post(':assetId/versions')
  request(
    @Req() req: IdentifiedRequest,
    @Param('assetId') assetId: string,
    @Body() dto: TutorialTempoRequestDto,
  ): Promise<VersionRequestResult> {
    return this.versions.requestVersion(
      { kind: 'user', userId: req.telegramUserId },
      assetId,
      dto.factor,
    );
  }

  @Post(':assetId/versions/:versionId/activate')
  activate(
    @Req() req: IdentifiedRequest,
    @Param('assetId') assetId: string,
    @Param('versionId') versionId: string,
  ): Promise<TutorialVersionView> {
    return this.versions.activate(
      { kind: 'user', userId: req.telegramUserId },
      assetId,
      versionId,
    );
  }

  /** Вернуть обычный темп — исходный файл, без сборки и без денег. */
  @Post(':assetId/revert')
  revert(
    @Req() req: IdentifiedRequest,
    @Param('assetId') assetId: string,
  ): Promise<TutorialVersionView> {
    return this.versions.revert(
      { kind: 'user', userId: req.telegramUserId },
      assetId,
    );
  }
}
