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
 * ## ⚠️⚠️ Что НЕ подтверждено — здесь неопределённости БОЛЬШЕ, чем в
 * `GrokVideoService` (синхронный клиент, этап 1) и даже больше, чем
 * обычно в этом проекте для внешних API
 *
 * Для CHAT `GrokBatchService` знает точную форму обёртки одного
 * запроса в пачке — `batch_request: { chat_get_completion: {...} } }`
 * — потому что она была сверена с РЕАЛЬНЫМИ ответами сервера в другом
 * проекте (см. доккомментарий того файла). Для ВИДЕО такой сверки
 * никто не делал, и ни один источник, включая официальные release
 * notes, не показывает буквальный пример JSON одного элемента пачки
 * для видео — только факт, что тип запроса поддерживается.
 *
 * Ключ обёртки ниже (`videos_generations`) — ДОГАДКА по аналогии с
 * `chat_get_completion` (снейк-кейс от имени эндпоинта
 * `/v1/videos/generations`), НЕ факт. Реальное имя может быть другим
 * (`video_generation`, `video`, что угодно ещё). Это НЕ то же самое
 * предупреждение, что уже трижды помогало в этом ТЗ («документация
 * есть, но не проверено вызовом») — здесь даже документации с точной
 * формой нет, есть только релиз-нота о самом факте поддержки.
 *
 * **Перед любым реальным использованием: обязательный тестовый вызов
 * на одну запись, сверка реального ответа xAI, и правка этого файла
 * по факту — то же самое предупреждение о `GrokBatchService`
 * («форма — не догадка, а наблюдение над реальным сервером») должно
 * стать верным и для этого файла тоже, а прямо сейчас не является.**
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

  constructor() {
    const config = loadConfiguration();
    this.apiKey = config.grok.apiKey;
    this.model = config.grok.videoModel;
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

      this.logger.log(
        `видео-пачка создана: ${xaiBatchId}. Добавляю ${items.length} запросов...`,
      );

      const batchRequests = items.map((item) => ({
        batch_request_id: item.batchRequestId,
        // ⚠️ НЕ подтверждено — см. доккомментарий класса.
        batch_request: {
          videos_generations: {
            model: this.model,
            prompt: item.prompt,
            ...(item.imageUrl ? { image_url: item.imageUrl } : {}),
            ...(item.referenceImageUrls?.length
              ? {
                  reference_images: item.referenceImageUrls.map((url) => ({
                    url,
                  })),
                }
              : {}),
            duration: item.durationSeconds,
            aspect_ratio: item.aspectRatio,
            resolution: item.resolution,
          },
        },
      }));

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
        return {
          error: `xAI вернул статус ${addRes.status} при добавлении запросов: ${JSON.stringify(addRes.data).slice(0, 300)}`,
        };
      }

      this.logger.log(
        `видео-пачка ${xaiBatchId} подана полностью (${items.length} запросов). Обработка на стороне xAI — обычно до 24 часов, проверка статуса по расписанию.`,
      );
      return { xaiBatchId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`не удалось подать видео-пачку "${name}": ${message}`);
      return { error: message };
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
  async getBatchResults(
    xaiBatchId: string,
  ): Promise<Record<string, string>> {
    const urlsByRequestId: Record<string, string> = {};
    if (!this.apiKey) return urlsByRequestId;

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
          if (url) urlsByRequestId[batchRequestId] = url;
        }

        paginationToken = res.data?.pagination_token;
        if (!paginationToken) break;
      }

      this.logger.log(
        `получено ${Object.keys(urlsByRequestId).length} результатов из ${totalItemsSeen} элементов видео-пачки ${xaiBatchId}.`,
      );
    } catch (err) {
      this.logger.warn(
        `не удалось получить результаты видео-пачки ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return urlsByRequestId;
  }

  /** ⚠️ Путь до `video.url` внутри `batch_result` — та же догадка по
   * аналогии, что и у запроса (см. доккомментарий класса), не факт. */
  private extractBatchResultUrl(item: Record<string, unknown>): string | null {
    const batchResult = item.batch_result as
      | {
          response?: {
            videos_generations?: { video?: { url?: string } };
          };
        }
      | undefined;
    const url = batchResult?.response?.videos_generations?.video?.url;
    return typeof url === 'string' ? url : null;
  }
}
