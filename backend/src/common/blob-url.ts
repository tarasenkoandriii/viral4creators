/**
 * Чей это URL — наш или чужой (этап 38, находка А-2.11).
 *
 * ## Что чинится
 *
 * Снимок манифеста бренда (§12) целиком перезаписывается клиентом через
 * открытый `PATCH /sessions/:id/brand-manifest`, а `photoUrl` внутри него
 * до этапа 38 проверялся только как «https-URL». Дальше эти адреса
 * попадали в список референс-изображений, и сервер их скачивал.
 *
 * Цепочка из двух запросов, таким образом, заставляла НАШ сервер сходить
 * по любому адресу, который назовёт клиент, — включая адреса, доступные
 * только изнутри сети. Хуже того, HTTP-статус возвращался в тексте
 * ошибки: это уже не просто запрос, а оракул, по которому чужую сеть
 * можно прощупывать.
 *
 * ## Почему проверяется хост, а не только путь
 *
 * `pathnameFromBlobUrl` (blob-paths.ts) сверяет ПУТЬ и этим защищает от
 * «удалить чужой файл, подсунув свой URL». Здесь задача другая: адрес
 * может иметь идеально правильный путь и вести куда угодно —
 * `https://внутренний-сервис/brand-manifests/bm1/photo.jpg` пройдёт
 * проверку пути и не должен пройти эту. Поэтому проверяются оба: хост И
 * префикс пути.
 *
 * ## Почему список хостов настраиваемый
 *
 * В проде публичные блобы живут на `*.public.blob.vercel-storage.com`.
 * Но стенд может отдавать их со своего домена (Blob разрешает привязать
 * свой), а тесты и локальная разработка — вообще с другого адреса.
 * Зашитый намертво список означал бы «на стенде не работает», а такое
 * лечат отключением проверки — то есть возвратом дыры.
 */

/** Хост публичных блобов Vercel: `<store>.public.blob.vercel-storage.com`. */
const VERCEL_BLOB_SUFFIX = '.public.blob.vercel-storage.com';

/** Префиксы, под которыми лежат ВСЕ наши файлы (см. doc/STORAGE-AUDIT.md). */
export const OWN_BLOB_PREFIXES = [
  'sessions/',
  'projects/',
  'brand-manifests/',
  'library/',
  'publications/',
] as const;

/**
 * Дополнительные хосты через запятую. Пустая переменная НЕ отключает
 * проверку — она лишь ничего не добавляет к списку: «выключить проверку
 * одной пустой переменной» это тот же самый дефект, только с рычагом.
 */
function extraHosts(env: NodeJS.ProcessEnv): string[] {
  return (env.BLOB_PUBLIC_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Хост принадлежит нашему хранилищу. */
export function isOwnBlobHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const h = host.toLowerCase();
  if (h.endsWith(VERCEL_BLOB_SUFFIX)) return true;
  return extraHosts(env).includes(h);
}

/**
 * Адрес указывает на наш файл: правильный хост И путь под нашим
 * префиксом. Всё остальное — чужое, даже если выглядит убедительно.
 */
export function isOwnBlobUrl(
  url: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Только https: http открывает подмену на пути, а file:/gopher: и
  // прочая экзотика в списке протоколов нам не нужны вовсе.
  if (parsed.protocol !== 'https:') return false;
  if (!isOwnBlobHost(parsed.hostname, env)) return false;

  const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  return OWN_BLOB_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Сообщение об отказе. Одинаковое для всех причин — сознательно: разные
 * тексты для «чужой хост» и «чужой путь» превращают отказ в подсказку
 * тому, кто подбирает адрес.
 */
export const FOREIGN_BLOB_URL_MESSAGE =
  'Ссылка на изображение должна вести в хранилище сервиса — загрузите файл через сервис, а не подставляйте внешний адрес';
