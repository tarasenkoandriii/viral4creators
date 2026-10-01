import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ExportService } from './export.service';
import { StartExportRequestDto } from './dto/start-export-request.dto';
import { StartRerenderRequestDto } from './dto/start-rerender-request.dto';

/**
 * ExportController — автоэкспорт под площадки (TODO §III, п.35,
 * `doc/MULTI-FORMAT-EXPORT-SPEC.md`, этап 75). `:sessionId` в пути — тот
 * же параметр, что и у `GenerationController`, поэтому глобальный
 * `SessionOwnerGuard` защищает эти маршруты автоматически, без своей
 * настройки (см. его доккомментарий: гвард смотрит на ЛЮБОЙ маршрут с
 * `:sessionId`, а не на конкретный контроллер).
 */
// Возвращаем данные, а не `{ success, data }`: конверт ставит глобальный
// `ResponseInterceptor`, и ручной конверт давал двойной — фронтенд читал
// `data.video` у `{ success, data }` и падал с «undefined is not an object
// (evaluating 'z.video.exportVariants')» на «Перерендерить» (найдено
// владельцем 01.10.2026). Шов `check-docs` больше такого не пропустит.
@Controller('sessions/:sessionId/export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  /** POST /sessions/:sessionId/export — ярус A, пакетная дешёвая обрезка. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async startBatch(
    @Param('sessionId') sessionId: string,
    @Body() dto: StartExportRequestDto,
  ) {
    const data = await this.exportService.startBatch(sessionId, dto.targets);
    return data;
  }

  /** POST /sessions/:sessionId/export/rerender — ярус B, второй платный рендер Veo. */
  @Post('rerender')
  @HttpCode(HttpStatus.ACCEPTED)
  async startRerender(
    @Param('sessionId') sessionId: string,
    @Body() dto: StartRerenderRequestDto,
  ) {
    const data = await this.exportService.startRerender(
      sessionId,
      dto.targetAspectRatio,
      dto.preset,
      dto.quality,
    );
    return data;
  }

  /** GET /sessions/:sessionId/export/status — продвигает и возвращает состояние обоих ярусов. */
  @Get('status')
  async status(@Param('sessionId') sessionId: string) {
    const data = await this.exportService.syncStatus(sessionId);
    return data;
  }
}
