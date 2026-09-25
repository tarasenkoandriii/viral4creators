/**
 * Окружение находки — чем её воспроизводить (этап 156,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.4).
 *
 * ## Разделение на две функции
 *
 * `readEnvironment()` только собирает глобальные значения и ничего не
 * решает; `describeEnvironment()` — чистая, и в ней вся нормализация.
 * Тому же разделению следует весь проект, и здесь у него своя причина:
 * нормализацию пишем мы, и она будет ошибаться на устройствах, которых
 * мы не видели, — значит она обязана быть под тестом.
 *
 * ## Почему сырой `ua` хранится рядом с выведенными полями
 *
 * Именно потому, что нормализация ошибётся. Сырая строка позволяет
 * переразобрать задним числом, когда станет понятно, КАК она ошибалась;
 * без неё останется только неверный ответ без следа вопроса.
 *
 * ## Почему нет библиотеки разбора `ua`
 *
 * Внутри Telegram надёжнее `platform` от самого клиента: он приходит
 * от приложения, а строку `User-Agent` браузеры год за годом сокращают
 * и замораживают. Нужное нам — семейство ОС и вид устройства — это
 * десяток строк с закрытым списком; сотня килобайт зависимости ради
 * них несоразмерна.
 */

import { getTelegramWebApp } from './telegram';
import { APP_BUILD } from './build-info';

/** Потолок длины любого строкового поля окружения. */
export const MAX_FIELD = 512;

export interface RawEnvironment {
  /** initData непустой — значит мы внутри Telegram. */
  hasTelegram: boolean;
  tgPlatform: string | null;
  tgVersion: string | null;
  tgColorScheme: string | null;
  /** Язык клиента Telegram — только исходное умолчание интерфейса. */
  tgLanguage: string | null;
  ua: string | null;
  /**
   * Сколько одновременных касаний держит экран. Единственное, чем iPad
   * на iPadOS 13+ отличается от настоящего Mac: строка `User-Agent` у
   * них одна и та же (`Macintosh`), а касаний у Mac ноль.
   */
  maxTouchPoints: number | null;
  browserLanguage: string | null;
  /** Локаль ИНТЕРФЕЙСА — то, на каком языке человек видел экран. */
  uiLocale: string;
  /**
   * Тема, В КОТОРОЙ человек видел экран, — не `tgColorScheme`.
   *
   * Этап 81 уже прошёл ровно это различие для самого интерфейса:
   * `webApp.colorScheme` — тема САМОГО Telegram, а явный выбор человека
   * внутри приложения сильнее её, и источником истины там назначен класс
   * `dark` на `<html>`. Снимок обязан спрашивать тот же источник:
   * «поехала вёрстка в тёмной» про то, что человек видел, а не про то,
   * какая тема стоит в Telegram.
   */
  theme: string | null;
  screen: { w: number; h: number; dpr: number } | null;
  viewport: { w: number; h: number } | null;
  network: string | null;
  appBuild: string;
}

export type Surface = 'TMA' | 'BROWSER';
export type DeviceKind = 'PHONE' | 'TABLET' | 'DESKTOP';

export interface Environment extends RawEnvironment {
  surface: Surface;
  osFamily: string;
  osVersion: string | null;
  deviceKind: DeviceKind;
}

/** Родные клиенты Telegram — по ним вид устройства известен точно. */
const NATIVE_PHONE = new Set(['ios', 'android']);
const NATIVE_DESKTOP = new Set(['tdesktop', 'macos', 'windows', 'linux']);

/**
 * iPad ли это.
 *
 * Два разных случая, и первый обманчиво прост. В РОДНОМ клиенте
 * Telegram (WKWebView с настройками по умолчанию) строка честно
 * содержит `iPad` — здесь достаточно её. А вот в Safari и в Telegram
 * Web на iPadOS 13+ включён «desktop-class browsing», и строка
 * СОВПАДАЕТ с маковской — `Macintosh; Intel Mac OS X`. Отличить их
 * можно только по касаниям: у Mac `maxTouchPoints` равен нулю.
 *
 * Аудит этапа 156: до него код проверял только токен `iPad` и
 * комментарий уверял, будто случай «представляется как Mac» тем самым
 * обработан. Он не был обработан вовсе — именно там, где токена нет,
 * проверка токена ничего и не делает. iPad в браузере записывался как
 * настольный Mac.
 */
