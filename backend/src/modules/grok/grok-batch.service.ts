/**
 * GrokBatchService — асинхронный Batch API xAI Grok (ТЗ §35.1).
 *
 * По прямому запросу пользователя: «использовать Grok AI как и в Solar
 * shop batch mode для перевода статей». Это ОТМЕНЯЕТ более раннее
 * решение этапа 55 (см. историю §35.1 в doc/PRODUCT-PROJECT-SPEC.md) —
 * там предлагались синхронные вызовы Gemini/GPT-5 под крон-бюджетом
 * времени вместо отдельной батч-инфраструктуры под конкретного
 * стороннего провайдера. Прямой запрос пользователя перевешивает то
 * рассуждение: перевод статей блога — фоновая, не интерактивная задача,
 * и Batch API стоит на 20–50% дешевле синхронных вызовов
 * (docs.x.ai/developers/pricing#batch-api-pricing) именно ценой
 * асинхронности (типично до 24 часов, best-effort, НЕ гарантировано).
 *
 * ПОРТ из solar-shop `apps/api/src/grok/grok-batch.service.ts` — почти
 * дословно: сама батч-инфраструктура xAI не завязана на предметную
 * область (годится для перевода статей ровно так же, как там она
 * годилась для рерайта), поэтому переносится код, а не только паттерн
 * (как для og-image-fetcher.ts/i18n в этапе 55). Единственное отличие —
 * HTTP-клиент: здесь axios с `validateStatus: () => true`, как во всех
 * остальных внешних клиентах этого бэкенда (SerpApiLensService), вместо
 * нативного `fetch` оригинала — сама логика запросов не менялась.
 *
 * ⚠️ Форма эндпоинтов/полей ниже — НЕ догадка и не буквальное чтение
 * официальной документации (которая сама местами неоднозначна: примеры
 * на docs.x.ai одновременно показывают и "responses", и
 * "chat_get_completion" как имя поля запроса без чёткого объяснения
 * разницы). Это перенесено из solar-shop, где эти эндпоинты уже были
 * сверены с РЕАЛЬНЫМИ ответами сервера (комментарий оригинала указывает
 * на проект RoadScout как источник сверки), а не просто прочитаны в
 * доке:
 * - `GET /batches/{id}` возвращает ТОЛЬКО вложенный `state.{num_requests,
 *   num_pending, num_success, num_error}` — плоского поля "status" нет
 *   вообще; готовность батча = `num_pending === 0`, а НЕ
 *   `num_success === num_requests` (часть запросов могла упасть с
 *   ошибкой — `num_error` — и тогда num_success никогда не сравняется с
 *   num_requests, хотя батч уже действительно готов).
 * - Результаты — на эндпоинте `/results` (не `/requests` — тот отдаёт
 *   только метаданные без фактического ответа модели).
 * - Текст ответа модели —
 *   `batch_result.response.chat_get_completion.choices[0].message.content`
 *   (формат Chat Completions, а не Responses API, несмотря на поле
 *   "responses" в примерах документации).
 * Менять форму запроса/ответа без повторной сверки на реальном аккаунте
 * xAI нельзя — это не поддающийся логическому выводу контракт стороннего
 * API, а наблюдение.
 *
 * Учёт расхода (§26, AiUsageService, provider `'GROK'`, operation
 * `'translate'`) — ответственность ВЫЗЫВАЮЩЕГО кода (`BlogTranslationService`,
 * модуль `blog`, этап 57), а не этого сервиса: тот же принцип разделения
 * ответственности, что уже применён здесь для GrokBatchService в
 * solar-shop и для AiUsageService в этом проекте — сервис-источник не
 * знает про журнал расходов, вызывающий знает, сколько строк реально
 * перевелось (`getBatchResults` возвращает только успешные).
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Защита от бесконечного цикла в getBatchResults, если xAI вернёт
 * некорректный/зацикленный pagination_token — лучше остановиться с
 * частичным результатом, чем зависнуть (перенесено из solar-shop).
 */
const MAX_RESULT_PAGES = 50;

export interface GrokBatchRequestItem {
  /**
   * Ключ, по которому результат находится в getBatchResults — например,
   * id будущей строки ArticleTranslation. Уникален внутри одной пачки.
   */
  batchRequestId: string;
  model: string;
  messages: { role: string; content: string }[];
  responseFormat?: { type: 'json_object' };
}

export interface GrokBatchStatus {
  totalCount: number;
  completedCount: number;
  /**
   * `null` — поля `num_pending` в ответе не было. Это НЕ ноль: ноль
   * означает «в очереди никого, пачка готова», и по нему забирают
   * результаты. Спутать их стоило бы целой оплаченной пачки.
   */
  pendingCount: number | null;
  errorCount: number;
}

export type GrokBatchSubmitResult =
  | { xaiBatchId: string; error?: undefined }
  | { error: string; xaiBatchId?: undefined };

@Injectable()
export class GrokBatchService {
  private readonly logger = new Logger(GrokBatchService.name);
  private readonly apiKey: string;

