/** Значения enum'ов Prisma `PaymentMethod`/`PaymentPurpose`/`PaymentStatus`
 * как строковые литералы — тот же приём, что `PlanId`/`PublicationPlatform`
 * в остальном проекте: Prisma-клиент в этой песочнице не сгенерирован для
 * новых моделей, а типы нужны уже сейчас (билд-неблокирующая заглушка,
 * не расходится с `schema.prisma`, где источник истины). */
export type PaymentMethodValue = 'STARS' | 'WAYFORPAY';
export type PaymentPurposeValue = 'SUBSCRIPTION' | 'CREDIT_PACK';

/** Ответ обоих `checkout`-маршрутов — ровно одно из двух полей заполнено,
 * в зависимости от `method` в запросе. */
export interface CheckoutResult {
  starsInvoiceUrl?: string;
  wayforpayFormUrl?: string;
  wayforpayFields?: Record<string, string>;
}
