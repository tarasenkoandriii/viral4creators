/**
 * Поддомен обучалок по сайту заказчика — `tutorial.viral4creators.app`.
 *
 * Решение владельца продукта — то же, что для поздравлений: тот же
 * проект `landing/`, не третье приложение. Поддомен подключён к тому же
 * деплою Vercel и отдаёт ту же сборку, а отличается только тем, что
 * показывает по корню.
 *
 * Отсюда та же главная опасность, что у `greeting-host.ts`: один и тот
 * же HTML доступен и по `welcome…/ru/site-tutorial`, и по
 * `tutorial…/ru`, и без разведения адресов две страницы конкурировали
 * бы в выдаче за одни и те же запросы. Каноническое место одно —
 * `https://tutorial…/<locale>`, — а `middleware.ts` сводит к нему
 * остальные пути.
 *
 * Отдельный модуль, а не пара констант рядом с поздравлениями: ветка
 * хоста в middleware читается построчно, и «какой это сайт» должно
 * отвечаться одной функцией на сайт, а не общим `switch`, в который
 * каждый новый поддомен дописывает по условию.
 */

export const TUTORIAL_HOST =
  process.env.NEXT_PUBLIC_TUTORIAL_HOST ?? 'tutorial.viral4creators.app';

/** Абсолютный адрес поддомена — для canonical, sitemap и robots. */
export const TUTORIAL_SITE_URL = `https://${TUTORIAL_HOST}`;

/**
 * Тот ли это хост. Заголовок `Host` приходит с портом на dev-стенде
 * (`tutorial.localhost:3003`) — порт отбрасываем, иначе локально ветка
 * не сработает ни разу и расхождение с продом вылезет только на нём.
 */
export function isTutorialHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return host.split(':')[0].toLowerCase() === TUTORIAL_HOST.toLowerCase();
}

/** Канонический адрес страницы обучалок для данной локали. */
export function tutorialPageUrl(locale: string): string {
  return `${TUTORIAL_SITE_URL}/${locale}`;
}
