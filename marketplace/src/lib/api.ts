/**
 * Тонкий серверный fetch-слой к публичным маршрутам маркетплейса
 * (backend/src/modules/creator-profile, backend/src/modules/portfolio —
 * контроллеры без гварда). Тот же паттерн, что и у landing's
 * shared-video-api.ts/blog-api.ts: вызывается только с сервера (Server
 * Component), Next кеширует fetch сам через `next: { revalidate }`.
 *
 * ТЗ на маркетплейс §9, §19–§21 (Этап 0 / Фаза 1) и §20 (публикация/шеринг).
 */

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api';

/** Каталог обновляется реже профиля — новых исполнителей не так много. */
export const CATALOG_REVALIDATE_SECONDS = 300;
/** Профиль/портфолио — короче, лайки и новые работы должны быть свежими. */
export const PROFILE_REVALIDATE_SECONDS = 60;

export interface PublicPortfolioPreview {
  id: string;
  thumbnailUrl: string | null;
  videoUrl: string;
}

export interface PublicCreatorCatalogItem {
  id: string;
  slug: string | null;
  displayName: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  isFeatured: boolean;
  portfolioPreview: PublicPortfolioPreview[];
}

export interface PublicCreatorCatalog {
  items: PublicCreatorCatalogItem[];
  nextCursor: string | null;
}

export interface PublicCreatorSocialLink {
  id: string;
  platform: string;
  url: string;
}

export interface PublicCreatorProfile {
  id: string;
  userId: string;
  displayName: string | null;
  slug: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  bio: string | null;
  isAcceptingOrders: boolean;
  contactHandle: string | null;
  socialLinks: PublicCreatorSocialLink[];
  viewCount: number;
  isFeatured: boolean;
  createdAt: string;
}

export interface PublicPortfolioItem {
  id: string;
  creatorProfileId: string;
  videoUrl: string;
  title: string;
  thumbnailUrl: string | null;
  status: string;
  likeCount: number;
  viewCount: number;
  collectionTag: string | null;
  likedByViewer: boolean;
  createdAt: string;
}

export interface SimilarCreator {
  id: string;
  displayName: string | null;
  niches: string[];
}

export interface SimilarPortfolioItem {
  id: string;
  creatorProfileId: string;
  title: string;
  thumbnailUrl: string | null;
  videoUrl: string;
}

export interface PortfolioFeedItem {
  id: string;
  creatorProfileId: string;
  creatorDisplayName: string | null;
  title: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  niches: string[];
  createdAt: string;
}

export interface PortfolioCollectionSummary {
  tag: string;
  itemCount: number;
}

/** Единый конверт { success, data } у всего API — тот же приём, что в landing. */
async function fetchJson<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { next: { revalidate } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.success ? (body.data as T) : (body as T);
  } catch {
    // Бэкенд недоступен на сборке/ревалидации — не роняем страницу целиком.
    return null;
  }
}

export async function getCreatorCatalog(params: {
  niche?: string;
  priceMax?: number;
  cursor?: string;
}): Promise<PublicCreatorCatalog> {
  const qs = new URLSearchParams();
  if (params.niche) qs.set('niche', params.niche);
  if (params.priceMax != null) qs.set('priceMax', String(params.priceMax));
  if (params.cursor) qs.set('cursor', params.cursor);
  const query = qs.toString();
  const data = await fetchJson<PublicCreatorCatalog>(
    `/creators${query ? `?${query}` : ''}`,
    CATALOG_REVALIDATE_SECONDS,
  );
  return data ?? { items: [], nextCursor: null };
}

/** ТЗ §20 №1 — принимает и id, и vanity-slug: бэкенд сам резолвит любое из двух. */
export async function getCreatorProfile(idOrSlug: string): Promise<PublicCreatorProfile | null> {
  return fetchJson<PublicCreatorProfile>(`/creators/${idOrSlug}`, PROFILE_REVALIDATE_SECONDS);
}

export async function getCreatorPortfolio(idOrSlug: string): Promise<PublicPortfolioItem[]> {
  const data = await fetchJson<PublicPortfolioItem[]>(
    `/creators/${idOrSlug}/portfolio`,
    PROFILE_REVALIDATE_SECONDS,
  );
  return data ?? [];
}

export async function getSimilarCreators(id: string): Promise<SimilarCreator[]> {
  const data = await fetchJson<SimilarCreator[]>(`/creators/${id}/similar`, PROFILE_REVALIDATE_SECONDS);
  return data ?? [];
}

export async function getPortfolioItem(id: string): Promise<PublicPortfolioItem | null> {
  return fetchJson<PublicPortfolioItem>(`/portfolio-items/${id}`, PROFILE_REVALIDATE_SECONDS);
}

export async function getSimilarPortfolioItems(id: string): Promise<SimilarPortfolioItem[]> {
  const data = await fetchJson<SimilarPortfolioItem[]>(
    `/portfolio-items/${id}/similar`,
    PROFILE_REVALIDATE_SECONDS,
  );
  return data ?? [];
}

export async function getPortfolioFeed(limit = 30): Promise<PortfolioFeedItem[]> {
  const data = await fetchJson<PortfolioFeedItem[]>(
    `/portfolio-items/feed?limit=${limit}`,
    PROFILE_REVALIDATE_SECONDS,
  );
  return data ?? [];
}

export async function getCollections(): Promise<PortfolioCollectionSummary[]> {
  const data = await fetchJson<PortfolioCollectionSummary[]>(
    '/portfolio-items/collections',
    CATALOG_REVALIDATE_SECONDS,
  );
  return data ?? [];
}

export async function getCollectionItems(tag: string): Promise<PublicPortfolioItem[]> {
  const data = await fetchJson<PublicPortfolioItem[]>(
    `/portfolio-items/collections/${encodeURIComponent(tag)}`,
    PROFILE_REVALIDATE_SECONDS,
  );
  return data ?? [];
}
