/**
 * Gemini Batch API для ИИ-разметки диалогов (заход 9, хвост Э3-бис (5);
 * ТЗ §5-тер.3 «пакетный режим −50% — ПРОВЕРИТЬ»). КОД ЗА ВЫКЛЮЧАТЕЛЕМ:
 * `ASSIST_LABEL_BATCH=1` — разметка уходит одним пакетным заданием за тик
 * крона `assist-analytics-run`, ответ забирается следующими тиками; без
 * переменной (умолчание) — прежние вызовы по одному.
 *
 * Включает владелец платформы ПОСЛЕ проверки на своём ключе (П): что
 * lite-модель (`ASSIST_LITE_MODEL`) доступна в Batch API и что скидка —
 * `ASSIST_LABEL_BATCH_PRICE_FACTOR` (умолчание 0.5 — «−50%» прайса Google).
 * Деньги: резерв бюджета аналитики — оценка × доля ДО отправки (как у
 * вызова по одному), расход в `site_ai_usage` — по факту токенов × доля,
 * задание не прошло/просрочено — резерв возвращается, диалог — `retry`.
 *
 * Вход модели тот же, что у вызова по одному (`buildLabelPrompt`: только
 * замаскированный текст), ответ проходит тот же `parseLabel`.
 */
import type { GoogleGenAI } from '@google/genai';
import { chatUsageFromMeta } from '../../../shared/assist-chat-core';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import { siteGeminiClient } from '../../site-ai/dev-fake-gemini';

/**
 * Задание без ответа дольше — просрочено: Google обещает ответ за 24 ч, но
 * держит задание до 48 ч (аудит P2-2). Просроченное отменяется и сверяется:
 * резерв возвращается только при подтверждённом сбое — иначе платили бы
 * дважды (старое задание дорабатывает, новое уже отправлено).
 */
export const LABEL_BATCH_STALE_MS = 49 * 60 * 60 * 1000;
/** Заданий, опрашиваемых за тик (каждое — один запрос к Google). */
export const LABEL_BATCH_POLLS_PER_TICK = 10;

export function labelBatchEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.ASSIST_LABEL_BATCH ?? '').trim() === '1';
}

/** Доля цены пакетного вызова от обычного (0 < x ≤ 1; мусор — 0.5). */
export function labelBatchPriceFactor(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.ASSIST_LABEL_BATCH_PRICE_FACTOR ?? '').trim();
  const v = raw === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
}

/**
 * Временное имя задания: строки пишутся до отправки (аудит P3-6). Строки с
 * ним не опрашиваются — после срока просрочки они уходят в retry без
 * возврата резерва (задание могло уйти, а имя — не записаться).
 */
export const LABEL_BATCH_TEMP_PREFIX = 'pending:';

export interface LabelBatchRequest {
  /** id диалога — ключ ответа (метаданные запроса). */
  key: string;
  /** Метаданные резерва (кабинет, сайт, оценка, время) — вернутся в ответе. */
  meta?: Record<string, string>;
  system: string;
  user: string;
  /** Видимый ответ; провайдеру — потолок с запасом (как у вызова по одному). */
  maxOutputTokens: number;
}

export interface LabelBatchResult {
  key: string;
  /** Метаданные запроса, как отправлены. */
  meta?: Record<string, string>;
  /** null — запрос пакета не удался (ошибка в ответе). */
  text: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Состояние задания:
 *  - `pending` — идёт;
 *  - `failed` — упало целиком (денег не взяли — резерв возвращается);
 *  - `succeeded` — готово, ответы по ключам;
 *  - `ended` — отменено/истекло: часть ответов могла быть оплачена — по
 *    ответам расход фактом, без ответа резерв НЕ возвращается.
 */
export type LabelBatchPoll =
  | { state: 'pending' }
  | { state: 'failed' }
  | { state: 'succeeded' | 'ended'; results: LabelBatchResult[] };

/** Пакетный клиент (подменяется в тестах подделкой). */
export interface LabelBatchClient {
  submit(model: string, reqs: LabelBatchRequest[]): Promise<string>;
  poll(name: string): Promise<LabelBatchPoll>;
  /** Отмена просроченного задания (ошибка — не страшно: дальше сверка). */
  cancel(name: string): Promise<void>;
}

const ENDED = new Set(['JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED']);

/** Настоящий клиент: inline-запросы `ai.batches` (@google/genai). */
export class GeminiLabelBatch implements LabelBatchClient {
  private client: Pick<GoogleGenAI, 'batches'> | null = null;

  private get ai(): Pick<GoogleGenAI, 'batches'> {
    this.client ??= siteGeminiClient();
    return this.client;
  }

  async submit(model: string, reqs: LabelBatchRequest[]): Promise<string> {
    const job = await this.ai.batches.create({
      model,
      src: reqs.map((r) => ({
        contents: [{ role: 'user', parts: [{ text: r.user }] }],
        metadata: { ...(r.meta ?? {}), key: r.key },
        config: {
          systemInstruction: r.system,
          maxOutputTokens: geminiOutputCeiling(r.maxOutputTokens),
          temperature: 0,
          responseMimeType: 'application/json',
        },
      })),
      config: { displayName: `assist-label-${Date.now()}` },
    });
    if (!job.name) throw new Error('batch: нет имени задания');
    return job.name;
  }

  async cancel(name: string): Promise<void> {
    await this.ai.batches.cancel({ name });
  }

  async poll(name: string): Promise<LabelBatchPoll> {
    const job = await this.ai.batches.get({ name });
    const state = String(job.state ?? '');
    if (state === 'JOB_STATE_FAILED') return { state: 'failed' };
    if (state !== 'JOB_STATE_SUCCEEDED' && !ENDED.has(state)) {
      return { state: 'pending' };
    }
    const out = job.dest?.inlinedResponses ?? [];
    return {
      state: state === 'JOB_STATE_SUCCEEDED' ? 'succeeded' : 'ended',
      results: out.map((r) => {
        const usage = chatUsageFromMeta(r.response?.usageMetadata);
        const cand = r.response?.candidates?.[0];
        // Ответ пакета — простой объект: текст из частей (без «мыслей»).
        const text = (cand?.content?.parts ?? [])
          .filter((x) => !x.thought && typeof x.text === 'string')
          .map((x) => x.text as string)
          .join('');
        // Обрезанный ответ в дело не идёт (как у вызова по одному).
        const ok = !r.error && cand && cand.finishReason !== 'MAX_TOKENS';
        const { key, ...meta } = r.metadata ?? {};
        return {
          key: key ?? '',
          meta,
          text: ok && text ? text : null,
          inputTokens: usage.in,
          cachedInputTokens: usage.cached,
          outputTokens: usage.out,
        };
      }),
    };
  }
}
