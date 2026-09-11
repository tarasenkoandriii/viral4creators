/**
 * Тонкий серверный fetch-слой к публичной странице ролика
 * (backend/src/modules/shared-video/shared-video.controller.ts,
 * `PublicSharedVideoController` — `GET /shared-video/:id`, без гварда,
 * без cookie). Тот же паттерн, что и у `blog-api.ts` (этап 58): вызывается
 * ТОЛЬКО с сервера (Server Component `app/video/[id]/page.tsx`), Next
 * кеширует fetch сам (`next: { revalidate }`) — никакого клиентского кода.
 *
 * ТЗ §40, этап 60: у этой страницы, в отличие от блога, НЕТ `[locale]`-
 * сегмента вообще — снимок хранит одну зафиксированную локаль автора
 * (`page.locale`), и именно ею читает `getDictionary()` в самом page.tsx,
 * а не URL-сегментом.
 */

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api';

/**
 * Раз в 5 минут, а не 15, как у блога: `viewCount` бампается прямо этим
 * запросом (best-effort на бэкенде), и страница шеринга живёт короче
 * записи блога — свежесть счётчика здесь важнее, чем экономия на кешах.
 */
export const SHARED_VIDEO_REVALIDATE_SECONDS = 300;

export interface PublicSharedVideoPage {
  id: string;
  videoUrl: string;
  aspectRatio: string | null;
  title: string;
  productName: string;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  locale: string;
  viewCount: number;
  /** Лента внутри TMA (этап 80, TODO §III.9) — поле зеркалит бэкенд для
   * типовой полноты (doc/SOCIAL-FEED-SPEC.md §2: сама лента и лайки —
   * только в TMA, лендинг их не показывает и не использует). */
  likeCount: number;
  shareCount: number;
  createdAt: string;
}

export async function getSharedVideo(
  id: string,
): Promise<PublicSharedVideoPage | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/shared-video/${id}`, {
      next: { revalidate: SHARED_VIDEO_REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // Тот же конверт { success, data }, что и у остального API.
    return body?.success ? (body.data as PublicSharedVideoPage) : null;
  } catch {
    // Сеть недоступна на сборке/ревалидации — не роняем страницу целиком.
    return null;
  }
}
