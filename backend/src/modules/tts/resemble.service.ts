/**
 * ResembleService — синтез речи через Resemble AI, второй провайдер
 * рядом с ElevenLabs (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, решён
 * §5.2 ТЗ: приоритет — неотличимость от живого голоса, не скорость).
 *
 * Протокол — по прямому чтению `docs.resemble.ai` (не вторичных
 * источников), сентябрь 2026:
 *   - синтез: `POST https://f.cluster.resemble.ai/synthesize`,
 *     `Authorization: Bearer <ключ>`, тело `{voice_uuid, data,
 *     output_format}` → JSON с `audio_content` в base64 (не сырые
 *     байты, как у ElevenLabs — разница учтена ниже);
 *   - каталог голосов: `GET https://app.resemble.ai/api/v2/voices`
 *     (ДРУГОЙ хост, чем синтез — это не опечатка).
 *
 * ## Мягкий фоллбек — тот же принцип, что у ElevenLabsService
 *
 * Ни одного `throw`: не настроено — `skipped: true` (штатное состояние
 * стенда), сломалось — `skipped: false` (повод разбираться). См.
 * доккомментарий `elevenlabs.service.ts:1-22` — здесь та же философия,
 * не повторяется дословно.
 *
 * ## Чем отличается от ElevenLabsService (важно при чтении диффа)
 *
 * - Лимит текста на запрос — 3000 символов, не 5000 (документация
 *   Resemble, не совпадает с ElevenLabs).
 * - У Resemble нет универсального голоса по умолчанию, который имело
 *   бы смысл зашивать в код (в отличие от `EXAVITQu4vr4xnSDxMaL` у
 *   ElevenLabs) — если ни бренд, ни `RESEMBLE_VOICE_ID` не задают
 *   голос, синтез — пропуск с понятной причиной, а не выдуманный ID.
 * - `project_uuid` НЕ передаётся: поле есть в API, но опционально и
 *   нужно только для организации клипов в личном кабинете Resemble —
 *   продукту сохранять клипы там незачем, аудио сразу уходит в свой
 *   Blob (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, §4.3, «Контекст»).
 * - Тайминг (`audio_timestamps.graph_chars`/`graph_times`) — приходит
 *   в ТОМ ЖЕ ответе синтеза, отдельного вызова, в отличие от
 *   ElevenLabs `/with-timestamps`, не нужно.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { mp3DurationSeconds } from '../../common/mp3-duration';
import { SubtitleAlignment } from '../../common/subtitles';
import {
  SynthesisOutcome,
  SynthesisRequest,
  TtsProvider,
  VoiceOption,
} from './tts.types';

/** Итог удаления клона у Resemble. */
export type ResembleDeleteStatus =
  | 'deleted'
  | 'not-found'
  | 'failed'
  | 'no-key';

/** Ключ `platform_settings` для голоса, ожидающего повтора удаления у Resemble. */
export const RESEMBLE_PENDING_DELETE_PREFIX = 'resemble_pending_delete:';

/** Лимит одного запроса — подтверждён `docs.resemble.ai/api-reference/text-to-speech/synthesize`. */
const MAX_CHARACTERS = 3000;

interface ResembleSynthesizeResponse {
  success?: boolean;
  audio_content?: string;
  output_format?: string;
  audio_timestamps?: {
    graph_chars?: string[];
    graph_times?: Array<[number, number]>;
  };
}

interface ResembleVoicesResponse {
  items?: Array<Record<string, unknown>>;
  // Некоторые версии API отдают под ключом `voices`, а не `items` —
  // не проверено вызовом с реальным ключом (см. находка аудита этого
  // этапа), читаем оба варианта защитно, ничего не теряя молча.
  voices?: Array<Record<string, unknown>>;
}

/** Язык реплик → локаль SSML Resemble. Только проверенные по списку
 * локалей документации; незнакомый язык — без обёртки, как раньше. */