  constructor() {
    this.apiKey = loadConfiguration().grok.apiKey;
  }

  /** Есть ли ключ — чтобы вызывающий мог отказать быстро и понятно. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Подаёт ОДНУ пачку запросов в xAI Batch API. Каждый элемент — обычный
   * `/v1/chat/completions`-payload (model+messages+response_format) —
   * тот же формат, каким viral4creators уже собирает запросы к
   * Gemini/GPT-5 (§26), так что существующие промпт-билдеры переносятся
   * без переписывания.
   */
  async submitBatch(
    name: string,
    items: GrokBatchRequestItem[],
  ): Promise<GrokBatchSubmitResult> {
    if (!this.apiKey) return { error: 'GROK_API_KEY не задан' };
    if (items.length === 0) {
      return { error: 'пустой список запросов для пачки' };
    }

    this.logger.log(`создаю пачку "${name}" (${items.length} запросов)...`);

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
        `пачка создана: ${xaiBatchId}. Добавляю ${items.length} запросов...`,
      );

      const batchRequests = items.map((item) => ({
        batch_request_id: item.batchRequestId,
        batch_request: {
          chat_get_completion: {
            model: item.model,
            ...(item.responseFormat
              ? { response_format: item.responseFormat }
              : {}),
            messages: item.messages,
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
        `пачка ${xaiBatchId} подана полностью (${items.length} запросов). Обработка на стороне xAI — обычно до 24 часов, проверка статуса по расписанию.`,
      );
      return { xaiBatchId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`не удалось подать batch "${name}": ${message}`);
      return { error: message };
    }
  }

  /**
   * Опрос статуса. Готовность — `pendingCount === 0`, и только оно:
   * `null` означает «xAI не сказал», а не «ноль» (см. предупреждение
   * в шапке файла про num_success vs num_pending).
   */
  async getBatchStatus(xaiBatchId: string): Promise<GrokBatchStatus | null> {
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
      const state = (res.data?.state ?? {}) as Record<string, unknown>;
      const num = (key: string): number | null =>
        typeof state[key] === 'number' ? (state[key] as number) : null;
      return {
        totalCount: num('num_requests') ?? 0,
        completedCount: num('num_success') ?? 0,
        // `null`, а НЕ ноль, когда поля нет: ноль здесь означает «в
        // очереди никого, пачка готова», и вызывающий по нему решает
        // забирать результаты. Найдено аудитом блога 24.09.2026 —
        // ответ без `state` (батч в queued/validating/expired, иное
        // именование полей) выдавал готовность, которой нет, и целая
        // оплаченная пачка помечалась провалённой.
        pendingCount: num('num_pending'),
        errorCount: num('num_error') ?? 0,
      };
    } catch (err) {
      this.logger.warn(
        `не удалось получить статус batch ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Забирает результаты завершённой пачки, разложенные по
   * `batch_request_id`. Возвращает СЫРОЙ текст ответа модели (не
   * разобранный JSON) — разбор остаётся на ответственности вызывающего
   * (`BlogTranslationService`/`blog-translation-apply.ts`), тот же
   * принцип разделения, что уже применён в AiUsageService.record.
   */
  async getBatchResults(xaiBatchId: string): Promise<Record<string, string>> {
    return (await this.getBatchResultsDetailed(xaiBatchId)).resultsByRequestId;
  }

  /**
   * М-3.2б седьмого аудита: `complete: false` — страницы результатов
   * прочитаны не полностью (HTTP-ошибка/таймаут/обрыв пагинации);
   * отсутствие текста у запроса тогда ничего не значит, и вызывающий
   * обязан повторить следующим тиком, а не помечать переводы FAILED
   * (и не писать по ним расход).
   */
  async getBatchResultsDetailed(xaiBatchId: string): Promise<{
    resultsByRequestId: Record<string, string>;
    complete: boolean;
  }> {
    const resultsByRequestId: Record<string, string> = {};
    let complete = false;
    if (!this.apiKey) return { resultsByRequestId, complete };

    this.logger.log(`забираю результаты пачки ${xaiBatchId}...`);

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

          const text = this.extractBatchResultText(record);
          if (text) resultsByRequestId[batchRequestId] = text;
        }

        paginationToken = res.data?.pagination_token;
        if (!paginationToken) {
          complete = true;
          break;
        }
      }

      this.logger.log(
        `получено ${Object.keys(resultsByRequestId).length} результатов из ${totalItemsSeen} элементов пачки ${xaiBatchId}.`,
      );
    } catch (err) {
      this.logger.warn(
        `не удалось получить результаты batch ${xaiBatchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { resultsByRequestId, complete };
  }

  private extractBatchResultText(item: Record<string, unknown>): string | null {
    const batchResult = item.batch_result as
      | {
          response?: {
            chat_get_completion?: {
              choices?: { message?: { content?: string } }[];
            };
          };
        }
      | undefined;
    const content =
      batchResult?.response?.chat_get_completion?.choices?.[0]?.message
        ?.content;
    return typeof content === 'string' ? content : null;
  }
}
