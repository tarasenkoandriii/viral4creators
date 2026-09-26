/**
 * ReplicateSeparationService — разделение дорожки на стемы через
 * Replicate (модель htdemucs).
 *
 * ТЗ: `docs-tz/TZ-Voice-Replace-Keep-Background.md`, этап B.
 *
 * ## Почему Replicate, а не свой воркер
 *
 * Demucs хочет GPU. Своего GPU-воркера у продукта нет вовсе, и заводить
 * его ради одной операции несоразмерно — та же логика, по которой
 * обрезка кадра ушла в хостед-ffmpeg (`ffmpeg-api.service.ts`).
 * Replicate — это ещё один HTTP-провайдер в ряду Veo, Grok и ffmpeg,
 * то есть ноль новых движущихся частей в инфраструктуре.
 *
 * ## Протокол
 *
 * Общий протокол предсказаний Replicate стабилен много лет и здесь
 * используется он, а не что-то специфичное для модели:
 *   - `POST /v1/models/<owner>/<name>/predictions` с `{input}` —
 *     вызов ПОСЛЕДНЕЙ версии модели, хеш знать не нужно; либо
 *     `POST /v1/predictions` с `{version, input}`, если версия
 *     закреплена. Заголовок `Authorization: Bearer <токен>`. В ответе
 *     — `status` (`starting`/`processing`/`succeeded`/`failed`/
 *     `canceled`), `output`, `error` и `urls.get`;
 *   - заголовок `Prefer: wait` просит подождать результат в том же
 *     запросе; если не успело — дочитываем опросом по `urls.get`.
 *
 * Обе формы вызова взяты из рабочего кода владельца в соседнем проекте
 * (`silverfinance/src/lib/server/ideogram.ts`), то есть проверены на
 * живом API, а не по документации.
 *
 * ## Чего мы НЕ знаем наверняка — и почему это не мешает
 *
 * Имена полей ВХОДА у конкретной модели (`audio`, `stem`,
 * `output_format`, …) из среды разработки проверить не удалось: до
 * replicate.com из песочницы нет доступа. Поэтому:
 *   - тело входа собирается в одном месте (`buildInput`) и полностью
 *     переопределяется переменной `REPLICATE_DEMUCS_INPUT` — если
 *     схема окажется другой, это правка переменной, а не деплой;
 *   - ответ разбирается ПО СОДЕРЖИМОМУ, а не по ожидаемой форме:
 *     ищем ссылки среди значений и раскладываем их на «вокал» и
 *     «остальное» по именам ключей. Модель, отдающая два стема, и
 *     модель, отдающая четыре, обе обрабатываются без правок кода.
 *
 * Первый живой вызов на проде обязан подтвердить имена полей — это
 * пункт приёмки этапа B, а не деталь реализации.
 *
 * ## Мягкий фоллбек
 *
 * Ни одного `throw` наружу: не настроено — `skipped: true`, сломалось —
 * `ok: false` с причиной. Ролик должен собраться в любом случае, пусть
 * и по-старому: см. план отката в §9 ТЗ.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AudioSeparationProvider,
  SeparationOutcome,
  SeparationRequest,
} from './audio-separation.types';

/** Ключи, по которым узнаём голосовой стем. Всё остальное — фон. */
const VOCAL_KEYS = ['vocals', 'vocal', 'voice', 'speech'];

/**
 * Ключи, которые заведомо НЕ являются стемами, хотя выглядят как
 * ссылки. Модель может вернуть рядом исходник или отчёт — подмешать
 * исходник в «фон» значило бы вернуть в ролик ровно тот голос, ради
 * удаления которого всё затевалось.
 */
const NOT_A_STEM = ['input', 'source', 'original', 'preview', 'log'];

/** Сколько ждать ответа в самом запросе, прежде чем перейти к опросу. */
const PREFER_WAIT_SECONDS = 60;
/** Потолок ожидания целиком. Разделение восьмисекундного ролика на A100
 *  — порядка 23 с; три минуты это запас, а не норма. */
const TOTAL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

const TERMINAL_OK = 'succeeded';
const TERMINAL_BAD = new Set(['failed', 'canceled']);

@Injectable()
export class ReplicateSeparationService implements AudioSeparationProvider {
  private readonly logger = new Logger(ReplicateSeparationService.name);

  private token(): string | undefined {
    return process.env.REPLICATE_API_TOKEN?.trim() || undefined;
  }

  /**
   * Закреплённая версия модели — НЕОБЯЗАТЕЛЬНА. Без неё вызов идёт на
   * эндпоинт модели и берёт последнюю версию; с ней — на общий
   * эндпоинт предсказаний. Закреплять стоит тогда, когда важна
   * воспроизводимость результата, а не когда просто хочется
   * определённости: у модели разделения смена версии — это обычно
   * улучшение качества, которое мы хотим получить сами собой.
   */
  private version(): string | undefined {
    return process.env.REPLICATE_DEMUCS_VERSION?.trim() || undefined;
  }

  /** Имя модели вида `owner/name`. */
  private model(): string {
    return process.env.REPLICATE_DEMUCS_MODEL?.trim() || 'ryan5453/demucs';
  }

  private base(): string {
    return (
      process.env.REPLICATE_API_BASE_URL?.replace(/\/+$/, '') ||
      'https://api.replicate.com/v1'
    );
  }

  /**
   * Настроен ли провайдер. Достаточно токена: имя модели имеет
   * разумное умолчание, а версия не обязательна вовсе.
   */
  configured(): boolean {
    return !!this.token();
  }

