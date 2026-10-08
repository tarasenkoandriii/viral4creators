// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/stream-chat.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Генератор событий стрима ответа модели (ТЗ лендинга §4.4, ТЗ помощника
 * §4.2 строка `assist-chat-core`).
 *
 * Что делает: открывает стрим с сигналом отмены (таймауты + уход
 * клиента), отдаёт `token` без разделителя блока действий, в конце —
 * `actions` (если есть) и `done` с токенами; при сбое — ровно одно
 * `error`. Наружу НЕ бросает: вызывающий (контроллер SSE/JSON) не должен
 * ловить ничего, кроме сбоев транспорта.
 *
 * Чего НЕ делает (это решает продукт): настройки, бюджет, промпт, учёт
 * расходов и журнал. Итог стрима — возвращаемое значение генератора
 * (`yield*` его отдаёт), чтобы продукт записал журнал и на штатном пути,
 * и на сбое — «что успело накопиться» тоже стоило денег.
 * Чистый модуль (см. шапку `protocol.ts`).
 */
import {
  ACTIONS_DELIMITER,
  DelimiterStreamBuffer,
  splitActionsBlock,
} from './delimiter-buffer';
import {
  ChatStreamEvent,
  chatUsageFromMeta,
  GeminiUsageMeta,
} from './protocol';
import { ChatTimeouts, createChatAbort } from './timeouts';

/** Кусок стрима — подмножество `GenerateContentResponse` из `@google/genai`. */
export interface ModelStreamChunk {
  text?: string;
  usageMetadata?: GeminiUsageMeta;
}

export interface RunChatStreamOptions<TAction, TErrorCode extends string> {
  /** Открыть стрим модели; `signal` обязан уйти в запрос (abortSignal). */
  openStream(signal: AbortSignal): Promise<AsyncIterable<ModelStreamChunk>>;
  timeouts: ChatTimeouts;
  /** Уход клиента (закрытие вкладки/соединения). */
  externalSignal?: AbortSignal;
  /** Разбор и дообогащение блока действий (сырой JSON после разделителя). */
  resolveActions(rawActionsJson: string | null): Promise<TAction[]>;
  /** Событие ошибки на сбой стрима; здесь же продукт пишет свой лог. */
  upstreamError(error: unknown): { code: TErrorCode; message: string };
  delimiter?: string;
}

export interface ChatStreamOutcome {
  ok: boolean;
  /** Весь текст модели, включая разделитель и блок действий. */
  fullText: string;
  /** Последний `usageMetadata` стрима (у Gemini — в последнем куске). */
  usageMeta: GeminiUsageMeta | null;
}

export async function* runChatStream<TAction, TErrorCode extends string>(
  options: RunChatStreamOptions<TAction, TErrorCode>,
): AsyncGenerator<ChatStreamEvent<TAction, TErrorCode>, ChatStreamOutcome> {
  const delimiter = options.delimiter ?? ACTIONS_DELIMITER;
  const abort = createChatAbort(options.timeouts, options.externalSignal);
  const buffer = new DelimiterStreamBuffer(delimiter);
  let usageMeta: GeminiUsageMeta | null = null;

  // `finally`: потребитель может бросить генератор посреди стрима
  // (`break` → `return()` — клиент ушёл); без него таймеры первого токена и
  // общего срока висели бы до срабатывания (аудит пакета Е, заход 10).
  try {
    try {
      const stream = await options.openStream(abort.signal);
      for await (const chunk of stream) {
        abort.firstTokenArrived();
        if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
        const t = buffer.push(chunk.text ?? '');
        if (t) yield { type: 'token', t };
      }
    } catch (error) {
      abort.clear();
      const { code, message } = options.upstreamError(error);
      yield { type: 'error', code, message };
      return { ok: false, fullText: buffer.fullText, usageMeta };
    }
  } finally {
    abort.clear();
  }

  // Хвост, придержанный буфером (обычная концовка без разделителя).
  const tail = buffer.flush();
  if (tail) yield { type: 'token', t: tail };

  const { rawActionsJson } = splitActionsBlock(buffer.fullText, delimiter);
  const actions = await options.resolveActions(rawActionsJson);
  if (actions.length > 0) yield { type: 'actions', items: actions };

  yield { type: 'done', usage: chatUsageFromMeta(usageMeta) };
  return { ok: true, fullText: buffer.fullText, usageMeta };
}
