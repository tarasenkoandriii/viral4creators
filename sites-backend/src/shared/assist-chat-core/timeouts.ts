// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/timeouts.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Таймауты стрима модели и обрыв по уходу клиента (ТЗ лендинга §4.4):
 * один `AbortController` на запрос, который дёргают три источника —
 * «нет первого токена N мс», «весь ответ дольше M мс» и внешний сигнал
 * (клиент закрыл вкладку). Без внешнего сигнала закрытая вкладка не
 * останавливала платный стрим раньше штатных таймаутов.
 * Чистый модуль (см. шапку `protocol.ts`).
 */

export interface ChatTimeouts {
  /** Сколько ждать первый кусок ответа. */
  firstTokenMs: number;
  /** Потолок на весь ответ целиком. */
  totalMs: number;
}

/** Значения лендинга: 30 с до первого токена, 90 с на весь ответ. */
export const DEFAULT_CHAT_TIMEOUTS: ChatTimeouts = {
  firstTokenMs: 30_000,
  totalMs: 90_000,
};

export interface ChatAbortHandle {
  readonly signal: AbortSignal;
  /** Пришёл первый кусок — таймер первого токена больше не нужен. */
  firstTokenArrived(): void;
  /** Стрим закончился (штатно или ошибкой) — снять оба таймера. */
  clear(): void;
}

export function createChatAbort(
  timeouts: ChatTimeouts,
  externalSignal?: AbortSignal,
): ChatAbortHandle {
  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      externalSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }
  const totalTimer = setTimeout(() => controller.abort(), timeouts.totalMs);
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => controller.abort(),
    timeouts.firstTokenMs,
  );
  const clearFirst = () => {
    if (firstTokenTimer) {
      clearTimeout(firstTokenTimer);
      firstTokenTimer = null;
    }
  };
  return {
    signal: controller.signal,
    firstTokenArrived: clearFirst,
    clear() {
      clearTimeout(totalTimer);
      clearFirst();
    },
  };
}
