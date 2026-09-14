/**
 * GrokVideoBatchService — xAI Batch API для видео-генерации (ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md §13, этап 2 плана реализации §14).
 *
 * Доп. запрос владельца продукта: тот же Batch API, что уже реализован
 * в `GrokBatchService` (`../grok/grok-batch.service.ts`) для перевода
 * статей блога — тот же `/v1/batches` эндпоинт, тот же жизненный цикл
 * (создать пачку → добавить запросы → опрашивать → забрать результаты),
 * но для видео вместо chat completions.
 *
 * ## Что подтверждено официально
 *
 * `docs.x.ai/developers/release-notes`, март 2026: «The Batch API now
 * supports image generation, image editing, and video generation in
 * addition to chat completions». Это РЕАЛЬНАЯ, датированная запись в
 * официальных release notes — сам факт поддержки не под вопросом.
 *
 * ## Форма одного элемента пачки — по официальной proto-схеме
 * (`github.com/xai-org/xai-proto`, `proto/xai/api/v1/batch.proto`,
 * сверено 14.09.2026)
 *
 * `BatchRequest { batch_request_id; oneof request { completion_request;
 * image_request; video_request (GenerateVideoRequest);
 * video_extension_request (ExtendVideoRequest) } }` — то есть видео-
 * генерация И расширение видео в пачке поддерживаются на уровне схемы,
 * а не только релиз-нотой. Результат — `BatchResult { batch_request_id;
 * oneof result { response: BatchResultData { oneof response {
 * completion_response; image_response; video_response (VideoResponse
 * { video: { url } }) } }; error: google.rpc.Status } }`.
 *
 * ## Имена ключей в REST-JSON — ПОДТВЕРЖДЕНЫ живым ответом (14.09.2026)
 *
 * REST-шлюз xAI не использует proto-имена полей oneof буквально. Первая
 * попытка по аналогии с `chat_get_completion` (`video_generate_video`)
 * получила 422 с исчерпывающим списком от самого сервера:
 * «unknown variant `video_generate_video`, expected one of
 * `chat_get_completion`, `responses`, `image_generation`, `image_edit`,
 * `video_generation`, `video_extension`». Итого:
 *   - генерация — `video_generation`, расширение — `video_extension`;
 *   - оба ключа по-прежнему переопределяются переменными окружения
 *     `GROK_BATCH_VIDEO_REQUEST_KEY` / `GROK_BATCH_VIDEO_EXTEND_KEY` на
 *     случай смены схемы у xAI;
 *   - разбор результата НЕ завязан на имя ключа: берётся первый
 *     объект в `batch_result.response`, у которого есть `video.url`
 *     (форма `VideoResponse.video.url` подтверждена и proto, и живым
 *     синхронным ответом `GET /v1/videos/{id}` — см. `GrokVideoService`).
 *   - тело самого запроса — по proto `GenerateVideoRequest`: `prompt`,
 *     `model`, `image: { url }` (ImageUrlContent — объект, НЕ `image_url`),
 *     `reference_images: [{ url }]`, `duration`, `aspect_ratio`,
 *     `resolution`; `ExtendVideoRequest`: `prompt`, `model`,
 *     `video: { url }`, `duration` (длина ДОБАВЛЯЕМОЙ части, 2–10 с).
 *     Форма ТЕЛА внутри ключа живым батчем ещё не подтверждена (422 был
 *     на имени ключа, до разбора тела) — первая успешная пачка это
 *     покажет; при 422 «unknown field» внутри тела править здесь.
 *
 * Учёт расхода — ответственность вызывающего кода, тот же принцип
 * разделения, что уже применён в `GrokBatchService`/`AiUsageService`
 * (`record()` вызывает не этот сервис).
 */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';
import { GrokResolution } from './grok-video.service';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const REQUEST_TIMEOUT_MS = 20_000;

/** Ключи oneof в REST-JSON пачки — подтверждены ответом 422 самого xAI
 * (см. доккомментарий класса), переопределяются окружением. */
