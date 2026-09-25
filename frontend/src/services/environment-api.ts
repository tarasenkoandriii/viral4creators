/**
 * Отправка окружения (этап 156,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.4).
 *
 * ## Когда шлём
 *
 * Один раз за запуск приложения и только ВНУТРИ Telegram. Причина —
 * не в том, что окружение браузера неинтересно (поле `surface` как раз
 * про это), а в 401: `POST /me/environment` требует личность, внутри
 * Telegram она есть всегда (initData), а в обычном браузере отличить
 * вошедшего от анонимного без ещё одного запроса нельзя — cookie входа
 * httpOnly. Платить за это 401-й на каждом анонимном заходе — и шумом
 * в консоли (см. интерцептор в `api.ts`, он пишет каждую ошибку), и
 * лишним запросом — дороже, чем пропустить редкий путь «браузер +
 * вход»: тестировщик работает в мини-аппе.
 *
 * ## Почему не сразу, а после разворота окна
 *
 * Аудит этапа 156. `initTelegramWebApp()` зовёт `webApp.expand()` при
 * загрузке, но разворачивает окно САМ КЛИЕНТ Telegram и делает это
 * позже — о результате он сообщает событием `viewportChanged`. Снимок,
 * снятый на монтировании, записывал бы «сжатую» высоту и называл её
 * видимой областью, то есть врал бы ровно в том поле, ради которого
 * заведён («не влезло» меряют по нему).
 *
 * Ожидание с потолком — в `lib/viewport-settle.ts`, под тестом: это
 * код про время, а такой ломается молча.
 *
 * ## Почему тихо
 *
 * Окружение — довесок к будущему тикету, а не действие человека. Ни
 * успех, ни отказ ему показывать нечего, и уронить запуск приложения
 * из-за него нельзя.
 */

import { api } from './api';
import { getTelegramWebApp } from '../lib/telegram';
import { readEnvironment } from '../lib/environment';
import { whenViewportSettled } from '../lib/viewport-settle';

export async function reportEnvironment(uiLocale: string): Promise<void> {
  const webApp = getTelegramWebApp();
  if (!webApp?.initData) return;
  try {
    await whenViewportSettled(webApp);
    await api.post('/me/environment', readEnvironment(uiLocale));
  } catch {
    /* окружение необязательно — молчим */
  }
}
