/**
 * Мемо АМ-N в панели редактора карты «Админки», iframe `wa.` (заход 13,
 * хвост Р-З11-А11; паритет с `editor-memo.controller.ts` «Сайта»):
 *   POST /assist-admin/v1/editor/memo/record/start  { path, memo?, lang }
 *   POST /assist-admin/v1/editor/memo/record/step   { path, descriptor, … }
 *   POST /assist-admin/v1/editor/memo/record/stop   { steps, slots, name, … }
 *   POST /assist-admin/v1/editor/memo/record/wait   у «Админки» нет — 404
 *   POST /assist-admin/v1/editor/memo/:key/try      { snapshot, from? }
 *   GET  /assist-admin/v1/editor/memo/list?lang=
 * Допуск — обе сессии (сотрудника `wa.` и редактора). Публикации здесь нет —
 * только черновик (публикует владелец в TMA).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ADMIN_SESSION_HEADER, EDITOR_SESSION_HEADER } from '../../../brand';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AdminEditorMemoService } from './admin-editor-memo.service';
import {
  AdminEditorSessionService,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';

const ADMIN = ADMIN_SESSION_HEADER.toLowerCase();
const EDITOR = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('assist-admin/v1/editor/memo')
@PublicRoute(
  'мемо «Админки» в панели редактора карты (iframe wa.): employee-JWT владельца + сессия редактора',
)
export class AdminEditorMemoController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly editor: AdminEditorSessionService,
    private readonly memos: AdminEditorMemoService,
  ) {}

  private async ed(
    admin: string | undefined,
    editor: string | undefined,
  ): Promise<ResolvedAdminEditor> {
    return this.editor.resolve(await this.sessions.resolve(admin), editor);
  }

  @Post('record/:op')
  @HttpCode(200)
  async record(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Param('op') op: string,
    @Body() body: unknown,
  ) {
    const ed = await this.ed(admin, editor);
    switch (op) {
      case 'start':
        return this.memos.start(ed, body);
      case 'step':
        return this.memos.step(ed, body);
      case 'stop':
        return this.memos.stop(ed, body);
      case 'wait':
        return this.memos.wait();
      // Мемо с ключом `record` — его «Прогнати» попадает сюда.
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

  @Get('list')
  async list(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Query('lang') lang: unknown,
  ) {
    return this.memos.list(await this.ed(admin, editor), lang);
  }

  @Post(':key/try')
  @HttpCode(200)
  async tryMemo(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.memos.tryMemo(await this.ed(admin, editor), key, body);
  }
}
