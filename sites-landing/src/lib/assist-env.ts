import { ASSIST_DEFAULTS, WIDGET_NAMES } from '../brand';

/**
 * Настройки связи лендинга с продуктом (Л2–Л3): где виджет, где API,
 * ключ НАШЕГО виджета и имя бота. Читаются на сборке (страницы — статика)
 * и впекаются `next.config.js` — с теми же правилами (две копии, как у
 * `SITE_URL`: конфиг читает Node без TypeScript; совпадение держит
 * `scripts/assist-env.test.ts`).
 *
 * Правила:
 *  - origin — только `https://хост` без пути/порта/параметров; `http://`
 *    допускается ТОЛЬКО для localhost/127.0.0.1 и только вне Vercel —
 *    это лабораторный стенд (`scripts/built/assist-stand.mjs`) для axe,
 *    Lighthouse и e2e; на Vercel так сборка падает;
 *  - ключ виджета — `pk_live_…` (на стенде допустим и `pk_test_…`); нет
 *    ключа — живого виджета на лендинге нет (честно: блок «запись»);
 *  - имя бота — `[A-Za-z][A-Za-z0-9_]{3,31}` и оканчивается на `bot`
 *    (правило Telegram); нет — нет кнопки «Сохранить и подключить».
 *  - `ASSIST_LANDING_EVENTS=off` — выключить события §10 (по умолчанию
 *    включены, если есть адрес API).
 */
export interface AssistEnv {
  widgetOrigin: string;
  apiOrigin: string;
  widgetPk: string | null;
  botUsername: string | null;
  eventsEnabled: boolean;
}

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function validateOrigin(raw: string, name: string, opts: { onVercel: boolean }): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} не URL: «${raw}»`);
  }
  const host = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} — только origin (https://домен), без пути и параметров: «${raw}»`);
  }
  if (url.protocol === 'https:' && !url.port && !local) return `https://${host}`;
  if (local && !opts.onVercel && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  }
  throw new Error(`${name} должен быть https://домен без порта (http://localhost — только для стенда вне Vercel): «${raw}»`);
}

export const PK_RE = /^pk_(live|test)_[A-Za-z0-9_-]{8,64}$/;
export const BOT_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function validatePk(raw: string, opts: { onVercel: boolean }): string {
  const pk = raw.trim();
  const m = PK_RE.exec(pk);
  if (!m) throw new Error(`ASSIST_WIDGET_PK — не публичный ключ виджета (pk_live_…): «${raw}»`);
  if (m[1] === 'test' && opts.onVercel) {
    throw new Error('ASSIST_WIDGET_PK: pk_test_ работает только на localhost — на Vercel нужен pk_live_');
  }
  return pk;
}

export function validateBot(raw: string): string {
  const name = raw.trim().replace(/^@/, '');
  if (!BOT_RE.test(name) || !/bot$/i.test(name)) {
    throw new Error(`ASSIST_BOT_USERNAME — не имя бота Telegram (…bot): «${raw}»`);
  }
  return name;
}

export function readAssistEnv(env: Env): AssistEnv {
  const onVercel = env.VERCEL === '1';
  const pick = (v: string | undefined) => (v && v.trim() ? v : null);
  const widgetOrigin = validateOrigin(pick(env.ASSIST_WIDGET_ORIGIN) ?? ASSIST_DEFAULTS.widgetOrigin, 'ASSIST_WIDGET_ORIGIN', { onVercel });
  const apiOrigin = validateOrigin(pick(env.ASSIST_API_ORIGIN) ?? ASSIST_DEFAULTS.apiOrigin, 'ASSIST_API_ORIGIN', { onVercel });
  const pk = pick(env.ASSIST_WIDGET_PK);
  const bot = pick(env.ASSIST_BOT_USERNAME);
  const events = (env.ASSIST_LANDING_EVENTS ?? '').trim().toLowerCase();
  if (events && events !== 'on' && events !== 'off') {
    throw new Error(`ASSIST_LANDING_EVENTS — on|off, получено «${env.ASSIST_LANDING_EVENTS}»`);
  }
  return {
    widgetOrigin,
    apiOrigin,
    widgetPk: pk ? validatePk(pk, { onVercel }) : null,
    botUsername: bot ? validateBot(bot) : null,
    eventsEnabled: events !== 'off',
  };
}

/**
 * Значения для страниц. `next.config.js` уже проверил и впёк их в
 * `process.env` (поэтому обращения — прямые, по имени: так Next их
 * подставляет); здесь — второй замок с тем же разбором.
 */
export function assistEnv(): AssistEnv {
  return readAssistEnv({
    VERCEL: process.env.VERCEL,
    ASSIST_WIDGET_ORIGIN: process.env.ASSIST_WIDGET_ORIGIN,
    ASSIST_API_ORIGIN: process.env.ASSIST_API_ORIGIN,
    ASSIST_WIDGET_PK: process.env.ASSIST_WIDGET_PK,
    ASSIST_BOT_USERNAME: process.env.ASSIST_BOT_USERNAME,
    ASSIST_LANDING_EVENTS: process.env.ASSIST_LANDING_EVENTS,
  });
}

export function loaderUrl(env: Pick<AssistEnv, 'widgetOrigin'>): string {
  return `${env.widgetOrigin}${WIDGET_NAMES.loaderPath}`;
}

export function eventsEndpoint(env: AssistEnv): string | null {
  return env.eventsEnabled ? `${env.apiOrigin}/public/landing/event` : null;
}

export function draftsEndpoint(env: Pick<AssistEnv, 'apiOrigin'>): string {
  return `${env.apiOrigin}/public/widget-drafts`;
}
