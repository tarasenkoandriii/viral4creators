import { SonioxObservability } from '../../soniox-observability/soniox-observability.service';
/**
 * Распознавание вопроса посетителя — Soniox async (Э5, ТЗ помощника §4.10,
 * §5-бис.7; приёмка Э5: «запись удаляется у нас и у провайдера при успехе,
 * отказе и таймауте — тот же шов, что у `soniox-stt.client.ts`»).
 *
 * Механика — генератора (`backend/src/modules/voice/soniox-stt.client.ts`):
 * чистая часть (тело транскрипции, разбор токенов, язык, секунды счёта) —
 * копия `shared/soniox-stt-core.ts` через `scripts/sync-sites-shared.mjs`;
 * здесь — сеть, сроки и уборка. Отличия от генератора:
 *  - срок попытки короче (VOICE_DEFAULTS.sttAttemptDeadlineMs — посетитель
 *    ждёт с индикатором, запись ≤ 30 с), второй попытки и запасного пути
 *    через Gemini нет (§4.10: только Soniox; недоступен — «напишите
 *    текстом»);
 *  - в лог не идёт НИЧЕГО от провайдера, кроме кода ответа: текст ошибки
 *    Soniox может цитировать запрос (§6.6, приёмка Э2 п.6 «нет ПДн в логах»);
 *  - `fetch` и часы — полями: тесты подают провайдера-мок без сети.
 *
 * ## Уборка у провайдера — обещание Условий п.3.4 (и DPA для посетителей)
 *
 * Soniox хранит загруженный файл и транскрипт, пока их не удалят. `DELETE`
 * файла и транскрипции стоят в `finally` — при успехе, ошибке и таймауте.
 * Порядок — СНАЧАЛА ФАЙЛ (звук уходит при любом исходе), затем
 * транскрипция; на `409` (ещё обрабатывается) — короткое ожидание и повтор.
 *
 * Своего срока хранения у Soniox НЕТ (документация async-API, сверено
 * 2026-10-07: «Files are not deleted automatically»; лимит — 2000
 * транскрипций на аккаунт). То, что не удалилось сразу (409 после
 * ожидания, сеть, 5xx, функция умерла до `finally`), убирает
 * `sweepStaleSoniox` в суточном кроне `assist-retention`: он берёт у
 * Soniox список файлов и транскрипций и удаляет СВОИ (метка `v4c-sites`
 * в `client_reference_id` и имени файла) старше часа — ключ может быть
 * общим с другими продуктами (C4 захода 8, ТЗ поздравлений 2.0 стр. 1622). Очередь id в базе здесь не годится:
 * публичный путь работает под ролью `assist_public`, у которой на
 * `assist_platform_settings` только SELECT, а список у провайдера ловит
 * и то, что очередь не увидела бы вовсе.
 * Звук у НАС — только `Buffer` в памяти запроса: в базу, Blob и логи он не
 * попадает (шов — спек «запись не хранится у нас»).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SONIOX_API_BASE, sonioxApiKey } from '../../../shared/soniox';
import {
  billedSeconds,
  sonioxTranscriptText,
  sonioxSpeechConfidence,
  sonioxTranscriptionBody,
  type SonioxToken,
} from '../../../shared/soniox-stt-core';
import {
  SONIOX_TAG_SITES,
  sonioxFileName,
  sonioxReferenceId,
  sweepOwnStaleSoniox,
  type SonioxSweepResult,
} from '../../../shared/soniox-sweep';
import { VOICE_DEFAULTS } from '../voice-config';
import {
  lowConfidenceTerms,
  type LowConfTerm,
  type SonioxConfToken,
} from './stt-low-conf';

export interface SiteSttRequest {
  audio: Buffer;
  mimeType: string;
  /** Языки сайта по порядку (персона): подсказка, не ограничение. */
  languageHints: readonly string[];
  /**
   * `context.terms` — имена и фразы опубликованных мемо и карты сайта
   * (`stt-terms.ts`; отбор и потолки — `assist-ui-core/stt-terms.ts`).
   * Только в тело запроса провайдеру — не в лог.
   */
  terms?: readonly string[];
}

