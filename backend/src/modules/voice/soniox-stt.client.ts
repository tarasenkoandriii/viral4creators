/**
 * SonioxSttClient — короткая запись → текст через асинхронный API Soniox.
 * Вариант распознавания рядом с Gemini, выбирается в админке
 * (`common/speech-recognition-provider.ts`).
 *
 * ## Почему асинхронный, а не потоковый
 *
 * Голосовой ввод продукта — запись целиком: «удерживать и говорить» в
 * мастере поздравления и диктовка описания товара. Потоковый режим
 * нужен, когда текст должен появляться, пока человек говорит; здесь
 * запись уже лежит в Blob, и асинхронная модель дешевле ($0.10 против
 * $0.12 за час) и точнее на коротком файле целиком.
 *
 * ## Уборка у провайдера — не улучшение, а обещание Условий
 *
 * Soniox хранит загруженный файл и транскрипт, пока их не удалят. Условия
 * (пункт 3.4, редакция 2026-09-29) обещают, что запись голосового ввода
 * удаляется у ИИ-провайдера сразу после расшифровки. Поэтому `DELETE`
 * транскрипции и файла стоят в `finally` — при успехе, ошибке и
 * таймауте. Уборка best-effort: её отказ пишется в лог, но результат
 * пользователя не теряется. Незавершённую задачу Soniox удалить может
 * не дать — тогда сработает его собственный срок хранения; так же
 * записано у Devil's Advocate. Шов `check-docs.mjs` «голос не остаётся у
 * провайдера» требует обе строки `DELETE` в этом файле.
 *
 * ## Что берём у Soniox такого, чего нет у Gemini
 *
 * - `language_hints` — параметром, а не строкой инструкции;
 * - `language_hints_strict` — на повторе после ответа латиницей;
 * - `context.terms` — имена получателя и отправителя. Devil's Advocate
 *   этого не делал вовсе; строка «Имена» §4А.3 ТЗ Greeting 2.0 наконец
 *   получает механизм провайдера, а не просьбу в тексте.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SONIOX_API_BASE, sonioxApiKey } from '../../common/soniox';
import {
  billedSeconds,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
  type SonioxSttRequest,
  type SonioxToken,
} from '../../common/soniox-stt-core';

// Чистая часть (тело запроса, разбор, язык, секунды) — common/soniox-stt-core.ts
// (её копирует sites-backend); здесь — сеть, сроки и уборка у провайдера.
export {
  billedSeconds,
  dominantSonioxLanguage,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
} from '../../common/soniox-stt-core';
export type { SonioxSttRequest } from '../../common/soniox-stt-core';

export interface SonioxSttResult {
  text: string | null;
  reason?: string;
  /** Длительность записи для счёта — см. `billedSeconds`. */
  seconds: number;
  /**
   * Задача у Soniox была создана — значит, вызов оплачен, даже если
   * текста нет (тишина, ошибка, истёкший срок). По этому признаку, а не
   * по наличию текста, пишется расход.
   */
  billable?: boolean;
  /**
   * Язык, на котором ГОВОРИЛИ, — определён Soniox по звуку, по фрагментам
   * (`enable_language_identification`), наружу — преобладающий. `null` —
   * провайдер языка не сообщил. Запрос владельца 29.09.2026: помощник
   * узнаёт язык человека из его речи, а не из настроек.
   */
  language?: string | null;
  /**
   * Длительность звука по данным самого Soniox, мс (`audio_duration_ms`);
   * `null` — обработка до неё не дошла. По ней мастер поздравления
   * отвергает запись длиннее минуты (финальный аудит ветки K).
   */
  audioMs?: number | null;
}

/**
 * Срок одной попытки целиком: загрузка, задача, опрос, текст. Короткая
 * реплика распознаётся за секунды; 20 секунд с запасом покрывают и
 * минутную диктовку, и оставляют место второй попытке мастера
 * поздравления и запасному пути через Gemini внутри одного вызова
 * функции и клиентского таймаута в 120 секунд.
 */
const ATTEMPT_DEADLINE_MS = 20_000;
/** Потолок одного запроса; внутри срока попытки — меньшее из двух. */
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_DELAY_MS = 1_000;
/** Сколько ждать конца обработки, чтобы удалить транскрипцию после 409. */
const CLEANUP_GRACE_MS = 6_000;

interface SonioxTranscriptionStatus {
  status: string;
  error_message?: string;
  /** Длительность звука, мс; есть, когда обработка началась. */
  audio_duration_ms?: number;
}

@Injectable()
export class SonioxSttClient {
  private readonly logger = new Logger(SonioxSttClient.name);
  /** Сроки — полями, чтобы тесты проверяли ветки срока без реального ожидания. */
  attemptDeadlineMs = ATTEMPT_DEADLINE_MS;
  cleanupGraceMs = CLEANUP_GRACE_MS;

  configured(): boolean {
    return !!sonioxApiKey();
  }

