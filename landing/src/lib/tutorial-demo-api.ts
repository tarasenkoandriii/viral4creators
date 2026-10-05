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

/** Only the public, reviewed tutorial feed; never raw cron snapshots. */
export async function listTutorialDemos(scenario: DemoScenario, locale: Locale): Promise<TutorialDemo[]> {
  const items = await Promise.all(TOPICS[scenario].map(async (subjectKey) => {
    try {
      const response = await fetch(`${API_BASE_URL}/tutorial-help/${subjectKey}?locale=${locale}`, {
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      const data = body?.data;
      if (!body?.success || data?.subjectKey !== subjectKey || data?.locale !== locale ||
          typeof data?.title !== 'string' || !data.title.trim() || typeof data?.videoUrl !== 'string') return null;
      const url = new URL(data.videoUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return { subjectKey, title: data.title, videoUrl: url.href };
    } catch {
      // A missing approval or API failure must not break the landing.
      return null;
    }
  }));
  return items.filter((item): item is TutorialDemo => item !== null);
}
