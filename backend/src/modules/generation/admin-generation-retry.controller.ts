/**
 * AdminGenerationRetryController — «Рендер не удался — попробовать
 * ещё раз», но из админки (доп. запрос владельца продукта: причина
 * провала и кнопка повтора прямо в списке сессий, не только в
 * интерфейсе пользователя).
 *
 * Живёт В GenerationModule, а не в admin-panel — единственная причина
 * чисто техническая: `AdminPanelModule` не может импортировать
 * `GenerationModule` напрямую — тот тянет `SharedVideoModule`, а она
 * сама импортирует `AdminPanelModule` (ради `AdminSharedVideoController`)
 * — обратный импорт замкнул бы цикл AdminPanelModule → GenerationModule
 * → SharedVideoModule → AdminPanelModule. Тот же самый прецедент уже
 * решён в проекте односторонне: admin-контроллер конкретной фичи живёт
 * в модуле этой фичи и импортирует `AdminPanelModule` сам (см.
 * `AdminSharedVideoController` в `shared-video.module.ts`) — этот
 * контроллер следует тому же правилу.
 *
 * Зовёт ровно тот же `GenerationService.generateVideo`, которым
 * пользуется собственная кнопка «Повторить» пользователя
 * (`POST /sessions/:id/generate`, см. `generation.controller.ts`) — те
 * же проверки блокировки/тарифа/бюджета, тот же платный рендер с теми
 * же настройками. Оператор не обходит биллинг: это тот же клик, просто
 * нажатый им, а не тем, у кого сессия.
 */
import {
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { GenerationService } from './generation.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';

@Controller('admin/sessions')
@UseGuards(AdminSessionGuard)
export class AdminGenerationRetryController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly generation: GenerationService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':id/retry')
  async retry(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);

    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    const data = (row.data as Record<string, unknown>) ?? {};
    const generatedVideo = data.generatedVideo as
      | { quality?: VideoQuality; aspectRatio?: string; status?: string }
      | undefined;
    // Качество/формат — те, что были в упавшей попытке, а не по
    // умолчанию: повтор должен воспроизводить тот же рендер, а не тихо
    // подменять его настройки.
    if (generatedVideo?.status !== GenerationStatus.FAILED) {
      throw new ForbiddenException(
        `Сессия ${id}: повтор доступен только для проваленного рендера (сейчас: ${generatedVideo?.status ?? 'рендера не было'})`,
      );
    }
    await this.generation.generateVideo(
      id,
      generatedVideo.quality,
      generatedVideo.aspectRatio,
    );
    return this.adminPanel.getSession(id);
  }
}