export interface SiteSttResult {
  text: string | null;
  /** Машинная причина без текста провайдера: no_key | empty | no_speech | error | timeout. */
  reason?: 'no_key' | 'empty' | 'no_speech' | 'error' | 'timeout';
  /** Безопасный код без тела ответа провайдера. */
  reasonCode?: string;
  /** Язык речи по Soniox (преобладающий); null — не сообщил. */
  language: string | null;
  speechConfidence?: number;
  /** Секунды для счёта (по длительности Soniox, иначе по токенам). */
  seconds: number;
  /** Задача у Soniox создана — вызов оплачен, даже без текста. */
  billable: boolean;
  /**
   * №113 (заход 11): неуверенно распознанные слова — кандидаты в словарь
   * терминов (`stt-low-conf.ts`); только при тексте. В лог — не идут.
   */
  lowConf?: LowConfTerm[];
}

const REQUEST_TIMEOUT_MS = 8_000;
const POLL_DELAY_MS = 500;
const CLEANUP_GRACE_MS = 6_000;

interface TranscriptionStatus {
  status: string;
  audio_duration_ms?: number;
}

class SonioxHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`Soniox ${path}: ${status}`);
    this.name = 'SonioxHttpError';
  }
}

@Injectable()
export class SiteSonioxStt {
  private readonly logger = new Logger(SiteSonioxStt.name);
  constructor(@Optional() private readonly telemetry?: SonioxObservability) {}
  /** Тесты подменяют сеть, env и сроки. */
  fetch: typeof fetch = (...a) => fetch(...a);
  env: NodeJS.ProcessEnv = process.env;
  attemptDeadlineMs: number = VOICE_DEFAULTS.sttAttemptDeadlineMs;
  pollDelayMs = POLL_DELAY_MS;
  cleanupGraceMs = CLEANUP_GRACE_MS;

  configured(): boolean {
    return !!sonioxApiKey(this.env);
  }

