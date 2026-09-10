/**
 * HedraClientService — тонкий HTTP-клиент Hedra Character-3
 * (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §3.2, шаги 3-4; §2 — сравнение;
 * «Аудит этого ТЗ», находка 1 — эндпоинт выверен прямым чтением двух
 * страниц официальной документации, не по пересказу).
 *
 * По форме — тот же приём, что `FfmpegApiService` (submit/status,
 * `withRetry` с повтором на 429/5xx и мгновенным отказом на 4xx): тут
 * тот же класс внешнего API — «отправь задачу, потом опрашивай статус».
 * Отличия от ffmpeg-клиента:
 *  - ответ НЕ завёрнут в `data` (Hedra отдаёт плоский JSON);
 *  - создание задачи — `202`, а не `200`;
 *  - точное имя поля с id задачи в ответе `202` не подтверждено
 *    прямым вызовом (ключа для реального теста на момент написания
 *    нет, см. §5.5 документа) — читаем защитно (`id`/`job_id`), тем же
 *    приёмом, что уже применён в `ffmpeg-api.service.ts` для похожей
 *    неопределённости.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface HedraSubmitOptions {
  prompt: string;
  /** Публичный URL портрета (BrandCharacterSnapshot.photoUrl) — `start_image` в терминах Hedra. */
  startImage: string;
  /** Публичный URL синтезированной Resemble озвучки. */
  audioUrl: string;
  aspectRatio: string;
  resolution: '540p' | '720p' | '1080p';
}

export interface HedraJobRef {
  jobId: string;
}

export interface HedraJobOutput {
  url: string;
  durationMs?: number;
}

export interface HedraJobStatus {
  /** Наш словарь: pending | completed | failed — тот же, что у FfmpegJobStatus. */
  status: 'pending' | 'completed' | 'failed';
  outputs?: HedraJobOutput[];
  error?: string;
  costMicroUsd?: number;
}

const PENDING = new Set(['IN_QUEUE', 'IN_PROGRESS', 'QUEUED', 'PROCESSING']);
const COMPLETE = new Set(['COMPLETED', 'COMPLETE', 'SUCCEEDED']);
const FAILURE = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED']);

@Injectable()
export class HedraClientService {
  private readonly logger = new Logger(HedraClientService.name);
  private readonly base = 'https://api.hedra.com/v3';

  private key(): string | undefined {
    return process.env.HEDRA_API_KEY?.trim() || undefined;
  }

  /** Не настроен — не ошибка: `ActorsService` отвечает понятным пропуском, как и остальные необязательные внешние сервисы проекта. */
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
    expectedStatuses: number[],
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}`, init);
    const text = await res.text();
    if (!expectedStatuses.includes(res.status)) {
      const err = Object.assign(
        new Error(`hedra api ${res.status}: ${text.slice(0, 400)}`),
        { status: res.status },
      );
      throw err;
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`hedra api вернул не-JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Создать задачу генерации (§3.2, шаг 3):
   * `POST /v3/models/hedra-character-3`, `202` + `job_id`.
   */
  async submit(opts: HedraSubmitOptions): Promise<HedraJobRef> {
    const key = this.key();
    if (!key) throw new Error('HEDRA_API_KEY не задан');

    const body = {
      prompt: opts.prompt,
      start_image: opts.startImage,
      audio: opts.audioUrl,
      aspect_ratio: opts.aspectRatio,
      resolution: opts.resolution,
    };

    const data = await this.withRetry(
      () =>
        this.call(
          '/models/hedra-character-3',
          {
            method: 'POST',
            headers: {
              'X-API-Key': key,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
          [200, 201, 202],
        ),
      'hedra submit',
    );

    const jobId = (data.job_id ?? data.jobId ?? data.id) as string | undefined;
    if (!jobId) {
      throw new Error(
        'ответ Hedra не содержит id задачи — см. лог для формата ответа',
      );
    }
    return { jobId };
  }

  /**
   * Статус задачи (§3.2, шаг 4): `GET /v3/jobs/{job_id}` →
   * `ResultResponse` с `status` и, у завершённой задачи, `outputs[]`
   * (`{status, url, asset_id, ...}`) и `cost`/`currency`.
   */
  async status(jobId: string): Promise<HedraJobStatus> {
    const key = this.key();
    if (!key) throw new Error('HEDRA_API_KEY не задан');

    const data = await this.withRetry(
      () =>
        this.call(
          `/jobs/${encodeURIComponent(jobId)}`,
          { headers: { 'X-API-Key': key } },
          [200],
        ),
      'hedra status',
    );

    const raw = String(data.status ?? '').toUpperCase();
    const status = COMPLETE.has(raw)
      ? 'completed'
      : FAILURE.has(raw)
        ? 'failed'
        : PENDING.has(raw)
          ? 'pending'
          : 'pending'; // незнакомый статус — считаем «ещё идёт», не проваливаем задачу вслепую

    const rawOutputs = Array.isArray(data.outputs)
      ? (data.outputs as Array<Record<string, unknown>>)
      : [];
    const outputs: HedraJobOutput[] = rawOutputs
      .filter((o) => typeof o.url === 'string' && o.url)
      .map((o) => ({
        url: o.url as string,
        durationMs:
          typeof o.duration_ms === 'number' ? o.duration_ms : undefined,
      }));

    const cost = typeof data.cost === 'number' ? data.cost : undefined;

    return {
      status,
      outputs: outputs.length > 0 ? outputs : undefined,
      error:
        status === 'failed'
          ? String(
              data.error ?? data.error_message ?? 'Hedra сообщил об ошибке',
            )
          : undefined,
      // `cost` у Hedra — в долларах (кредиты уже переведены в валюту),
      // переводим в микродоллары тем же масштабом, что весь остальной
      // журнал расходов проекта (common/ai-pricing.ts).
      costMicroUsd:
        cost !== undefined ? Math.round(cost * 1_000_000) : undefined,
    };
  }
}
