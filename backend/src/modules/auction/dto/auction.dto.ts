import { Equals, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * Аудит-фикс: ТЕХНИЧЕСКИЙ потолок обработки платежа, НЕ бизнес-
 * ограничение цены — §22.4 сознательно оставляет цену без верхнего
 * предела («исполнитель сам оценивает шедевр... любую цену»), и этот
 * потолок его не отменяет: 10 млн в любой поддерживаемой валюте на много
 * порядков выше любой реалистичной цены. Причина — `Payment.amount` в
 * `backend/prisma/schema.prisma` типа `Int` (Postgres int4, потолок
 * ~2.147 млрд), а `BillingService.startAuctionCheckout` переводит сумму
 * в минорные единицы (`Math.round(amountMajor * 100)`, billing.service.ts).
 * Без этой проверки опечатка или подделанный запрос на сумму порядка
 * 10^10+ переполнил бы int4 при переводе в копейки/центы.
 */
const PAYMENT_PROCESSING_MAX = 10_000_000;

/**
 * POST /auctions — исполнитель ставит в очередь кандидата (ТЗ на
 * маркетплейс §22.1). Не создаёт заказчик и не разовое событие — см.
 * решение в начале §22 основного ТЗ. Заявка уходит в PENDING_MODERATION,
 * а не сразу ACTIVE: ИИ-оценка и модерация оператора (§22, Этап 3) —
 * пока просто ручная модерация оператором, как у portfolio-items.
 */
export class CreateAuctionListingDto {
  @IsString()
  portfolioItemId!: string;

  /**
   * §22.6 — самозаявление, не проверка платформой (технически нечем
   * проверить владение правами). @Equals(true), не @IsBoolean() —
   * false тоже валидный boolean, но здесь недостаточен: подтверждение
   * обязано быть именно утвердительным, не просто присутствовать.
   */
  @Equals(true, { message: 'rightsConfirmed must be explicitly true — confirm you have the right to sell this video exclusively' })
  rightsConfirmed!: boolean;

  @IsOptional()
  @IsBoolean()
  includeBrandManifest?: boolean;

  /** Обязателен, если includeBrandManifest: true — проверяется в сервисе, не декоратором. */
  @IsOptional()
  @IsString()
  brandManifestId?: string;

  @IsOptional()
  @IsIn(['BLITZ', 'STANDARD'])
  auctionType?: 'BLITZ' | 'STANDARD';

  /**
   * Антиснайпер (ТЗ на живой аукцион §7.3) — явный чекбокс продавца, НЕ
   * поведение по умолчанию для всех лотов (осознанное отклонение от
   * исходного ТЗ по запросу — там применялось безусловно ко всем
   * BLITZ). Продавец сам решает при подаче заявки, продлевать ли торги
   * на позднюю ставку — не задано/false = старое поведение, торги
   * закрываются строго по expiresAt без продления.
   */
  @IsOptional()
  @IsBoolean()
  antiSnipeEnabled?: boolean;

  /**
   * Живой аукцион (ТЗ на живой аукцион §7.8, ПРАВКА 1.4) — явное
   * согласие продавца на то, что лот МОЖЕТ быть выбран оператором для
   * живой трансляции с ИИ-ведущей (голосовые подсказки озвучивают
   * данные лота и ход торгов). Не задано/false — оператор не сможет
   * назначить студию этому лоту (`AuctionService.assignVirtualStudio`
   * отклонит), даже если auctionType уже BLITZ. Само по себе включение
   * этого чекбокса ничего не запускает — только снимает один из двух
   * гейтов на назначение студии (второй — auctionType === 'BLITZ',
   * проверяется в сервисе, не здесь).
   */
  @IsOptional()
  @IsBoolean()
  liveStreamOptIn?: boolean;

  /** Валюта выплаты продавцу — задаёт смысл всех цен ниже (§22). Не задана = UAH. */
  @IsOptional()
  @IsIn(['UAH', 'USD', 'EUR'])
  payoutCurrency?: 'UAH' | 'USD' | 'EUR';

  /** Без бизнес-верхнего предела (§22.4) — @Max(PAYMENT_PROCESSING_MAX) выше только технический потолок обработки платежа, см. доккомментарий константы. */
  @IsNumber()
  @Min(1)
  @Max(PAYMENT_PROCESSING_MAX)
  startingPrice!: number;

  /** null/не задана = равна startingPrice (§22.1). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(PAYMENT_PROCESSING_MAX)
  reservePrice?: number;

  /** Если задана — обязана быть >= reservePrice (или startingPrice) — проверяется в сервисе. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(PAYMENT_PROCESSING_MAX)
  buyNowPrice?: number;
}

/** POST /auctions/:id/bids — покупатель делает ставку (§22.1, настоящие торги). */
export class PlaceBidDto {
  @IsNumber()
  @Min(0.01)
  @Max(PAYMENT_PROCESSING_MAX)
  amount!: number;
}

/** POST /admin/auctions/:id/reject */
export class RejectAuctionListingDto {
  @Length(1, 2000)
  reason!: string;
}

/**
 * POST /admin/auctions/:id/studio — живой аукцион (ТЗ §7.6, Этап 5),
 * оператор назначает студию эфира лоту. `videoFragmentId` необязателен
 * — не задан, значит взять самый свежий готовый VIDEO-фрагмент этой
 * студии (см. доккомментарий AuctionService.assignVirtualStudio).
 */
export class AssignVirtualStudioDto {
  @IsString()
  virtualStudioId!: string;

  @IsOptional()
  @IsString()
  videoFragmentId?: string;
}
