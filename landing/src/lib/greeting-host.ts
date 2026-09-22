/**
 * Поддомен поздравлений — `greeting.viral4creators.app` (этап 3 плана
 * docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md, находка 1.6).
 *
 * Решение владельца продукта: тот же проект `landing/`, не второе
 * приложение. Поддомен подключён к тому же деплою Vercel и отдаёт ту же
 * сборку, а отличается только тем, что показывает по корню.
 *
 * Отсюда главная опасность этой конфигурации — дубль контента: один и
 * тот же HTML доступен и по `welcome…/ru/greetings`, и по
 * `greeting…/ru`, и без разведения адресов две страницы конкурировали
 * бы друг с другом в выдаче за одни и те же запросы. Поэтому здесь
 * задано одно каноническое место — `https://greeting…/<locale>`, — а
 * `middleware.ts` сводит к нему все остальные пути: на поддомене
 * `/<locale>/greetings` редиректом схлопывается в `/<locale>`, на
 * главном домене `/<locale>/greetings` редиректом уходит на поддомен.
 *
 * Хост в переменной окружения по тому же принципу, что `TMA_URL` и
 * `MARKETPLACE_URL` в content.ts: адрес может смениться, а дефолт
 * годится для прода.
 */

export const GREETING_HOST =
  process.env.NEXT_PUBLIC_GREETING_HOST ?? 'greeting.viral4creators.app';

/** Абсолютный адрес поддомена — для canonical, sitemap и robots. */
export const GREETING_SITE_URL = `https://${GREETING_HOST}`;

/**
 * Тот ли это хост. Заголовок `Host` приходит с портом на dev-стенде
 * (`greeting.localhost:3003`) — порт отбрасываем, иначе локально ветка
 * не сработает ни разу и расхождение с продом вылезет только на нём.
 */
export function isGreetingHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return host.split(':')[0].toLowerCase() === GREETING_HOST.toLowerCase();
}

/** Канонический адрес страницы поздравлений для данной локали. */
export function greetingPageUrl(locale: string): string {
  return `${GREETING_SITE_URL}/${locale}`;
}