function isIpad(ua: string, maxTouchPoints: number | null): boolean {
  if (/\biPad\b/i.test(ua)) return true;
  return /\bMacintosh\b/i.test(ua) && (maxTouchPoints ?? 0) > 0;
}

function osFrom(
  ua: string,
  tgPlatform: string | null,
  maxTouchPoints: number | null
): {
  family: string;
  version: string | null;
} {
  const ipad = isIpad(ua, maxTouchPoints);
  const iphone = /\biPhone\b/i.test(ua);
  if (ipad || iphone || tgPlatform === 'ios') {
    // На iPad в браузере версии не будет, и это правильно: строка там
    // маковская и замороженная (`Mac OS X 10_15_7`), к iPadOS отношения
    // не имеющая. Отдельной защиты для этого случая нет намеренно —
    // шаблон ниже требует цифр сразу после `OS `, а там стоит `X`, и
    // мутация с её снятием пережила тест: ветка была недостижимой.
    const m = /OS (\d+)[._](\d+)/.exec(ua);
    return { family: 'ios', version: m ? `${m[1]}.${m[2]}` : null };
  }
  const android = /Android\s+([\d.]+)/i.exec(ua);
  if (android || tgPlatform === 'android') {
    return { family: 'android', version: android ? android[1] : null };
  }
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (mac) return { family: 'macos', version: `${mac[1]}.${mac[2]}` };
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) return { family: 'windows', version: win[1] };
  if (/\bLinux\b/i.test(ua)) return { family: 'linux', version: null };
  return { family: 'unknown', version: null };
}

/**
 * Вид устройства. Порядок источников важнее самих признаков.
 *
 * Сначала РОДНОЙ клиент Telegram: `ios`/`android` — это телефон или
 * планшет, `tdesktop`/`macos` — настольный, и приложение о себе знает
 * точнее любой строки. А вот `weba`/`webk` — это Telegram в браузере, и
 * он бывает где угодно: считать его настольным по имени было бы
 * ошибкой ровно там, где чаще всего и ломается вёрстка.
 */
function deviceFrom(
  ua: string,
  tgPlatform: string | null,
  viewport: { w: number } | null,
  maxTouchPoints: number | null
): DeviceKind {
  // Планшет — раньше родного клиента: на iPad клиент Telegram
  // называет себя `ios`, то есть неотличим от айфона.
  if (isIpad(ua, maxTouchPoints) || /\bTablet\b/i.test(ua)) return 'TABLET';
  if (tgPlatform && NATIVE_DESKTOP.has(tgPlatform)) return 'DESKTOP';
  if (tgPlatform && NATIVE_PHONE.has(tgPlatform)) return 'PHONE';
  if (/\bMobi|\biPhone\b|\bAndroid\b/i.test(ua)) return 'PHONE';
  if (ua) return 'DESKTOP';
  // Строки нет вовсе — последняя опора ширина окна. Граница 768 та же,
  // что у вёрстки приложения: спорить с ней значило бы называть
  // телефоном то, что приложение рисует как настольное.
  return viewport && viewport.w < 768 ? 'PHONE' : 'DESKTOP';
}

export function describeEnvironment(raw: RawEnvironment): Environment {
  const ua = raw.ua?.trim() ?? '';
  const platform = raw.tgPlatform?.trim() || null;
  const os = osFrom(ua, platform, raw.maxTouchPoints);
  return {
    ...raw,
    ua: ua || null,
    tgPlatform: platform,
    // Внутри Telegram мы, только если оттуда пришли данные. Само по
    // себе наличие `window.Telegram` ничего не значит: объект есть и в
    // обычном браузере, если скрипт SDK подключён страницей.
    surface: raw.hasTelegram ? 'TMA' : 'BROWSER',
    osFamily: os.family,
    osVersion: os.version,
    deviceKind: deviceFrom(ua, platform, raw.viewport, raw.maxTouchPoints),
  };
}

