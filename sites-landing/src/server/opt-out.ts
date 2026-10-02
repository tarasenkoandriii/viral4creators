import { BRAND } from '../brand';
import { isLocale, X_DEFAULT_LOCALE } from '../lib/i18n';
import { notifyConfig } from './pilot-notify';
import { clientIp, ipKeyPart, RateLimiter } from './rate-limit';
import { createHash } from 'node:crypto';

/**
 * Форма «уберите мой сайт» (opt-out, ТЗ §13, §6.3; страница бота
 * `/assistant/bot`). Публичного маршрута opt-out в продукте нет (только
 * таблица ядра `site_opt_out_domains`), поэтому — как форма пилота до
 * продукта: route handler → сообщение в служебный Telegram-канал, оператор
 * вносит домен в список ядра (обещание на странице — до 72 ч, как QA).
 * Мгновенный путь, который работает без нас, — `robots.txt` для нашего UA
 * (обход его соблюдает) — страница говорит об этом первым.
 *
 * Только обычная отправка формы (страница бота без клиентского JS): ответ
 * — 303 на статическую страницу результата `/<loc>/assistant/bot/status/<код>`.
 * Порядок проверок — как у пилота: Origin/размер → ловушка → лимит → поля
 * → env → Telegram. Ни одна ветка не «съедает» запрос молча: без env —
 * «временно недоступно, запрос НЕ отправлен».
 */
export const OPT_OUT_CODES = ['sent', 'invalid', 'limited', 'unavailable', 'error'] as const;
export type OptOutCode = (typeof OPT_OUT_CODES)[number];

export const OPT_OUT_LIMITS = { bodyBytes: 4 * 1024, domain: 253, contact: 120, comment: 500 } as const;
export const OPT_OUT_HONEYPOT = 'website';

export interface OptOutRequest {
  domain: string;
  contact: string;
  comment: string;
  locale: string;
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Домен из ввода: схема/путь/порт/`www.` отбрасываются; только имя с точкой, без IP. */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(CONTROL, '');
  if (!s || s.length > OPT_OUT_LIMITS.domain + 20) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.includes('@')) return null;
  if (s.startsWith('www.')) s = s.slice(4);
  let ascii: string;
  try {
    ascii = new URL(`https://${s}/`).hostname;
  } catch {
    return null;
  }
  if (ascii.length > OPT_OUT_LIMITS.domain || !/^[a-z0-9.-]+$/.test(ascii) || !ascii.includes('.')) return null;
  if (/^\d+(\.\d+){3}$/.test(ascii) || ascii.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
  return ascii;
}

export function validateOptOut(raw: Record<string, unknown>): { ok: true; value: OptOutRequest } | { ok: false } {
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const domain = normalizeDomain(str('domain'));
  const contact = str('contact').replace(CONTROL, '').trim();
  const comment = str('comment').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  const consent = raw.consent === 'on' || raw.consent === true || raw.consent === 'true';
  const contactOk = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(contact) || /^@[A-Za-z0-9_]{5,32}$/.test(contact);
  if (!domain || !contactOk || contact.length > OPT_OUT_LIMITS.contact || comment.length > OPT_OUT_LIMITS.comment || !consent) return { ok: false };
  return { ok: true, value: { domain, contact, comment, locale: isLocale(str('locale')) ? str('locale') : X_DEFAULT_LOCALE } };
}

/** Текст в канал — простой текст без parse_mode; комментарий — с префиксом строк (как у пилота). */
export function formatOptOutMessage(r: OptOutRequest, at: Date): string {
  const lines = [
    `Opt-out: прибрати сайт з обходу — ${BRAND.name}`,
    `Домен: ${r.domain}`,
    `Контакт: ${r.contact}`,
    `Мова сторінки: ${r.locale}`,
    'Дія: внести домен у site_opt_out_domains (≤ 72 год), відповісти на контакт.',
  ];
  if (r.comment) lines.push('', 'Коментар:', ...r.comment.split(/\n|[\u0085\u2028\u2029]/).map((l) => `│ ${l}`));
  lines.push('', `Отримано: ${at.toISOString()}`);
  return lines.join('\n');
}

export interface OptOutDeps {
  limiter: RateLimiter;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function handleOptOut(req: Request, deps: OptOutDeps): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  let locale: string = X_DEFAULT_LOCALE;
  const reply = (code: OptOutCode) =>
    new Response(null, { status: 303, headers: { location: `/${locale}/assistant/bot/status/${code}`, 'cache-control': 'no-store' } });

  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin && host) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== host) return reply('error');
  }
  if (Number(req.headers.get('content-length') ?? '0') > OPT_OUT_LIMITS.bodyBytes) return reply('error');
  let raw: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > OPT_OUT_LIMITS.bodyBytes) return reply('error');
    raw = Object.fromEntries(new URLSearchParams(text));
  } catch {
    return reply('invalid');
  }
  if (typeof raw.locale === 'string' && isLocale(raw.locale)) locale = raw.locale;
  if (typeof raw[OPT_OUT_HONEYPOT] === 'string' && (raw[OPT_OUT_HONEYPOT] as string).trim() !== '') return reply('sent');
  const key = createHash('sha256').update(`${ipKeyPart(clientIp(req.headers))}|${new Date(now).toISOString().slice(0, 10)}|opt-out`).digest('hex').slice(0, 32);
  if (!deps.limiter.take(key, now)) return reply('limited');
  const checked = validateOptOut(raw);
  if (!checked.ok) return reply('invalid');
  const config = notifyConfig(deps.env);
  if (!config) return reply('unavailable');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text: formatOptOutMessage(checked.value, new Date(now)), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`opt-out: Telegram sendMessage ответил ${res.status}`);
      return reply('error');
    }
  } catch (err) {
    console.error(`opt-out: Telegram sendMessage не выполнен: ${(err as Error).name}`);
    return reply('error');
  }
  return reply('sent');
}
