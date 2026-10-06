import type { Locale } from './i18n';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000/api').replace(/\/+$/, '');
export type DemoScenario = 'ads' | 'greetings';
const TOPICS: Record<DemoScenario, readonly string[]> = {
  ads: Array.from({ length: 10 }, (_, i) => String(i + 1)),
  greetings: ['greeting-brief', 'greeting-references', 'greeting-script', 'greeting-settings', 'greeting-video'],
};

export interface TutorialDemo {
  subjectKey: string;
  title: string;
  videoUrl: string;
}

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
      const url = parseUrl(data.videoUrl);
      if (!url || url.protocol !== 'https:' || url.username || url.password) return 'none';
      return { subjectKey, title: data.title, videoUrl: url.href };
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
