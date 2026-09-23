import { ogImageUrl } from './social-meta';
import type { Locale } from './i18n';
import type { PublicSharedVideoPage } from './shared-video-api';

/**
 * Картинка, которой разворачивается ссылка на ролик.
 *
 * Порядок и его причины:
 *
 *  1. **Свой кадр-постер** (`posterUrl`) — вынут из ГОТОВОГО файла в
 *     момент публикации, поэтому показывает ровно то, что человек
 *     откроет по ссылке: нужный формат кадра, вшитые титры и наклейку.
 *  2. **Фото товара** — у товарных роликов оно было и до постера;
 *     ронять его было бы регрессом.
 *  3. **Брендовая картинка лендинга** — когда нет ни того, ни другого.
 *
 * Третий пункт — запасной вариант, а не подделка под кадр: это обычная
 * обложка лендинга 1200×630, та же, что у страницы поздравлений.
 * Показать вместо несуществующего кадра узнаваемую обложку честно;
 * показать чужой кадр или картинку, притворяющуюся кадром этого
 * ролика, — нет.
 *
 * Постер и фото возвращаются с `own: true`. Это нужно `<video
 * poster>`: там уместен только НАСТОЯЩИЙ кадр, потому что горизонтальная
 * обложка за вертикальным роликом выглядит поломкой вёрстки, а не
 * превью.
 */
export interface PreviewImage {
  url: string;
  /** Это изображение самого ролика, а не запасная обложка лендинга. */
  own: boolean;
}

export function previewImageOf(
  page: Pick<PublicSharedVideoPage, 'posterUrl' | 'productImageUrl' | 'projectType'>,
  locale: Locale,
  origin: string,
): PreviewImage {
  if (page.posterUrl) return { url: page.posterUrl, own: true };
  if (page.productImageUrl) return { url: page.productImageUrl, own: true };
  return {
    url: ogImageUrl(
      origin,
      page.projectType === 'GREETING_VIDEO' ? 'greetings' : 'main',
      locale,
    ),
    own: false,
  };
}
