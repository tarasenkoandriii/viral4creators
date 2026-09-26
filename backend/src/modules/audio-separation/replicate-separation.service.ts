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
 *   - `POST /v1/predictions` с `{version, input}` и заголовком
 *     `Authorization: Bearer <токен>`. В ответе — `status`
 *     (`starting`/`processing`/`succeeded`/`failed`/`canceled`),
 *     `output`, `error` и `urls.get`;
 *   - хеш версии берётся из `GET /v1/models/<owner>/<name>` →
 *     `latest_version.id` и запоминается на процесс;
 *   - заголовок `Prefer: wait` просит подождать результат в том же
 *     запросе; если не успело — дочитываем опросом по `urls.get`.
 *
 * ## Почему не `POST /v1/models/<owner>/<name>/predictions`
 *
 * Первая редакция звала именно его — приём взят из рабочего кода
 * владельца в соседнем проекте (`silverfinance/.../ideogram.ts`), где
 * он работает годами. Но у приёма есть предусловие, которого я не
 * проверила: этот эндпоинт существует только для ОФИЦИАЛЬНЫХ моделей
 * Replicate. `ideogram-ai/ideogram-v3-turbo` официальная, а
 * `ryan5453/demucs` — сообщественная, и на живом проде вызов вернул
 * `404 {"detail":"The requested resource could not be found."}` — при
 * том что страница модели открывается, токен верный, а деньги за
 * попытку списываются.
 *
 * Отсюда нынешняя форма: версия разрешается всегда, и разница между
 * официальной и сообщественной моделью перестаёт существовать.
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
const PREFER_WAIT_SECONDS = 45;

/**
 * Потолок ожидания целиком.
 *
 * Найдено аудитом этапа C: в первой редакции стояло 180 секунд —
 * число, выбранное «с запасом» и без единого взгляда на то, сколько
 * времени есть у вызывающего. А вызывающий — постобработка внутри
 * функции Vercel с потолком 300 секунд, которая к моменту разделения
 * уже сходила за озвучкой, собрала субтитры и карточки и залила их в
 * Blob; впереди у неё ещё отправка задачи в ffmpeg. Отдать одному
 * шагу три минуты из пяти значит подарить ему право уронить всё
 * остальное. Для сравнения, целые кроновые задания в этом же
 * продукте живут по 120–180 секунд ЦЕЛИКОМ.
 *
 * 60 секунд — это почти втрое больше заявленных ~23 секунд прогона на
 * A100, то есть запас есть, но не за чужой счёт. Не уложились —
 * откат: ролик соберётся по-старому, и это штатный исход, а не сбой
 * (§9 ТЗ). Переопределяется переменной на случай, если на живых
 * роликах окажется иначе — менять код ради одного числа не придётся.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
/** Меньше этого ждать бессмысленно: прогон на A100 заявлен ~23 с. */
const MIN_TOTAL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

/**
 * Читается ПРИ ВЫЗОВЕ, а не при импорте модуля.
 *
 * Найдено сквозным аудитом A–F: все остальные переменные в этом файле
 * (`token()`, `model()`, `base()`) читаются из `process.env` в момент
 * обращения, и только потолок ожидания вычислялся один раз на импорте.
 * Практического вреда на проде нет — там процесс всё равно
 * перезапускается деплоем, — но тесту пришлось городить
 * `jest.resetModules()` с динамическим импортом, и это ровно тот
 * сигнал, что константа притворяется настройкой. Теперь она настройка
 * по-настоящему.
 */
function totalTimeoutMs(): number {
  const raw = Number(process.env.REPLICATE_DEMUCS_TIMEOUT_MS);
  return Math.max(
    MIN_TOTAL_TIMEOUT_MS,
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOTAL_TIMEOUT_MS,
  );
}

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

/** Хеш последней версии по «база|модель». Модель меняется раз в год. */
const versionCache = new Map<string, string>();

const TERMINAL_OK = 'succeeded';
const TERMINAL_BAD = new Set(['failed', 'canceled']);

@Injectable()
export class ReplicateSeparationService implements AudioSeparationProvider {
  private readonly logger = new Logger(ReplicateSeparationService.name);

  private token(): string | undefined {
    return process.env.REPLICATE_API_TOKEN?.trim() || undefined;
  }

  /**
   * Закреплённая версия модели — НЕОБЯЗАТЕЛЬНА: без неё берётся
   * последняя (см. `resolveVersion`). Закреплять стоит ради
   * воспроизводимости результата, а не ради определённости.
   */
  private version(): string | undefined {
    return process.env.REPLICATE_DEMUCS_VERSION?.trim() || undefined;
  }

  /**
   * Хеш версии, которым адресуется прогон.
   *
   * Закреплён переменной — берём его. Нет — спрашиваем у Replicate
   * последнюю и запоминаем на процесс: модель меняется раз в год, а
   * прогонов десятки в день, и платить лишним запросом за каждый
   * незачем. Кеш модульный, а не в экземпляре, потому что сервис
   * живёт в DI одним экземпляром, а тесты создают свои — им общий кеш
   * мешал бы, поэтому ключ включает имя модели и базовый адрес.
   */
  private async resolveVersion(token: string): Promise<string> {
    const pinned = this.version();
    if (pinned) return pinned;

    const model = this.model();
    const key = `${this.base()}|${model}`;
    const cached = versionCache.get(key);
    if (cached) return cached;

    const res = await fetch(`${this.base()}/models/${model}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `модель ${model} недоступна (${res.status}) — проверьте REPLICATE_DEMUCS_MODEL или закрепите версию в REPLICATE_DEMUCS_VERSION`,
      );
    }
    const id = (JSON.parse(text) as { latest_version?: { id?: string } })
      ?.latest_version?.id;
    if (!id) {
      throw new Error(
        `у модели ${model} в ответе нет latest_version.id — закрепите версию в REPLICATE_DEMUCS_VERSION`,
      );
    }
    versionCache.set(key, id);
    return id;
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
      // `sessionId` до сквозного аудита принимался и никуда не шёл.
      // Прогон платный и небыстрый; когда в логе десяток таких строк
      // подряд, единственный способ понять, чьи они, — эта пометка.
      this.logger.log(
        `разделяю дорожку${request.sessionId ? ` (сессия ${request.sessionId})` : ''}`,
      );
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
    const version = await this.resolveVersion(token);
    const input = this.buildInput(sourceUrl);
    const res = await fetch(`${this.base()}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Просим дождаться результата в этом же запросе: у коротких
        // роликов ответ приходит сразу, и опрос не начинается вовсе.
        Prefer: `wait=${PREFER_WAIT_SECONDS}`,
      },
      body: JSON.stringify({ version, input }),
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
      if (Date.now() - started > totalTimeoutMs()) {
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
