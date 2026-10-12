/**
 * Микрофон «Сказать сейчас» в панели редактора карты «Админки» (iframe
 * `wa.`) — заход 13, хвост Р-З11-А11 (паритет с `POST /editor/v1/voice`
 * «Сайта»; ТЗ §5-кватер.6 п.1 «Запись → Soniox (как в бою) → „я услышал: …“»):
 *   POST /assist-admin/v1/editor/voice   (тело — сама запись `audio/*` ≤ 1 МБ,
 *                                         как у `/assist-admin/v1/voice`;
 *                                         ответ `{ text, lang, left }`)
 * Текст дальше идёт тем же `POST /assist-admin/v1/editor/try` (показ без
 * нажатий, без модели).
 *
 * Распознавание — КАК У ГОЛОСОВОГО УПРАВЛЕНИЯ «Админки» (Р-З13-А6): тот же
 * клиент Soniox «Админки» (`AdminSonioxStt`: запись только в памяти,
 * удаление файла и транскрипции у провайдера в `finally`, метка уборки
 * сайтов), та же операция учёта `assist-admin-stt` и тот же суточный
 * потолок «Админки» (резерв ДО провайдера). Отличия от боевого `/voice`:
 *  - билета голоса нет: текст не исполняется, только показ плана;
 *  - переключатель голосового управления не нужен (редактор готовит карту
 *    ДО включения), нужен только голос платформы и ключ провайдера;
 *  - потолок — общий с «Сказать сейчас» (100 в сутки на сайт, запись — одна
 *    из проверок), засчитывается до провайдера;
 *  - подсказки распознаванию — имена/синонимы (без `suggested`)/термины
 *    ЧЕРНОВИКА карты «Админки»: владелец проверяет то, что только что назвал.
 * В лог — id сайта, байты, секунды и код; ни текста, ни языка.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import {
  ADMIN_STT,
  AdminSonioxStt,
  adminAudioHeaderOk,
  sniffAdminAudio,
} from '../../assist-admin-voice/admin-stt';
import { AdminVoiceSettingsService } from '../../assist-admin-voice/admin-voice-settings.service';
import { buildSttTerms } from '../../assist-ui-core/stt-terms';
import {
  parseVoiceMapContent,
  VOICE_MAP_LANGS,
} from '../../assist-ui-core/voice-map';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { adminVoiceMapError } from '../admin-voice-map-errors';
import { AdminVoiceMapService } from '../admin-voice-map.service';
import type { AdminEditorVoiceView } from '../api-types';
import { AdminEditorBudget } from './admin-editor-budget';
import {
  AdminEditorSessionService,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';

/** Модель учёта секунд — та же, что у боевого голоса «Админки». */
export const ADMIN_EDITOR_STT_MODEL = 'soniox-stt-async';

@Injectable()
export class AdminEditorVoiceService {
  private readonly logger = new Logger(AdminEditorVoiceService.name);

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: AdminVoiceMapService,
    private readonly editor: AdminEditorSessionService,
    private readonly stt: AdminSonioxStt,
    private readonly settings: AdminVoiceSettingsService,
    private readonly budget: AdminEditorBudget,
    private readonly usage: AiUsageRecorder,
  ) {}

  async transcribe(
    ed: ResolvedAdminEditor,
    audio: Buffer,
    contentType: unknown,
  ): Promise<AdminEditorVoiceView> {
    try {
      // Заголовок — только допуск; тип для провайдера — по байтам записи.
      const mime = adminAudioHeaderOk(contentType)
        ? sniffAdminAudio(audio)
        : null;
      if (
        !mime ||
        audio.length < ADMIN_STT.minAudioBytes ||
        audio.length > ADMIN_STT.maxAudioBytes
      )
        throw adminVoiceMapError(
          HttpStatus.BAD_REQUEST,
          'EDITOR_VOICE_AUDIO_INVALID',
          'Запись не подходит — повторите или напишите текстом',
        );
      if (!this.settings.voiceAvailable() || !this.stt.configured())
        throw adminVoiceMapError(
          HttpStatus.CONFLICT,
          'EDITOR_VOICE_UNAVAILABLE',
          'Распознавание голоса сейчас недоступно — напишите команду текстом',
        );
      const db = this.sitesDb.forAccount(ed.accountId);
      const map = parseVoiceMapContent(
        (await this.maps.loadMap(db, ed.accountId, ed.siteId)).draft,
      );
      const est = estimateCost(ADMIN_EDITOR_STT_MODEL, {
        seconds: ADMIN_STT.reserveSeconds,
      }).costMicroUsd;
      // Деньги — до потолка проверок (без денег проверка дня не сгорает)
      // и до провайдера.
      const rsv = await this.budget.reserve(ed.accountId, ed.siteId, est);
      if (!rsv)
        throw adminVoiceMapError(
          HttpStatus.PAYMENT_REQUIRED,
          'EDITOR_VOICE_BUDGET',
          'Суточный лимит помощника сотрудников исчерпан — проверьте команду текстом',
        );
      let left: number;
      try {
        left = await this.editor.spendTry(ed);
      } catch (e) {
        await this.budget.settle(rsv, 0);
        throw e;
      }
      let actual: number | null = 0;
      let r: Awaited<ReturnType<AdminSonioxStt['transcribe']>>;
      try {
        const active = map.targets.filter(
          (t) => t.status === 'active' && !t.denylisted,
        );
        r = await this.stt.transcribe({
          audio,
          mimeType: mime,
          languageHints: [...VOICE_MAP_LANGS],
          terms: buildSttTerms([
            active.flatMap((t) => VOICE_MAP_LANGS.map((l) => t.names[l])),
            map.terms,
            active.flatMap((t) =>
              VOICE_MAP_LANGS.flatMap((l) =>
                (t.synonyms[l] ?? [])
                  .filter((s) => s.origin !== 'suggested')
                  .map((s) => s.text),
              ),
            ),
          ]),
        });
        if (r.billable) {
          const u = await this.usage
            .record(
              this.sitesDb.system(
                'учёт расходов «Админки»: распознавание «Сказать сейчас» в редакторе карты',
              ),
              {
                accountId: ed.accountId,
                siteId: ed.siteId,
                operation: 'assist-admin-stt',
                model: ADMIN_EDITOR_STT_MODEL,
                units: { seconds: r.seconds },
              },
            )
            .catch(() => null);
          // Факт не записался — оценка остаётся расходом (строже).
          actual = u ? u.costMicroUsd : null;
        }
      } finally {
        await this.budget.settle(rsv, actual);
      }
      this.logger.log(
        `admin editor voice site=${ed.siteId} bytes=${audio.length} s=${r.seconds} ok=${!!r.text} reason=${r.reason ?? '-'}`,
      );
      if (!r.text)
        throw r.reason === 'no_speech' || r.reason === 'empty'
          ? adminVoiceMapError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'EDITOR_VOICE_NOT_HEARD',
              'Не расслышал — повторите ближе к микрофону',
            )
          : adminVoiceMapError(
              HttpStatus.BAD_GATEWAY,
              'EDITOR_VOICE_UPSTREAM',
              'Распознавание недоступно — напишите команду текстом',
            );
      return { text: r.text.slice(0, 200).trim(), lang: r.language, left };
    } finally {
      // Звук команды не живёт дольше запроса (Условия п.3.4, §6.3).
      audio.fill(0);
    }
  }
}
