/**
 * Публичный адрес API (origin sites-backend) для адресов, которые заказчик
 * вписывает на СВОЁМ сервере — вебхук целей s2s (плагин WordPress, npm
 * `./server`): сервер отдаёт только путь (`IntegrationsView.endpoint`,
 * A — без origin: свой адрес он не знает), полный URL собирает кабинет.
 *
 * Источник (по порядку): `VITE_ASSIST_PUBLIC_API_ORIGIN` (прод:
 * `https://assist-api.<домен>` — https-origin без пути); абсолютный
 * `VITE_SITES_API_URL` (локальный стенд); иначе origin кабинета + база
 * `/api` — тот же rewrite `assist/vercel.json` (рабочий адрес, но лишнее
 * плечо через проект кабинета). Чистые функции — проверяются скриптом.
 */

/** https-origin без пути/запроса; иначе null. */
function httpsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function publicApiBase(
  envOrigin: unknown,
  sitesApiUrl: string,
  pageOrigin: string
): string {
  const env = httpsOrigin(envOrigin);
  if (env) return env;
  if (/^https?:\/\//.test(sitesApiUrl)) return sitesApiUrl.replace(/\/+$/, '');
  const path = sitesApiUrl.startsWith('/') ? sitesApiUrl : '/api';
  return `${pageOrigin}${path}`.replace(/\/+$/, '');
}

/** Путь вебхука целей, который отдаёт сервер (A, `goalWebhookEndpoint`). */
export const GOAL_WEBHOOK_PATH =
  /^\/assist\/v1\/sites\/[A-Za-z0-9_%-]{1,100}\/goal-events$/;

/** Полный адрес вебхука целей для копирования; путь не того вида — ''. */
export function goalWebhookUrl(endpoint: string, base: string): string {
  if (!GOAL_WEBHOOK_PATH.test(endpoint) || !/^https?:\/\//.test(base))
    return '';
  return base + endpoint;
}

/** Э-С Ш5: база путей API знаний, которую отдаёт сервер (`knowledgeApiEndpoint`). */
export const KNOWLEDGE_API_PATH =
  /^\/assist\/v1\/sites\/[A-Za-z0-9_%-]{1,100}\/knowledge\/site\/documents$/;

/** Полный адрес API знаний (без ключа документа); путь не того вида — ''. */
export function knowledgeApiUrl(endpoint: string, base: string): string {
  if (!KNOWLEDGE_API_PATH.test(endpoint) || !/^https?:\/\//.test(base))
    return '';
  return base + endpoint;
}
