/**
 * Панель редактора голосовой карты, iframe `we.` — подсказки (№113, заход
 * 10; ТЗ §5-кватер.4 «Предложения ИИ», §5-кватер.10):
 *   POST /editor/v1/suggest-synonyms  { expectedRevision, key } — ИИ-синонимы
 *                                     цели (`assist-learn`) → `suggested` в черновик
 *   GET  /editor/v1/misses?path=      «Промахи»: Т-4 по целям страницы и
 *                                     «просили, не нашли» на шаблоне
 *   GET  /editor/v1/suggestions?path= «Предложения» из очереди обучения
 *   POST /editor/v1/suggestions/mute  { id } | { key, lang, text } — не
 *                                     предлагать 30 дней
 *   POST /editor/v1/suggestions/term  { expectedRevision, id } — (заход 11)
 *                                     термин распознавания → черновик карты
 * Допуск — заголовок сессии редактора, как у `editor.controller.ts`.
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
import { EDITOR_SESSION_HEADER } from '../../../brand';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { EditorAssistService } from './editor-assist.service';
import { EditorSessionService } from './editor-session.service';

const H = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('editor/v1')
@PublicRoute(
  'панель редактора голосовой карты (iframe we.): подсказки — допуск по сессии редактора',
)
export class EditorAssistController {
  constructor(
    private readonly editor: EditorSessionService,
    private readonly assist: EditorAssistService,
  ) {}

  @Post('suggest-synonyms')
  @HttpCode(200)
  async suggestSynonyms(
    @Headers(H) s: string | undefined,
    @Body() body: unknown,
  ) {
    return this.assist.suggestSynonyms(await this.editor.resolve(s), body);
  }

  @Get('misses')
  async misses(
    @Headers(H) s: string | undefined,
    @Query('path') path: unknown,
  ) {
    return this.assist.misses(await this.editor.resolve(s), path);
  }

  @Get('suggestions')
  async suggestions(
    @Headers(H) s: string | undefined,
    @Query('path') path: unknown,
  ) {
    return this.assist.suggestions(await this.editor.resolve(s), path);
  }

  @Post('suggestions/mute')
  @HttpCode(200)
  async mute(@Headers(H) s: string | undefined, @Body() body: unknown) {
    return this.assist.mute(await this.editor.resolve(s), body);
  }

  @Post('suggestions/term')
  @HttpCode(200)
  async acceptTerm(@Headers(H) s: string | undefined, @Body() body: unknown) {
    return this.assist.acceptTerm(await this.editor.resolve(s), body);
  }
}
