/**
 * VeoPassthroughService — третий пункт селектора «Озвучка по умолчанию»
 * в админке (рядом с `elevenlabs`/`resemble`), не третий провайдер
 * синтеза в смысле §4.1 doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md.
 *
 * Ничего не синтезирует и не может быть «сломан» — у него нет ни
 * ключа, ни аккаунта, ни баланса, который может закончиться. Он
 * реализует `TtsProvider` формальности ради (тот же интерфейс, что и
 * настоящие провайдеры — `default-tts-provider.service.ts` роутит на
 * него точно так же, без разбора случаев), а по существу — всегда
 * возвращает «не настроено» (`skipped: true`), и `postprod.service.ts`
 * (`synthesize()`, решение 2 в шапке файла) на это уже умеет: озвучка
 * молча не случается, ролик уходит со звуком, который синтезировала
 * сама Veo при рендере.
 *
 * Зачем отдельный класс, а не просто «третий вариант, для которого
 * ничего не вызывается»: витрина настроек (`admin-panel`) показывает
 * состояние по единому контракту `TtsProvider.configured()` для всех
 * трёх пунктов селектора — если бы `veo` не был `TtsProvider`, витрине
 * пришлось бы отдельно знать про этот частный случай.
 */
import { Injectable } from '@nestjs/common';
import {
  SynthesisOutcome,
  SynthesisRequest,
  TtsProvider,
  VoiceOption,
} from './tts.types';

export const VEO_PASSTHROUGH_SKIP_REASON =
  'Озвучка отключена администратором — используется голос модели';

@Injectable()
export class VeoPassthroughService implements TtsProvider {
  readonly providerKey = 'veo';

  /**
   * Всегда `false` — не в смысле «сломан», а в смысле «нечего
   * настраивать»: сверка `admin-panel`'ом уровня «требует внимания»
   * не должна применяться к пункту, у которого по определению нет ни
   * ключа, ни баланса.
   */
  configured(): boolean {
    return false;
  }

  async synthesize(_request: SynthesisRequest): Promise<SynthesisOutcome> {
    return { ok: false, skipped: true, reason: VEO_PASSTHROUGH_SKIP_REASON };
  }

  async voices(): Promise<{ voices: VoiceOption[]; error?: string }> {
    return {
      voices: [],
      // Найдено при аудите (полный аудит озвучки, по прямому запросу):
      // текст был Veo-специфичным («Голос Veo не выбирается…»), хотя
      // этот класс отвечает за ЛЮБОЙ провайдер с собственным нативным
      // голосом — с появлением Grok (§10–11 ТЗ) формулировка стала
      // неточной для сессий, сгенерированных через Grok. Само поведение
      // класса уже было провайдер-нейтральным (`configured()`/
      // `synthesize()` не смотрят на `provider` вовсе) — правился
      // только текст.
      error:
        'Голос модели не выбирается из каталога — она озвучивает реплики сама',
    };
  }
}
