import type { Dictionary } from './get-dictionary';
import type { PublicSharedVideoPage } from './shared-video-api';

/**
 * Заголовок, который увидит получатель ссылки на опубликованный ролик.
 *
 * Снимок кладёт в `title` сырой КОД повода, когда автор не вписал свой
 * заголовок: `SharedVideoService.snapshotFromSession` делает `dto.title
 * ?? customOccasionText ?? greeting.occasion`, и так гарантируется
 * непустое поле в базе. Но человеку, которому прислали ссылку, нельзя
 * показывать `BIRTHDAY` — а этот код уходил и в `<h1>`, и в `og:title`,
 * и в `name` разметки VideoObject, то есть ещё и в превью мессенджера,
 * где ссылку и открывают.
 *
 * Чинится на лендинге, а не в снимке, по одной причине: локализованное
 * название повода знает только он — потому что знает локаль страницы.
 * На бэкенде пришлось бы либо хранить название на одном языке, либо
 * тащить туда словари лендинга.
 *
 * Заголовок, написанный автором, не подменяется никогда: замена
 * срабатывает ровно тогда, когда `title` совпал с кодом повода —
 * то есть когда своего заголовка не было.
 *
 * Отдельным файлом, а не внутри страницы, чтобы это можно было
 * проверить тестом: у страницы JSX и импорты Next, у функции — ничего.
 */
export function headingOf(
  page: PublicSharedVideoPage,
  dict: Dictionary,
): string {
  if (page.projectType !== 'GREETING_VIDEO' || !page.occasion) {
    return page.title;
  }
  if (page.title !== page.occasion) return page.title;
  return dict.sharedVideo.occasion[page.occasion] || page.title;
}
