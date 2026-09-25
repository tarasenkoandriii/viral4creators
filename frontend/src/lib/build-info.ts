/**
 * Версия сборки мини-аппа (этап 154,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §8 этап 0).
 *
 * ## Почему дата есть здесь и нет на бэкенде
 *
 * Фронтенд собирается по-настоящему: Vite выполняет конфиг в момент
 * сборки и знает, когда это было. У serverless-бэкенда такого момента
 * нет — `new Date()` при загрузке модуля даёт время холодного старта,
 * разное у каждого экземпляра, и дата, посчитанная так, врала бы
 * убедительно. Поэтому бэкенд отвечает только коммитом
 * (`backend/src/common/build-info.ts`), а дату несёт эта сборка.
 *
 * ## Почему значение подставляется, а не читается из переменной
 *
 * Обычная переменная сборки с префиксом VITE работала бы, но её
 * пришлось бы задавать руками на каждом стенде — и первый же забытый
 * стенд дал бы тикеты без версии, то есть ровно то, ради чего всё это
 * делается.
 * `define` в конфиге считает значение сам из того, что и так есть в
 * окружении сборки.
 */

declare const __APP_BUILD__: string | undefined;

export interface BuildStamp {
  sha: string | null;
  date: string | null;
}

/** Ровно семь символов — столько печатает `git log --oneline`. */
const SHORT = 7;

function looksLikeSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * Собрать человекочитаемую версию.
 *
 * Дата впереди не ради красоты: строки сортируются как текст, и тикеты
 * за разные дни выстраиваются по порядку сами. Коммит один, без даты,
 * такого не даёт — а именно «что новее» и спрашивают, глядя на два
 * тикета.
 */
export function describeBuild(stamp: BuildStamp): string {
  const sha =
    stamp.sha && looksLikeSha(stamp.sha.trim())
      ? stamp.sha.trim().slice(0, SHORT).toLowerCase()
      : null;
  const date = stamp.date?.trim() || null;
  if (date && sha) return `${date}-${sha}`;
  if (date) return date;
  if (sha) return sha;
  // Пустота в тикете читается как потерянное поле, а не как
  // неопознанная сборка.
  return 'dev';
}

/**
 * Версия ЭТОЙ сборки. Константа подставлена Vite; в тестах и в dev, где
 * `define` не отработал, остаётся `dev`.
 */
export const APP_BUILD: string =
  typeof __APP_BUILD__ === 'string' && __APP_BUILD__ ? __APP_BUILD__ : 'dev';
