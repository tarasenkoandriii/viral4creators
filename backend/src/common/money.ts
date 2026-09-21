/**
 * Общие хелперы конвертации между «мажорными» единицами (гривны,
 * доллары — то, что видит пользователь и что принимает/отдаёт API) и
 * «минорными» (копейки/центы — то, что реально хранится в БД для
 * денежных полей: Payment.amount в BillingService уже так работал,
 * AuctionListing/Bid/AuctionPayment переведены на ту же конвенцию тем же
 * аудитом, см. docs-tz/AUDIT-Auction-Money-Currency.md — Float
 * накапливал ошибку округления на деньгах, Int в минорных единицах не
 * накапливает).
 *
 * Единая функция вместо разбросанного по коду `Math.round(x * 100)` —
 * на случай, если когда-нибудь появится валюта с другим числом минорных
 * знаков (сейчас UAH/USD/EUR — у всех три сопровождаемые здесь валюты
 * по два, 100 минорных единиц на 1 мажорную, как и BillingService уже
 * молча предполагает).
 */

export function toMinorUnits(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

export function toMajorUnits(amountMinor: number): number {
  return amountMinor / 100;
}