  /** Никогда не бросает: отказ провайдера — `text: null` с причиной. */
  async transcribe(req: SiteSttRequest): Promise<SiteSttResult> {
    return this.telemetry
      ? this.telemetry.track('stt', 'system', () => this.transcribeImpl(req))
      : this.transcribeImpl(req);
  }
  private async transcribeImpl(req: SiteSttRequest): Promise<SiteSttResult> {
    const key = sonioxApiKey(this.env);
    if (!key) {
      return {
        text: null,
        reason: 'no_key',
        language: null,
        seconds: 0,
        billable: false,
      };
    }
    if (req.audio.length === 0) {
      return {
        text: null,
        reason: 'empty',
        language: null,
        seconds: 0,
        billable: false,
      };
    }
    const deadline = Date.now() + this.attemptDeadlineMs;
    let fileId: string | null = null;
    let transcriptionId: string | null = null;
    let audioMs: number | null = null;
    const fail = (reason: SiteSttResult['reason']): SiteSttResult => ({
      text: null,
      reason,
      language: null,
      seconds: billedSeconds(audioMs, 0),
      billable: transcriptionId !== null,
    });
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(req.audio)], { type: req.mimeType }),
        // Метка сайтов: уборка по списку удаляет только своё.
        sonioxFileName(SONIOX_TAG_SITES),
      );
      form.append('client_reference_id', sonioxReferenceId(SONIOX_TAG_SITES));
      const uploaded = await this.call<{ id: string }>(
        key,
        '/files',
        deadline,
        {
          method: 'POST',
          body: form,
        },
      );
      fileId = uploaded.id;
      const created = await this.call<{ id: string }>(
        key,
        '/transcriptions',
        deadline,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...sonioxTranscriptionBody(fileId, {
              languageHints: req.languageHints,
              terms: req.terms ?? [],
            }),
            client_reference_id: sonioxReferenceId(SONIOX_TAG_SITES),
          }),
        },
      );
      transcriptionId = created.id;
      while (Date.now() < deadline) {
        await this.sleep(this.pollDelayMs);
        const st = await this.call<TranscriptionStatus>(
          key,
          `/transcriptions/${transcriptionId}`,
          deadline,
        );
        if (typeof st.audio_duration_ms === 'number')
          audioMs = st.audio_duration_ms;
        if (st.status === 'completed') {
          const t = await this.call<{ text?: string; tokens?: SonioxToken[] }>(
            key,
            `/transcriptions/${transcriptionId}/transcript`,
            deadline,
          );
          const parsed = sonioxTranscriptText(t);
          const seconds = billedSeconds(audioMs, parsed.seconds);
          return parsed.text
            ? {
                text: parsed.text,
                ...(sonioxSpeechConfidence(t.tokens ?? []) !== null
                  ? {
                      speechConfidence: sonioxSpeechConfidence(t.tokens ?? [])!,
                    }
                  : {}),
                language: parsed.language,
                seconds,
                billable: true,
                lowConf: lowConfidenceTerms(
                  t.tokens as SonioxConfToken[] | undefined,
                ),
              }
            : { ...fail('no_speech'), seconds };
        }
        if (st.status === 'error') return fail('error');
      }
      return fail('timeout');
    } catch (e) {
      const timeout =
        e !== null &&
        typeof e === 'object' &&
        'name' in e &&
        ['TimeoutError', 'AbortError'].includes(String(e.name));
      this.logger.warn(
        `распознавание Soniox не удалось: ${e instanceof SonioxHttpError ? `${e.path.replace(/^(\/(?:files|transcriptions))\/[^/]+/, '$1/:id')} ${e.status}` : timeout ? 'таймаут' : errName(e)}`,
      );
      return {
        ...fail(timeout ? 'timeout' : 'error'),
        ...(e instanceof SonioxHttpError
          ? { reasonCode: `http-${e.status}` }
          : {}),
      };
    } finally {
      // Обещание Условий (3.4) и DPA: запись не остаётся у провайдера.
      await this.cleanup(key, transcriptionId, fileId);
    }
  }

  /** Сначала файл (звук), затем транскрипция; 409 — подождать и повторить. */
  private async cleanup(
    key: string,
    transcriptionId: string | null,
    fileId: string | null,
  ): Promise<void> {
    if (fileId) await this.remove(key, `/files/${fileId}`);
    if (!transcriptionId) return;
    const graceUntil = Date.now() + this.cleanupGraceMs;
    for (;;) {
      const status = await this.remove(
        key,
        `/transcriptions/${transcriptionId}`,
      );
      if (status !== 409) return;
      if (Date.now() >= graceUntil) {
        this.logger.warn(
          'Soniox: транскрипция ещё обрабатывается и не удалена — звук удалён, текст задачи уберёт крон assist-retention (sweepStaleSoniox)',
        );
        return;
      }
      await this.sleep(this.pollDelayMs);
    }
  }

  /** DELETE; отдаёт код ответа (0 — сеть). Не бросает. */
  private async remove(key: string, path: string): Promise<number> {
    try {
      const res = await this.fetch(`${SONIOX_API_BASE}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        this.logger.warn(`Soniox: уборка вернула ${res.status}`);
      }
      return res.status;
    } catch (e) {
      this.logger.warn(`Soniox: уборка не удалась: ${errName(e)}`);
      return 0;
    }
  }

  private async call<T>(
    key: string,
    path: string,
    deadline: number,
    init: RequestInit = {},
  ): Promise<T> {
    const left = Math.max(
      1,
      Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()),
    );
    const res = await this.fetch(`${SONIOX_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(left),
    });
    if (!res.ok) throw new SonioxHttpError(path, res.status);
    return (await res.json()) as T;
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}

// ── Уборка оставшегося у Soniox (C4 захода 8) ────────────────────────────

/**
 * Своё у Soniox старше часа — по списку провайдера и метке сайтов
 * (`shared/soniox-sweep.ts`); чужое при общем ключе не трогается. Зовёт
 * крон `assist-retention`. Не бросает; в лог — только числа.
 */
export function sweepStaleSoniox(
  deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: Date } = {},
): Promise<SonioxSweepResult> {
  return sweepOwnStaleSoniox({
    tag: SONIOX_TAG_SITES,
    key: sonioxApiKey(deps.env ?? process.env),
    fetch: deps.fetch,
    now: deps.now,
    logger: new Logger('SonioxSweep'),
  });
}

/** Имя класса ошибки без текста (§6.6). */
function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
