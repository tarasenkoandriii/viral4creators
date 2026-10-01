import { HONEYPOT_FIELD, PILOT_LIMITS, validatePilot, type PilotResultCode } from '../lib/pilot-validation';
import { isLocale, X_DEFAULT_LOCALE } from '../lib/i18n';
import { sendPilotApplication } from './pilot-notify';
import { clientIp, rateKey, RateLimiter } from './rate-limit';

/**
 * Обработчик `POST /api/pilot` (логика отдельно от `app/api/pilot/route.ts`,
 * чтобы её проверял `scripts/pilot.test.ts` без Next).
 *
 * Порядок проверок выбран так, чтобы ни одна ветка не «съедала» заявку
 * молча:
 *  1. чужой Origin / слишком большое тело — отказ (`error`);
 *  2. ловушка заполнена — вежливое «отправлено» БЕЗ отправки (боту
 *     незачем знать, что его поймали; человек поле не видит);
 *  3. лимит — `limited`;
 *  4. проверка полей — `invalid` со списком полей;
 *  5. нет env — `unavailable` (503): «временно недоступно, заявка НЕ
 *     отправлена», данные остаются в форме;
 *  6. Telegram не принял — `error` (502), то же обещание.
 *
 * JSON-запрос (форма с JS) получает JSON; обычная отправка формы (без
 * JS) — 303 на статическую страницу результата `/<loc>/assistant/pilot/status/<код>`.
 */
export interface PilotDeps {
  limiter: RateLimiter;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const STATUS: Record<PilotResultCode, number> = { sent: 200, invalid: 422, limited: 429, unavailable: 503, error: 502 };

export async function handlePilotRequest(req: Request, deps: PilotDeps): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  const contentType = req.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  const reply = (code: PilotResultCode, locale: string, extra: Record<string, unknown> = {}, statusOverride?: number) => {
    if (isJson) {
      return Response.json({ ok: code === 'sent', code, ...extra }, { status: statusOverride ?? STATUS[code], headers: { 'cache-control': 'no-store' } });
    }
    const loc = isLocale(locale) ? locale : X_DEFAULT_LOCALE;
    return new Response(null, {
      status: 303,
      headers: { location: `/${loc}/assistant/pilot/status/${code}`, 'cache-control': 'no-store' },
    });
  };

  // 1. Origin: браузер присылает его на POST; чужой — не наша форма.
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin && host) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== host) return reply('error', '', { reason: 'origin' }, 403);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > PILOT_LIMITS.bodyBytes) return reply('error', '', { reason: 'too_large' }, 413);

  let raw: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > PILOT_LIMITS.bodyBytes) return reply('error', '', { reason: 'too_large' }, 413);
    if (isJson) {
      const parsed: unknown = JSON.parse(text);
      raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } else {
      raw = Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return reply('invalid', '', { fields: [] });
  }
  const locale = typeof raw.locale === 'string' ? raw.locale : '';

  // 2. Ловушка.
  if (typeof raw[HONEYPOT_FIELD] === 'string' && (raw[HONEYPOT_FIELD] as string).trim() !== '') {
    console.warn('pilot: сработала ловушка, заявка не отправлена');
    return reply('sent', locale);
  }

  // 3. Лимит.
  if (!deps.limiter.take(rateKey(clientIp(req.headers), now), now)) return reply('limited', locale);

  // 4. Поля.
  const checked = validatePilot(raw);
  if (!checked.ok) return reply('invalid', locale, { fields: checked.errors });

  // 5–6. Отправка.
  const result = await sendPilotApplication(checked.value, { env: deps.env, fetchImpl: deps.fetchImpl, now: new Date(now) });
  if (result === 'unconfigured') return reply('unavailable', locale);
  if (result === 'failed') return reply('error', locale);
  return reply('sent', locale);
}
