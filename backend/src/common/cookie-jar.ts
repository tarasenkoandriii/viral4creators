/**
 * cookie-jar.ts — перенос cookie jar между отдельными запусками браузера
 * (этап 110).
 *
 * ## Зачем это отдельный примитив
 *
 * `doc/CLIENT-SITE-TUTORIAL-SPEC.md` §5.1 формулирует это как КЛЮЧЕВОЕ
 * архитектурное решение всего визарда, а не деталь: «Каждый шаговый
 * запрос = свежий `launchHeadlessBrowser()` → `page.setCookie(...)`
 * (восстановление куки из предыдущего шага) → `page.goto(lastUrl)` →
 * выполнить РОВНО один новый шаг → … → закрыть браузер». Держать
 * Chromium живым между HTTP-запросами на serverless-функции нельзя
 * архитектурно, поэтому состояние авторизации переезжает из шага в шаг
 * ТОЛЬКО через этот jar. Второе место — §7.4.7: финальная сборка ролика
 * для черновика с `requiresLiveLoginReplay: true` обязана проигрывать
 * СОХРАНЁННЫЕ куки напрямую (капчу/2FA заново пройти нечем).
 *
 * До этого этапа примитива не существовало: `page.setCookie` не
 * встречался в `backend/` ни разу (проверено аудитом этапа 109), то есть
 * самая нагруженная часть §5.1 не имела реализации вообще.
 *
 * ## Почему jar приходит как НЕДОВЕРЕННЫЕ данные
 *
 * Источников два, и оба вне нашего контроля по содержимому: cookie jar,
 * снятый со ЧУЖОГО сайта (`Network.getAllCookies` в `live-login-relay`,
 * §7.4.5), и расшифрованная строка из нашей же БД, которая могла быть
 * записана более старой версией кода. Поэтому вход здесь именно
 * разбирается и нормализуется, а не приводится типом: одна кривая запись
 * не должна ни ронять шаг визарда, ни тихо обнулять весь jar.
 *
 * ## Тонкости CDP, из-за которых это не `map` в одну строку
 *
 * Обе ниже молча ломают ровно те куки, ради которых всё и делается —
 * сессионные куки логина, — и обе невидимы в логах: `Network.setCookies`
 * отвечает успехом, а кука просто не появляется в браузере.
 *
 * 1. `expires: -1` — это то, что `Network.getAllCookies` возвращает для
 *    СЕССИОННОЙ куки. Отправить это значение обратно нельзя: CDP примет
 *    его как «истекает в 1969 году», то есть кука окажется просроченной
 *    сразу же. Правильно — не передавать `expires` вовсе (CDP: «session
 *    cookie if not set»).
 * 2. `sameSite: 'None'` без `secure: true` современный Chromium
 *    отклоняет целиком. Такое сочетание реально прилетает с http-сайтов;
 *    здесь атрибут в этом случае снимается, чтобы кука хотя бы легла с
 *    поведением по умолчанию, а не пропала.
 */

import { decryptToken, encryptToken } from './token-crypto';

/** Ровно то, что отдаёт CDP `Network.getAllCookies` (§7.1
 * doc/LIVE-LOGIN-RELAY-SPEC.md) — та же структура, что реле передаёт
 * backend'у. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** unix-секунды; `-1` — сессионная кука (живёт до закрытия браузера). */
  expires: number;
}

/** То, что уходит в `page.setCookie(...)`: `expires` ОТСУТСТВУЕТ у
 * сессионных кук, а не равен -1 (см. доккомментарий файла). */
export interface SettableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/**
 * Узкий интерфейс страницы — только то, что реально нужно для
 * восстановления. Тот же приём, что `RelayPage` в `live-login-relay`:
 * настоящий `puppeteer-core` `Page` ему структурно удовлетворяет, а
 * тесты подставляют лёгкий мок и проверяют РОВНО форму аргументов,
 * которую мы отдаём в CDP, без запуска Chromium (запустить его в CI
 * этого проекта всё равно нельзя).
 */
export interface CookieSettablePage {
  setCookie(...cookies: SettableCookie[]): Promise<void>;
}

export interface ParsedCookieJar {
  cookies: CdpCookie[];
  /** Сколько записей отброшено при разборе — для лога: «восстановлено 12
   * из 14» это сигнал разбираться, а не тишина. */
  dropped: number;
}

/**
 * Потолок размера сериализованного jar'а. Обычный jar сайта вместе с
 * куками SSO-провайдера — десятки килобайт; 256 КБ с запасом перекрывает
 * реальные случаи и ограничивает то, что уедет в шифрование и в
 * текстовую колонку БД. Превышение — не молчаливое обрезание (обрезанный
 * jar = наполовину авторизованная сессия, худший из возможных исходов), а
 * явная ошибка у вызывающего.
 */
export const MAX_COOKIE_JAR_BYTES = 256 * 1024;

export class CookieJarTooLargeError extends Error {}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Разбирает и нормализует jar из недоверенного источника (ответ реле или
 * расшифрованная строка из БД). Кривые записи отбрасываются поштучно —
 * см. доккомментарий файла, почему не «бросить на первой».
 *
 * Уже просроченные куки тоже отбрасываются: восстанавливать их
 * бессмысленно, а в счётчике `dropped` они честно видны.
 */
