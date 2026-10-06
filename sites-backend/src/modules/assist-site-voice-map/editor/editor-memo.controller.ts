/**
 * Мемо в панели редактора (iframe `we.`, Э6-тер (д), ТЗ §5-бис.17 п.6–7,
 * §5-кватер.5, §5-кватер.13):
 *   POST /editor/v1/memo/record/start  { path, memo? }            → начало записи / правка мемо N
 *   POST /editor/v1/memo/record/step   { path, descriptor, … }    → шаг или остановка записи
 *   POST /editor/v1/memo/record/stop   { steps, slots, name, … }  → черновик мемо (origin recording)
 *   POST /editor/v1/memo/:key/try      { snapshot, from? }        → «Прогнать» черновик на странице
 * Допуск — тот же, что у остальных `/editor/v1/*`: заголовок сессии
 * редактора (`EditorSessionService.resolve` на каждом запросе: сессия жива,
 * участник — владелец/менеджер, хост — verified «Сайта»), основная роль.
 * Публикации здесь нет — только черновик (В-50).
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { EDITOR_SESSION_HEADER } from '../../../brand';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { EditorMemoService } from './editor-memo.service';
import { EditorSessionService } from './editor-session.service';

const H = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('editor/v1/memo')
@PublicRoute(
  'мемо в панели редактора (iframe we.): допуск — сессия редактора из одноразовой ссылки кабинета',
)
export class EditorMemoController {
  constructor(
    private readonly editor: EditorSessionService,
    private readonly memos: EditorMemoService,
  ) {}

  @Post('record/:op')
  @HttpCode(200)
  async record(
    @Headers(H) s: string | undefined,
    @Param('op') op: string,
    @Body() body: unknown,
  ) {
    const ed = await this.editor.resolve(s);
    switch (op) {
      case 'start':
        return this.memos.start(ed, body);
      case 'step':
        return this.memos.step(ed, body);
      case 'stop':
        return this.memos.stop(ed, body);
      // Мемо с ключом `record` — его «Прогнать» попадает сюда.
      case 'try':
        return this.memos.tryMemo(ed, 'record', body);
      default:
        throw new HttpException(
          {
            error: 'EDITOR_MEMO_BAD_REQUEST',
            code: 'EDITOR_MEMO_BAD_REQUEST',
            message: 'Операция записи: start | step | stop',
          },
          HttpStatus.NOT_FOUND,
        );
    }
  }

  @Post(':key/try')
  @HttpCode(200)
  async tryMemo(
    @Headers(H) s: string | undefined,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.memos.tryMemo(await this.editor.resolve(s), key, body);
  }
}
