/**
 * «Живые» (не терминальные) значения AuctionListingStatus — ТЗ на
 * маркетплейс §22.1. Единственное место, откуда этот список берут оба
 * потребителя:
 *  - AuctionService.create() — нельзя подать в очередь работу, у
 *    которой уже есть незавершённая заявка на ДРУГОЙ аукцион;
 *  - AuctionService.withdraw() — что считается «уже в терминальном
 *    статусе» при повторном отзыве (идемпотентность);
 *  - PortfolioService.withdraw() — можно ли отозвать саму работу из
 *    портфолио, пока у неё есть заявка на аукцион (AuctionListing.
 *    portfolioItem — onDelete: Restrict, аудит-фикс того прохода).
 *
 * Вынесено в common/, а не оставлено локальной константой в
 * auction.service.ts, именно чтобы PortfolioService мог использовать
 * тот же список без импорта самого AuctionModule — модули маркетплейса
 * и так не образуют циклов (см. auction-payment.module.ts), заводить
 * ещё один повод для зависимости между portfolio/ и auction/ не нужно.
 */
export const LIVE_AUCTION_LISTING_STATUSES = [
  'PENDING_MODERATION',
  'QUEUED',
  'ACTIVE',
  'WON',
] as const;

export type LiveAuctionListingStatus = (typeof LIVE_AUCTION_LISTING_STATUSES)[number];
