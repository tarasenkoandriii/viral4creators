/**
 * Музыкальные темы поздравления — фича №4 компаньон-ТЗ.
 *
 * ## Почему каталог, а не список в коде
 *
 * Музыка — это лицензированные файлы, а не строки. Их нельзя ни
 * сгенерировать, ни «дописать в константу»: у каждой темы есть
 * правообладатель и условия использования, и решение, что именно
 * звучит в чужом поздравлении, принимает владелец продукта, а не
 * автор этого файла. Поэтому код принимает КАТАЛОГ (настройка
 * платформы `greeting.musicThemes`, правится из админки без
 * редеплоя), а сам никаких треков не знает.
 *
 * Пустой каталог — рабочее состояние, а не ошибка: фича просто не
 * показывается, ролики собираются как прежде. Это же и путь выката:
 * код уезжает в прод тёмным, включается загрузкой первой темы.
 *
 * ## Почему разбор терпимый
 *
 * Значение приходит из админки, то есть его печатает человек. Одна
 * кривая запись не должна гасить весь каталог — иначе опечатка в
 * десятой теме отключит девять рабочих. Негодные записи
 * пропускаются молча, годные остаются.
 */

import {
  GREETING_OCCASIONS,
  GreetingMusicTheme,
  GreetingOccasion,
} from './types/greeting.types';

import type { GreetingMusicSelection } from './types/greeting.types';

// Реэкспорт для вызывающих, которым нужен и разбор, и тип: место
// объявления — файл типов (`types/greeting.types.ts`), потому что на
// него ссылается снимок брифа, а он не должен зависеть от разбора.
export type { GreetingMusicSelection, GreetingMusicTheme };

/** Ключ настройки платформы (`PlatformSettingsService`). */
export const GREETING_MUSIC_SETTING_KEY = 'greeting.musicThemes';

/**
 * Насколько тише голоса звучит музыка.
 *
 * 0.12 — то же значение, что у приглушения исходной дорожки в режиме
 * `voiceover` (`DEFAULT_DUCK`, `common/postprod.ts`), и по той же
 * причине: подложка обязана быть слышна, но не спорить с речью. Ровно
 * этот вопрос там уже разбирался отдельным пунктом ТЗ («двоение
 * голоса»), второй раз подбирать его заново незачем.
 */
export const DEFAULT_MUSIC_VOLUME = 0.12;

/** Больше этого в каталоге держать незачем — экран выбора станет свалкой. */
export const MAX_MUSIC_THEMES = 24;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TITLE_LENGTH = 80;

function isOccasion(value: unknown): value is GreetingOccasion {
  return (
    typeof value === 'string' &&
    (GREETING_OCCASIONS as readonly string[]).includes(value)
  );
}

/**
 * Хосты, на которые ссылка вести не может.
 *
 * Ссылку мы сами не скачиваем — её открывает сторонний ffmpeg-сервис,
 * так что внутренней сети продукта она не достанет в любом случае.
 * Проверка нужна не от этого, а чтобы человек получил внятный отказ
 * сразу, а не «задача постобработки упала» через минуту: `localhost`
 * и адреса домашней сети у ffmpeg-сервиса не разрешатся никогда.
 */
const PRIVATE_HOST =
  /^(localhost|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;

/**
 * Ссылка на трек, присланная пользователем.
 *
 * Строже каталожной: каталог пишет владелец продукта, и опечатка там —
 * его опечатка, а здесь строку печатает кто угодно.
 */
export function userTrackUrl(value: unknown): string | null {
  const url = httpsUrl(value);
  if (!url) return null;
  const { hostname, username, password } = new URL(url);
  if (PRIVATE_HOST.test(hostname)) return null;
  // Логин с паролем в ссылке означал бы, что мы сохраним чужие
  // учётные данные в снимке сессии и отдадим их ffmpeg-сервису.
  if (username || password) return null;
  return url;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    // Только https: ссылка уходит наружу, стороннему ffmpeg-сервису.
    // `http://` там означало бы, что трек можно подменить по дороге, а
    // `file://`/`data:` — что можно попросить сервис прочитать что-то
    // у себя.
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Разбирает значение настройки в каталог. Негодные записи
 * пропускаются; полностью негодное значение даёт пустой каталог, а не
 * исключение (см. доккомментарий файла).
 */
export function parseMusicCatalog(raw: string | null): GreetingMusicTheme[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { themes?: unknown })?.themes)
      ? (parsed as { themes: unknown[] }).themes
      : [];

  const seen = new Set<string>();
  const out: GreetingMusicTheme[] = [];
  for (const entry of list) {
    if (out.length >= MAX_MUSIC_THEMES) break;
    const row = entry as {
      id?: unknown;
      title?: unknown;
      url?: unknown;
      occasions?: unknown;
    };
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!ID_PATTERN.test(id)) continue;
    // Дубль id означал бы, что выбор пользователя указывает на две
    // темы сразу; побеждает первая — она в каталоге раньше.
    if (seen.has(id.toLowerCase())) continue;
    const url = httpsUrl(row.url);
    if (!url) continue;
    const title =
      typeof row.title === 'string' && row.title.trim()
        ? row.title.trim().slice(0, MAX_TITLE_LENGTH)
        : id;
    const occasions = Array.isArray(row.occasions)
      ? row.occasions.filter(isOccasion)
      : null;
    seen.add(id.toLowerCase());
    out.push({
      id,
      title,
      url,
      // Пустой массив после фильтрации — это «перечислили только
      // мусор», а не «подходит всем»: молча расширять тему на все
      // поводы значило бы поставить фанфары под соболезнование.
      occasions: occasions === null ? null : occasions,
    });
  }
  return out;
}

/** Темы, подходящие поводу: общие плюс перечислившие его явно. */
export function themesForOccasion(
  catalog: readonly GreetingMusicTheme[],
  occasion: GreetingOccasion,
): GreetingMusicTheme[] {
  return catalog.filter(
    (t) => t.occasions === null || t.occasions.includes(occasion),
  );
}

/**
 * Тема по id — и только если она подходит поводу.
 *
 * Повод проверяется здесь, а не только на экране: повод сессии
 * правится в брифе, и тема, выбранная под день рождения, не должна
 * пережить смену повода на соболезнование.
 */
export function findThemeForOccasion(
  catalog: readonly GreetingMusicTheme[],
  occasion: GreetingOccasion,
  id: string,
): GreetingMusicTheme | null {
  const wanted = id.trim().toLowerCase();
  return (
    themesForOccasion(catalog, occasion).find(
      (t) => t.id.toLowerCase() === wanted,
    ) ?? null
  );
}
