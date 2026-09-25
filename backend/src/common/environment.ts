/**
 * Окружение находки на стороне сервера (этап 156,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.4).
 *
 * ## Почему нормализация повторена, а не импортирована
 *
 * `frontend/src/lib/environment.ts` — другой пакет, общего кода между
 * ними в проекте нет вовсе. Но повтор здесь не дублирование ради
 * удобства: серверу нельзя ВЕРИТЬ клиентскому ключу. `envKey` решает,
 * сольются ли две находки в одну группу, а клиентское значение
 * приходит из браузера тестировщика и подделывается тривиально —
 * достаточно старой сборки, чтобы ключи разошлись и группы рассыпались.
 * Поэтому ключ считает сервер, из полей, которые он же и обрезал.
 *
 * Расхождение двух копий сторожит шов в `scripts/check-docs.mjs`:
 * молчаливое добавление части ключа в одном месте развалило бы
 * группировку задним числом, а заметить это по результату нельзя —
 * групп просто станет больше, и выглядеть это будет как разные баги.
 */

/** Потолок длины любого строкового поля. Зеркало `MAX_FIELD` на клиенте. */
export const MAX_FIELD = 512;

/** Потолок для чисел — экран и вьюпорт. Больше — заведомо мусор. */
const MAX_PIXELS = 100_000;

export type Surface = 'TMA' | 'BROWSER';
export type DeviceKind = 'PHONE' | 'TABLET' | 'DESKTOP';

const THEMES = ['light', 'dark'] as const;
const SURFACES: readonly Surface[] = ['TMA', 'BROWSER'];
const DEVICE_KINDS: readonly DeviceKind[] = ['PHONE', 'TABLET', 'DESKTOP'];

export interface Environment {
  surface: Surface;
  deviceKind: DeviceKind;
  osFamily: string;
  osVersion: string | null;
  tgPlatform: string | null;
  tgVersion: string | null;
  tgColorScheme: string | null;
  tgLanguage: string | null;
  ua: string | null;
  /**
   * Касания — единственное, чем iPad на iPadOS 13+ отличается от Mac:
   * строка `User-Agent` у них одна и та же. Хранится сырым, рядом с
   * `ua`, по той же причине, что и он: вывод «это планшет» сделан нами
   * и однажды окажется неверным.
   */
  maxTouchPoints: number | null;
  browserLanguage: string | null;
  uiLocale: string;
  /**
   * Тема, В КОТОРОЙ человек видел экран (`light`/`dark`), — не
   * `tgColorScheme`. Явный выбор человека внутри приложения сильнее
   * темы Telegram (этап 81), и сломанную вёрстку он видел в первой.
   */
  theme: string | null;
  screen: { w: number; h: number; dpr: number } | null;
  viewport: { w: number; h: number } | null;
  network: string | null;
  appBuild: string;
}

function text(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function pixels(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > MAX_PIXELS) return null;
  return rounded;
}

/** Небольшое неотрицательное целое; всё прочее — `null`. */
function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= 255 ? rounded : null;
}

function size(value: unknown): { w: number; h: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { w?: unknown; h?: unknown };
  const w = pixels(raw.w);
  const h = pixels(raw.h);
  // Половина размера бесполезна: «не влезло» читается только по паре.
  return w !== null && h !== null ? { w, h } : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Привести пришедшее с клиента к хранимому виду.
 *
 * Возвращает `null`, если нет даже поверхности и вида устройства: без
 * них запись не отвечает ни на один вопрос о воспроизводимости, и
 * хранить её значит делать вид, что окружение собрано.
 *
 * Всё остальное необязательно: клиент бывает старым, а поля
 * (`navigator.connection`, `Telegram.WebApp.platform`) есть не везде.
 * Отказ из-за отсутствующего поля стоил бы нам всей находки.
 */
export function normalizeEnvironment(input: unknown): Environment | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const surface = oneOf(raw.surface, SURFACES);
  const deviceKind = oneOf(raw.deviceKind, DEVICE_KINDS);
  if (!surface || !deviceKind) return null;

  return {
    surface,
    deviceKind,
    // Семейство ОС — свободная строка (клиент видел устройства, которых
    // не видели мы), но короткая: это `ios`, `android`, `windows`.
    osFamily: text(raw.osFamily, 32) ?? 'unknown',
    osVersion: text(raw.osVersion, 32),
    tgPlatform: text(raw.tgPlatform, 32),
    tgVersion: text(raw.tgVersion, 32),
    tgColorScheme: text(raw.tgColorScheme, 32),
    tgLanguage: text(raw.tgLanguage, 32),
    ua: text(raw.ua),
    maxTouchPoints: count(raw.maxTouchPoints),
    browserLanguage: text(raw.browserLanguage, 32),
    uiLocale: text(raw.uiLocale, 32) ?? '',
    theme: oneOf(raw.theme, THEMES),
    screen: (() => {
      const wh = size(raw.screen);
      if (!wh) return null;
      const dprRaw = (raw.screen as { dpr?: unknown }).dpr;
      const dpr =
        typeof dprRaw === 'number' && Number.isFinite(dprRaw) && dprRaw > 0
          ? Math.round(Math.min(dprRaw, 10) * 100) / 100
          : 1;
      return { ...wh, dpr };
    })(),
    viewport: size(raw.viewport),
    network: text(raw.network, 32),
    appBuild: text(raw.appBuild, 64) ?? 'unknown',
  };
}

/**
 * Ключ группировки похожих находок. Зеркало `envKey` на клиенте.
 *
 * Намеренно грубый: до семейства ОС, без версии. Мелкий ключ не
 * собирает группы вовсе, а смысл его ровно в том, чтобы группы были.
 * Локаль внутри — у «поехала вёрстка» язык такая же часть условия, что
 * платформа.
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

/** Ключ по уже нормализованному окружению — чтобы места сборки ключа не расходились. */
export function envKeyOf(
  env: Environment,
  where: { scenario: string | null; stepId: string | null },
): string {
  return envKey({
    scenario: where.scenario,
    stepId: where.stepId,
    surface: env.surface,
    tgPlatform: env.tgPlatform,
    osFamily: env.osFamily,
    uiLocale: env.uiLocale,
  });
}
