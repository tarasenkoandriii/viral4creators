import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { PostProductionService } from './postprod.service';
import { PostProdError } from '../../common/postprod';
import { SessionService } from '../../common/session.service';
import { ReVoiceRequestDto } from './dto/revoice-request.dto';

/**
 * PostProdController — переозвучка готового ролика без перегенерации
 * (доп. запрос владельца продукта, этап 87). `:sessionId` в пути — тот
 * же параметр, что у GenerationController/ExportController, поэтому
 * глобальный `SessionOwnerGuard` защищает маршрут автоматически (см.
 * его доккомментарий: гвард смотрит на ЛЮБОЙ маршрут с `:sessionId`,
 * а не на конкретный контроллер).
 */
@Controller('sessions/:sessionId/postprod')
export class PostProdController {
  constructor(
    private readonly postprod: PostProductionService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * POST /sessions/:sessionId/postprod/revoice — новая звуковая дорожка
   * (и, если сессия включает субтитры, новые субтитры под неё) поверх
   * УЖЕ готового ролика, без второго платного рендера Veo/Grok. Голос
   * меняют отдельным вызовом `PATCH /sessions/:id/brand-manifest` перед
   * этим маршрутом; здесь — только (необязательный) новый текст реплик.
   */
  @Post('revoice')
  @HttpCode(HttpStatus.ACCEPTED)
  async reVoice(
    @Param('sessionId') sessionId: string,
    @Body() dto: ReVoiceRequestDto,
  ) {
    const session = await this.sessions.getSession(sessionId);
    if (!session?.generatedVideo) {
      throw new NotFoundException(
        `Session ${sessionId} has no generated video`,
      );
    }
    try {
      const data = await this.postprod.reVoice(
        sessionId,
        session.generatedVideo,
        { voiceoverScript: dto.voiceoverScript },
      );
      return { success: true, data };
    } catch (e) {
      // `PostProdError` — обычный Error, не Nest HttpException (тот же
      // приём, что `ExportService.startBatch`, см. её доккомментарий):
      // не перехваченный здесь, дошёл бы до клиента как 500, хотя это
      // обычная ошибка валидации запроса пользователя (голос Veo без
      // дорожки, ролик ещё не готов, бюджет исчерпан и т.п.).
      if (e instanceof PostProdError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
