/**
 * Годится ли значение как адрес, на который можно сослаться наружу.
 *
 * Появилось в `middleware.ts` после боевой проверки этапа 3
 * поздравлений: `SITE_URL` на проде оказался не задан, и дефолт
 * `http://localhost:3003` из `content.ts` превращал редирект в ссылку на
 * машину самого посетителя.
 *
 * Вынесено в общий модуль по находке Ф-4 аудита живого лендинга: тем же
 * дефолтом отравляются не только редиректы, но и `hreflang`/`canonical`,
 * если строить их абсолютными. Одна функция на оба случая — иначе
 * второе место про эту ловушку однажды забудет.
 */
export function isReachableOrigin(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}
