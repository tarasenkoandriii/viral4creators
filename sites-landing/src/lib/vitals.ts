/**
 * Полевые Core Web Vitals (ТЗ §9 п.7): `web-vitals` в браузере →
 * `POST /api/vitals` → строка в логах функции Vercel.
 *
 * Почему так, а не first-party события §10: их приёмник
 * (`POST /public/landing/event` в `sites-backend`) появится только в Э2
 * продукта; до него у Л0–Л1 — только Vercel Web Analytics (§14 Л0), а
 * её пользовательские события на Hobby недоступны. Логи — честный
 * промежуточный приёмник: без cookie и без идентификатора посетителя,
 * только метрика, значение, оценка и путь. p75 по логам считается
 * выгрузкой (Vercel → Logs, фильтр `vital`); с Э2 продукта — переключить
 * отправку на §10.
 */
import { locales } from './i18n';
import { LEGAL_DOCS } from './legal-docs';
import { PAGES } from './pages';
import { PILOT_RESULT_CODES } from './pilot-validation';

export const VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

export interface VitalSample {
  name: VitalName;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  path: string;
}

/**
 * Пути, которые попадают в журнал как есть: страницы сайта × локали,
 * страницы результата формы и юр-страницы. Любой другой путь (404,
 * опечатка, подделанный запрос) пишется как `other`: приёмник открыт
 * всем, и без этого через поле `path` в журнал можно было бы писать
 * произвольный текст (`/my-email-…`) — чужие данные в наших логах.
 */
export const OTHER_PATH = 'other';
export const KNOWN_VITAL_PATHS: ReadonlySet<string> = new Set([
  ...locales.flatMap((l) => [
    ...PAGES.map((p) => `/${l}${p.path}`),
    ...PILOT_RESULT_CODES.map((c) => `/${l}/assistant/pilot/status/${c}`),
  ]),
  ...LEGAL_DOCS.map((d) => `/legal/${d.slug}`),
]);

/** Предел тела запроса приёмника (байты/символы): выборка — ~100 байт. */
export const VITAL_BODY_LIMIT = 2000;

export function parseVital(raw: unknown): VitalSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!(VITAL_NAMES as readonly unknown[]).includes(r.name)) return null;
  if (typeof r.value !== 'number' || !Number.isFinite(r.value) || r.value < 0 || r.value > 600_000) return null;
  if (r.rating !== 'good' && r.rating !== 'needs-improvement' && r.rating !== 'poor') return null;
  if (typeof r.path !== 'string' || !/^\/[A-Za-z0-9/_-]{0,200}$/.test(r.path)) return null;
  const path = KNOWN_VITAL_PATHS.has(r.path) ? r.path : OTHER_PATH;
  return { name: r.name as VitalName, value: Math.round(r.value * 1000) / 1000, rating: r.rating, path };
}
