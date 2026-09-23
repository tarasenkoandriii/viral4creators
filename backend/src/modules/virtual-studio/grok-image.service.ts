/**
 * GrokImageService — тонкий клиент к `POST /v1/images/generations` xAI
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §4.1, Этап 1).
 *
 * Отдельный эндпоинт от `GrokVideoService` (`/v1/videos/generations`) —
 * тот уже есть в проекте и переиспользуется студией напрямую для
 * видео-фрагментов (§4.1), этого класса не было нигде: референс-кадр
 * (текст → неподвижная картинка) — единственный шаг всего этого ТЗ,
 * которому действительно нужен новый код, а не переиспользование.
 *
 * По форме — тот же приём, что `GrokVideoService`: свой конструктор без
 * DI-зависимостей (`loadConfiguration()` напрямую), `GROK_API_KEY` (тот
 * же ключ, не отдельный), синхронный HTTP-вызов без поллинга (в отличие
 * от видео — генерация изображения у xAI не асинхронная, ответ
 * приходит сразу телом POST, docs.x.ai).
 *
 * ⚠️ Форма ответа НЕ подтверждена реальным вызовом на момент написания
 * (тот же класс предупреждения, что у `GrokVideoService`, п.1
 * доккомментария класса) — по OpenAI-совместимой конвенции изображений
 * (`data: [{ url }]`, которой xAI явно следует и в документации, и по
 * которой уже написан референсный `generateRefImage()` в SilverFinance)
 * читаем защитно несколько разумных вариантов расположения поля, тем же
 * приёмом, что `HedraClientService.submit()` уже применяет для
 * неподтверждённого `job_id`. ПРОВЕРИТЬ одним тестовым вызовом до
 * первого реального использования в проде.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../config/configuration';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const REQUEST_TIMEOUT_MS = 60_000;

export interface GrokImageResult {
  /** Временная ссылка от xAI — недолговечна, вызывающий обязан
   * перезалить в собственное хранилище (тот же принцип, что у видео,
   * §4.1 ТЗ). */
  url: string;
}

@Injectable()
export class GrokImageService {
  private readonly logger = new Logger(GrokImageService.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const config = loadConfiguration();
    this.apiKey = config.grok.apiKey;
    this.model = config.grok.imageModel;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Имя модели — для составного ключа в `common/ai-pricing.ts`, тот же
   * приём, что `GrokVideoService.modelName`. */
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
   * Генерирует одно изображение по текстовому промпту. `aspectRatio` —
   * тот же формат строки, что и у `GrokVideoService.startGeneration`
   * (`'9:16'`/`'16:9'`/...); студия использует референс-кадр как
   * `start_image` для последующего image-to-video, поэтому формат
   * должен совпадать с тем, что потом попросят у видео.
   */
  async generate(
    prompt: string,
    aspectRatio: string,
  ): Promise<GrokImageResult> {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY не задан');
    }

    const res = await axios.post(
      `${XAI_BASE_URL}/images/generations`,
      {
        model: this.model,
        prompt,
        aspect_ratio: aspectRatio,
      },
      {
        headers: this.headers(),
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );

    if (res.status >= 400) {
      this.logger.error(
        `Grok image generate failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`,
      );
      throw new Error(`Grok image generate failed (HTTP ${res.status})`);
    }

    // Конвенция OpenAI-совместимых image-эндпоинтов — `data: [{ url }]`;
    // защитно проверяем и одиночный объект на случай расхождения формы.
    const first = Array.isArray(res.data?.data) ? res.data.data[0] : res.data;
    const url: string | undefined = first?.url ?? first?.image_url;
    if (!url) {
      this.logger.error(
        `Grok image generate: ответ без url — ${JSON.stringify(res.data)}`,
      );
      throw new Error(
        'Grok image generate: не удалось прочитать url изображения из ответа',
      );
    }

    return { url };
  }
}
