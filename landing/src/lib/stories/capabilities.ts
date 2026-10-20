/**
 * Блок «что доступно» лендинга Story‑Tales (итерация 2, Р-ST3-6) — из
 * публичного `GET /api/public/story-capabilities` backend'а (без
 * авторизации, без PII, `Cache-Control: public, max-age=300`).
 *
 * Читается на сервере при сборке и при ISR-ревалидации (`revalidate:
 * 300`, как сам ответ API), только в режимах `pilot`/`public`
 * (`landing-mode.ts`): в `closed` страница не отдаётся, и ходить в API
 * незачем. Браузер посетителя в API не ходит — CORS и счётчики не нужны.
 *
 * Любая неудача — сеть, таймаут, 404 (backend в режиме `owner`), не тот
 * конверт, негодные поля — даёт `STATIC_STORY_CAPABILITIES`: сборка не
 * падает, страница показывает честное общее описание без списка историй
 * и без цены. Ответ API проверяется по полям, а не доверяется целиком:
 * строки обрезаются, языки — только из закрытого списка, формат — только
 * известный странице, цена — только положительное конечное число; всё
 * чужое отбрасывается по одному, а не роняет блок.
 */

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000/api').replace(/\/+$/, '');

/** Тот же интервал, что `max-age` ответа API. */
export const STORY_CAPABILITIES_REVALIDATE_SECONDS = 300;
const TIMEOUT_MS = 5000;
const MAX_TALES = 30;
const MAX_TITLE = 120;

export const STORY_CAPABILITY_LANGUAGES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type StoryCapabilityLanguage = (typeof STORY_CAPABILITY_LANGUAGES)[number];
export const STORY_CAPABILITY_FORMATS = ['audio', 'video'] as const;
export type StoryCapabilityFormat = (typeof STORY_CAPABILITY_FORMATS)[number];

export interface StoryCapabilityTale {
  slug: string;
  /** Название на языке страницы, если оно есть, иначе основное. */
  titles: Partial<Record<StoryCapabilityLanguage, string>>;
  title: string;
  languages: StoryCapabilityLanguage[];
}

export interface StoryCapabilities {
  /** `api` — данные приложения; `static` — откат без списка и цены. */
  source: 'api' | 'static';
  languages: StoryCapabilityLanguage[];
  tales: StoryCapabilityTale[];
  formats: StoryCapabilityFormat[];
  priceFromUsd: number | null;
}

/** Откат: языки пилота из контракта, без историй, форматов и цены. */
export const STATIC_STORY_CAPABILITIES: Readonly<StoryCapabilities> = Object.freeze<StoryCapabilities>({
  source: 'static',
  languages: ['ru', 'uk'],
  tales: [],
  formats: [],
  priceFromUsd: null,
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE) : null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v)))];
}

/**
 * Разбор тела ответа: конверт `{success, data}` глобального
 * ResponseInterceptor или голые данные. `null` — данных нет совсем
 * (тогда — откат).
 */
export function parseStoryCapabilities(body: unknown): StoryCapabilities | null {
  const envelope = body as { success?: unknown; data?: unknown } | null;
  const data = (envelope && typeof envelope === 'object' && 'success' in envelope
    ? envelope.success === true
      ? envelope.data
      : null
    : body) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.mode !== 'pilot' && data.mode !== 'public') return null;
  const languages = pick(data.languages, STORY_CAPABILITY_LANGUAGES);
  if (!languages.length) return null;
  const tales: StoryCapabilityTale[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.tales) ? data.tales : []) {
    if (tales.length >= MAX_TALES) break;
    if (!raw || typeof raw !== 'object') continue;
    const tale = raw as Record<string, unknown>;
    const slug = typeof tale.slug === 'string' && SLUG_RE.test(tale.slug) ? tale.slug : null;
    const title = text(tale.title);
    const taleLanguages = pick(tale.languages, STORY_CAPABILITY_LANGUAGES);
    if (!slug || !title || !taleLanguages.length || seen.has(slug)) continue;
    seen.add(slug);
    const titles: Partial<Record<StoryCapabilityLanguage, string>> = {};
    if (tale.titles && typeof tale.titles === 'object') {
      for (const l of STORY_CAPABILITY_LANGUAGES) {
        const t = text((tale.titles as Record<string, unknown>)[l]);
        if (t) titles[l] = t;
      }
    }
    tales.push({ slug, title, titles, languages: taleLanguages });
  }
  const price = data.priceFromUsd;
  return {
    source: 'api',
    languages,
    tales,
    formats: pick(data.formats, STORY_CAPABILITY_FORMATS),
    priceFromUsd: typeof price === 'number' && Number.isFinite(price) && price > 0 && price < 1000 ? price : null,
  };
}

/** Название истории на языке страницы (иначе — основное). */
export function taleTitle(tale: StoryCapabilityTale, locale: string): string {
  return tale.titles[locale as StoryCapabilityLanguage] ?? tale.title;
}

/** Только сервер: сборка и ISR. Никогда не бросает. */
export async function loadStoryCapabilities(fetchImpl: typeof fetch = fetch): Promise<StoryCapabilities> {
  try {
    const response = await fetchImpl(`${API_BASE_URL}/public/story-capabilities`, {
      next: { revalidate: STORY_CAPABILITIES_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    } as RequestInit);
    if (!response.ok) return STATIC_STORY_CAPABILITIES;
    return parseStoryCapabilities(await response.json()) ?? STATIC_STORY_CAPABILITIES;
  } catch {
    // Backend недоступен на сборке/ревалидации — лендинг не падает.
    return STATIC_STORY_CAPABILITIES;
  }
}
