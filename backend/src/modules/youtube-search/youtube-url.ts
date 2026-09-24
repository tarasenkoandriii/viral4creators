/**
 * Разбор ссылки на YouTube в id ролика (ТЗ TZ-Multilingual-YouTube.md,
 * этап 136).
 *
 * Понадобился, потому что теги исходника берутся у `videos.list`, а тот
 * работает только по id: в продукте же ссылка живёт целиком — и когда
 * её вставили руками, и когда её выбрали в поиске. Отдельный чистый
 * модуль, а не регулярка по месту, ровно по той же причине, что и
 * `youtube-duration.ts` рядом: разбор чужого формата проверяется
 * тестами отдельно от того, кто его вызывает.
 *
 * Разбираем через `URL`, а не регуляркой: у ссылок из жизни есть хвосты
 * (`&list=`, `?t=30`, `&si=`), и регулярка на них либо ошибается, либо
 * обрастает до нечитаемости.
 *
 * Формы шире, чем пропускает `RegisterYoutubeRequestDto` (тот знает
 * только `watch?v=` и `youtu.be/`): `shorts/`, `embed/` и `live/` стоят
 * здесь не «на будущее», а потому что разбор ссылки — общая операция, и
 * сужать её до текущего вызывающего значит готовить вторую такую же
 * функцию рядом. Неизвестная форма — `null`, и это штатный ответ:
 * вызывающий просто останется без тегов исходника.
 */

/** Id ролика на YouTube: 11 символов сегодня, с запасом на завтра. */
const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;

export function parseYoutubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  let id: string | null = null;
  if (host === 'youtu.be') {
    id = parts[0] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (
      parts.length >= 2 &&
      (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live')
    ) {
      id = parts[1];
    }
  }

  if (!id) return null;
  return VIDEO_ID.test(id) ? id : null;
}
