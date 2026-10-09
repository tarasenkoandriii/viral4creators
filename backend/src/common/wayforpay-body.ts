/**
 * Тело вебхука WayForPay (`serviceUrl`) в один вид — общий для backend
 * (`billing/webhook/wayforpay`, генератор) и sites-backend
 * (`assist/billing/webhook/wayforpay`, Помощник). Копия —
 * `sites-backend/src/shared/wayforpay-body.ts` через
 * `scripts/sync-sites-shared.mjs`.
 *
 * Схему задаёт провайдер, DTO нет. Виды, которые встречаются:
 *  - JSON (`application/json`) — объект как есть;
 *  - форма `x-www-form-urlencoded`, где весь JSON — ОДИН ключ с пустым
 *    значением (так присылают некоторые интеграции WayForPay): `{ '{…}': '' }`;
 *  - строка (если маршрут разбирает `text/plain`) — JSON.parse;
 *  - без тела / неподходящий тип — `{}` (Express 5 + `defaultEmptyBody`).
 * Нераспознанное — `{}`: проверка подписи дальше просто не сойдётся
 * (квитанция/400), а не TypeError → 500. Заход 12, аудит P2-3.
 */

function parseObject(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function wayforpayBody<T extends object = Record<string, unknown>>(
  body: unknown,
): Partial<T> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && o[keys[0]] === '' && keys[0].startsWith('{')) {
      return parseObject(keys[0]) as Partial<T>;
    }
    return o as Partial<T>;
  }
  if (typeof body === 'string') return parseObject(body) as Partial<T>;
  return {};
}