const RESEMBLE_LOCALES: Record<string, string> = {
  uk: 'uk-ua',
  ru: 'ru-ru',
  en: 'en-us',
  de: 'de-de',
  es: 'es-es',
  fr: 'fr-fr',
  it: 'it-it',
  pl: 'pl-pl',
};

export function resembleLocale(
  language: string | null | undefined,
): string | undefined {
  const code = language?.trim().toLowerCase().split(/[-_]/)[0];
  return code ? RESEMBLE_LOCALES[code] : undefined;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function withLanguage(text: string, locale: string): string {
  return `<speak><lang xml:lang="${locale}">${escapeXml(text)}</lang></speak>`;
}

/** М-6.5 седьмого аудита: таймаут внешних HTTP-вызовов. */
const EXTERNAL_TIMEOUT_MS = 60_000;

@Injectable()
export class ResembleService implements TtsProvider {
  readonly providerKey = 'resemble';
  private readonly logger = new Logger(ResembleService.name);
  private readonly synthesizeBase = 'https://f.cluster.resemble.ai';
  private readonly manageBase = 'https://app.resemble.ai/api/v2';

  /**
   * База — только для списка ожидания удалений (`deleteVoice`).
   * Необязательна: синтез и тесты создают сервис без неё.
   */
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  private key(): string | undefined {
    return process.env.RESEMBLE_API_KEY?.trim() || undefined;
  }

  configured(): boolean {
    return !!this.key();
  }

  defaultVoice(): string | undefined {
    // Намеренно без захардкоженного ID — у Resemble нет универсального
    // голоса каталога, аналогичного дефолту ElevenLabs; выдумывать его
    // означало бы дать команду синтезировать несуществующим голосом.
    return process.env.RESEMBLE_VOICE_ID?.trim() || undefined;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisOutcome> {
    const key = this.key();
    if (!key) {
      return {
        ok: false,
        skipped: true,
        reason:
          'RESEMBLE_API_KEY не задан — озвучка на этом стенде не подключена',
      };
    }

    const text = request.text?.trim() ?? '';
    if (!text) {
      return { ok: false, skipped: true, reason: 'пустой текст озвучки' };
    }

    const voiceId = request.voiceId?.trim() || this.defaultVoice();
    if (!voiceId) {
      return {
        ok: false,
        skipped: true,
        reason:
          'голос не выбран и RESEMBLE_VOICE_ID не задан — у Resemble нет голоса по умолчанию',
      };
    }

    const locale = resembleLocale(request.language);
    // Обёртка SSML и экранирование тоже считаются в лимит.
    let payloadText = text.slice(0, MAX_CHARACTERS);
    let requestText = locale ? withLanguage(payloadText, locale) : payloadText;
    if (requestText.length > MAX_CHARACTERS) {
      payloadText = payloadText.slice(
        0,
        payloadText.length - (requestText.length - MAX_CHARACTERS),
      );
      requestText = withLanguage(payloadText, locale!);
    }
    if (payloadText.length < text.length) {
      this.logger.warn(
        `текст озвучки обрезан до ${MAX_CHARACTERS} символов (было ${text.length})`,
      );
    }

    try {
      const res = await fetch(`${this.synthesizeBase}/synthesize`, {
        method: 'POST',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        // Сознательно без project_uuid — см. доккомментарий файла.
        body: JSON.stringify({
          voice_uuid: voiceId,
          // Язык реплик — явно, SSML `<lang>` (docs.resemble.ai, SSML
          // Reference; `uk-ua` в списке локалей). Без него модель читает
          // украинский текст с просодией языка голоса — ударения не на
          // тех слогах даже в двусложных словах.
          data: requestText,
          output_format: 'mp3',
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Resemble ответил ${res.status}: ${body.slice(0, 300)}`,
        );
        return { ok: false, skipped: false, reason: `Resemble ${res.status}` };
      }

      let data: ResembleSynthesizeResponse;
      try {
        data = (await res.json()) as ResembleSynthesizeResponse;
      } catch {
        return {
          ok: false,
          skipped: false,
          reason: 'Resemble вернул не-JSON на /synthesize',
        };
      }

      if (data.success === false) {
        return {
          ok: false,
          skipped: false,
          reason: 'Resemble сообщил об ошибке синтеза (success: false)',
        };
      }
      if (!data.audio_content) {
        return {
          ok: false,
          skipped: false,
          reason: 'Resemble не вернул audio_content',
        };
      }

      const audio = Buffer.from(data.audio_content, 'base64');
      if (audio.length === 0) {
        return {
          ok: false,
          skipped: false,
          reason: 'Resemble вернул пустой файл',
        };
      }

      const alignment =
        request.timestamps === true
          ? this.parseAlignment(data.audio_timestamps)
          : undefined;

      return {
        ok: true,
        audio,
        mimeType: 'audio/mpeg',
        characters: payloadText.length,
        durationSeconds: mp3DurationSeconds(audio),
        voiceId,
        model: request.model?.trim() || 'resemble',
        alignment,
      };
    } catch (e) {
      return {
        ok: false,
        skipped: false,
        reason: `ошибка Resemble: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * `graph_chars`/`graph_times` — подтверждены доккументацией
   * (посимвольный тайминг, пара старт/конец на символ), но БЕЗ примера
   * реального ответа с числами — точный порядок пары (старт, конец, а
   * не старт, длительность) проверить при первом реальном вызове (см.
   * doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, реализация этого файла).
   * Поэтому — только защитный разбор: любое несоответствие форме
   * (нет поля, разная длина массивов, пара не из двух чисел) — тихий
   * возврат `undefined`, синтез всё равно успешен, просто без
   * субтитров у этого ролика — та же деградация, что уже принята в
   * интерфейсе для провайдеров без тайминга вообще.
   */
  private parseAlignment(
    timestamps: ResembleSynthesizeResponse['audio_timestamps'],
  ): SubtitleAlignment | undefined {
    const chars = timestamps?.graph_chars;
    const times = timestamps?.graph_times;
    if (!chars || !times || chars.length !== times.length) {
      if (timestamps) {
        this.logger.warn(
          'Resemble: audio_timestamps не в ожидаемой форме (graph_chars/graph_times) — субтитры для этого ролика будут без тайминга',
        );
      }
      return undefined;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    for (const pair of times) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        this.logger.warn(
          'Resemble: элемент graph_times не является парой [старт, конец] — субтитры для этого ролика будут без тайминга',
        );
        return undefined;
      }
      starts.push(pair[0]);
      ends.push(pair[1]);
    }
    return { characters: chars, starts, ends };
  }

  /**
   * Каталог голосов. Тот же принцип, что у ElevenLabsService.voices():
   * пустой список с пояснением — тоже ответ, не молчаливая поломка.
   * Каталог у Resemble заметно меньше, чем `/v1/shared-voices`
   * ElevenLabs (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, находка 6.5) —
   * это свойство самого Resemble, не повод для отдельной логики здесь.
   */
  async voices(): Promise<{ voices: VoiceOption[]; error?: string }> {
    const key = this.key();
    if (!key) {
      return { voices: [], error: 'RESEMBLE_API_KEY не задан' };
    }
    try {
      // 15.09.2026, по живому «Resemble 400 при запросе списка голосов»:
      // у `GET /api/v2/voices` параметр `page` ОБЯЗАТЕЛЕН (docs.resemble.ai,
      // List voices: page ≥ 1 required; page_size 10–1000, по умолчанию 10).
      // Без него — 400, и весь каталог голосов в форме бренда пустой,
      // а озвучка Resemble молча не подключается. Берём максимум за раз:
      // каталог у аккаунта небольшой, пагинация тут не нужна.
      const res = await fetch(
        `${this.manageBase}/voices?page=1&page_size=1000`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        const body =
          typeof res.text === 'function'
            ? await res.text().catch(() => '')
            : '';
        return {
          voices: [],
          error: `Resemble ${res.status} при запросе списка голосов${
            body ? `: ${body.slice(0, 200)}` : ''
          }`,
        };
      }
      const data = (await res.json()) as ResembleVoicesResponse;
      const rows = data.items ?? data.voices ?? [];
      const byId = new Map<string, VoiceOption>();
      for (const v of rows) {
        const id = String(v.uuid ?? v.id ?? v.voice_uuid ?? '');
        if (!id || byId.has(id)) continue;
        byId.set(id, {
          voiceId: id,
          name: String(v.name ?? 'Голос'),
          previewUrl: null, // Resemble не документирует превью-URL в списке — не выдумываем.
          accent: (v.language ?? v.accent ?? null) as string | null,
        });
      }
      const voices = [...byId.values()];
      return voices.length
        ? { voices }
        : {
            voices: [],
            error:
              'Resemble вернул 0 голосов — нужно наклонировать хотя бы один голос в личном кабинете',
          };
    } catch (e) {
      return {
        voices: [],
        error: `не удалось получить список голосов: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  // ── Клонирование голоса (этап 73, TODO п.32) — отдельно от TtsProvider:
  // это НЕ синтез речи, а управление каталогом голосов, и сегодня умеет
  // это только Resemble (ElevenLabs в проекте вообще не вызывает
  // /v1/voices/add — см. AI-ACTORS-NO-REFERENCE-SPEC.md §3.2), поэтому
  // методы ниже — прямые вызовы этого класса, не часть общего
  // интерфейса TtsProvider (который остаётся про синтез/каталог, не
  // про создание новых голосов). ──────────────────────────────────────

  /**
   * `POST /api/v2/voices` — запускает асинхронное обучение (доказано
   * доккументацией, doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.3): ответ
   * приходит СРАЗУ с `{uuid, status: "pending"}`, готовность — отдельным
   * вебхуком на `callbackUri` либо опросом `getVoiceStatus` (фоллбек,
   * §5.4 того же документа). `datasetUrl` — публичная ссылка на образец
   * (наш же Blob, тот же приём, что фото персонажа для Hedra).
   */
  async cloneVoice(
    name: string,
    datasetUrl: string,
    callbackUri?: string,
  ): Promise<
    { ok: true; resembleVoiceId: string } | { ok: false; reason: string }
  > {
    const key = this.key();
    if (!key) {
      return { ok: false, reason: 'RESEMBLE_API_KEY не задан' };
    }
    try {
      const res = await fetch(`${this.manageBase}/voices`, {
        method: 'POST',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          name,
          dataset_url: datasetUrl,
          ...(callbackUri ? { callback_uri: callbackUri } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Resemble POST /voices ответил ${res.status}: ${body.slice(0, 300)}`,
        );
        return { ok: false, reason: `Resemble ${res.status}` };
      }
      // Защитный разбор — тот же принцип, что у voices() выше: точный
      // конверт ответа не проверен реальным вызовом (нет ключа в
      // песочнице), читаем несколько вероятных форм, не падаем на
      // неожиданной.
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const item = (data.item ?? data) as Record<string, unknown>;
      const uuid = String(item.uuid ?? item.id ?? '');
      if (!uuid) {
        return {
          ok: false,
          reason: 'Resemble не вернул uuid нового голоса',
        };
      }
      return { ok: true, resembleVoiceId: uuid };
    } catch (e) {
      return {
        ok: false,
        reason: `ошибка Resemble: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Poll-фоллбек готовности (§5.4 TTS-спека) — для стендов без
   * публичного HTTPS-эндпоинта под вебхук Resemble. Молчаливый
   * `undefined` на любую нештатную форму ответа — вызывающий код просто
   * оставляет голос в TRAINING до следующей попытки, не падает.
   */
  async getVoiceStatus(
    resembleVoiceId: string,
  ): Promise<{ status: string } | undefined> {
    const key = this.key();
    if (!key) return undefined;
    try {
      const res = await fetch(
        `${this.manageBase}/voices/${encodeURIComponent(resembleVoiceId)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        },
      );
      if (!res.ok) return undefined;
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const item = (data.item ?? data) as Record<string, unknown>;
      const status = item.status;
      return typeof status === 'string' ? { status } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Удаление клона у Resemble при удалении `UserVoice` (и персоны).
   * Не бросает: локальная запись удаляется независимо от ответа Resemble
   * (тот же принцип деградации, что у `BlobService.deleteBlob`).
   *
   * Но и не молчит (волна исправлений «Я в кадре», CONTRACT5 п.15):
   * возвращает итог, а неудачу (`failed`, `no-key`) записывает в список
   * ожидания — строка `platform_settings` с ключом
   * `RESEMBLE_PENDING_DELETE_PREFIX + id` (своя строка на голос: без
   * гонок за общий список и без новой таблицы). Крон хранения персон
   * повторяет их (`retryPendingDeletes`). Согласие обещает удаление
   * голоса — «ответили 500, забыли» это обещание нарушало бы молча.
   * 404 у Resemble — голоса там уже нет, это успех (`not-found`).
   */
  async deleteVoice(resembleVoiceId: string): Promise<ResembleDeleteStatus> {
    const status = await this.deleteRemote(resembleVoiceId);
    if (status === 'deleted' || status === 'not-found') {
      await this.forgetPendingDelete(resembleVoiceId);
    } else {
      await this.rememberPendingDelete(resembleVoiceId);
    }
    return status;
  }

  /** Повтор удалений из списка ожидания; не бросает на отдельном голосе. */
  async retryPendingDeletes(
    limit = 50,
  ): Promise<{ retried: number; deleted: number; stillFailing: number }> {
    if (!this.prisma) return { retried: 0, deleted: 0, stillFailing: 0 };
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { startsWith: RESEMBLE_PENDING_DELETE_PREFIX } },
      select: { key: true },
      orderBy: { key: 'asc' },
      take: limit,
    });
    let deleted = 0;
    for (const r of rows) {
      const id = r.key.slice(RESEMBLE_PENDING_DELETE_PREFIX.length);
      const s = await this.deleteVoice(id);
      if (s === 'deleted' || s === 'not-found') deleted++;
    }
    return {
      retried: rows.length,
      deleted,
      stillFailing: rows.length - deleted,
    };
  }

  private async deleteRemote(
    resembleVoiceId: string,
  ): Promise<ResembleDeleteStatus> {
    const key = this.key();
    if (!key) {
      this.logger.warn(
        `RESEMBLE_API_KEY не задан — голос ${resembleVoiceId} у Resemble не удалён, поставлен в повтор`,
      );
      return 'no-key';
    }
    try {
      const res = await fetch(
        `${this.manageBase}/voices/${encodeURIComponent(resembleVoiceId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        },
      );
      if (res.ok) return 'deleted';
      if (res.status === 404) return 'not-found';
      this.logger.warn(
        `Resemble DELETE /voices/${resembleVoiceId} ответил ${res.status} — запись в нашей БД всё равно удаляется, удаление у Resemble — в повтор`,
      );
      return 'failed';
    } catch (e) {
      this.logger.warn(
        `не удалось удалить голос ${resembleVoiceId} на стороне Resemble: ${
          e instanceof Error ? e.message : String(e)
        } — запись в нашей БД всё равно удаляется, удаление у Resemble — в повтор`,
      );
      return 'failed';
    }
  }

  private async rememberPendingDelete(resembleVoiceId: string): Promise<void> {
    if (!this.prisma) return;
    const key = RESEMBLE_PENDING_DELETE_PREFIX + resembleVoiceId;
    try {
      await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, value: new Date().toISOString() },
        update: {},
      });
    } catch (e) {
      this.logger.warn(
        `голос ${resembleVoiceId} не записан в повтор удаления: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async forgetPendingDelete(resembleVoiceId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.platformSetting.deleteMany({
        where: { key: RESEMBLE_PENDING_DELETE_PREFIX + resembleVoiceId },
      });
    } catch {
      // Строка останется — следующий повтор получит 404 и уберёт её.
    }
  }
}