  /**
   * Тело входа. Вынесено отдельно и переопределяется переменной:
   * см. «Чего мы НЕ знаем наверняка» в шапке файла.
   */
  private buildInput(sourceUrl: string): Record<string, unknown> {
    const raw = process.env.REPLICATE_DEMUCS_INPUT?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Ссылка подставляется в любое поле, где стоит плейсхолдер, —
        // так переменная не обязана знать имя поля с аудио.
        const filled: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) {
          filled[k] = v === '{{source}}' ? sourceUrl : v;
        }
        return filled;
      } catch {
        this.logger.warn(
          'REPLICATE_DEMUCS_INPUT — не JSON, использую значения по умолчанию',
        );
      }
    }
    return {
      audio: sourceUrl,
      stem: 'vocals',
      output_format: 'mp3',
    };
  }

  async separate(request: SeparationRequest): Promise<SeparationOutcome> {
    const token = this.token();
    if (!token) {
      return {
        ok: false,
        skipped: true,
        reason:
          'REPLICATE_API_TOKEN не задан — разделение дорожки на этом стенде не подключено',
      };
    }
    const sourceUrl = request.sourceUrl?.trim();
    if (!sourceUrl) {
      return {
        ok: false,
        skipped: true,
        reason: 'нечего разделять: нет ссылки на исходник',
      };
    }

    const started = Date.now();
    try {
      let prediction = await this.create(token, sourceUrl);
      prediction = await this.settle(token, prediction, started);

      if (prediction.status !== TERMINAL_OK) {
        return {
          ok: false,
          reason: `разделение не удалось (${prediction.status ?? 'без статуса'}): ${
            typeof prediction.error === 'string'
              ? prediction.error.slice(0, 200)
              : 'провайдер не назвал причину'
          }`,
        };
      }

      const { backgroundUrls, vocalsUrl } = splitStems(prediction.output);
      if (backgroundUrls.length === 0) {
        return {
          ok: false,
          reason:
            'разделение прошло, но фоновых стемов в ответе нет — проверьте REPLICATE_DEMUCS_INPUT и схему модели',
        };
      }
      return {
        ok: true,
        backgroundUrls,
        vocalsUrl,
        seconds: (Date.now() - started) / 1000,
      };
    } catch (e) {
      return {
        ok: false,
        reason: `разделение сорвалось: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private async create(token: string, sourceUrl: string): Promise<Prediction> {
    const version = this.version();
    // Версия закреплена — общий эндпоинт с полем `version`; не
    // закреплена — эндпоинт модели, который сам возьмёт последнюю.
    const url = version
      ? `${this.base()}/predictions`
      : `${this.base()}/models/${this.model()}/predictions`;
    const input = this.buildInput(sourceUrl);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Просим дождаться результата в этом же запросе: у коротких
        // роликов ответ приходит сразу, и опрос не начинается вовсе.
        Prefer: `wait=${PREFER_WAIT_SECONDS}`,
      },
      // Тернарник здесь для читателя, а не для провода: `JSON.stringify`
      // и так выбрасывает поля со значением `undefined`, так что
      // мутация «слать version всегда» неотличима по байтам. Оставлено
      // явным, потому что две формы вызова — не деталь сериализации, а
      // два разных эндпоинта выше.
      body: JSON.stringify(version ? { version, input } : { input }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`replicate ${res.status}: ${text.slice(0, 300)}`);
    }
    return parseJson(text);
  }

  /** Довести предсказание до терминального статуса опросом. */
  private async settle(
    token: string,
    first: Prediction,
    started: number,
  ): Promise<Prediction> {
    let current = first;
    while (
      current.status !== TERMINAL_OK &&
      !TERMINAL_BAD.has(current.status ?? '')
    ) {
      if (Date.now() - started > TOTAL_TIMEOUT_MS) {
        return { ...current, status: 'timeout' };
      }
      const next = current.urls?.get;
      if (!next) {
        return { ...current, status: 'failed', error: 'нет ссылки на статус' };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(next, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `replicate status ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      current = parseJson(text);
    }
    return current;
  }
}

function parseJson(text: string): Prediction {
  try {
    return JSON.parse(text) as Prediction;
  } catch {
    throw new Error(`replicate вернул не-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Разложить выход модели на «голос» и «всё остальное».
 *
 * Разбираем по содержимому, а не по ожидаемой форме: выход бывает
 * объектом (`{vocals, no_vocals}` или `{vocals, drums, bass, other}`),
 * а бывает и одной ссылкой. Экспортируется ради теста — это та самая
 * часть, где ошибка стоила бы возвращения голоса модели в ролик.
 */
export function splitStems(output: unknown): {
  backgroundUrls: string[];
  vocalsUrl?: string;
} {
  const backgroundUrls: string[] = [];
  let vocalsUrl: string | undefined;

  const isUrl = (v: unknown): v is string =>
    typeof v === 'string' && /^https?:\/\//.test(v);

  if (isUrl(output)) {
    // Одна ссылка без имени — считать её фоном нельзя: с тем же
    // успехом это может быть выделенный голос, и тогда мы вернули бы в
    // ролик ровно то, что убирали.
    return { backgroundUrls: [] };
  }

  if (output && typeof output === 'object') {
    for (const [key, value] of Object.entries(
      output as Record<string, unknown>,
    )) {
      if (!isUrl(value)) continue;
      const name = key.toLowerCase();
      if (NOT_A_STEM.some((n) => name === n)) continue;
      const isVocal =
        VOCAL_KEYS.some((v) => name === v) ||
        // `no_vocals` содержит «vocals», но это ФОН — проверка на
        // отрицание обязана идти раньше проверки на вхождение.
        (VOCAL_KEYS.some((v) => name.includes(v)) &&
          !/^(no|non|without)[-_]/.test(name));
      if (isVocal) {
        vocalsUrl = value;
      } else {
        backgroundUrls.push(value);
      }
    }
  }

  return { backgroundUrls, vocalsUrl };
}
