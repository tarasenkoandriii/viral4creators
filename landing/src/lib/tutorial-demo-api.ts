import type { Locale } from './i18n';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000/api').replace(/\/+$/, '');
export type DemoScenario = 'ads' | 'greetings';
const TOPICS: Record<DemoScenario, readonly string[]> = {
  ads: Array.from({ length: 10 }, (_, i) => String(i + 1)),
  greetings: ['greeting-brief', 'greeting-references', 'greeting-script', 'greeting-settings', 'greeting-video'],
};

export type DemoTheme = 'light' | 'dark';

export interface TutorialDemo {
  subjectKey: string;
  title: string;
  videoUrl: string;
  /**
   * Размер холста ролика — сцена плеера ставит по нему пропорцию ДО
   * загрузки видео (`preload="none"`). Оба `null`, если API размера не
   * дал или дал негодный: тогда прежняя вертикаль 720:1560.
   */
  width: number | null;
  height: number | null;
  /** Первый кадр ролика, показывается до нажатия; `null` — нет. */
  posterUrl: string | null;
  /** Тема интерфейса на съёмке; `null` — не записана. */
  theme: DemoTheme | null;
  /**
   * Одобренные ролики каждой темы (`variants` ответа API). Верхние поля —
   * как раньше (их показывает сервер до того, как браузер узнал тему
   * посетителя); вариант выбирает сцена плеера по `prefers-color-scheme`
   * (`pickDemoVariant` в `demo-stage.ts`). Пусто — прежнее поведение.
   */
  variants: DemoVariants;
}

/** Ролик одной темы: те же поля и те же проверки, что у верхних. */
export interface DemoVariant {
  videoUrl: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
}

export type DemoVariants = Partial<Record<DemoTheme, DemoVariant>>;

export const DEMO_THEMES: readonly DemoTheme[] = ['light', 'dark'];

/** Границы размера: меньше 16 px — не кадр, больше 8K — не наш ролик.
 * Вне них — мусор, который сломал бы `aspect-ratio` сцены. */
export const DEMO_MIN_SIDE = 16;
export const DEMO_MAX_SIDE = 7680;

/**
 * Лента демо одной локали. `failed` — роликов нет, и хотя бы одна тема не
 * ответила (сеть, таймаут, 5xx, битый ответ): сказать «видео для этого
 * языка нет» тогда нельзя, страница показывает нейтральный текст.
 * Если ролики есть, частичный сбой не важен — показываем, что пришло.
 */
export interface TutorialDemoFeed {
  items: TutorialDemo[];
  failed: boolean;
}

type TopicResult = TutorialDemo | 'none' | 'error';

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Публичная ссылка на медиа: только https и без логина/пароля в адресе. */
export function safeMediaUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = parseUrl(raw);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href;
}

function side(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= DEMO_MIN_SIDE && raw <= DEMO_MAX_SIDE
    ? raw
    : null;
}

/** Размер кадра — оба целых в границах или оба `null`: по одной
 * стороне пропорцию не поставить. */
export function demoSize(width: unknown, height: unknown): { width: number; height: number } | null {
  const w = side(width);
  const h = side(height);
  return w !== null && h !== null ? { width: w, height: h } : null;
}

/**
 * Один вариант темы. Без годного `videoUrl` варианта нет; размер и
 * постер, как у верхних полей, отбрасываются по одному.
 */
export function parseDemoVariant(raw: unknown): DemoVariant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const videoUrl = safeMediaUrl(data.videoUrl);
  if (!videoUrl) return null;
  const size = demoSize(data.width, data.height);
  return { videoUrl, posterUrl: safeMediaUrl(data.posterUrl), width: size?.width ?? null, height: size?.height ?? null };
}

/**
 * `variants` ответа: только ключи `light`/`dark`, каждый — через
 * `parseDemoVariant`. Нет поля, не объект, всё негодное — `{}`, то есть
 * прежнее поведение по верхним полям.
 */
export function parseDemoVariants(raw: unknown): DemoVariants {
  const out: DemoVariants = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const theme of DEMO_THEMES) {
    // Только собственные поля: `{ __proto__: … }` из JSON — не тема.
    if (!Object.prototype.hasOwnProperty.call(raw, theme)) continue;
    const variant = parseDemoVariant((raw as Record<string, unknown>)[theme]);
    if (variant) out[theme] = variant;
  }
  return out;
}

/**
 * Only the public, reviewed tutorial feed; never raw cron snapshots.
 *
 * Страница вызывает это ОДИН раз и раздаёт результат галерее, кнопке
 * первого экрана и футеру. Полагаться на дедупликацию fetch в рамках
 * рендера нельзя: React пропускает её для запроса со своим `signal`
 * (`AbortSignal.timeout` ниже), так что второй вызов — это ещё десять
 * походов в API.
 */
export async function loadTutorialDemos(scenario: DemoScenario, locale: Locale): Promise<TutorialDemoFeed> {
  const results = await Promise.all(TOPICS[scenario].map(async (subjectKey): Promise<TopicResult> => {
    try {
      const response = await fetch(`${API_BASE_URL}/tutorial-help/${subjectKey}?locale=${locale}`, {
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return 'error';
      const body = await response.json();
      const data = body?.data;
      if (!body?.success || data?.subjectKey !== subjectKey || typeof data?.title !== 'string') return 'error';
      // Ответ корректный, но ролика для этой локали нет (не вычитан, или
      // API отдал тему на языке по умолчанию).
      if (data.locale !== locale || !data.title.trim() || typeof data.videoUrl !== 'string') return 'none';
      const videoUrl = safeMediaUrl(data.videoUrl);
      if (!videoUrl) return 'none';
      // Метаданные — улучшение, а не условие: негодный размер или постер
      // отбрасываются по одному, ролик остаётся.
      const size = demoSize(data.width, data.height);
      return {
        subjectKey,
        title: data.title,
        videoUrl,
        width: size?.width ?? null,
        height: size?.height ?? null,
        posterUrl: safeMediaUrl(data.posterUrl),
        theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : null,
        variants: parseDemoVariants(data.variants),
      };
    } catch {
      // A missing approval or API failure must not break the landing.
      return 'error';
    }
  }));
  const items = results.filter((item): item is TutorialDemo => typeof item === 'object');
  return { items, failed: items.length === 0 && results.includes('error') };
}

export async function listTutorialDemos(scenario: DemoScenario, locale: Locale): Promise<TutorialDemo[]> {
  return (await loadTutorialDemos(scenario, locale)).items;
}
