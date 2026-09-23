/**
 * Разбор ответа Pixabay и правила выдачи стикеров — чистая часть фичи
 * №8, без сети.
 *
 * ## Что обязывает нас Pixabay
 *
 * Условия их API (pixabay.com/api/docs) содержат три требования, и все
 * три влияют на код, а не на совесть:
 *
 *  1. «permanent hotlinking of images is not allowed… please download
 *     them to your server first» — значит выбранный стикер обязан
 *     уехать в НАШЕ хранилище. Ссылку Pixabay в готовый ролик
 *     подставлять нельзя.
 *  2. «Requests must be cached for 24 hours» — значит у поиска должен
 *     быть кеш, а не «каждое нажатие клавиши новый запрос».
 *  3. «Show your users where the images and videos are from, whenever
 *     search results are displayed» — значит выдача обязана нести
 *     `sourceUrl`, и экран обязан его показать. Сама ЛИЦЕНЗИЯ
 *     атрибуции не требует (pixabay.com/service/license-summary), но
 *     условия API — требуют, и это разные документы.
 *
 * Лицензия при этом разрешает коммерческое использование и
 * переработку; запрещает продавать контент «as-is» отдельным товаром —
 * чего мы и не делаем: стикер попадает в ролик как элемент, а не как
 * товар.
 */

/** Сколько кандидатов показываем. Больше — экран превращается в свалку. */
export const MAX_STICKER_RESULTS = 24;

/** Кеш поиска: требование условий Pixabay, не оптимизация. */
export const STICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StickerCandidate {
  /** Идентификатор Pixabay — по нему потом забираем выбранный. */
  id: string;
  /** Маленькая картинка для экрана выбора. Показывать — можно. */
  previewUrl: string;
  /** Полноразмерный файл; его мы СКАЧИВАЕМ, а не подставляем в ролик. */
  downloadUrl: string;
  /** Страница на Pixabay — обязательна к показу рядом с выдачей. */
  sourceUrl: string;
  tags: string;
}

interface PixabayHit {
  id?: number;
  previewURL?: string;
  webformatURL?: string;
  largeImageURL?: string;
  pageURL?: string;
  tags?: string;
}

/**
 * Параметры поиска.
 *
 * `colors=transparent` — то единственное, ради чего стоило брать
 * именно Pixabay: стикер без прозрачности накладывать не на что, он
 * закроет кадр белым прямоугольником. `image_type=illustration`
 * отсекает фотографии: фотография в роли наклейки не работает.
 */
export function stickerSearchParams(
  query: string,
  apiKey: string,
): URLSearchParams {
  return new URLSearchParams({
    key: apiKey,
    q: query.trim().slice(0, 100),
    image_type: 'illustration',
    colors: 'transparent',
    safesearch: 'true',
    per_page: String(MAX_STICKER_RESULTS),
  });
}

/**
 * Ответ Pixabay → кандидаты. Запись без изображения или без страницы
 * пропускается: первую не на что накладывать, вторую нечем
 * подписать, а подписывать обязательно.
 */
export function parseStickerHits(payload: unknown): StickerCandidate[] {
  const hits = (payload as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];
  const out: StickerCandidate[] = [];
  for (const raw of hits) {
    const hit = raw as PixabayHit;
    const id = hit.id === undefined ? '' : String(hit.id);
    const downloadUrl = hit.largeImageURL || hit.webformatURL || '';
    const previewUrl = hit.previewURL || hit.webformatURL || downloadUrl;
    if (!id || !downloadUrl || !hit.pageURL) continue;
    out.push({
      id,
      previewUrl,
      downloadUrl,
      sourceUrl: hit.pageURL,
      tags: (hit.tags ?? '').trim(),
    });
    if (out.length >= MAX_STICKER_RESULTS) break;
  }
  return out;
}

/** Ключ кеша: запрос без регистра и лишних пробелов — это один запрос. */
export function stickerCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
