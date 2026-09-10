/**
 * Тонкий серверный fetch-слой к публичной витрине блога backend'а
 * (backend/src/modules/blog/blog.controller.ts, `BlogController` —
 * `GET /blog`, `GET /blog/:slug`, без гварда, без cookie). Вызывается
 * ТОЛЬКО с сервера (Server Component'ы `app/[locale]/blog/**`,
 * `sitemap.ts`, `sitemap-news.xml/route.ts`, `feed*`) — TODO §II.3:
 * «Лендинг рендерит блог статически (generateStaticParams + ревалидация),
 * а не ходит в API на каждый запрос». Next.js кеширует такой fetch сам
 * (см. `next: { revalidate }` на каждом вызове) и ревалидирует по
 * расписанию, а не при каждом заходе посетителя — поэтому здесь нет
 * клиентского кода вообще, в отличие от admin/src/lib/admin-api.ts
 * (та) браузерная админка ходит в API на каждый клик).
 *
 * Никакой аутентификации не нужно — публичная витрина не требует cookie
 * и не завязана на CORS_ORIGIN (см. doc/DEPLOYMENT.md §4): запрос идёт
 * сервер-сервер на этапе сборки/ревалидации, а не из браузера посетителя.
 */

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api';

/** Как часто Next ревалидирует данные блога (секунды) — TODO §II.5:
 * sitemap-news требует записи не старше двух суток, поэтому кеш не может
 * быть длиннее нескольких часов, иначе новая публикация не попадёт в
 * файл вовремя. Отдельная переменная, а не константа в каждом файле. */
export const BLOG_REVALIDATE_SECONDS = 900; // 15 минут

export interface PublicBlogPostListItem {
  slug: string;
  title: string;
  category: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  isRequestedLocale: boolean;
}

export interface PublicBlogPostPage {
  items: PublicBlogPostListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicBlogPostDetail extends PublicBlogPostListItem {
  bodyHtml: string;
  youtubeVideoId: string | null;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      next: { revalidate: BLOG_REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // Тот же конверт { success, data }, что и у остального API (см.
    // admin/src/lib/admin-api.ts) — публичные маршруты его тоже проходят
    // через глобальный ResponseInterceptor бэкенда.
    return body?.success ? (body.data as T) : null;
  } catch {
    // Сеть недоступна на сборке/ревалидации — не роняем всю страницу
    // сборки, отдаём null и вызывающий код показывает пустое состояние
    // честно, а не падает build целиком.
    return null;
  }
}

export function listBlogPosts(opts: {
  locale: string;
  category?: string;
  page?: number;
  pageSize?: number;
}): Promise<PublicBlogPostPage | null> {
  const params = new URLSearchParams({ locale: opts.locale });
  if (opts.category) params.set('category', opts.category);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  return getJson<PublicBlogPostPage>(`/blog?${params.toString()}`);
}

/** Собирает ВСЕ опубликованные записи постранично — используется только
 * sitemap.ts/sitemap-news.xml/feed, где нужен полный список, а не
 * страница для человека. `pageSize` — максимум, который допускает
 * `PublicBlogQueryDto` (см. backend/src/modules/blog/dto/blog.dto.ts). */
export async function listAllBlogPosts(
  locale: string
): Promise<PublicBlogPostListItem[]> {
  const pageSize = 100;
  const items: PublicBlogPostListItem[] = [];
  let page = 1;
  for (;;) {
    const result = await listBlogPosts({ locale, page, pageSize });
    if (!result || result.items.length === 0) break;
    items.push(...result.items);
    if (items.length >= result.total || result.items.length < pageSize) break;
    page += 1;
    // Предохранитель — блог не растёт настолько быстро, чтобы это когда-
    // либо сработало честно, но бесконечный цикл на несогласованных
    // данных сервера хуже, чем неполный sitemap.
    if (page > 50) break;
  }
  return items;
}

export function getBlogPost(
  slug: string,
  locale: string
): Promise<PublicBlogPostDetail | null> {
  return getJson<PublicBlogPostDetail>(
    `/blog/${encodeURIComponent(slug)}?locale=${locale}`
  );
}
