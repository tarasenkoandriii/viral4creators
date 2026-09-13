/**
 * GrokVideoService — тонкий клиент к синхронному (не batch) video-
 * эндпоинту xAI. Доп. запрос владельца продукта: Grok как провайдер
 * видео-генерации (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md, §10–11, этап 1
 * плана реализации, §14).
 *
 * Не путать с `GrokBatchService` (`../grok/grok-batch.service.ts`) —
 * тот ходит на `/v1/batches` для перевода статей блога (chat
 * completions), этот — на `/v1/videos/generations`, синхронный запуск
 * + опрос статуса, ближе по форме к тому, как `generation.service.ts`
 * уже опрашивает Veo (`predictLongRunning` + поллинг), чем к батчам.
 *
 * ## Что подтверждено официальной документацией (`docs.x.ai`) на
 * момент написания — см. ТЗ §10.1, §10.5:
 *   - `POST https://api.x.ai/v1/videos/generations` с телом
 *     `{ model, prompt, image_url?, duration, aspect_ratio, resolution }`
 *     запускает генерацию.
 *   - Модель GA, официальное имя на момент подготовки ТЗ —
 *     `grok-imagine-video-1.5` (см. `config.grok.videoModel`).
 *   - Разрешение — `480p` | `720p` | `1080p`, цена разная (§10.2 ТЗ) —
 *     сама генерация принимает разрешение как есть, эта цена НЕ
 *     считается здесь (см. `common/ai-pricing.ts`).
 *
 * ## ⚠️ Что НЕ подтверждено — ПРОВЕРИТЬ перед первым реальным вызовом
 *
 * В отличие от `GrokBatchService` (его доккомментарий прямо говорит:
 * форма ответов сверена с РЕАЛЬНЫМИ вызовами в другом проекте) — здесь
 * такой сверки не было. Три конкретных места, где документация
 * противоречит сама себе или где официального примера просто не было
 * в распоряжении на момент написания:
 *   1. **Форма ответа на POST.** Официальный bash-пример показывает
 *      `REQUEST_ID=$(curl -s -X POST ... )` — то есть `request_id`
 *      извлекается из ответа, но точное имя поля и его расположение
 *      (`response.request_id` vs `response.id` vs что-то ещё) в
 *      захваченном тексте документации не показаны буквально.
 *   2. **URL опроса статуса.** Официальный текст говорит только «Use
 *      the request_id to check the status» — конкретный путь
 *      (`GET /v1/videos/generations/{request_id}` — предположение по
 *      REST-конвенции, ПО АНАЛОГИИ с тем, как устроен сам POST) нигде
 *      не показан буквально в захваченном тексте документации.
 *   3. **Значение статуса «готово».** Официальный пример ответа
 *      показывает `"status": "done"`; независимый источник (агрегатор,
 *      не первоисточник) называет `"completed"` для того же смысла.
 *      Ниже код проверяет ОБА варианта — минимальная защита, а не
 *      замена реальной проверки.
 *
 * Ровно то же самое предупреждение, которое уже трижды спасало этот
 * проект от повторения истории `generateAudio` (см. `generation.service.ts`)
 * — один тестовый вызов вне трафика ДО того, как это откроется
 * пользователям (ТЗ §10.5, закрытый вопрос №2).
 *
 * ## Reference-to-video (ТЗ §15 — множественные референсы персонажей
 * бренда) — подтверждено официально `docs.x.ai/developers/model-
 * capabilities/video/reference-to-video`, в отличие от остального
 * класса файла выше:
 *   - Поле — `reference_images`, массив объектов `{ url }` (НЕ голых
 *     строк) — до 7 штук.
 *   - Несовместимо с `image_url` в одном запросе — «Only one mode can
 *     be active per request» — то же взаимоисключение, что уже
 *     реализовано у Veo (`image` XOR `referenceImages`,
 *     `generation.service.ts`).
 *   - Разрешение в этом режиме — максимум 720p (ниже потолка обычного
 *     text/image-to-video у той же модели, где доступен 1080p).
 *   - Модель ожидает МЕТКИ `<IMAGE_1>`, `<IMAGE_2>` … ПРЯМО В ТЕКСТЕ
 *     промпта там, где должен появиться этот референс (официальный
 *     пример: «they wear the shirt from <IMAGE_2>»), а не отдельным
 *     списком-приложением, как у Veo (`referenceMappingText`). Этот
 *     класс сам текст не переписывает — готовит его вызывающий
 *     (`generation.service.ts`); честно говоря — это ПРИБЛИЖЕНИЕ к
 *     конвенции, не точное следование ей (см. доккомментарий
 *     `buildGrokReferencePromptText` там же).
 */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const REQUEST_TIMEOUT_MS = 30_000;

export type GrokResolution = '480p' | '720p' | '1080p';

export interface GrokVideoStartResult {
  requestId: string;
}

export interface GrokVideoStatusResult {
  /** `true` — видео готово, `videoUrl` заполнен. */
  done: boolean;
  /** Заполнено только при ошибке генерации на стороне xAI. */
  error?: string;
  /** Заполнено только когда `done === true` и ошибки не было. */
  videoUrl?: string;
}

@Injectable()
export class GrokVideoService {
  private readonly logger = new Logger(GrokVideoService.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const config = loadConfiguration();
    this.apiKey = config.grok.apiKey;
    this.model = config.grok.videoModel;
  }