export const GROK_BATCH_VIDEO_REQUEST_KEY =
  process.env.GROK_BATCH_VIDEO_REQUEST_KEY || 'video_generation';
export const GROK_BATCH_VIDEO_EXTEND_KEY =
  process.env.GROK_BATCH_VIDEO_EXTEND_KEY || 'video_extension';

/** Та же защита от зацикленной пагинации, что уже есть у GrokBatchService. */
const MAX_RESULT_PAGES = 50;

export interface GrokVideoBatchRequestItem {
  /** Ключ, по которому результат находится в getBatchResults —
   * например, `generatedVideoId` будущей попытки. Уникален внутри пачки. */
  batchRequestId: string;
  prompt: string;
  imageUrl?: string;
  referenceImageUrls?: string[];
  durationSeconds: number;
  aspectRatio: string;
  resolution: GrokResolution;
}

/** Расширение существующего ролика в пачке (`video_extension_request`
 * в proto) — то же, что `GrokVideoService.extendVideo`, но
 * асинхронно. `durationSeconds` — длина добавляемой части (2–10 с);
 * формат и разрешение наследуются от входа, не задаются. */
export interface GrokVideoBatchExtendItem {
  batchRequestId: string;
  prompt: string;
  videoUrl: string;
  durationSeconds: number;
}

export interface GrokVideoBatchResults {
  /** URL готового видео по `batch_request_id` — только успешные. */
  urlsByRequestId: Record<string, string>;
  /** Текст ошибки xAI по `batch_request_id` — для тех, кто упал
   * (`BatchResult.error`, google.rpc.Status). */
  errorsByRequestId: Record<string, string>;
  /** `false` — страницы результатов прочитаны НЕ полностью (HTTP-ошибка,
   * таймаут, обрыв пагинации): отсутствие url у запроса тогда ничего не
   * значит, и вызывающий обязан повторить в следующий тик, а не
   * закрывать строки сбоем (М-3.2/М-6.2 седьмого аудита: транзиентный
   * 502 на `/results` помечал ВСЮ оплаченную партию FAILED навсегда). */
  complete: boolean;
}

export interface GrokVideoBatchStatus {
  totalCount: number;
  completedCount: number;
  pendingCount: number;
  errorCount: number;
}

export type GrokVideoBatchSubmitResult =
  | { xaiBatchId: string; error?: undefined }
  | { error: string; xaiBatchId?: undefined };

