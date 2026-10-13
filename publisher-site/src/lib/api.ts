import { unstable_cache } from 'next/cache';
import { PUBLIC_API_PREFIX } from '@/brand';
import type { AltContact, Envelope, FaqItem, PublicContent, PublicContentListItem, SiteConfigView } from './api-types';
import { publisherEnv } from './server-env';
import { siteHost } from './site-url';

/**
 * Серверные запросы к публичному API (проектный документ §13.1, §11.4).
 * Только при сборке и ISR: `next.revalidate = 300` (как у страниц) и тег
 * `publisher` — `POST /api/revalidate` сбрасывает все разом.
 *
 * Честность (ТЗ §19): сбой API — исключение. При `next build` сборка
 * падает (страница без данных не собирается с выдуманными), при ISR Next
 * оставляет прежнюю версию страницы. Снятый материал — `withdrawn`, а не
 * ошибка; неизвестный — `not_found`.
 *
 * Запросы без `Origin` (сервер сборки) — их допускает гвард для `GET`.
 *
 * ЭПОХА ревалидации (`rv=`, Z-2b): ответы публичного API кэширует CDN
 * sites-backend (`s-maxage=60, stale-while-revalidate=300`). Без меры
 * `POST /api/revalidate` перестраивал бы страницы по УСТАРЕВШЕМУ ответу CDN
 * (снятый материал снова попадал бы в ISR). Эпоха — значение в общем
 * data cache Next с тем же тегом: ревалидация её сбрасывает, новая эпоха
 * меняет адрес запроса → промах CDN → свежий ответ. Между ревалидациями
 * эпоха постоянна, кэш CDN работает как раньше.
 */
export const REVALIDATE_SEC = 300;
export const CACHE_TAG = 'publisher';
/** Список снятых для middleware (`/api/withdrawn`) — чаще страниц. */
export const WITHDRAWN_REVALIDATE_SEC = 60;

const revalidationEpoch = unstable_cache(async () => Date.now().toString(36), ['publisher-revalidation-epoch'], {
  tags: [CACHE_TAG],
});

export class PublisherApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`publisher API ${path}: HTTP ${status}${code ? ` ${code}` : ''}`);
  }
}

async function getJson<T>(
  path: string,
  query: Record<string, string>,
  revalidate: number = REVALIDATE_SEC,
): Promise<{ status: number; body: Envelope<T> | null }> {
  const { apiOrigin, publicKey } = publisherEnv();
  const qs = new URLSearchParams({ key: publicKey, ...query, rv: await revalidationEpoch() });
  const res = await fetch(`${apiOrigin}${PUBLIC_API_PREFIX}${path}?${qs}`, {
    headers: { accept: 'application/json', 'accept-language': 'uk' },
    next: { revalidate, tags: [CACHE_TAG] },
  });
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function fail(path: string, status: number, body: Envelope<unknown> | null): never {
  const code = body && body.success === false ? body.error.code : null;
  throw new PublisherApiError(path, status, code);
}

export async function getSiteConfig(): Promise<SiteConfigView> {
  const { status, body } = await getJson<SiteConfigView>('/site-config', { host: siteHost() });
  if (status !== 200 || !body || body.success !== true) fail('/site-config', status, body);
  return body.data;
}

export async function listContents(): Promise<PublicContentListItem[]> {
  const { status, body } = await getJson<PublicContentListItem[]>('/contents', {});
  if (status !== 200 || !body || body.success !== true || !Array.isArray(body.data)) fail('/contents', status, body);
  return body.data;
}

/**
 * Снятые slug для middleware (`/api/withdrawn`): тот же data cache и тег,
 * что у страниц, — `POST /api/revalidate` сбрасывает его вместе с ними.
 * Сбой — исключение (маршрут ответит 503, middleware уйдёт в fail-closed).
 */
export async function listWithdrawnSlugs(): Promise<string[]> {
  const { status, body } = await getJson<PublicContentListItem[]>('/contents', {}, WITHDRAWN_REVALIDATE_SEC);
  if (status !== 200 || !body || body.success !== true || !Array.isArray(body.data)) fail('/contents', status, body);
  return body.data.filter((c) => c.withdrawn === true && typeof c.slug === 'string').map((c) => c.slug);
}

/** Опубликованные (не снятые) — для списка, sitemap и примера на посадочной. */
export async function listPublished(): Promise<PublicContentListItem[]> {
  return (await listContents()).filter((c) => !c.withdrawn && SLUG_RE.test(c.slug));
}

export const SLUG_RE = /^[a-z0-9-]{3,80}$/;

export type ContentResult = { kind: 'ok'; content: PublicContent } | { kind: 'withdrawn' } | { kind: 'not_found' };

export async function getContent(slug: string): Promise<ContentResult> {
  if (!SLUG_RE.test(slug)) return { kind: 'not_found' };
  const path = `/contents/${slug}`;
  const { status, body } = await getJson<PublicContent | { withdrawn: true }>(path, {});
  if (status === 410) return { kind: 'withdrawn' };
  if (status === 404) return { kind: 'not_found' };
  if (status !== 200 || !body || body.success !== true) fail(path, status, body);
  const data = body.data as PublicContent | { withdrawn: true };
  if ('withdrawn' in data && data.withdrawn === true) return { kind: 'withdrawn' };
  return { kind: 'ok', content: data as PublicContent };
}

// ── Нормализация «unknown»-полей site-config ───────────────────────────

const ALT_HREF_RE = /^(https:\/\/[^\s]+|mailto:[^\s]+|tel:\+?[0-9 ()-]{5,30})$/;

/** `alt_contact` → `{label, href}`; ссылка — только https/mailto/tel (как `parameter-schemas.ts`). */
export function altContactOf(raw: unknown): AltContact | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label) return null;
  const href = typeof r.href === 'string' && ALT_HREF_RE.test(r.href.trim()) ? r.href.trim() : null;
  return { label: label.slice(0, 200), href };
}

/** Факты `faq` → `{question, answer}`, не больше пяти (ТЗ §8.1). */
export function faqOf(raw: unknown[]): FaqItem[] {
  const out: FaqItem[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.question === 'string' && typeof r.answer === 'string' && r.question.trim() && r.answer.trim()) {
      out.push({ question: r.question.trim(), answer: r.answer.trim() });
    }
    if (out.length === 5) break;
  }
  return out;
}

/** Умолчание параметра `contact_sla` (`contracts/parameters.ts`) — ТЗ §6. */
export const DEFAULT_SLA_RULE = 'next_business_day_end';

/** Срок ответа по `contact_sla.rule`: известное правило → текст словаря, иначе — без обещания срока. */
export function slaTextOf(raw: unknown, texts: Record<string, string>): string {
  const rule =
    raw && typeof raw === 'object' && typeof (raw as { rule?: unknown }).rule === 'string'
      ? (raw as { rule: string }).rule
      : raw === undefined || raw === null
        ? DEFAULT_SLA_RULE
        : 'unknown';
  return texts[rule] ?? texts.unknown;
}
