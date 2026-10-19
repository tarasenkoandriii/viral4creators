/**
 * Второй канал телеметрии сайта — агрегатный счётчик «Посещения лендингов»
 * платформы (backend viral4creators, `POST …/api/public/landing-visits`,
 * вкладка Админки). Проектный документ §13.5 (Р-IA-FXA-1…3; внутренний
 * аудит 19.10.2026, IA-AB-03 = IA-C-01 = Н-D1-2).
 *
 * Канал включён, только если ВСЕ условия выполнены:
 *  1. адрес задан `PUBLISHER_LANDING_VISITS_URL` (без значения — канал
 *     выключен и его origin не попадает в CSP); превью/разработка Vercel —
 *     всегда выключен (тестовый трафик);
 *  2. site-config продукта: `mode = live` — в `closed` сайт не открыт, а
 *     `test` — тестовый трафик, который у счётчика платформы не
 *     помечается и попал бы в деловые суммы (AT-CORE-06);
 *  3. site-config продукта: `consentState ∈ {granted, not_required}` — то
 *     же согласие, что у основного трекера Publisher; `denied` и
 *     `unknown` — не отправлять.
 * Решение принимается на сервере (layout) — клиент получает либо адрес,
 * либо `null`. Тело — `{eventId, landing:'publisher', locale}`: без cookie
 * (`credentials:'omit'`), без referrer, URL, query и идентификатора
 * посетителя (`eventId` — случайный ключ идемпотентности одного события).
 */
import type { ConsentState, ProductMode } from './api-types';

/** Ключ лендинга Publisher у счётчика платформы. */
export const LANDING_VISITS_LANDING = 'publisher';
/**
 * Язык сайта у счётчика платформы — `PUBLISHER_BRAND.lang` (сайт одноязычный,
 * uk; равенство держит `scripts/landing-visits.test.ts`). Константа, а не
 * проп, — меньше кода в чанке трекера.
 */
export const LANDING_VISITS_LOCALE = 'uk';
/** Состояния согласия, при которых канал разрешён (то же поле, что у трекера). */
export const LANDING_VISITS_CONSENT: readonly ConsentState[] = ['granted', 'not_required'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Адрес счётчика из окружения: `''` — канал выключен (не задан или превью
 * Vercel). Неверное значение — ошибка (как у `PUBLISHER_API_ORIGIN`).
 * Те же правила — `validateLandingVisitsUrl` в `next.config.js`;
 * совпадение держит `scripts/landing-visits.test.ts`.
 */
export function landingVisitsUrlOf(env: Record<string, string | undefined>): string {
  const raw = (env.PUBLISHER_LANDING_VISITS_URL ?? '').trim();
  if (!raw) return '';
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLISHER_LANDING_VISITS_URL не URL: «${raw}»`);
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.search || url.hash || url.pathname === '/' || !url.pathname) {
    throw new Error(`PUBLISHER_LANDING_VISITS_URL — полный адрес приёма без параметров и учётных данных: «${raw}»`);
  }
  if (url.protocol === 'https:' && !url.port && !LOCAL_HOSTS.has(host)) return `https://${host}${url.pathname}`;
  if (LOCAL_HOSTS.has(host) && !env.VERCEL && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  }
  throw new Error(
    `PUBLISHER_LANDING_VISITS_URL должен быть https://домен/путь без порта (http://localhost — только вне Vercel): «${raw}»`,
  );
}

/** Куда слать просмотр: адрес или `null` (канал выключен для этой сборки/конфига). */
export function landingVisitsTarget(
  url: string,
  cfg: { mode: ProductMode; consentState: ConsentState },
): string | null {
  if (!url) return null;
  if (cfg.mode !== 'live') return null;
  if (!LANDING_VISITS_CONSENT.includes(cfg.consentState)) return null;
  return url;
}

/**
 * Один просмотр: `fetch` без cookie и referrer; ошибка сети не всплывает на
 * страницу. `eventId` — случайный ключ идемпотентности этого события (не
 * идентификатор посетителя). Минимум аргументов — меньше кода в чанке
 * трекера (бюджет ≤ 2048 Б gzip, §13.6).
 */
export function sendLandingVisit(endpoint: string): void {
  // Порядок полей — как у `sendEvent` (track.ts): gzip чанка трекера сжимает повтор.
  fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      eventId: crypto.randomUUID(),
      landing: LANDING_VISITS_LANDING,
      locale: LANDING_VISITS_LOCALE,
    }),
    keepalive: true,
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    referrerPolicy: 'no-referrer',
  }).catch(() => undefined);
}