@Injectable()
export class GrokVideoBatchService {
  private readonly logger = new Logger(GrokVideoBatchService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly extendModel: string;

  constructor() {
    const config = loadConfiguration();
    this.apiKey = config.grok.apiKey;
    this.model = config.grok.videoModel;
    this.extendModel = config.grok.videoExtendModel;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Имя модели, для составного ключа в `common/ai-pricing.ts`
   * (`{modelName}:{resolution}`, §11.5/§10.2 ТЗ) — тот же геттер, что
   * уже есть у `GrokVideoService`, нужен воркеру каталог-партий для
   * расчёта стоимости пачки перед подачей (найдено при аудите §16 —
   * до этого расчёта не было вовсе). */
  get modelName(): string {
    return this.model;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Подаёт ОДНУ пачку видео-запросов. См. доккомментарий класса —
   * форма `batch_request.videos_generations` НЕ подтверждена реальным
   * вызовом.
   */
  async submitBatch(
    name: string,
    items: GrokVideoBatchRequestItem[],
  ): Promise<GrokVideoBatchSubmitResult> {
    if (!this.apiKey) return { error: 'GROK_API_KEY не задан' };
    if (items.length === 0) {
      return { error: 'пустой список запросов для пачки' };
    }
    for (const item of items) {
      if (item.imageUrl && item.referenceImageUrls?.length) {
        return {
          error: `запрос ${item.batchRequestId}: imageUrl и referenceImageUrls взаимоисключающие (§15 ТЗ)`,
        };
      }
    }

    this.logger.log(
      `создаю видео-пачку "${name}" (${items.length} запросов)...`,
    );

    try {
      const created = await this.createBatch(name);
      if (created.error !== undefined) return { error: created.error };
      const xaiBatchId = created.xaiBatchId;

      this.logger.log(
        `видео-пачка создана: ${xaiBatchId}. Добавляю ${items.length} запросов...`,
      );

      const batchRequests = items.map((item) => ({
        batch_request_id: item.batchRequestId,
        // Ключ oneof — см. доккомментарий класса (вывод по аналогии,
        // переопределяется окружением); тело — по proto
        // `GenerateVideoRequest`.
        batch_request: {
          [GROK_BATCH_VIDEO_REQUEST_KEY]: {
            model: this.model,
            prompt: item.prompt,
            ...(item.imageUrl ? { image: { url: item.imageUrl } } : {}),
            ...(item.referenceImageUrls?.length
              ? {
                  reference_images: item.referenceImageUrls.map((url) => ({
                    url,
                  })),
                }
              : {}),
            duration: item.durationSeconds,
            aspect_ratio: item.aspectRatio,
            // То же понижение, что у синхронного `startGeneration`
            // (reference-to-video — не выше 720p, М-3.8 седьмого аудита):
            // иначе один и тот же ролик проходит в sync и падает в batch.
            resolution:
              item.referenceImageUrls?.length && item.resolution === '1080p'
                ? '720p'
                : item.resolution,
          },
        },
      }));

      return await this.addRequests(name, xaiBatchId, batchRequests);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`не удалось подать видео-пачку "${name}": ${message}`);
      return { error: message };
    }
  }

  /**
   * Пачка расширений (`video_extension_request` в proto) — для
   * продолжения цепочки одиночного ролика, начатого через батч
   * (`GenerationService.continueGrokChain`). Отдельный метод, а не
   * `kind` в `submitBatch`: у расширения другое тело и другие
   * ограничения (без формата/разрешения), смешивать их в одном
   * интерфейсе значило бы половину полей делать необязательными.
   */
  async submitExtendBatch(
    name: string,
    items: GrokVideoBatchExtendItem[],
  ): Promise<GrokVideoBatchSubmitResult> {
    if (!this.apiKey) return { error: 'GROK_API_KEY не задан' };
    if (items.length === 0) {
      return { error: 'пустой список запросов для пачки' };
    }

    this.logger.log(
      `создаю пачку расширений "${name}" (${items.length} запросов)...`,
    );
    try {
      const created = await this.createBatch(name);
      if (created.error !== undefined) return { error: created.error };
      const xaiBatchId = created.xaiBatchId;

      const batchRequests = items.map((item) => ({
        batch_request_id: item.batchRequestId,
        batch_request: {
          [GROK_BATCH_VIDEO_EXTEND_KEY]: {
            // Живой ответ 14.09.2026: у `grok-imagine-video-1.5` расширение
            // не поддерживается — отдельная модель из конфига.
            model: this.extendModel,
            prompt: item.prompt,
            video: { url: item.videoUrl },
            duration: item.durationSeconds,
          },
        },
      }));

      return await this.addRequests(name, xaiBatchId, batchRequests);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `не удалось подать пачку расширений "${name}": ${message}`,
      );
      return { error: message };
    }
  }

  private async createBatch(name: string): Promise<GrokVideoBatchSubmitResult> {
    const createRes = await axios.post(
      `${XAI_BASE_URL}/batches`,
      { name },
      {
        headers: this.headers(),
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    if (createRes.status < 200 || createRes.status >= 300) {
      return {
        error: `xAI вернул статус ${createRes.status} при создании пачки: ${JSON.stringify(createRes.data).slice(0, 300)}`,
      };
    }
    const xaiBatchId: string | undefined =
      createRes.data?.id ?? createRes.data?.batch_id;
    if (!xaiBatchId) {
      return {
        error: `ответ xAI не содержит ни "id", ни "batch_id": ${JSON.stringify(createRes.data).slice(0, 300)}`,
      };
    }
    return { xaiBatchId };
  }

  private async addRequests(
    name: string,
    xaiBatchId: string,
    batchRequests: unknown[],
  ): Promise<GrokVideoBatchSubmitResult> {
    const addRes = await axios.post(
      `${XAI_BASE_URL}/batches/${xaiBatchId}/requests`,
      { batch_requests: batchRequests },
      {
        headers: this.headers(),
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    if (addRes.status < 200 || addRes.status >= 300) {
      await this.cancelBatchQuietly(xaiBatchId);
      return {
        error: `xAI вернул статус ${addRes.status} при добавлении запросов: ${JSON.stringify(addRes.data).slice(0, 300)}`,
      };
    }

    // М-6.7 седьмого аудита: имя oneof-ключа видео-запроса выведено по
    // аналогии, не подтверждено; если шлюз xAI молча проигнорирует
    // неизвестный ключ (как он уже сделал с `video_url`), элементы
    // пачки не появятся — `num_requests` останется 0, и опрос ждал бы
    // дедлайна 26 ч. Сверяем сразу и падаем громко.
    const state = await this.getBatchStatus(xaiBatchId);
    if (state && state.totalCount !== batchRequests.length) {
      await this.cancelBatchQuietly(xaiBatchId);
      return {
        error: `xAI принял ${state.totalCount} из ${batchRequests.length} запросов пачки ${xaiBatchId} — вероятно, неверный ключ запроса (см. GROK_BATCH_VIDEO_REQUEST_KEY / GROK_BATCH_VIDEO_EXTEND_KEY)`,
      };
    }

    this.logger.log(
      `видео-пачка ${xaiBatchId} ("${name}") подана полностью (${batchRequests.length} запросов). Обработка на стороне xAI — обычно до 24 часов, проверка статуса по расписанию.`,
    );
    return { xaiBatchId };
  }

  /** Пустая/битая пачка на стороне xAI после неудачной подачи — не
   * оставлять сиротой (М-6.7). Best-effort: `CancelBatch` есть в proto
   * (`BatchMgmt.CancelBatch`), REST-путь — по конвенции; сбой отмены
   * только логируется. */
  private async cancelBatchQuietly(xaiBatchId: string): Promise<void> {
    try {
      await axios.post(
        `${XAI_BASE_URL}/batches/${xaiBatchId}/cancel`,
        {},
        {
          headers: this.headers(),
          timeout: REQUEST_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
    } catch (err) {
      this.logger.warn(
        `не удалось отменить пачку-сироту ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Готовность — `pendingCount === 0`, тот же принцип и то же
   * предупреждение про `num_success` vs `num_pending`, что у
   * `GrokBatchService.getBatchStatus`. */
  async getBatchStatus(
    xaiBatchId: string,
  ): Promise<GrokVideoBatchStatus | null> {
    if (!this.apiKey) return null;
    try {
      const res = await axios.get(`${XAI_BASE_URL}/batches/${xaiBatchId}`, {
        headers: this.headers(),
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) {
        this.logger.warn(`getBatchStatus(${xaiBatchId}): HTTP ${res.status}`);
        return null;
      }
      const state = (res.data?.state ?? {}) as Record<string, number>;
      return {
        totalCount: state.num_requests ?? 0,
        completedCount: state.num_success ?? 0,
        pendingCount: state.num_pending ?? 0,
        errorCount: state.num_error ?? 0,
      };
    } catch (err) {
      this.logger.warn(
        `не удалось получить статус видео-пачки ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Забирает результаты завершённой пачки — URL готового видео на
   * `batch_request_id`. Видео и картинки в результатах батча живут
   * **1 час** (официально подтверждено, см. доккомментарий класса) —
   * вызывающий обязан скачать и сохранить в свой Blob СРАЗУ, не
   * откладывая на следующий прогон крона.
   */
  async getBatchResults(xaiBatchId: string): Promise<Record<string, string>> {
    return (await this.getBatchResultsDetailed(xaiBatchId)).urlsByRequestId;
  }

  /** То же, плюс ошибки по запросам — одиночному ролику нужно
   * отличить «ещё не готово» от «упало» (`GenerationService.pollGrokStatus`). */
  async getBatchResultsDetailed(
    xaiBatchId: string,
  ): Promise<GrokVideoBatchResults> {
    const urlsByRequestId: Record<string, string> = {};
    const errorsByRequestId: Record<string, string> = {};
    let complete = false;
    if (!this.apiKey) return { urlsByRequestId, errorsByRequestId, complete };

    this.logger.log(`забираю результаты видео-пачки ${xaiBatchId}...`);

    try {
      let paginationToken: string | undefined;
      let totalItemsSeen = 0;

      for (let page = 0; page < MAX_RESULT_PAGES; page++) {
        const res = await axios.get(
          `${XAI_BASE_URL}/batches/${xaiBatchId}/results`,
          {
            headers: this.headers(),
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true,
            params: {
              limit: 100,
              ...(paginationToken ? { pagination_token: paginationToken } : {}),
            },
          },
        );
        if (res.status < 200 || res.status >= 300) {
          this.logger.warn(
            `getBatchResults(${xaiBatchId}): HTTP ${res.status} на странице ${page}`,
          );
          break;
        }
        const items = (res.data?.results ?? []) as unknown[];
        totalItemsSeen += items.length;

        for (const item of items) {
          const record = item as Record<string, unknown>;
          const batchRequestId = (record.batch_request_id ??
            record.custom_id ??
            record.id) as string | undefined;
          if (!batchRequestId) continue;

          const url = this.extractBatchResultUrl(record);
          if (url) {
            urlsByRequestId[batchRequestId] = url;
            continue;
          }
          const error = this.extractBatchResultError(record);
          if (error) errorsByRequestId[batchRequestId] = error;
        }

        paginationToken = res.data?.pagination_token;
        if (!paginationToken) {
          complete = true;
          break;
        }
      }

      this.logger.log(
        `получено ${Object.keys(urlsByRequestId).length} результатов из ${totalItemsSeen} элементов видео-пачки ${xaiBatchId}.`,
      );
    } catch (err) {
      this.logger.warn(
        `не удалось получить результаты видео-пачки ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { urlsByRequestId, errorsByRequestId, complete };
  }

  /**
   * `batch_result.response.<oneof-ключ>.video.url` — имя oneof-ключа
   * в REST не подтверждено (см. доккомментарий класса), поэтому
   * ищется ЛЮБОЙ объект в `response`, у которого есть `video.url`:
   * форма `VideoResponse { video: { url } }` подтверждена и proto, и
   * живым синхронным ответом.
   */
  private extractBatchResultUrl(item: Record<string, unknown>): string | null {
    const batchResult = item.batch_result as
      | { response?: Record<string, unknown> }
      | undefined;
    const response = batchResult?.response;
    if (!response || typeof response !== 'object') return null;
    for (const value of Object.values(response)) {
      const url = (value as { video?: { url?: unknown } } | null)?.video?.url;
      if (typeof url === 'string' && url) return url;
    }
    return null;
  }

  /** `BatchResult.error` — google.rpc.Status `{ code, message }`. */
  private extractBatchResultError(
    item: Record<string, unknown>,
  ): string | null {
    const batchResult = item.batch_result as
      | { error?: { code?: number; message?: string } }
      | undefined;
    const error = batchResult?.error;
    if (!error) return null;
    const message =
      typeof error.message === 'string' && error.message
        ? error.message
        : 'xAI batch: запрос завершился ошибкой';
    return error.code !== undefined
      ? `${message} (code ${error.code})`
      : message;
  }
}
