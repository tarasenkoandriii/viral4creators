// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/external-url-guard.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

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
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 — ретрансляторы 6to4 (упразднены, RFC 7526)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 — TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 — TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * IPv4 в ЛЮБОЙ записи, которую понимают URL-парсер и `inet_aton`:
 * `127.0.0.1`, `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1` (последняя
 * часть заполняет оставшиеся байты). Без этого `http://0x7f.1/` или
 * адрес из чужого резолвера в «нестандартной» форме прошёл бы мимо
 * проверки, которая ждёт ровно четыре десятичных октета. `null` — не IPv4.
 */
function parseIpv4Any(input: string): string | null {
  const parts = input.split('.');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop(); // `127.0.0.1.`
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part))
      n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) n = Number(part);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  if (last >= 256 ** (5 - nums.length)) return null;
  let value = last;
  head.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join('.');
}

/** IPv6 → восемь 16-битных групп (с хвостом `a.b.c.d`); `null` — не IPv6. */
function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  // Хвост в записи IPv4 (`::ffff:127.0.0.1`, `::127.0.0.1`) → две группы.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    s =
      dotted[1] +
      ((octets[0] << 8) | octets[1]).toString(16) +
      ':' +
      ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = [...head, ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...new Array<number>(fill).fill(0),
    ...tail.map((g) => parseInt(g, 16)),
  ];
}

/** IPv4, вложенный в две группы IPv6. */
function embeddedIpv4(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * IPv6 — тот же список смыслов, что и для IPv4, плюс обёртки, через
 * которые IPv4-адрес прячется в IPv6 (QA-ТЗ §5.4, В-64): адрес сравнивается
 * по ЧИСЛАМ групп, а не по тексту — `::ffff:7f00:1` и `::ffff:127.0.0.1`
 * один и тот же loopback.
 */
function isBlockedIpv6Groups(h: number[]): boolean {
  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((g) => g === 0);
  // ::ffff:0:0/96 — IPv4-отображённый: решает вложенный IPv4.
  if (zeros(0, 5) && h[5] === 0xffff)
    return isBlockedIpv4(embeddedIpv4(h[6], h[7]));
  // ::/96 — `::`, `::1` и упразднённый IPv4-совместимый `::a.b.c.d`;
  // ::ffff:0:0:0/96 (SIIT) — тоже не глобальный адрес.
  if (zeros(0, 6)) return true;
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return true;
  // 64:ff9b::/96 — NAT64 (RFC 6052): шлюз сходит на вложенный IPv4.
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) {
    return isBlockedIpv4(embeddedIpv4(h[6], h[7]));
  }
  // 64:ff9b:1::/48 — NAT64 для локального использования (RFC 8215).
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;
  // 2002::/16 — 6to4: следующие 32 бита — IPv4 ретранслятора.
  if (h[0] === 0x2002) return isBlockedIpv4(embeddedIpv4(h[1], h[2]));
  // 2001::/23 — служебные назначения IETF, в т.ч. Teredo 2001::/32
  // (внутри — замаскированный IPv4 клиента, проверять бессмысленно).
  if (h[0] === 0x2001 && h[1] < 0x200) return true;
  // 2001:db8::/32 и 3fff::/20 — документация (RFC 3849, RFC 9637).
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  if (h[0] === 0x3fff && h[1] < 0x1000) return true;
  // Глобальный юникаст — только 2000::/3. Всё прочее (fe80::/10
  // link-local, fc00::/7 ULA, ff00::/8 multicast, fec0::/10, 100::/64
  // discard, 5f00::/16 …) извне недостижимо или служебное.
  return (h[0] & 0xe000) !== 0x2000;
}

/**
 * Можно ли серверу ходить на этот IP-адрес (результат резолва или
 * IP-литерал из ссылки). `true` — НЕЛЬЗЯ: служебный, приватный,
 * зарезервированный диапазон или строка вовсе не разобралась как адрес
 * (консервативно). Принимает IPv4 в любой записи (`2130706433`,
 * `0177.0.0.1`, `0x7f.1`), IPv6 со скобками и зоной (`[fe80::1%eth0]`).
 *
 * Общая для генератора (фид товаров) и sites-backend (обход сайтов,
 * IP-pin — `site-crawl/net/pinned-fetch.ts`, копия через
 * scripts/sync-sites-shared.mjs).
 */
export function isBlockedAddress(ip: string): boolean {
  let s = String(ip ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s) return true;
  if (s.includes(':')) {
    const groups = parseIpv6(s);
    return groups ? isBlockedIpv6Groups(groups) : true;
  }
  const v4 = parseIpv4Any(s);
  return v4 ? isBlockedIpv4(v4) : true;
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
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
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
