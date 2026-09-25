/**
 * Дождаться, пока Telegram развернёт окно (аудит этапа 156).
 *
 * `initTelegramWebApp()` зовёт `webApp.expand()` при загрузке, но
 * разворачивает окно САМ КЛИЕНТ и делает это позже — о результате он
 * сообщает событием `viewportChanged`. Всё, что меряет видимую область
 * раньше, меряет «сжатую» высоту.
 *
 * Отдельным файлом, а не внутри `services/environment-api.ts`, по одной
 * причине: это код про ВРЕМЯ, а такой код ломается молча — событие
 * перестаёт приходить, обработчик не снимается, ожидание не кончается,
 * и наружу это выглядит как «окружения почему-то нет». Здесь он без
 * единого импорта кроме типа, а значит под тестом.
 */

import type { TelegramWebApp } from './telegram';

/**
 * Потолок ожидания. Клиент может не прислать событие вовсе — окно уже
 * развёрнуто, менять нечего, — и тогда снимок обязан уйти всё равно.
 * Ожидание без потолка означало бы, что у части тестировщиков
 * окружения не будет никогда.
 */
export const SETTLE_MS = 1500;

export function whenViewportSettled(
  webApp: Pick<TelegramWebApp, 'onEvent' | 'offEvent'>,
  timeoutMs: number = SETTLE_MS
): Promise<void> {
  // Старый клиент без подписки на события — ждать нечего и нечем.
  if (!webApp.onEvent || !webApp.offEvent) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Снимаем обработчик обязательно: подписка живёт столько же,
      // сколько мини-апп, а нужна она была один раз.
      webApp.offEvent?.('viewportChanged', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    webApp.onEvent?.('viewportChanged', finish);
  });
}
