/**
 * Панель редактора карты «Админки», iframe `wa.` (заход 11, №117; ТЗ
 * §5-кватер.13 «панель „Админки“, iframe wa.: /assist-admin/v1/editor/* — то
 * же + employee-JWT владельца»):
 *   POST /assist-admin/v1/editor/session          { token, parentOrigin } → сессия редактора
 *   GET  /assist-admin/v1/editor/map?path=        черновик для шаблона страницы админки
 *   POST /assist-admin/v1/editor/ops              { expectedRevision, ops[] } → 409/422
 *   POST /assist-admin/v1/editor/try              «Сказать сейчас»: текст + снимок → показ плана
 *   POST /assist-admin/v1/editor/publish-request  запрос публикации → версия; публикует владелец в TMA
 *   POST /assist-admin/v1/editor/publish          всегда 403
 *   POST /assist-admin/v1/editor/rebind           к новой сессии сотрудника того же `sub` (свежий JWT)
 *   POST /assist-admin/v1/editor/exit             выход — сессия гаснет
 * Допуск — ОБА заголовка: `X-Assist-Admin-Session` (сессия сотрудника `wa.`
 * по employee-JWT; на `session` — та, к которой привяжется редактор) и
 * `X-Assist-Editor` (сессия редактора, кроме `session`). CORS — только
 * origin «Админки» (`/assist-admin/v1/*`, common/cors.ts). Основная роль.
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
import { ADMIN_SESSION_HEADER, EDITOR_SESSION_HEADER } from '../../../brand';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { adminVoiceMapError } from '../admin-voice-map-errors';
import {
  AdminEditorSessionService,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';

const ADMIN = ADMIN_SESSION_HEADER.toLowerCase();
const EDITOR = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('assist-admin/v1/editor')
@PublicRoute(
  'панель редактора карты «Админки» (iframe wa.): employee-JWT сотрудника + одноразовая ссылка владельца / сессия редактора',
)
export class AdminEditorController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly editor: AdminEditorSessionService,
  ) {}

  private async ed(
    admin: string | undefined,
    editor: string | undefined,
  ): Promise<ResolvedAdminEditor> {
    const s = await this.sessions.resolve(admin);
    return this.editor.resolve(s, editor);
  }

  @Post('session')
  @HttpCode(200)
  async session(
    @Headers(ADMIN) admin: string | undefined,
    @Body() body: unknown,
  ) {
    return this.editor.exchange(await this.sessions.resolve(admin), body);
  }

  @Get('map')
  async map(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Query('path') path: unknown,
  ) {
    return this.editor.map(await this.ed(admin, editor), path);
  }

  @Post('ops')
  @HttpCode(200)
  async ops(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.editor.ops(await this.ed(admin, editor), body);
  }

  @Post('try')
  @HttpCode(200)
  async tryCommand(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.editor.tryCommand(await this.ed(admin, editor), body);
  }

  @Post('publish-request')
  @HttpCode(200)
  async publishRequest(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
  ) {
    return this.editor.publishRequest(await this.ed(admin, editor));
  }

  /** Публикация из панели невозможна (кликджекинг на странице, В-50). */
  @Post('publish')
  async publish(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
  ) {
    await this.ed(admin, editor);
    throw adminVoiceMapError(
      HttpStatus.FORBIDDEN,
      'EDITOR_PUBLISH_FORBIDDEN',
      'Публикация — только с подтверждением в Telegram',
    );
  }

  /**
   * Перепривязка к новой сессии сотрудника (свежий JWT после `exp`): тот же
   * `sub` и сайт — иначе 401 (раунд исправлений захода 11, аудит P1-1).
   */
  @Post('rebind')
  @HttpCode(200)
  async rebind(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
  ) {
    return this.editor.rebind(await this.sessions.resolve(admin), editor);
  }

  @Post('exit')
  @HttpCode(200)
  async exit(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
  ) {
    return this.editor.exit(await this.ed(admin, editor));
  }
}
