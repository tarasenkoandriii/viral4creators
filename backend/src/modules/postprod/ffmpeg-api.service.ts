/**
 * FfmpegApiService — тонкий клиент хостед-ffmpeg (ТЗ §16.1, этап 34).
 *
 * У Vercel Functions нет ffmpeg и не может быть: это не про лимит, а про
 * то, что рендер видео — не задача для функции с потолком в 300 секунд.
 * Поднимать свой воркер ради одной операции (обрезать кадр) дороже, чем
 * отдать её сервису, который только это и делает.
 *
 * Подход и форма запроса взяты из рабочего кода соседнего проекта
 * владельца (`vgffmpeg.service.ts` в atm-travel): один POST с картой
 * входных URL, списком команд и списком имён выходных файлов; сервис сам
 * скачивает входы, подставляет их вместо `{{ключ}}` и отдаёт ссылки на
 * результат. Здесь тот же протокол, но без манифеста клипов: команду
 * собирает `common/reframe.ts`.
 *
 * Что перенесено дословно, потому что проверено на живом API:
 *  - ответы завёрнуты в `data` — и у submit, и у status;
 *  - готовая задача приходит со статусом `succeeded`, а не `completed`;
 *  - `error_message` — пустая строка, а не null, когда ошибки нет;
 *  - повтор при 429 и 5xx с ростом паузы, при 4xx — сразу наружу.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface FfmpegJobRef {
  jobId: string;
  status: string;
}

export interface FfmpegJobStatus {
  /** Наш словарь: pending | completed | failed. */
  status: 'pending' | 'completed' | 'failed';
  /** Имя файла → ссылка на скачивание; есть только у завершённой задачи. */
  outputs?: Record<string, string>;
  error?: string;
}

const SUCCESS = new Set([
  'succeeded',
  'completed',
  'success',
  'done',
  'finished',
]);
const FAILURE = new Set([
  'failed',
  'error',
  'errored',
  'cancelled',
  'canceled',
]);

@Injectable()
export class FfmpegApiService {
  private readonly logger = new Logger(FfmpegApiService.name);

  private base(): string {
    return (
      process.env.FFMPEG_API_BASE_URL?.replace(/\/+$/, '') ||
      'https://verygoodffmpeg.com/api'
    );
  }

  private key(): string | undefined {
    const raw = process.env.FFMPEG_API_KEY?.trim();
    return raw || undefined;
  }

  /**
   * Настроен ли сервис. Не настроен — не ошибка: продукт продолжает
   * работать, просто ролик остаётся в родном формате Veo, а
   * `reframePending` честно висит флагом, как и до этого этапа.
   */
  configured(): boolean {
    return !!this.key();
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        const status = (e as { status?: number }).status;
        // 4xx — это наша ошибка в запросе, повтор её не исправит.
        const transient = !status || status === 429 || status >= 500;
        this.logger.warn(
          `${label}: попытка ${attempt}/3 не удалась — ${
            e instanceof Error ? e.message : String(e)
          }${transient ? ', повторяем' : ', повтор не поможет'}`,
        );
        if (!transient || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw last;
  }

  private async call(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base()}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      const err = Object.assign(
        new Error(`ffmpeg api ${res.status}: ${text.slice(0, 400)}`),
        { status: res.status },
      );
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // Ответы завёрнуты в `data`; разворачиваем в одном месте, чтобы
      // остальной код не помнил про конверт.
      return (parsed.data as Record<string, unknown>) ?? parsed;
    } catch {
      throw new Error(`ffmpeg api вернул не-JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Отправить задачу. `idempotencyKey` считается из содержимого и уходит
   * заголовком `Idempotency-Key` — по документации протокола это ДОЛЖНО
   * значить, что повтор того же запроса не создаёт вторую задачу и
   * второй счёт. В отличие от списка выше (`data`-обёртка, `succeeded`,
   * `error_message`), это поведение НЕ проверено на живом API (аудит
   * 2026-09-09, Д-4) — считать защитой-по-умолчанию, а не гарантией.
   * Вызывающий код, для которого повторная отправка была бы дорогой
   * ошибкой (двойное списание), обязан САМ не допускать двух вызовов
   * `submit()` для одной и той же задачи — так, как это делает
   * `ActorsService.advanceSubtitleBurn` (замок сессии + свежее чтение из
   * БД под замком непосредственно перед вызовом), а не полагаться на то,
   * что этот заголовок где-то на стороне провайдера спасёт от дубля.
   */
  async submit(opts: {
    inputs: Record<string, string>;
    outputs: string[];
    commands: string[];
  }): Promise<FfmpegJobRef> {
    const key = this.key();
    if (!key) throw new Error('FFMPEG_API_KEY не задан');

    const body = {
      input_files: opts.inputs,
      output_files: opts.outputs,
      ffmpeg_commands: opts.commands,
    };
    const idempotencyKey = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');

    const data = await this.withRetry(
      () =>
        this.call('/ffmpeg', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        }),
      'ffmpeg submit',
    );

    const jobId = (data.id ?? data.jobId ?? data.job_id) as string | undefined;
    if (!jobId) {
      throw new Error(
        'ответ ffmpeg-сервиса не содержит id задачи — см. лог для формата ответа',
      );
    }
    return { jobId, status: String(data.status ?? 'queued') };
  }

  async status(jobId: string): Promise<FfmpegJobStatus> {
    const key = this.key();
    if (!key) throw new Error('FFMPEG_API_KEY не задан');

    const data = await this.withRetry(
      () =>
        this.call(`/jobs/${encodeURIComponent(jobId)}`, {
          headers: { Authorization: `Bearer ${key}` },
        }),
      'ffmpeg status',
    );

    const raw = String(data.status ?? '');
    const status = SUCCESS.has(raw)
      ? 'completed'
      : FAILURE.has(raw)
        ? 'failed'
        : 'pending';

    const files = data.output_files as Record<string, string> | undefined;
    const outputs = files && Object.keys(files).length > 0 ? files : undefined;

    // `error_message` приходит пустой строкой, а не null, когда ошибки
    // нет — сравнение с undefined тут дало бы ложное «ошибка есть».
    const message = (data.error_message ?? data.error) as string | undefined;

    return { status, outputs, error: message ? message : undefined };
  }
}
