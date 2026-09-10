/**
 * Г-3.3 (аудит round4, этап 64): `recToken` (реквизит регулярного
 * списания), `cardPan`, `authCode` вырезаются перед сохранением ответа
 * WayForPay в `Payment.rawPayload` — иначе дамп таблицы `payments`
 * содержит токены рекуррентных списаний ВСЕХ клиентов открытым текстом,
 * хотя тот же `recToken` для реального использования отдельно шифруется
 * (`Subscription.recTokenEnc`, ключ `PAYMENT_TOKEN_KEY`,
 * `token-crypto.ts`). `rawPayload` нужен только для разбора спорных
 * случаев оператором — этих трёх полей там не требуется.
 *
 * Общий helper для всех трёх мест, где ответ/вебхук WayForPay попадает в
 * `rawPayload`: `billing.service.ts` (вебхук чекаута и продления),
 * `wayforpay-renewal.service.ts` (host2host `Charge` крона продления).
 */
export function sanitizeWayForPayRawPayload(payload: unknown): object {
  if (typeof payload !== 'object' || payload === null) {
    // Оба вызывающих места всегда передают объект (тело вебхука/ответ
    // API) — этот путь на практике не встречается, но `rawPayload`
    // (Prisma `Json`) не принимает примитив как есть, оборачиваем.
    return { value: payload };
  }
  const safe = { ...(payload as Record<string, unknown>) };
  delete safe.recToken;
  delete safe.cardPan;
  delete safe.authCode;
  return safe;
}
