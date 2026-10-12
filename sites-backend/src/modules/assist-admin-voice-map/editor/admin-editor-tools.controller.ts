/**
 * Инструменты панели редактора карты «Админки», iframe `wa.` (заход 13,
 * хвост Р-З11-А11 — паритет с панелью `we.` «Сайта»; ТЗ §5-кватер.4,
 * §5-кватер.6 п.1, §5-кватер.10, §5-кватер.13):
 *   POST /assist-admin/v1/editor/suggest-synonyms   { expectedRevision, key } — ИИ-синонимы цели
 *   GET  /assist-admin/v1/editor/misses?path=       «Промахи» (журнал «Админки»)
 *   GET  /assist-admin/v1/editor/suggestions?path=  «Пропозиції»
 *   POST /assist-admin/v1/editor/suggestions/mute   { id } | { key, lang, text }
 *   POST /assist-admin/v1/editor/suggestions/term   у «Админки» терминов нет — 400
 *   POST /assist-admin/v1/editor/voice              запись `audio/*` ≤ 1 МБ → { text, lang, left }
 *   /assist-admin/v1/editor/memo/*                  — `admin-editor-memo.controller.ts`
 * Допуск — обе сессии, как у `admin-editor.controller.ts`: сотрудника `wa.`
 * (`X-Assist-Admin-Session`) и редактора (`X-Assist-Editor`); сессия
 * редактора на каждом запросе перепроверяет владельца, хост и тариф.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ADMIN_SESSION_HEADER, EDITOR_SESSION_HEADER } from '../../../brand';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AdminEditorAssistService } from './admin-editor-assist.service';
import {
  AdminEditorSessionService,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';
import { AdminEditorVoiceService } from './admin-editor-voice.service';

const ADMIN = ADMIN_SESSION_HEADER.toLowerCase();
const EDITOR = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('assist-admin/v1/editor')
@PublicRoute(
  'панель редактора карты «Админки» (iframe wa.): подсказки и микрофон — employee-JWT владельца + сессия редактора',
)
export class AdminEditorToolsController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly editor: AdminEditorSessionService,
    private readonly assist: AdminEditorAssistService,
    private readonly voice: AdminEditorVoiceService,
  ) {}

  private async ed(
    admin: string | undefined,
    editor: string | undefined,
  ): Promise<ResolvedAdminEditor> {
    return this.editor.resolve(await this.sessions.resolve(admin), editor);
  }

  @Post('suggest-synonyms')
  @HttpCode(200)
  async suggestSynonyms(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.assist.suggestSynonyms(await this.ed(admin, editor), body);
  }

  @Get('misses')
  async misses(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Query('path') path: unknown,
  ) {
    return this.assist.misses(await this.ed(admin, editor), path);
  }

  @Get('suggestions')
  async suggestions(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Query('path') path: unknown,
  ) {
    return this.assist.suggestions(await this.ed(admin, editor), path);
  }

  @Post('suggestions/mute')
  @HttpCode(200)
  async mute(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.assist.mute(await this.ed(admin, editor), body);
  }

  @Post('suggestions/term')
  @HttpCode(200)
  async acceptTerm(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.assist.acceptTerm(await this.ed(admin, editor), body);
  }

  /** Сырое тело `audio/*` — парсер `app.setup.ts` (ADMIN_EDITOR_VOICE_PATH). */
  @Post('voice')
  @HttpCode(200)
  async transcribe(
    @Headers(ADMIN) admin: string | undefined,
    @Headers(EDITOR) editor: string | undefined,
    @Headers('content-type') type: string | undefined,
    @Body() body: unknown,
  ) {
    const audio = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    try {
      const ed = await this.ed(admin, editor);
      return await this.voice.transcribe(ed, audio, type);
    } finally {
      audio.fill(0);
    }
  }
}
