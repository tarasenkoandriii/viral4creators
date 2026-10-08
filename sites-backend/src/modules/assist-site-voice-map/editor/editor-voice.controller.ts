/**
 * POST /editor/v1/voice — запись «Сказать сейчас» из панели редактора
 * (iframe `we.`, заход 9, Э6-тер (7); ТЗ §5-кватер.6 п.1): тело — сама
 * запись `audio/*` ≤ 1 МБ (сырой парсер — `import-body.ts`
 * `editorVoiceRaw`, подключение — `app.setup.ts`), ответ `{ text, lang,
 * left }`. Допуск — заголовок сессии редактора, как у всех `/editor/v1/*`.
 */
import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { EDITOR_SESSION_HEADER } from '../../../brand';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { EditorSessionService } from './editor-session.service';
import { EditorVoiceService } from './editor-voice.service';

const H = EDITOR_SESSION_HEADER.toLowerCase();

@Controller('editor/v1')
@PublicRoute(
  'голос «Сказать сейчас» в панели редактора (iframe we.): допуск — сессия редактора из одноразовой ссылки кабинета',
)
export class EditorVoiceController {
  constructor(
    private readonly editor: EditorSessionService,
    private readonly voice: EditorVoiceService,
  ) {}

  @Post('voice')
  @HttpCode(200)
  async transcribe(
    @Headers(H) s: string | undefined,
    @Headers('content-type') type: string | undefined,
    @Body() body: unknown,
  ) {
    const audio = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    try {
      const ed = await this.editor.resolve(s);
      return await this.voice.transcribe(ed, audio, type);
    } finally {
      audio.fill(0);
    }
  }
}
