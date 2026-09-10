/**
 * Guard against SSRF (Server-Side Request Forgery) для ссылок, которые
 * ПОЛЬЗОВАТЕЛЬ подставляет сам (этап 68, товарный фид — §47).
 *
 * ## Чем это отличается от `common/blob-url.ts`
 *
 * `isOwnBlobUrl()` решает противоположную задачу: убедиться, что URL —
 * ЭТО НАШ файл (чтобы не принять чужой адрес там, где ожидается только
 * свой Blob). Здесь — наоборот: пользователь ЯВНО указывает ЧУЖОЙ адрес
 * (ссылку на свой YML/CSV-фид на Rozetka/Prom/своём сайте), и сервер
 * обязан его скачать. Отклонять «не наш хост» бессмысленно — это и есть
 * весь смысл фичи, — но нужно не дать сервером сходить туда, куда
 * снаружи дойти нельзя: во внутреннюю сеть хостинга, на localhost, на
 * метаданные облака (169.254.169.254 — классический вектор кражи
 * учётных данных инстанса), и так далее. Тот же класс уязвимости, что
 * закрыт в `blob-url.ts` (этап 38, находка А-2.11) для чужого URL в
 * манифесте бренда, но с противоположным списком допустимого: там
 * «разрешён только наш хост», здесь «запрещены только служебные диапазоны».
 *
 * ## Почему резолвится DNS, а не проверяется только строка хоста
 *
 * `http://ссылка-продавца.com/feed.xml` синтаксически безобиден — но
 * если её DNS-запись указывает на `127.0.0.1` или на приватный IP,
 * сервер, ничего не подозревая, обратится к самому себе или во
 * внутреннюю сеть хостинга. Проверять нужно РЕЗУЛЬТАТ резолва, а не
 * текст ссылки.
 *
 * ## Остаточный риск (DNS rebinding)
 *
 * Между этой проверкой и фактическим TCP-соединением DNS-запись может
 * измениться (атакующий контролирует свой собственный DNS-сервер и
 * отдаёт безопасный адрес на резолве, вредоносный — на самом
 * подключении). Честная защита — резолвить один раз и подключаться по
 * УЖЕ полученному IP, минуя повторный DNS-запрос сетевого стека. В
 * проекте нет ни одного прецедента IP-pinned fetch (модуль `undici`/
 * встроенный `fetch` таких настроек не даёт без ручной подмены
 * DNS-резолвера), и городить это ради разового импорта фида — за
 * рамками этапа. Смягчение: вызов повторяется дважды — один раз при
 * создании запуска импорта (быстрый отказ на явно опасный URL), второй
 * раз непосредственно перед скачиванием в воркере (см.
 * `product-feed-import-worker.service.ts`) — окно для rebinding-атаки
 * тем самым не «весь путь запроса», а только сам вызов `fetch`.
 */

import { promises as dns } from 'dns';

export class UnsafeExternalUrlError extends Error {}

export const UNSAFE_EXTERNAL_URL_MESSAGE =
  'Ссылка недоступна извне или указывает на служебный адрес — укажите публичную ссылку на файл фида';

/** IPv4 — приватные/служебные/зарезервированные диапазоны (RFC 1918, RFC 5735 и др.). */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true; // не распарсили как IPv4 — блокируем консервативно
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // "эта сеть"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, carrier-grade NAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, включая метаданные облака 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 — TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 — TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** IPv6 — тот же список смыслов, что и для IPv4, в терминах диапазонов v6. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified

  // IPv4-отображённые адреса (::ffff:a.b.c.d) — проверяем как обёрнутый IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  const firstHextet = parseInt(lower.split(':')[0] || '0', 16) || 0;
  if (firstHextet >>> 6 === 0b1111111010) return true; // fe80::/10 — link-local
  if (firstHextet >>> 9 === 0b1111110) return true; // fc00::/7 — unique local (ULA)
  return false;
}

function isBlockedIp(family: 4 | 6, ip: string): boolean {
  return family === 4 ? isBlockedIpv4(ip) : isBlockedIpv6(ip);
}

