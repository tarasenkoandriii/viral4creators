/**
 * Микрофон «Сказать сейчас» в панели редактора (Э6-тер (7), заход 9; ТЗ
 * §5-кватер.6 п.1: «Запись → Soniox (как в бою) → „я услышал: …“»):
 *   POST /editor/v1/voice   (тело — сама запись `audio/*` ≤ 1 МБ, как у
 *                            `/widget/v1/voice`; ответ `{ text, lang, left }`)
 * Текст дальше идёт тем же `POST /editor/v1/try` (показ без нажатий).
 *
 *  - допуск — сессия редактора (`EditorSessionService.resolve` в
 *    контроллере: сессия жива, право и хост живые);
 *  - потолок — ОБЩИЙ с «Сказать сейчас» (`spendTry`, 100 в сутки на сайт):
 *    запись засчитывается до вызова провайдера;
 *  - деньги — бюджет ОБУЧЕНИЯ сайта (§5-кватер.6: «бюджет обучения»;
 *    отдельной операции `assist-voice-test` в учёте нет — `assist-learn`):
 *    резерв ДО провайдера, поправка на факт секунд после; нет бюджета — 402;
 *  - звук — только `Buffer` в памяти запроса, затирается в `finally`; у
 *    провайдера файл удаляет клиент (SiteSonioxStt, Условия п.3.4); в лог —
 *    id сайта, байты, секунды и код, ни текста, ни языка;
 *  - подсказки распознаванию — имена/синонимы/термины ЧЕРНОВИКА карты
 *    (владелец проверяет то, что только что назвал), без мемо.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  voicePlatformEnabled,
  voiceProviderConfigured,
} from '../../../config/voice-env';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { buildSttTerms } from '../../assist-ui-core/stt-terms';
import {
  parseVoiceMapContent,
  VOICE_MAP_LANGS,
} from '../../assist-ui-core/voice-map';
import { SiteSonioxStt } from '../../assist-site-voice/public/soniox-stt.client';
import {
  VOICE_DEFAULTS,
  audioMimeOf,
  sniffAudio,
} from '../../assist-site-voice/voice-config';
import { LearningBudget } from '../../site-ai/learning-budget';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { voiceMapError } from '../voice-map-errors';
import { VoiceMapService } from '../voice-map.service';
import {
  EditorSessionService,
  type ResolvedEditor,
} from './editor-session.service';

export const EDITOR_STT_MODEL = 'soniox-stt-async';

export interface EditorVoiceView {
  text: string;
  lang: string | null;
  /** Проверок «Сказать сейчас» осталось сегодня (запись — одна из них). */
  left: number;
}

@Injectable()
export class EditorVoiceService {
  private readonly logger = new Logger(EditorVoiceService.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: VoiceMapService,
    private readonly editor: EditorSessionService,
    private readonly stt: SiteSonioxStt,
    private readonly budget: LearningBudget,
    private readonly usage: AiUsageRecorder,
  ) {}

  async transcribe(
    ed: ResolvedEditor,
    audio: Buffer,
    contentType: unknown,
  ): Promise<EditorVoiceView> {
    try {
      // Заголовок — только допуск; тип для провайдера — по байтам записи.
      const mime = audioMimeOf(contentType) ? sniffAudio(audio) : null;
      if (
        !mime ||
        audio.length < VOICE_DEFAULTS.minAudioBytes ||
        audio.length > VOICE_DEFAULTS.maxAudioBytes
      )
        throw voiceMapError(
          HttpStatus.BAD_REQUEST,
          'EDITOR_VOICE_AUDIO_INVALID',
          'Запись не подходит — повторите или напишите текстом',
        );
      if (!voicePlatformEnabled(this.env) || !voiceProviderConfigured(this.env))
        throw voiceMapError(
          HttpStatus.CONFLICT,
          'EDITOR_VOICE_UNAVAILABLE',
          'Распознавание голоса сейчас недоступно — напишите команду текстом',
        );
      const db = this.sitesDb.forAccount(ed.accountId);
      const map = parseVoiceMapContent(
        (await this.maps.loadMap(db, ed.accountId, ed.siteId)).draft,
      );
      const est = estimateCost(EDITOR_STT_MODEL, {
        seconds: VOICE_DEFAULTS.sttReserveSeconds,
      }).costMicroUsd;
      // Деньги — до потолка проверок (аудит P3: без бюджета проверка дня не
      // сгорает) и до провайдера.
      if (!(await this.budget.reserve(ed.accountId, ed.siteId, est)))
        throw voiceMapError(
          HttpStatus.PAYMENT_REQUIRED,
          'EDITOR_VOICE_BUDGET',
          'Бюджет обучения на этот месяц исчерпан — проверьте команду текстом',
        );
      // Потолок «Сказать сейчас» — до провайдера; сверх — резерв назад.
      let left: number;
      try {
        left = await this.editor.spendTry(db, ed.siteId);
      } catch (e) {
        await this.budget
          .adjust(ed.accountId, ed.siteId, -est)
          .catch(() => undefined);
        throw e;
      }
      let actual = 0;
      let r: Awaited<ReturnType<SiteSonioxStt['transcribe']>>;
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
                'учёт расходов ИИ: распознавание «Сказать сейчас» в редакторе (assist-learn)',
              ),
              {
                accountId: ed.accountId,
                siteId: ed.siteId,
                operation: 'assist-learn',
                model: EDITOR_STT_MODEL,
                units: { seconds: r.seconds },
              },
            )
            .catch(() => null);
          actual = u?.costMicroUsd ?? est;
        }
      } finally {
        await this.budget
          .adjust(ed.accountId, ed.siteId, actual - est)
          .catch(() => undefined);
      }
      this.logger.log(
        `editor voice site=${ed.siteId} bytes=${audio.length} s=${r.seconds} ok=${!!r.text} reason=${r.reason ?? '-'}`,
      );
      if (!r.text)
        throw r.reason === 'no_speech' || r.reason === 'empty'
          ? voiceMapError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'EDITOR_VOICE_NOT_HEARD',
              'Не расслышал — повторите ближе к микрофону',
            )
          : voiceMapError(
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