  /**
   * Никогда не бросает — тот же контракт, что у расшифровки через Gemini.
   *
   * ## Бюджет времени (сквозной аудит голоса 29.09.2026)
   *
   * Первая редакция опрашивала 20 раз по секунде, и КАЖДЫЙ запрос мог
   * ждать ответа 15 секунд: худший случай одной попытки — больше пяти
   * минут, а реплика мастера поздравления делает до двух попыток. Теперь
   * у попытки один общий срок (`ATTEMPT_DEADLINE_MS`), и каждый запрос
   * получает не больше, чем от него осталось.
   */
  async transcribe(req: SonioxSttRequest): Promise<SonioxSttResult> {
    const key = sonioxApiKey();
    if (!key)
      return { text: null, reason: 'SONIOX_API_KEY not set', seconds: 0 };
    if (req.audio.length === 0)
      return { text: null, reason: 'empty audio', seconds: 0 };

    const deadline = Date.now() + this.attemptDeadlineMs;
    let fileId: string | null = null;
    let transcriptionId: string | null = null;
    // Длительность звука по данным самого Soniox — по ней он и выставляет
    // счёт. Появляется, когда обработка началась.
    let audioMs: number | null = null;
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(req.audio)], { type: req.mimeType }),
        'voice',
      );
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
          body: JSON.stringify(sonioxTranscriptionBody(fileId, req)),
        },
      );
      transcriptionId = created.id;

      const pollDelayMs = process.env.NODE_ENV === 'test' ? 0 : POLL_DELAY_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollDelayMs));
        const status = await this.call<SonioxTranscriptionStatus>(
          key,
          `/transcriptions/${transcriptionId}`,
          deadline,
        );
        if (typeof status.audio_duration_ms === 'number') {
          audioMs = status.audio_duration_ms;
        }
        if (status.status === 'completed') {
          const transcript = await this.call<{
            text?: string;
            tokens?: SonioxToken[];
          }>(key, `/transcriptions/${transcriptionId}/transcript`, deadline);
          const parsed = sonioxTranscriptText(transcript);
          const seconds = billedSeconds(audioMs, parsed.seconds);
          return parsed.text
            ? {
                text: parsed.text,
                seconds,
                language: parsed.language,
                billable: true,
                ...(audioMs !== null ? { audioMs } : {}),
              }
            : {
                text: null,
                reason: 'no speech recognised',
                seconds,
                billable: true,
                ...(audioMs !== null ? { audioMs } : {}),
              };
        }
        if (status.status === 'error') {
          return {
            text: null,
            reason: `Soniox: ${status.error_message ?? 'ошибка распознавания'}`,
            seconds: billedSeconds(audioMs, 0),
            billable: true,
            ...(audioMs !== null ? { audioMs } : {}),
          };
        }
      }
      return {
        text: null,
        reason: 'Soniox: распознавание не уложилось во время',
        seconds: billedSeconds(audioMs, 0),
        billable: true,
        ...(audioMs !== null ? { audioMs } : {}),
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(`распознавание Soniox не удалось: ${reason}`);
      return {
        text: null,
        reason,
        seconds: billedSeconds(audioMs, 0),
        billable: transcriptionId !== null,
        ...(audioMs !== null ? { audioMs } : {}),
      };
    } finally {
      // Обещание Условий (3.4): запись не остаётся у провайдера.
      await this.cleanup(key, transcriptionId, fileId);
    }
  }

  /**
   * Уборка у Soniox — по его документации, а не наугад (сверено
   * 29.09.2026):
   *
   * - транскрипцию, которая ещё обрабатывается, удалить нельзя — `409`;
   * - файл удалить можно, и задача, которая до него ещё не добралась,
   *   падает с `file_not_found`.
   *
   * Поэтому порядок — СНАЧАЛА ФАЙЛ: аудиозапись, о которой и говорит
   * обещание Условий, уходит от провайдера при любом исходе, включая
   * истёкший срок попытки. Затем транскрипция; на `409` — короткое
   * ожидание конца обработки и ещё одна попытка. Не вышло и после неё —
   * у провайдера остаётся текст задачи (не звук) до его собственного
   * срока хранения, и это пишется в лог с идентификатором.
   */
  private async cleanup(
    key: string,
    transcriptionId: string | null,
    fileId: string | null,
  ): Promise<void> {
    if (fileId) {
      await this.remove(key, `/files/${fileId}`);
    }
    if (!transcriptionId) return;
    const graceUntil = Date.now() + this.cleanupGraceMs;
    const waitMs = process.env.NODE_ENV === 'test' ? 0 : POLL_DELAY_MS;
    for (;;) {
      const status = await this.remove(
        key,
        `/transcriptions/${transcriptionId}`,
      );
      if (status !== 409) return;
      if (Date.now() >= graceUntil) {
        this.logger.warn(
          `Soniox: транскрипция ${transcriptionId} ещё обрабатывается и не удалена — звук удалён, текст задачи останется до срока хранения провайдера`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /** DELETE; отдаёт код ответа (0 — сеть). Ошибки не бросает. */
  private async remove(key: string, path: string): Promise<number> {
    try {
      const res = await fetch(`${SONIOX_API_BASE}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        this.logger.warn(`Soniox: уборка ${path} вернула ${res.status}`);
      }
      return res.status;
    } catch (e) {
      this.logger.warn(
        `Soniox: уборка ${path} не удалась: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
  }

  private async call<T>(
    key: string,
    path: string,
    deadline: number,
    init: RequestInit = {},
  ): Promise<T> {
    // Не дольше, чем осталось от срока попытки, и не дольше потолка запроса.
    const left = Math.max(
      1,
      Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()),
    );
    const res = await fetch(`${SONIOX_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(left),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Soniox ${path}: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}
