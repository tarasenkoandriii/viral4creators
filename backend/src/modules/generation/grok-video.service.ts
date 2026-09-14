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
 *     `{ model, prompt, image?: { url }, duration, aspect_ratio, resolution }`
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
 * такой сверки не было. Из трёх изначальных пунктов неопределённости
 * два закрыты по факту реального сбоя в проде (2026-09-14) — см. ниже:
 *   1. **Форма ответа на POST.** Официальный bash-пример показывает
 *      `REQUEST_ID=$(curl -s -X POST ... )` — то есть `request_id`
 *      извлекается из ответа, но точное имя поля и его расположение
 *      (`response.request_id` vs `response.id` vs что-то ещё) в
 *      захваченном тексте документации не показаны буквально. Код
 *      ниже (`startGeneration`) уже пробует оба варианта — не
 *      переподтверждено с тех пор, но пока сбоев на этом месте не
 *      было.
 *   2. **[ЗАКРЫТО, 2026-09-14]** URL опроса статуса. Изначальная
 *      догадка (`GET /v1/videos/generations/{request_id}`, по
 *      аналогии с POST) провалилась в реальном проде — HTTP 404 «No
 *      handler found on route». Официальная документация REST API
 *      (`docs.x.ai/developers/rest-api-reference/inference/videos`,
 *      с полным примером запроса/ответа) подтверждает верный путь:
 *      `GET /v1/videos/{request_id}` — БЕЗ сегмента `/generations/`,
 *      он есть только у POST-эндпоинта создания. Исправлено ниже.
 *   3. **[ЗАКРЫТО, 2026-09-14]** Значение статуса «готово». Та же
 *      официальная страница, с тем же полным примером ответа,
 *      подтверждает `"status": "done"` буквально — не по аналогии,
 *      реальный зафиксированный пример. `"completed"` оставлен как
 *      запасной вариант проверки (не убран), но `"done"` теперь
 *      подтверждённый факт, не одна из двух равновероятных догадок.
 *      Та же страница подтверждает и форму `video.url` — тоже была
 *      написана по догадке, тоже оказалась верной.
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
 *   - Несовместимо с `image` в одном запросе — «Only one mode can
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

/** Нативная длительность генерации, docs.x.ai (Video Generation): 1–15 с. */
const GROK_MIN_DURATION_SECONDS = 1;
const GROK_MAX_DURATION_SECONDS = 15;
/** Длина добавляемой части у расширения, docs.x.ai (Video Extension): 2–10 с. */
const GROK_MIN_EXTEND_DURATION_SECONDS = 2;
const GROK_MAX_EXTEND_DURATION_SECONDS = 10;

export type GrokResolution = '480p' | '720p' | '1080p';

export interface GrokVideoStartResult {
  requestId: string;
}

/**
 * Фактическое разрешение, которое отдаст xAI (М-6.6/М-1.7/М-2.8
 * седьмого аудита): reference-to-video и расширение — не выше 720p.
 * Одна функция для запроса, учёта расхода и оценки, чтобы они не
 * расходились.
 */