/**
 * Бросает `UnsafeExternalUrlError`, если ссылку небезопасно скачивать
 * с сервера: неподдерживаемая схема, либо ЛЮБОЙ из резолвящихся
 * адресов хоста попадает в служебный/приватный диапазон. Вызывающий
 * код обязан поймать это и вернуть пользователю понятную ошибку
 * (`UNSAFE_EXTERNAL_URL_MESSAGE`), а не техническую деталь резолва —
 * то же соображение «одинаковое сообщение для всех причин», что и в
 * `blob-url.ts`, чтобы отказ не превращался в подсказку для подбора
 * адреса.
 */
export async function assertPubliclyRoutableUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    // Хост не резолвится — не наша забота чинить чужой DNS, но и
    // разрешать нечего: тот же отказ, что и на явно опасный адрес.
    throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
  }
  if (addresses.length === 0) {
    throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
  }
  // Блокируем, если ХОТЯ БЫ один из резолвящихся адресов небезопасен —
  // резолвер может отдать несколько A/AAAA-записей, и полагаться на
  // то, какую из них выберет клиент сети, нельзя.
  for (const { address, family } of addresses) {
    if (isBlockedIp(family === 6 ? 6 : 4, address)) {
      throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
    }
  }
}

/**
 * `fetch`, устойчивый к обходу guard'а через HTTP-редирект (пятый аудит,
 * Д-3.1): обычный `fetch(url)` с проверкой ТОЛЬКО исходного `url`
 * ничего не мешает серверу-жертве ответить `302 Location:
 * http://169.254.169.254/...` — сам `fetch` послушно пойдёт по
 * редиректу мимо `assertPubliclyRoutableUrl`, ведь она вызывалась один
 * раз и только для стартового адреса. Здесь редирект НЕ передаётся
 * движку сети (`redirect: 'manual'`) — каждый хоп читается вручную,
 * заново резолвится и заново проверяется той же функцией, прежде чем
 * последовать по нему.
 */
export async function fetchPubliclyRoutable(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPubliclyRoutableUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    if (hop >= maxRedirects) {
      throw new UnsafeExternalUrlError(UNSAFE_EXTERNAL_URL_MESSAGE);
    }
    const location = res.headers.get('location');
    if (!location) return res; // редирект без Location — отдаём как есть, вызывающий код увидит !res.ok
    current = new URL(location, current).toString();
  }
}

export class BodyTooLargeError extends Error {}

/**
 * Читает тело ответа С ПОТОКОВЫМ ограничением размера (пятый аудит,
 * Д-3.2). До этой функции оба потребителя (фид, фото товара из фида)
 * проверяли размер ПОСТФАКТУМ: сверялись с `Content-Length`, если он
 * есть, а затем всё равно читали ВЕСЬ ответ целиком (`res.text()`/
 * `res.arrayBuffer()`) и только тогда сверяли фактический размер. Обе
 * проверки бесполезны против источника, который либо не шлёт
 * `Content-Length` (chunked-ответ), либо занижает его (сжатие снимается
 * клиентом до подсчёта) — сервер всё равно успевал бы буферизовать в
 * памяти сколь угодно большое тело чужого ответа ПРЕЖДЕ, чем отказать.
 *
 * Здесь тело читается чанками через `res.body` (Web `ReadableStream`,
 * которую отдаёт нативный `fetch`); как только пройденный объём
 * превышает `maxBytes`, поток отменяется (`reader.cancel()`) и выше
 * бросается `BodyTooLargeError` — источник не может заставить сервер
 * удержать в памяти больше объявленного предела, вне зависимости от
 * того, что он сообщил (или не сообщил) в заголовках.
 *
 * Если `res.body` недоступен (окружение без поддержки потоковых тел
 * `fetch` — в проде не встречается, но защищаемся) — откатываемся к
 * прежнему постфактум-варианту через `res.arrayBuffer()`, что не хуже,
 * чем было до этой правки.
 */
export async function readBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new BodyTooLargeError();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
