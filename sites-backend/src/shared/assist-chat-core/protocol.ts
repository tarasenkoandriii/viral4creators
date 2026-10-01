// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/protocol.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Протокол событий стрима консультанта — общий для лендинга
 * (`modules/assistant`) и Помощника (`sites-backend`, ТЗ помощника §4.2,
 * строка `assist-chat-core`).
 *
 * Модуль ЧИСТЫЙ: ни Nest, ни Prisma, ни `process.env`, ни импортов вне
 * своей папки — его побайтно копирует `scripts/sync-sites-shared.mjs` в
 * `sites-backend/src/shared/`, и любой внешний импорт сломал бы копию.
 */

/** Сводка токенов в `done` — та же форма, что отдаёт лендинг с первого дня. */
export interface ChatUsageSummary {
  in: number;
  out: number;
  cached: number;
}

/**
 * События стрима. Действие и код ошибки — параметры: у лендинга свой
 * словарь `kind` и свои коды, у Помощника будут свои (ТЗ §4.9), а форма
 * событий одна — на ней держатся и SSE, и JSON-запасной путь контроллера.
 */
export type ChatStreamEvent<TAction, TErrorCode extends string = string> =
  | { type: 'token'; t: string }
  | { type: 'actions'; items: TAction[] }
  | { type: 'done'; usage: ChatUsageSummary }
  | { type: 'error'; code: TErrorCode; message: string };

/** `usageMetadata` ответа Gemini SDK — в той части, что нужна для учёта. */
export interface GeminiUsageMeta {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Токены из `usageMetadata`. «Мысли» модели считаются выходом: за них
 * платят по ставке выхода, и без них расход в `done` занижался бы.
 */
export function chatUsageFromMeta(
  meta: GeminiUsageMeta | null | undefined,
): ChatUsageSummary {
  return {
    in: meta?.promptTokenCount ?? 0,
    out: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cached: meta?.cachedContentTokenCount ?? 0,
  };
}

/** Реплика диалога в нашем контракте (роль `assistant`, не `model`). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeminiContent {
  role: string;
  parts: { text: string }[];
}

/**
 * Gemini называет ответ модели ролью `model`, наш контракт — `assistant`;
 * перевод в одном месте, чтобы второй продукт не завёл свой вариант.
 */
export function toGeminiContent(m: ChatMessage): GeminiContent {
  return {
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  };
}
