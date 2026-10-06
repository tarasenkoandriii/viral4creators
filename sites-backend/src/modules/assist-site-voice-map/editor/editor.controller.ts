/**
 * Панель редактора голосовой карты, iframe `we.` (Э6-тер, ТЗ §5-кватер.13):
 *   POST /editor/v1/session          обмен одноразового токена (из #t=) → сессия
 *   GET  /editor/v1/map?path=        черновик для шаблона страницы
 *   POST /editor/v1/ops              { expectedRevision, ops[] } → 409/422
 *   POST /editor/v1/try              «Сказать сейчас»: текст + снимок → показ плана по черновику
 *   POST /editor/v1/publish-request  запрос публикации → версия; подтверждение — в TMA
 *   POST /editor/v1/publish          всегда 403: публикует только человек в TMA (В-50)
 *   POST /editor/v1/exit             выход — сессия гаснет
 * Допуск — заголовок EDITOR_SESSION_HEADER (сессия только в памяти и
 * sessionStorage `we.`: страница заказчика её не видит). Основная роль
 * (запись в черновик), НЕ assist_public (§5-кватер.13). Мемо в редакторе
 * (запись кликами `memo/record/*`, «Прогнать» `memo/:key/try`, Э6-тер (д)) —
 * `editor-memo.controller.ts`. Отложено: ИИ-предложения синонимов
 * (`suggest-synonyms`), проверка устойчивости воркером (`stability`) —
 * doc/TODO.md I-Р.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { EDITOR_SESSION_HEADER } from '../../../brand';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { voiceMapError } from '../voice-map-errors';
import { EditorSessionService } from './editor-session.service';

const H = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('editor/v1')
@PublicRoute(
  'панель редактора голосовой карты (iframe we.): допуск — одноразовая ссылка кабинета / сессия редактора',
)
export class EditorController {
  constructor(private readonly editor: EditorSessionService) {}

  @Post('session')
  @HttpCode(200)
  session(@Body() body: unknown) {
    return this.editor.exchange(body);
  }

  @Get('map')
  async map(@Headers(H) s: string | undefined, @Query('path') path: unknown) {
    return this.editor.map(await this.editor.resolve(s), path);
  }

  @Post('ops')
  @HttpCode(200)
  async ops(@Headers(H) s: string | undefined, @Body() body: unknown) {
    return this.editor.ops(await this.editor.resolve(s), body);
  }

  @Post('try')
  @HttpCode(200)
  async tryCommand(@Headers(H) s: string | undefined, @Body() body: unknown) {
    return this.editor.tryCommand(await this.editor.resolve(s), body);
  }

  @Post('publish-request')
  @HttpCode(200)
  async publishRequest(@Headers(H) s: string | undefined) {
    return this.editor.publishRequest(await this.editor.resolve(s));
  }

  /** Публикация из панели невозможна (кликджекинг на странице заказчика, В-50). */
  @Post('publish')
  async publish(@Headers(H) s: string | undefined) {
    await this.editor.resolve(s);
    throw voiceMapError(
      HttpStatus.FORBIDDEN,
      'EDITOR_PUBLISH_FORBIDDEN',
      'Публикация — только с подтверждением в Telegram',
    );
  }

  @Post('exit')
  @HttpCode(200)
  async exit(@Headers(H) s: string | undefined) {
    return this.editor.exit(await this.editor.resolve(s));
  }
}