export function parseCookieJar(
  raw: unknown,
  now: Date = new Date(),
): ParsedCookieJar {
  const list = Array.isArray(raw) ? raw : [];
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const cookies: CdpCookie[] = [];
  let dropped = Array.isArray(raw) ? 0 : 1;

  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      dropped++;
      continue;
    }
    const c = item as Record<string, unknown>;
    if (!isNonEmptyString(c.name) || !isNonEmptyString(c.domain)) {
      dropped++;
      continue;
    }
    // Пустое ЗНАЧЕНИЕ куки — легально (так гасят куку на стороне сайта),
    // в отличие от пустого имени/домена.
    if (typeof c.value !== 'string') {
      dropped++;
      continue;
    }
    const expires =
      typeof c.expires === 'number' && Number.isFinite(c.expires)
        ? c.expires
        : -1;
    if (expires > 0 && expires <= nowSeconds) {
      dropped++;
      continue;
    }
    const sameSite =
      c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
        ? c.sameSite
        : undefined;
    cookies.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: isNonEmptyString(c.path) ? c.path : '/',
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      ...(sameSite ? { sameSite } : {}),
      expires,
    });
  }

  return { cookies, dropped };
}

/** Преобразование в форму `page.setCookie(...)` — здесь и живут обе
 * тонкости CDP из доккомментария файла. */
export function toSettableCookie(cookie: CdpCookie): SettableCookie {
  const settable: SettableCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  // Тонкость 1: сессионная кука — это ОТСУТСТВИЕ expires, не -1.
  if (cookie.expires > 0) settable.expires = cookie.expires;
  // Тонкость 2: SameSite=None без Secure Chromium отклоняет целиком —
  // лучше положить куку с поведением по умолчанию, чем потерять её.
  if (cookie.sameSite && !(cookie.sameSite === 'None' && !cookie.secure)) {
    settable.sameSite = cookie.sameSite;
  }
  return settable;
}

/**
 * Восстанавливает jar в СВЕЖЕМ браузере — вызывать ДО `page.goto()`
 * (§5.1 ТЗ). Порядок важен не стилистически: `page.setCookie` у
 * puppeteer подставляет текущий URL страницы как `url` куки, если тот
 * начинается с `http` (`cdp/Page.js:506-517`), и тогда домен из jar'а
 * перестал бы быть единственным источником правды. На чистой странице
 * (`about:blank`) подстановки не происходит, и каждая кука ложится
 * ровно на свой домен — включая куки СТОРОННЕГО SSO-провайдера, ради
 * которых §7.4.5 и требует снимать весь jar, а не куки текущей страницы.
 *
 * Пустой список — не ошибка (первый шаг визарда, когда восстанавливать
 * ещё нечего): просто ничего не делаем.
 */
export async function restoreCookieJar(
  page: CookieSettablePage,
  cookies: CdpCookie[],
): Promise<{ restored: number }> {
  if (cookies.length === 0) return { restored: 0 };
  await page.setCookie(...cookies.map(toSettableCookie));
  return { restored: cookies.length };
}

/** Сериализация для хранения. Отдельная функция, чтобы формат
 * шифруемой строки знало ровно одно место. */
export function serializeCookieJar(cookies: CdpCookie[]): string {
  const json = JSON.stringify(cookies);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_COOKIE_JAR_BYTES) {
    throw new CookieJarTooLargeError(
      `cookie jar ${bytes} байт превышает потолок ${MAX_COOKIE_JAR_BYTES} — сохранять обрезанный jar нельзя, это наполовину авторизованная сессия`,
    );
  }
  return json;
}

/**
 * Шифрование jar'а для хранения в БД (§7.4.5 ТЗ — «cookies шифруются
 * `token-crypto.ts`, тем же способом, что и `credentialsEnc`»).
 *
 * Ключ — ПАРАМЕТР, а не чтение `process.env` внутри: ровно так устроен и
 * сам `token-crypto.ts`, и это здесь принципиально. Схема БД фиксирует
 * правило «разные секреты разной чувствительности не должны делить один
 * ключ шифрования» (`schema.prisma`, комментарий у `PublishingChannel`),
 * так что когда клиентская обучалка будет реализована, ей заводят СВОЙ
 * ключ, а не переиспользуют `CHANNEL_TOKEN_KEY`. Этот модуль сознательно
 * не решает за неё, какой именно, и не добавляет переменную окружения,
 * которую сегодня никто не читает.
 */
export function encryptCookieJar(cookies: CdpCookie[], key: string): string {
  return encryptToken(serializeCookieJar(cookies), key);
}

/** Обратная операция. Расшифрованное содержимое всё равно проходит
 * `parseCookieJar` — строка в БД могла быть записана прошлой версией
 * кода, а мы не обязаны ей доверять. */
export function decryptCookieJar(
  encrypted: string,
  key: string,
  now: Date = new Date(),
): ParsedCookieJar {
  const plain = decryptToken(encrypted, key);
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    return { cookies: [], dropped: 1 };
  }
  return parseCookieJar(raw, now);
}