/**
 * Ключ группировки похожих находок (§3.6 ТЗ).
 *
 * Намеренно грубый: до семейства ОС, без версии. Мелкий ключ не
 * собирает группы вовсе, а смысл его ровно в том, чтобы группы были.
 * Локаль внутри — у «поехала вёрстка» язык такая же часть условия, что
 * платформа: длина слова в немецком и в русском разная, и ломается
 * именно на этом.
 */
export function envKey(input: {
  scenario: string | null;
  stepId: string | null;
  surface: Surface;
  tgPlatform: string | null;
  osFamily: string;
  uiLocale: string;
}): string {
  const part = (v: string | null | undefined) =>
    (v ?? '').trim().toLowerCase() || '-';
  return [
    part(input.scenario),
    part(input.stepId),
    part(input.surface),
    part(input.tgPlatform ?? input.osFamily),
    part(input.uiLocale),
  ].join(':');
}

/**
 * Собрать окружение прямо сейчас. Только чтение глобальных значений —
 * вся нормализация в `describeEnvironment()` выше, под тестом.
 *
 * `uiLocale` передаётся снаружи, а не читается из хранилища: на экране
 * человек видит ТЕКУЩУЮ локаль контекста, а в хранилище может лежать
 * прошлая (переключение до записи) или не лежать ничего вовсе. Нужна
 * ровно та, при которой он смотрел на сломанную вёрстку.
 *
 * Функция не бросает ни при каких условиях: окружение — это довесок к
 * тикету, и падение сборщика не имеет права утащить за собой сам тикет.
 */
export function readEnvironment(uiLocale: string): Environment {
  return describeEnvironment(readRawEnvironment(uiLocale));
}

function readRawEnvironment(uiLocale: string): RawEnvironment {
  const tg = safe(() => getTelegramWebApp());
  const nav: Navigator | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  const win: Window | undefined =
    typeof window === 'undefined' ? undefined : window;

  return {
    // Не `tg !== null`: объект `window.Telegram` существует всюду, где
    // подключён SDK, — внутри Telegram нас выдаёт непустой initData.
    hasTelegram: Boolean(tg?.initData),
    tgPlatform: str(tg?.platform),
    tgVersion: str(tg?.version),
    tgColorScheme: str(tg?.colorScheme),
    tgLanguage: str(tg?.initDataUnsafe?.user?.language_code),
    ua: str(nav?.userAgent),
    maxTouchPoints:
      typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : null,
    browserLanguage: str(nav?.language),
    uiLocale,
    // Класс на <html>, а не `webApp.colorScheme`: см. поле `theme` выше
    // и `applyTheme()` в lib/telegram.ts — явный выбор человека сильнее
    // темы Telegram, и именно он нарисован на экране.
    theme:
      safe(() =>
        typeof document === 'undefined'
          ? null
          : document.documentElement.classList.contains('dark')
            ? 'dark'
            : 'light'
      ) ?? null,
    screen: win?.screen
      ? {
          w: Math.round(win.screen.width),
          h: Math.round(win.screen.height),
          dpr: round2(win.devicePixelRatio || 1),
        }
      : null,
    // Видимая область, а не окно: внутри Telegram экран урезан сверху
    // шапкой клиента, и «не влезло» случается именно по ней.
    viewport: win
      ? { w: Math.round(win.innerWidth), h: Math.round(win.innerHeight) }
      : null,
    // Нестандартное поле, есть не везде (нет в Safari и Firefox) —
    // отсюда `safe` и `null` как обычный исход, а не как сбой.
    network: str(
      safe(
        () =>
          (nav as Navigator & { connection?: { effectiveType?: string } })
            ?.connection?.effectiveType
      )
    ),
    appBuild: APP_BUILD,
  };
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Длину режем здесь, а не на бэкенде: `User-Agent` бывает
  // многосотенным, а хранить мы собираемся ВСЕ окружения.
  return trimmed ? trimmed.slice(0, MAX_FIELD) : null;
}

function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 1;
}
