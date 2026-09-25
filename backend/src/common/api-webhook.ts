/**
 * Вебхуки внешнего API (этап 146, docs-tz/TZ-Vneshnee-API.md) — подпись
 * и проверка адреса. Чистый модуль: сеть снаружи.
 *
 * ## Чем подписываем, если ключа у нас нет
 *
 * Ключ API мы не храним — только его sha-256 (этап 144), и подписать
 * им поэтому нечем. Зато этот же хеш чужая сторона получает в одну
 * строку из своего ключа: `sha256(ключ)` в hex. Он и служит секретом
 * подписи.
 *
 * Отдельного секрета нет намеренно. Он означал бы вторую церемонию
 * «показываем один раз», второе место, где его теряют, и второе поле,
 * которое надо уметь перевыпускать. А выигрыш был бы только в одном
 * случае — если бы секрет подписи давали тому, кому не давали ключ; у
 * нас таких нет: вебхук уходит на адрес, который назвал владелец ключа.
 * Побочное следствие приятное: перевыпуск ключа меняет и подпись.
 *
 * ## Почему в подпись входит время
 *
 * Без него перехваченный запрос можно повторять вечно, и он будет
 * проходить проверку. Время в подписи даёт принимающей стороне право
 * отказать старому — она сравнивает `X-V4C-Timestamp` со своими часами.
 * Окно выбирает она: наше дело — дать ей, чем проверять.
 */

import { createHmac } from 'crypto';

export const SIGNATURE_HEADER = 'X-V4C-Signature';
export const TIMESTAMP_HEADER = 'X-V4C-Timestamp';

/**
 * Подпись доставки: `sha256=<hex>` от `<время>.<тело>`.
 *
 * Точка между ними не украшение: без разделителя время «1" + тело
 * «23…» и время «12» + тело «3…» дали бы одну подпись, и подменить
 * одно другим стало бы возможно, не трогая подписи.
 */
export function signWebhook(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `sha256=${mac}`;
}

/** Хосты, на которые наш сервер ходить не должен ни при каких условиях. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
]);

/**
 * Годится ли адрес для доставки.
 *
 * Адрес называет чужой человек, а ходит по нему НАШ сервер — изнутри
 * нашей же сети. Это классический способ заставить чужой сервер
 * постучаться туда, куда снаружи не достучаться: в метаданные облака за
 * ключами, в служебные адреса, в соседний контейнер. Поэтому список
 * разрешённого, а не запрещённого: только `https`, только публичный
 * хост, без логина с паролем в адресе.
 *
 * Полной защиты это не даёт — имя может указывать на внутренний адрес,
 * и разрешить его может DNS уже после проверки. Но закрывает всё, что
 * делается одной строкой в поле ввода, а остальное стоит сетевого
 * периметра, которого у serverless нет.
 */
export function isDeliverableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Только https: по http подпись и тело уедут открытым текстом, и
  // подписывать их было бы самообманом.
  if (url.protocol !== 'https:') return false;
  // Логин с паролем в адресе — это чужой секрет в нашей базе и в наших
  // логах, которого мы не просили.
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  // Имя без точки — это внутреннее имя сети, а не адрес в интернете.
  if (!host.includes('.') && !host.includes(':')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isPrivateAddress(host)) return false;
  return true;
}

/** Частные и служебные диапазоны IPv4 и IPv6, записанные адресом. */
function isPrivateAddress(host: string): boolean {
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Доставка удалась. 2xx и только он: 3xx — это «не здесь». */
export function isDelivered(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * Повторять ли после такого ответа.
 *
 * 4xx (кроме 408 и 429) — это «ты прислал не то»: повтор пришлёт то же
 * самое. 5xx и сетевые осечки — «у меня сейчас плохо», и это как раз
 * то, ради чего повторы существуют.
 */
export function isRetryable(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}