  /** Есть ли ключ — чтобы вызывающий мог отказать быстро и понятно,
   * тот же приём, что уже есть у `GrokBatchService.isConfigured()`. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Имя модели, для составного ключа в `common/ai-pricing.ts`
   * (`{modelName}:{resolution}`, §11.5/§10.2 ТЗ) — единственный
   * источник, не дублируется отдельным чтением конфигурации у
   * вызывающего (`generation.service.ts`). */
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
   * Запускает генерацию. `imageUrl` — публично доступный URL (наш же
   * Blob), НЕ base64: xAI, в отличие от Veo, принимает изображение
   * ссылкой, а не байтами в теле запроса (§10.1 ТЗ). `aspectRatio` —
   * тот же формат, что уже используется в проекте (`'16:9'`/`'9:16'`).
   *
   * `referenceImageUrls` — reference-to-video (ТЗ §15, до 7 ссылок) —
   * НЕСОВМЕСТИМО с `imageUrl` в одном запросе (см. доккомментарий
   * класса); вызывающий передаёт РОВНО одно из двух, не оба. При
   * заданных референсах разрешение ограничено 720p — сервис сам
   * понижает `1080p` до `720p`, а не отклоняет запрос: тихая деградация
   * качества честнее отказа там, где вызывающий мог не знать про этот
   * потолок именно у этого режима.
   *
   * `extendVideoUrl` — Scene Extension (ТЗ §9, этап 4 плана §14):
   * продолжает СУЩЕСТВУЮЩЕЕ видео (предыдущий сегмент цепочки) с
   * последнего кадра. Официально подтверждено — `docs.x.ai`, поле
   * `video_url` (Python SDK: `client.video.extend(video_url=...,
   * duration=...)`) — «Only one mode can be active per request»,
   * взаимоисключающе с `imageUrl`/`referenceImageUrls` (та же логика
   * XOR, что уже здесь есть). `durationSeconds` в этом режиме — это
   * ДЛИНА ДОБАВЛЯЕМОГО сегмента, не итоговая длина ролика — расчёт,
   * сколько сегментов и какой длины нужно всего, живёт в
   * `common/video-extension-plan.ts`, не здесь.
   */
  async startGeneration(params: {
    prompt: string;
    imageUrl?: string;
    referenceImageUrls?: string[];
    extendVideoUrl?: string;
    durationSeconds: number;
    aspectRatio: string;
    resolution: GrokResolution;
  }): Promise<GrokVideoStartResult> {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY не задан');
    }
    const modesSet = [
      params.imageUrl,
      params.referenceImageUrls?.length,
      params.extendVideoUrl,
    ].filter(Boolean).length;
    if (modesSet > 1) {
      // Программная ошибка вызывающего, не ввод пользователя — не
      // локализуем, это никогда не должно дойти до интерфейса.
      throw new Error(
        'GrokVideoService.startGeneration: imageUrl/referenceImageUrls/extendVideoUrl взаимоисключающие (§9, §15 ТЗ)',
      );
    }
    const resolution =
      params.referenceImageUrls?.length && params.resolution === '1080p'
        ? '720p'
        : params.resolution;

    const res = await axios.post(
      `${XAI_BASE_URL}/videos/generations`,
      {
        model: this.model,
        prompt: params.prompt,
        ...(params.imageUrl ? { image_url: params.imageUrl } : {}),
        ...(params.referenceImageUrls?.length
          ? {
              reference_images: params.referenceImageUrls.map((url) => ({
                url,
              })),
            }
          : {}),
        ...(params.extendVideoUrl
          ? { video_url: params.extendVideoUrl }
          : {}),
        duration: params.durationSeconds,
        aspect_ratio: params.aspectRatio,
        resolution,
      },
      { headers: this.headers(), timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true },
    );

    if (res.status >= 400) {
      this.logger.error(
        `Grok video start failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`,
      );
      throw new Error(
        `Grok video generation failed to start (HTTP ${res.status})`,
      );
    }

    // Не подтверждено буквально (см. доккомментарий класса, п.1) —
    // проверяем оба разумных варианта расположения поля.
    const requestId: string | undefined =
      res.data?.request_id ?? res.data?.id;
    if (!requestId) {
      this.logger.error(
        `Grok video start: ответ без request_id — ${JSON.stringify(res.data)}`,
      );
      throw new Error(
        'Grok video generation: не удалось прочитать request_id из ответа',
      );
    }

    return { requestId };
  }

  /**
   * Опрашивает статус. URL опроса — ПРЕДПОЛОЖЕНИЕ по REST-конвенции
   * (см. доккомментарий класса, п.2) — не подтверждено буквальным
   * примером из документации на момент написания.
   */
  async getStatus(requestId: string): Promise<GrokVideoStatusResult> {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY не задан');
    }

    const res = await axios.get(
      `${XAI_BASE_URL}/videos/generations/${requestId}`,
      { headers: this.headers(), timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true },
    );

    if (res.status >= 400) {
      this.logger.error(
        `Grok video status failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`,
      );
      return { done: false, error: `HTTP ${res.status}` };
    }

    const status: string | undefined = res.data?.status;
    // Не подтверждено буквально (см. доккомментарий класса, п.3) —
    // 'done' — из официального примера, 'completed' — из независимого
    // источника; проверяем оба, ничего не теряя при любом варианте.
    const isDone = status === 'done' || status === 'completed';
    if (!isDone) {
      // 'error' — тоже не подтверждено буквально; трактуем любой явный
      // статус ошибки как ошибку, не как "ещё идёт".
      if (status === 'error' || status === 'failed') {
        return { done: true, error: res.data?.error ?? 'Grok video generation failed' };
      }
      return { done: false };
    }

    const videoUrl: string | undefined = res.data?.video?.url;
    if (!videoUrl) {
      return { done: true, error: 'Grok video generation: ответ без video.url' };
    }

    return { done: true, videoUrl };
  }
}
