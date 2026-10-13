/**
 * Статус снятия материала для middleware (проектный документ §13.3, аудит
 * P3-22, аудит P-F S2-2, хвост Z-2b). App Router не отдаёт 410 из страницы,
 * поэтому middleware переписывает снятый slug на `/gone/[slug]` (410).
 *
 * Источник списка — СВОЙ маршрут `/api/withdrawn` (route handler читает
 * список через общий data cache Next с тегом `publisher`): middleware (edge)
 * и route handlers живут в разных рантаймах/инстансах, общей памяти у них
 * нет, а data cache — общий, и `POST /api/revalidate` (его вызывает
 * sites-backend при снятии) сбрасывает его сразу. Своя память middleware —
 * только 1 с (`TTL_MS`) против всплесков: сразу после ревалидации снятый
 * материал отдаёт 410, а не 404 (остаточное окно ≤ 1 с на экземпляр).
 *
 * FAIL-CLOSED: список не получен (сбой, не-2xx) — НЕ «пусто»: повтор не
 * раньше чем через 5 с, а пока — проверка самого материала у API
 * `GET /contents/:slug` (410 → снят); не удалось и это — `unknown`,
 * middleware отвечает 503 без текста.
 */
import { PUBLIC_API_PREFIX } from '@/brand';

export const TTL_MS = 1_000;
export const LIST_RETRY_MS = 5_000;
export type SlugState = 'withdrawn' | 'pass' | 'unknown';

let list: { at: number; slugs: Set<string> } | null = null;
let listFailedAt = -Infinity;
const perSlug = new Map<string, { at: number; state: Exclude<SlugState, 'unknown'> }>();

export function withdrawnFromList(data: unknown): Set<string> | null {
  if (!Array.isArray(data)) return null;
  const out = new Set<string>();
  for (const it of data) {
    if (it && typeof it === 'object' && (it as { withdrawn?: unknown }).withdrawn === true) {
      const slug = (it as { slug?: unknown }).slug;
      if (typeof slug === 'string') out.add(slug);
    }
  }
  return out;
}

export interface Deps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}
const defaultDeps: Deps = { fetch: (u, i) => fetch(u, i), now: () => Date.now() };

export interface Origins {
  /** Origin самого сайта (запроса) — для `/api/withdrawn`. */
  site: string;
  /** `PUBLISHER_API_ORIGIN` — запасная проверка материала. */
  api: string;
}

export async function slugState(
  origins: Origins,
  publicKey: string,
  slug: string,
  deps: Deps = defaultDeps,
): Promise<SlugState> {
  const apiOrigin = origins.api;
  const now = deps.now();
  const q = `key=${encodeURIComponent(publicKey)}`;
  if (!(list && now - list.at < TTL_MS) && now - listFailedAt >= LIST_RETRY_MS) {
    try {
      const res = await deps.fetch(`${origins.site}/api/withdrawn`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const body = (await res.json()) as { success?: boolean; data?: unknown };
      const slugs = res.ok && body.success === true ? withdrawnFromList(body.data) : null;
      if (slugs) list = { at: now, slugs };
      else listFailedAt = now;
    } catch {
      listFailedAt = now;
    }
  }
  if (list && now - list.at < TTL_MS) return list.slugs.has(slug) ? 'withdrawn' : 'pass';
  // Список неизвестен — проверяем сам материал.
  const hit = perSlug.get(slug);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  try {
    const res = await deps.fetch(`${apiOrigin}${PUBLIC_API_PREFIX}/contents/${slug}?${q}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const state = res.status === 410 ? 'withdrawn' : res.status === 200 || res.status === 404 ? 'pass' : null;
    if (!state) return 'unknown';
    perSlug.set(slug, { at: now, state });
    return state;
  } catch {
    return 'unknown';
  }
}

/** Только для unit-тестов. */
export function resetWithdrawnState() {
  list = null;
  listFailedAt = -Infinity;
  perSlug.clear();
}