export function effectiveGrokResolution(
  requested: GrokResolution,
  opts: { references?: boolean; extension?: boolean },
): GrokResolution {
  if ((opts.references || opts.extension) && requested === '1080p') {
    return '720p';
  }
  return requested;
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
   * `durationSeconds` — нативная длительность ролика, 1–15 с
   * (docs.x.ai, Video Generation) — НЕ фиксированные 8: до 14.09.2026
   * сюда всегда приходило `VIDEO_DURATION_SECONDS`, из-за чего любой
   * запрос длиннее 8 с рендерился восьмисекундным. Сколько секунд
   * просить — решает `common/video-extension-plan.ts` (`segments[0]`).
   *
   * Расширение существующего ролика — НЕ этот метод, а `extendVideo()`
   * ниже: у xAI это отдельный эндпоинт с другим телом.
   */
  async startGeneration(params: {
    prompt: string;
    imageUrl?: string;
    referenceImageUrls?: string[];
    durationSeconds: number;
    aspectRatio: string;
    resolution: GrokResolution;
  }): Promise<GrokVideoStartResult> {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY не задан');
    }
    if (params.imageUrl && params.referenceImageUrls?.length) {
      // Программная ошибка вызывающего, не ввод пользователя — не
      // локализуем, это никогда не должно дойти до интерфейса.
      throw new Error(
        'GrokVideoService.startGeneration: imageUrl/referenceImageUrls взаимоисключающие (§15 ТЗ)',
      );
    }
    if (
      params.durationSeconds < GROK_MIN_DURATION_SECONDS ||
      params.durationSeconds > GROK_MAX_DURATION_SECONDS
    ) {
      throw new Error(
        `GrokVideoService.startGeneration: duration ${params.durationSeconds} вне 1–${GROK_MAX_DURATION_SECONDS} с (docs.x.ai)`,
      );
    }
    const resolution = effectiveGrokResolution(params.resolution, {
      references: !!params.referenceImageUrls?.length,
    });

    const res = await axios.post(
      `${XAI_BASE_URL}/videos/generations`,
      {
        model: this.model,
        prompt: params.prompt,
        // М-6.1 седьмого аудита: REST-поле — `image: { url }`
        // (ImageUrlContent, docs.x.ai image-to-video + proto
        // GenerateVideoRequest.image), НЕ `image_url` — это kwarg
        // Python SDK. Неизвестное поле xAI молча игнорирует (так уже
        // было с `video_url`, см. `extendVideo`), то есть до правки
        // image-to-video тихо рендерился как text-to-video без товара.
        ...(params.imageUrl ? { image: { url: params.imageUrl } } : {}),
        ...(params.referenceImageUrls?.length
          ? {
              reference_images: params.referenceImageUrls.map((url) => ({
                url,
              })),
            }
          : {}),
        duration: params.durationSeconds,
        aspect_ratio: params.aspectRatio,
        resolution,
      },
      { headers: this.headers(), timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true },
    );

    return this.readRequestId(res, 'Grok video start');
  }

  /**
   * Scene Extension (ТЗ §9, этап 4 плана §14) — продолжает
   * СУЩЕСТВУЮЩЕЕ видео с последнего кадра; результат — один склеенный
   * ролик (оригинал + продолжение), забирается тем же `getStatus()`.
   *
   * Найдено по реальному сбою 14.09.2026 («при любой длительности —
   * 8 секунд»): раньше продолжение слалось на `/v1/videos/generations`
   * с полем `video_url` — такого поля у этого эндпоинта нет, xAI его
   * молча игнорировал и рендерил НОВЫЙ ролик с нуля, который затирал
   * первый сегмент. Подтверждено официально (`docs.x.ai/developers/
   * model-capabilities/video/extension`, с curl-примером):
   *   - `POST https://api.x.ai/v1/videos/extensions`;
   *   - тело `{ model, prompt, duration, video: { url } }` — видео
   *     объектом `{ url }`, как у `reference_images`, не голой строкой;
   *   - `duration` — длина ДОБАВЛЯЕМОЙ части, 2–10 с (по умолчанию 6);
   *   - вход — .mp4 длиной 2–15 с; поэтому расширить можно только
   *     базовый сегмент, «цепочки» из нескольких расширений у Grok нет
   *     (см. `GROK_MAX_SECONDS` в `common/video-extension-plan.ts`);
   *   - `aspect_ratio`/`resolution` НЕ принимаются: формат наследуется
   *     от входа, выход не выше 720p — 1080p-база после расширения
   *     станет 720p, это ограничение API, не наше.
   * Ответ — тот же `request_id`, что у генерации; опрос — тот же
   * `GET /v1/videos/{request_id}`.
   */
  async extendVideo(params: {
    prompt: string;
    videoUrl: string;
    durationSeconds: number;
  }): Promise<GrokVideoStartResult> {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY не задан');
    }
    if (
      params.durationSeconds < GROK_MIN_EXTEND_DURATION_SECONDS ||
      params.durationSeconds > GROK_MAX_EXTEND_DURATION_SECONDS
    ) {
      throw new Error(
        `GrokVideoService.extendVideo: duration ${params.durationSeconds} вне ${GROK_MIN_EXTEND_DURATION_SECONDS}–${GROK_MAX_EXTEND_DURATION_SECONDS} с (docs.x.ai)`,
      );
    }

    const res = await axios.post(
      `${XAI_BASE_URL}/videos/extensions`,
      {
        model: this.model,
        prompt: params.prompt,
        duration: params.durationSeconds,
        video: { url: params.videoUrl },
      },
      { headers: this.headers(), timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true },
    );

    return this.readRequestId(res, 'Grok video extend');
  }

  /** Общее для генерации и расширения чтение `request_id` из ответа. */
  private readRequestId(
    res: { status: number; data?: { request_id?: string; id?: string } },
    what: string,
  ): GrokVideoStartResult {
    if (res.status >= 400) {
      this.logger.error(
        `${what} failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`,
      );
      throw new Error(`${what} failed to start (HTTP ${res.status})`);
    }

    // Не подтверждено буквально (см. доккомментарий класса, п.1) —
    // проверяем оба разумных варианта расположения поля.
    const requestId: string | undefined =
      res.data?.request_id ?? res.data?.id;
    if (!requestId) {
      this.logger.error(
        `${what}: ответ без request_id — ${JSON.stringify(res.data)}`,
      );
      throw new Error(`${what}: не удалось прочитать request_id из ответа`);
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

    // Найдено по реальному сбою в проде (2026-09-14, HTTP 404 "No
    // handler found on route") — путь БЕЗ "/generations/" подтверждён
    // официальной документацией REST API
    // (docs.x.ai/developers/rest-api-reference/inference/videos):
    // `GET https://api.x.ai/v1/videos/{request_id}`, не
    // `/v1/videos/generations/{request_id}`, как было здесь раньше
    // (путаница с POST-эндпоинтом создания — `/v1/videos/generations`,
    // у него этот сегмент действительно есть, но у GET-статуса нет).
    const res = await axios.get(
      `${XAI_BASE_URL}/videos/${requestId}`,
      { headers: this.headers(), timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true },
    );

    if (res.status >= 400) {
      this.logger.error(
        `Grok video status failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`,
      );
      // М-6.4 седьмого аудита: 404/410 — request_id неизвестен или
      // удалён, это постоянная ошибка, а не «ещё идёт» — иначе опрос
      // крутится до дедлайна с вводящим в заблуждение таймаутом.
      if (res.status === 404 || res.status === 410) {
        return { done: true, error: `xAI: запрос не найден (HTTP ${res.status})` };
      }
      return { done: false, error: `HTTP ${res.status}` };
    }

    const status: string | undefined = res.data?.status;
    // Подтверждено официальной документацией (тот же источник, что и
    // выше) — 'done' действительно так называется в реальном ответе,
    // не догадка; 'completed' оставлен как запасной вариант, если он
    // всё же где-то встретится, ничего не теряя при любом раскладе.
    const isDone = status === 'done' || status === 'completed';
    if (!isDone) {
      // 'error' — тоже не подтверждено буквально; трактуем любой явный
      // статус ошибки как ошибку, не как "ещё идёт".
      // М-6.4: `expired` — третий терминальный статус по документации
      // (done | failed | expired); `error` может быть объектом.
      if (status === 'error' || status === 'failed' || status === 'expired') {
        const raw: unknown = res.data?.error;
        const message =
          typeof raw === 'string'
            ? raw
            : ((raw as { message?: string } | undefined)?.message ??
              (status === 'expired'
                ? 'xAI: запрос истёк (expired)'
                : 'Grok video generation failed'));
        return { done: true, error: message };
      }
      return { done: false };
    }

    // Подтверждено официальной документацией: `video.url` — точная
    // форма реального ответа, не догадка.
    const videoUrl: string | undefined = res.data?.video?.url;
    if (!videoUrl) {
      return { done: true, error: 'Grok video generation: ответ без video.url' };
    }

    return { done: true, videoUrl };
  }
}
