/**
 * AuctionService — ТЗ на маркетплейс §22, полный цикл: подача → ИИ-оценка
 * + модерация оператора (AuctionAiAssessmentService, adminApprove/Reject)
 * → очередь QUEUED с приоритетом BLITZ (promoteNextQueued) → ACTIVE →
 * ставки/buyNow → WON/EXPIRED/WITHDRAWN → AuctionPayment → SOLD. Google
 * Ads для блиц-лотов (ниже) — последний из этапов, добавленных поверх
 * этого же цикла, не переписывая его.
 *
 * Развязка от тендера (см. решение в начале §22 основного ТЗ): свой
 * AuctionPayment, НЕ Contract/Escrow «Сейф 5%» — тот контур остаётся
 * отложен до сигнала §19.4 вместе с самим тендером.
 *
 * Оплата — self-serve чек-аут через billing, WayForPay (§startCheckout,
 * BillingService.startAuctionCheckout) — единственный здесь провайдер,
 * названный уже протестированным для этого прохода; Stars для аукциона
 * сознательно не подключён (см. доккомментарий startAuctionCheckout).
 * Завершение оплаты — AuctionPaymentService.applySuccess, общий для
 * вебхука WayForPay и ручного запасного пути оператора
 * (adminConfirmPayment) — см. доккомментарий этого сервиса.
 *
 * Google Ads для блиц-лотов (§22, «Google Ads для блиц-лотов») —
 * GoogleAdsService, вызывается best-effort из promoteNextQueued()
 * (переход в ACTIVE) и из всех трёх путей ухода из ACTIVE (WON/EXPIRED/
 * WITHDRAWN) — см. доккомментарии activateGoogleAdsCampaignIfBlitz() и
 * pauseGoogleAdsCampaignIfAny() ниже. Сбой или отсутствие credentials
 * там не должны ронять сам аукционный цикл — реклама бонус, не условие
 * продажи.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { AuctionPaymentService } from './auction-payment.service';
import { GoogleAdsService } from './google-ads.service';
import { GoogleIndexingService } from './google-indexing.service';
import { LiveAuctionOrchestratorService } from './live-auction-orchestrator.service';
import { LIVE_AUCTION_LISTING_STATUSES } from '../../common/auction-status';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { publicVideoUrl } from '../../common/watermark';
import { toMinorUnits, toMajorUnits } from '../../common/money';
import { convertForDisplay } from '../../common/fx-rates';
import { GenerationStatus } from '../../common/types/generation.types';
import {
  AdminAuctionListResult,
  AdminAuctionListingView,
  AuctionCurrencyValue,
  AuctionLiveStateView,
  AuctionLiveVoiceCueView,
  AuctionListingView,
  BidView,
  MyBidView,
  PublicAuctionListingView,
} from '../../common/types/marketplace.types';
import {
  AssignVirtualStudioDto,
  CreateAuctionListingDto,
  PlaceBidDto,
  RejectAuctionListingDto,
} from './dto/auction.dto';

/** §22.1 — размер витрины целиком, не лимит на исполнителя; число временное. */
const MAX_ACTIVE_LISTINGS = 5;
const MAX_ACTIVE_EXCLUSIVE_LISTINGS = 3;

/**
 * «Живые» статусы заявки — не завершённые терминально. Общий с
 * PortfolioService.withdraw() список — см. common/auction-status.ts.
 */
const LIVE_LISTING_STATUSES = LIVE_AUCTION_LISTING_STATUSES;

/**
 * Сколько можно молча повторять паузу Google Ads-кампании (см.
 * reconcileGoogleAdsCampaigns), прежде чем эскалировать оператору. §22
 * требует паузу ОБЯЗАТЕЛЬНО, не best-effort — но и тревожить человека
 * на первом же транзиентном сбое не нужно: инлайн-попытка + ~7 тиков
 * крона (раз в 2 минуты) — разумный кредит доверия автоматике.
 */
const GOOGLE_ADS_PAUSE_ALERT_AFTER_MS = 15 * 60 * 1000;

const BLITZ_DURATION_MS = 48 * 60 * 60 * 1000;
/** Середина диапазона 3–7 дней (§22.1) — точный выбор внутри диапазона на этом этапе не собирается отдельным полем формы. */
const STANDARD_DURATION_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Антиснайпер (ТЗ на живой аукцион §7.3) — та же формула, что в
 * первоисточнике (SilverFinance, `TZ-Blitz-Auction.md` §5):
 * `expiresAt = max(expiresAt, now + ANTI_SNIPE_EXTENSION_MS)`. Только
 * ОПЦИОНАЛЬНО, по явному чекбоксу продавца (`AuctionListing.antiSnipeEnabled`)
 * — по запросу, отклонение от исходного ТЗ, где применялось безусловно
 * ко всем BLITZ-лотам.
 */
const ANTI_SNIPE_EXTENSION_MS = 2 * 60 * 1000;

type ListingWithBids = { bids: { amount: number }[] } & Record<string, any>;

@Injectable()
export class AuctionService {
  private readonly logger = new Logger(AuctionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly auctionPayment: AuctionPaymentService,
    private readonly notify: TelegramNotifyService,
    private readonly googleAds: GoogleAdsService,
    private readonly googleIndexing: GoogleIndexingService,
    private readonly liveAuction: LiveAuctionOrchestratorService,
  ) {}

  private async ownCreatorProfileOrThrow(userId: string) {
    const profile = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new ForbiddenException('complete the creator quiz first (POST /creator-profiles/quiz)');
    }
    return profile;
  }

  // ── Исполнитель: подача заявки, свои заявки, отзыв (§22.1) ──────────

  async create(userId: string, dto: CreateAuctionListingDto): Promise<AuctionListingView> {
    const profile = await this.ownCreatorProfileOrThrow(userId);

    const item = await this.prisma.portfolioItem.findUnique({ where: { id: dto.portfolioItemId } });
    if (!item || item.creatorProfileId !== profile.id) {
      throw new NotFoundException('portfolio item not found');
    }
    if (item.status !== 'PUBLISHED') {
      throw new ConflictException('only a published portfolio item can be auctioned');
    }
    // Аудит-фикс: раньше здесь не проверялось, что у этой же работы уже
    // нет незавершённой заявки на другой аукцион — фронтенд просто не
    // предлагал такие работы в выпадающем списке (UX-подсказка), но
    // прямым запросом это ограничение ничем не было защищено. Один и
    // тот же эксклюзивный товар не может продаваться дважды одновременно.
    const existingLiveListing = await this.prisma.auctionListing.findFirst({
      where: { portfolioItemId: item.id, status: { in: [...LIVE_LISTING_STATUSES] } },
    });
    if (existingLiveListing) {
      throw new ConflictException('this work already has an active or pending auction listing');
    }

    if (dto.includeBrandManifest) {
      if (!dto.brandManifestId) {
        throw new BadRequestException('brandManifestId is required when includeBrandManifest is true');
      }
      const manifest = await this.prisma.brandManifest.findUnique({ where: { id: dto.brandManifestId } });
      if (!manifest || manifest.userId !== userId) {
        throw new NotFoundException('brand manifest not found');
      }
      if (manifest.isLocked) {
        throw new ConflictException('this brand manifest was already sold exclusively and can no longer be listed');
      }
    }

    const reserve = dto.reservePrice ?? dto.startingPrice;
    if (dto.buyNowPrice != null && dto.buyNowPrice < reserve) {
      throw new BadRequestException('buyNowPrice must be >= reservePrice (or startingPrice if no reserve is set)');
    }

    const listing = await this.prisma.auctionListing.create({
      data: {
        creatorProfileId: profile.id,
        portfolioItemId: item.id,
        brandManifestId: dto.includeBrandManifest ? dto.brandManifestId : null,
        includeBrandManifest: dto.includeBrandManifest ?? false,
        auctionType: dto.auctionType ?? 'STANDARD',
        // Антиснайпер (ТЗ на живой аукцион §7.3) — явный чекбокс продавца,
        // не задан/false = старое поведение (без продления), см. доккомментарий DTO.
        antiSnipeEnabled: dto.antiSnipeEnabled ?? false,
        // Живой аукцион (§7.8, ПРАВКА 1.4) — явное согласие продавца,
        // не задано/false = оператор не сможет назначить студию этому
        // лоту (assignVirtualStudio отклонит), см. доккомментарий DTO.
        liveStreamOptIn: dto.liveStreamOptIn ?? false,
        payoutCurrency: dto.payoutCurrency ?? 'UAH',
        // dto.rightsConfirmed уже гарантированно true — @Equals(true) в
        // DTO отклонил бы запрос раньше, чем он сюда дошёл (§22.6).
        rightsConfirmedAt: new Date(),
        // Аудит-фикс (Float→Int минорные единицы): DTO/API остаются в
        // МАЖОРНЫХ единицах (см. доккомментарий CreateAuctionListingDto)
        // — конвертация в минорные (копейки/центы) только на этой
        // границе записи в БД, см. common/money.ts.
        startingPrice: toMinorUnits(dto.startingPrice),
        reservePrice: dto.reservePrice != null ? toMinorUnits(dto.reservePrice) : null,
        buyNowPrice: dto.buyNowPrice != null ? toMinorUnits(dto.buyNowPrice) : null,
      },
    });
    return this.toOwnView(listing, []);
  }

  async listMine(userId: string): Promise<AuctionListingView[]> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const listings = await this.prisma.auctionListing.findMany({
      where: { creatorProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
      include: { bids: true },
    });
    return listings.map((l) => this.toOwnView(l, l.bids));
  }

  async withdraw(userId: string, id: string): Promise<AuctionListingView> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const listing = await this.prisma.auctionListing.findUnique({ where: { id }, include: { bids: true } });
    if (!listing || listing.creatorProfileId !== profile.id) {
      throw new NotFoundException('listing not found');
    }
    if (listing.status === 'WON') {
      throw new ConflictException('cannot withdraw a listing that has already been won');
    }
    if (!LIVE_LISTING_STATUSES.includes(listing.status as (typeof LIVE_LISTING_STATUSES)[number])) {
      return this.toOwnView(listing, listing.bids); // идемпотентно — уже в терминальном статусе (WITHDRAWN/EXPIRED/REJECTED)
    }
    const wasActive = listing.status === 'ACTIVE';
    // Продуктовое решение (см. «Открытые вопросы» в AUDIT-Auction-Full-
    // Pipeline.md, закрыто по запросу): withdraw() запрещён, если среди
    // ставок уже есть удовлетворяющая reservePrice (или startingPrice,
    // если резерв не задан) — то есть лот на момент закрытия и так был
    // бы продан (см. ту же формулу reserve в closeExpiredListings()).
    // Ставки НИЖЕ резерва withdraw не блокируют — они и так не выигрывают
    // сами по себе к закрытию (§22.1, «Три разные цены»), продавец не
    // отменяет уже состоявшуюся по факту сделку, только неопределённость.
    // Отмена лота с уже «выигранной» ставкой — это отмена сделки, а не
    // снятие товара с витрины; такое, при необходимости, должно идти
    // через оператора/спор, а не самообслуживанием исполнителя.
    if (wasActive) {
      const reserve = listing.reservePrice ?? listing.startingPrice;
      const hasReserveMeetingBid = listing.bids.some((b) => b.amount >= reserve);
      if (hasReserveMeetingBid) {
        throw new ConflictException(
          'cannot withdraw — at least one bid already meets the reserve price; this listing would sell at close, contact an operator to cancel a completed sale',
        );
      }
    }
    // Аудит-фикс: googleAdsCampaignId больше НЕ обнуляется здесь — см.
    // доккомментарий pauseGoogleAdsCampaignIfAny() про то, почему
    // обнуление ДО подтверждённой паузы теряло единственную ссылку на
    // кампанию навсегда при любом сбое. Поле обнуляет сама эта функция,
    // только после успешного pauseCampaign().
    const updated = await this.prisma.auctionListing.update({
      where: { id },
      data: { status: 'WITHDRAWN' },
    });
    // Освободившееся ACTIVE-место занимает следующий из очереди (§22, «Публикация по свободному месту»).
    if (wasActive) {
      void this.pauseGoogleAdsCampaignIfAny(id, listing.googleAdsCampaignId);
      // Аудит-фикс: раньше сделавшие ставку узнавали о снятии лота только
      // случайно, зайдя на страницу и получив 404 (§22, «не должна
      // оставлять мёртвые публичные ссылки»), без единого объяснения. На
      // этот момент withdraw уже гарантированно прошёл проверку выше —
      // ставок, удовлетворяющих резерву, среди этих bids нет (иначе
      // выбросили бы ConflictException раньше), так что уведомление верно
      // для всех: их ставка не выигрывала бы в любом случае.
      void this.notifyBiddersOfWithdrawal(id, listing.bids.map((b) => b.buyerId));
      await this.promoteNextQueued();
    }
    return this.toOwnView(updated, listing.bids);
  }

  /** Best-effort, тот же принцип, что notifyWinner()/sendSoldNotification. */
  private async notifyBiddersOfWithdrawal(listingId: string, buyerIds: string[]): Promise<void> {
    if (buyerIds.length === 0) return;
    try {
      const [listing, buyers] = await Promise.all([
        this.prisma.auctionListing.findUnique({ where: { id: listingId }, include: { portfolioItem: true } }),
        this.prisma.user.findMany({ where: { id: { in: [...new Set(buyerIds)] } } }),
      ]);
      if (!listing) return;
      await Promise.all(
        buyers.map((buyer) =>
          this.notify.dm(
            buyer.telegramId,
            `Лот «${listing.portfolioItem.title}», на который вы делали ставку, снят продавцом с аукциона до завершения торгов. Оплата не требуется.`,
          ),
        ),
      );
    } catch (e) {
      this.logger.warn(`Не удалось уведомить участников торгов о снятии лота ${listingId}: ${(e as Error).message}`);
    }
  }

  // ── Публичная витрина (§22.1, «постоянный раздел», только ACTIVE) ──

  async listPublic(): Promise<PublicAuctionListingView[]> {
    const listings = await this.prisma.auctionListing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: {
        portfolioItem: true,
        creatorProfile: { include: { user: true } },
        bids: true,
      },
    });
    return listings.map((l) => this.toPublicView(l));
  }

  async getPublic(id: string): Promise<PublicAuctionListingView> {
    const listing = await this.prisma.auctionListing.findUnique({
      where: { id },
      include: {
        portfolioItem: true,
        creatorProfile: { include: { user: true } },
        bids: true,
      },
    });
    // §22 «не должна оставлять мёртвые публичные ссылки» — не-ACTIVE лот
    // отдаёт 404, тот же принцип, что уже применён к /item/:id для
    // непубличных PortfolioItem (§20).
    if (!listing || listing.status !== 'ACTIVE') {
      throw new NotFoundException('auction listing not found');
    }
    return this.toPublicView(listing);
  }

  // ── Ставки — настоящие торги, не выбор заказчиком (§22.1) ───────────

  async placeBid(userId: string, listingId: string, dto: PlaceBidDto): Promise<BidView> {
    // Аудит-фикс (race condition, было HIGH): раньше это был обычный
    // read-then-write БЕЗ транзакции и без блокировки строки — два
    // одновременных запроса читали один и тот же currentHighest, ОБА
    // проходили проверку «выше текущей лучшей» и оба создавали ставку,
    // корродируя саму идею «побеждает наибольшая ставка» (§22.1): порядок
    // двух гонки-выигравших ставок в БД был не определён (`Bid` — только
    // индексы, без уникального ограничения на «одна активная максимальная
    // ставка»). Теперь вся проверка+вставка — одна транзакция,
    // сериализованная блокировкой строки самого лота (`SELECT ... FOR
    // UPDATE`): второй параллельный запрос ждёт коммита первого и видит
    // уже актуальный currentHighest, а не устаревший снимок.
    // Аудит-фикс (Float→Int минорные единицы): dto.amount приходит с
    // клиента в МАЖОРНЫХ единицах (API-контракт не меняется) — вся
    // внутренняя арифметика (сравнение с floor/buyNowPrice, запись в БД)
    // ниже ведётся в минорных, чтобы сравнивать точные целые, а не Float.
    const amountMinor = toMinorUnits(dto.amount);

    const { listing, bid } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM auction_listings WHERE id = ${listingId} FOR UPDATE`;

      const listing = await tx.auctionListing.findUnique({
        where: { id: listingId },
        include: { bids: true, creatorProfile: true },
      });
      if (!listing || listing.status !== 'ACTIVE') {
        throw new NotFoundException('auction listing not found');
      }
      if (listing.expiresAt && listing.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('this auction has already ended');
      }
      // Аудит-фикс: раньше ничего не мешало исполнителю самому ставить на
      // собственный лот (shill bidding) — включая мгновенный «выкуп»
      // через buyNowPrice, что фиктивно помечало бы брендбук как
      // проданный без реальной сделки на стороне.
      if (listing.creatorProfile.userId === userId) {
        throw new ForbiddenException('cannot bid on your own auction listing');
      }

      // Резерв НЕ проверяется здесь намеренно (§22.1, «Три разные цены»)
      // — ставка ниже reservePrice допустима, просто не выигрывает сама
      // по себе к моменту закрытия (см. closeExpiredListings).
      // Проверяется только то, что ставка реально перебивает текущую
      // лучшую. listing.startingPrice/bids[].amount — уже в минорных
      // единицах (из БД), сравниваем с amountMinor того же порядка.
      const currentHighest = listing.bids.reduce((max, b) => Math.max(max, b.amount), 0);
      const floor = Math.max(listing.startingPrice, currentHighest);
      if (amountMinor <= floor) {
        throw new BadRequestException(`bid must be higher than the current highest bid (${toMajorUnits(floor)})`);
      }

      const bid = await tx.bid.create({
        data: { listingId: listing.id, buyerId: userId, amount: amountMinor },
      });

      // Антиснайпер (ТЗ на живой аукцион §7.3) — ТОЛЬКО если продавец явно
      // включил чекбокс при подаче заявки (antiSnipeEnabled, по запросу —
      // осознанное отклонение от исходного ТЗ, где применялось безусловно
      // ко всем BLITZ-лотам). Не применяется, если эта же ставка мгновенно
      // выигрывает через buyNowPrice — продлевать торги, которые уже
      // закрываются этой самой ставкой, бессмысленно (§7.3, п.1: «иначе —
      // срабатывает антиснайпер», то есть строго when NOT buyNow-win).
      // Внутри той же транзакции и под тем же `FOR UPDATE`-локом на лоте
      // (см. выше) — иначе два одновременных поздних бида могли бы
      // разойтись в том, что каждый читает как «текущий expiresAt» для
      // формулы max(), и один из них применить лишний/недостающий раз.
      const buyNowWin = listing.buyNowPrice != null && bid.amount >= listing.buyNowPrice;
      if (!buyNowWin && listing.antiSnipeEnabled && listing.expiresAt) {
        const minExpiresAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
        if (minExpiresAt.getTime() > listing.expiresAt.getTime()) {
          await tx.auctionListing.update({
            where: { id: listing.id },
            data: { expiresAt: minExpiresAt, extensions: { increment: 1 } },
          });
        }
      }

      return { listing, bid };
    });

    // buyNowPrice — сразу WON, минуя expiresAt (§22.1). Вне транзакции
    // выше намеренно: closeListing делает СВОЮ отдельную транзакцию и
    // best-effort побочные эффекты (уведомления, Google Ads) — к этому
    // моменту ставка уже гарантированно закоммичена.
    const buyNowWin = listing.buyNowPrice != null && bid.amount >= listing.buyNowPrice;
    if (buyNowWin) {
      await this.closeListing(listing.id, bid.id, bid.amount, listing.googleAdsCampaignId);
    } else if (listing.virtualStudioId) {
      // Живой аукцион (ТЗ §7.3, ПРАВКА 1.1) — best-effort, только если у
      // лота назначена студия эфира; торги без студии этот вызов не
      // трогает вовсе. Мгновенная buyNow-победа выше уже останавливает
      // эфир сама (см. closeListing) — новая BID_STATS-подсказка для
      // уже закрытого лота не нужна.
      void this.liveAuction.onBidPlaced(listing.id, { id: bid.id, amount: bid.amount });
    }

    // bid.amount из БД — минорные единицы, наружу в API-контракте BidView — мажорные.
    return { id: bid.id, listingId: bid.listingId, amount: toMajorUnits(bid.amount), createdAt: bid.createdAt.toISOString() };
  }

  // ── Закрытие по дедлайну — вызывается cron'ом (§22, «Публикация по свободному месту») ──

  async closeExpiredListings(): Promise<{ closed: number }> {
    const expired = await this.prisma.auctionListing.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      include: { bids: true },
    });
    for (const listing of expired) {
      const reserve = listing.reservePrice ?? listing.startingPrice;
      const winningBid = listing.bids
        .filter((b) => b.amount >= reserve)
        .sort((a, b) => b.amount - a.amount)[0];
      if (winningBid) {
        await this.closeListing(listing.id, winningBid.id, winningBid.amount, listing.googleAdsCampaignId);
      } else {
        // Ставки были или не было — не различаем здесь: обе ветки не
        // приводят к продаже, обе EXPIRED (§22.5, AuctionListingStatus).
        // googleAdsCampaignId НЕ обнуляется здесь — см. доккомментарий
        // pauseGoogleAdsCampaignIfAny() (аудит-фикс).
        await this.prisma.auctionListing.update({
          where: { id: listing.id },
          data: {
            status: 'EXPIRED',
            // Живой аукцион (§7.5) — эфир останавливается вместе с
            // истечением торгов; liveStreamEndedAt не трогается, если
            // эфира не было (см. тот же приём в closeListing выше).
            ...(listing.liveStreamActive ? { liveStreamActive: false, liveStreamEndedAt: new Date() } : {}),
          },
        });
        void this.pauseGoogleAdsCampaignIfAny(listing.id, listing.googleAdsCampaignId);
        // Этап 6 (§7.8) — торги истекли без продажи; если эфир шёл, его
        // остановка (см. data выше) должна долететь до Google как
        // isLiveBroadcast:false, не только до нашей же БД.
        if (listing.liveStreamActive) {
          void this.googleIndexing.notify(this.listingUrl(listing.id), 'URL_UPDATED');
        }
        await this.promoteNextQueued();
      }
    }
    return { closed: expired.length };
  }

  /** WON — заявка выиграна, ждёт AuctionPayment (оплата отдельным шагом, §22.5). */
  private async closeListing(
    listingId: string,
    winningBidId: string,
    amount: number,
    googleAdsCampaignId: string | null,
  ): Promise<void> {
    // googleAdsCampaignId НЕ обнуляется здесь — см. доккомментарий
    // pauseGoogleAdsCampaignIfAny() (аудит-фикс).
    const [, , liveStreamStopped] = await this.prisma.$transaction([
      this.prisma.auctionListing.update({
        where: { id: listingId },
        data: { status: 'WON' },
      }),
      this.prisma.auctionPayment.create({
        data: {
          listingId,
          winningBidId,
          amount,
          commission: 0, // считается в AuctionPaymentService.applySuccess по auctionType — комиссия списывается по факту сделки (§22)
        },
      }),
      // Живой аукцион (§7.5) — «эфир останавливается так же, как при
      // обычном истечении». updateMany с условием liveStreamActive:
      // true — no-op для лотов, у которых эфира никогда не было (не
      // трогает liveStreamEndedAt, оставляя его null).
      this.prisma.auctionListing.updateMany({
        where: { id: listingId, liveStreamActive: true },
        data: { liveStreamActive: false, liveStreamEndedAt: new Date() },
      }),
    ]);
    void this.pauseGoogleAdsCampaignIfAny(listingId, googleAdsCampaignId);
    // Этап 6 (§7.8) — только если updateMany выше реально что-то
    // остановил (`count > 0`, лот действительно был в эфире), не на
    // каждую продажу лота без студии/эфира.
    if (liveStreamStopped.count > 0) {
      void this.googleIndexing.notify(this.listingUrl(listingId), 'URL_UPDATED');
    }
    await this.promoteNextQueued();
    // Реальный пробел, закрытый этим фиксом: победитель ОБЫЧНЫХ торгов
    // (не «купить сейчас») узнаёт о выигрыше только по дедлайну, через
    // крон, а не сразу на странице — там его уже нет. Тот же вызов
    // покрывает и мгновенное закрытие через buyNowPrice (§22.1) —
    // избыточно с инлайн-подтверждением на фронте, но не вредно:
    // человек мог уже уйти со страницы до того, как её увидел.
    void this.notifyWinner(listingId, winningBidId);
  }

  /**
   * Этап 6 (§7.8) — публичная страница лота на маркетплейсе, для
   * Google Indexing API. Тот же URL, что строит
   * `activateGoogleAdsCampaignIfBlitz` (`finalUrl`, ниже) для Google Ads
   * — без префикса локали, middleware маркетплейса сам редиректит на
   * дефолтную (см. доккомментарий `notifyWinner` про тот же принцип).
   * Отдельный маленький хелпер, а не общий с `LiveAuctionOrchestratorService.
   * listingUrl()` — то же дублирование одной строки, что уже есть между
   * `notifyWinner`/`activateGoogleAdsCampaignIfBlitz` в этом же файле.
   */
  private listingUrl(listingId: string): string {
    const siteUrl = process.env.MARKETPLACE_SITE_URL ?? 'http://localhost:3004';
    return `${siteUrl}/auctions/${listingId}`;
  }

  /** Best-effort — заблокированный бот/сетевой сбой не должны ронять закрытие лота. */
  private async notifyWinner(listingId: string, winningBidId: string): Promise<void> {
    try {
      const [bid, listing] = await Promise.all([
        this.prisma.bid.findUnique({ where: { id: winningBidId }, include: { buyer: true } }),
        this.prisma.auctionListing.findUnique({ where: { id: listingId }, include: { portfolioItem: true } }),
      ]);
      if (!bid || !listing) return;
      const siteUrl = process.env.MARKETPLACE_SITE_URL ?? 'http://localhost:3004';
      // Без префикса локали намеренно — middleware маркетплейса сам
      // редиректит на дефолтную (ru) без cookie явного выбора, тот же
      // принцип, что и у любой другой голой ссылки на этот сайт.
      const link = `${siteUrl}/my-bids`;
      // bid.amount из БД — минорные единицы, для человека форматируем в мажорных.
      await this.notify.dm(
        bid.buyer.telegramId,
        `🎉 Вы выиграли аукцион за «${listing.portfolioItem.title}» — ${toMajorUnits(bid.amount)}. Перейдите к оплате: ${link}`,
      );
    } catch {
      // best-effort
    }
  }

  /**
   * Освобождённое ACTIVE-место занимает следующий одобренный (QUEUED)
   * кандидат — приоритет BLITZ перед STANDARD (§22, «Модерация очереди
   * кандидатов»), внутри каждого типа — по дате подачи (FIFO).
   *
   * Сортировка явно в JS, а не `orderBy: [{auctionType}, {createdAt}]`
   * на стороне Prisma: 'BLITZ' < 'STANDARD' по алфавиту дал бы нужный
   * порядок случайно, но полагаться на алфавитное совпадение значений
   * enum — хрупко и неочевидно читающему код.
   *
   * Пропуск кандидата с включённым брендбуком, когда занят только
   * эксклюзивный подлимит (3 из 5), не блокирует остальную очередь —
   * следующие без брендбука всё равно проверяются и могут занять место.
   *
   * Аудит-фикс (race condition, было HIGH): раньше подсчёт
   * activeCount/activeExclusiveCount и последующая серия update() не
   * были защищены ни транзакцией, ни локом — а этот метод вызывается из
   * МНОЖЕСТВА независимых точек, способных сработать конкурентно:
   * withdraw(), closeExpiredListings() (крон, в цикле по нескольким
   * лотам за тик), closeListing() (и из placeBid, и из самого
   * closeExpiredListings), adminApprove(). Два таких вызова, стартующих
   * почти одновременно, могли оба прочитать activeCount < 5 ДО того, как
   * любой из них закоммитил свои промоушены, и оба продвинуть кандидатов
   * — пробивая жёсткий потолок 5 ACTIVE / 3 эксклюзивных, вокруг которого
   * и построена вся очередь (§22.1). Теперь всё тело — одна транзакция,
   * сериализованная `pg_advisory_xact_lock` (тот же приём, что уже
   * применён в `BillingService` для вебхука WayForPay) — конкурентные
   * вызовы этого метода теперь выполняются строго по очереди, не
   * параллельно.
   */
  private async promoteNextQueued(): Promise<void> {
    const promoted = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'auction-promote-queue'}))`;

      const activeCount = await tx.auctionListing.count({ where: { status: 'ACTIVE' } });
      const activeExclusiveCount = await tx.auctionListing.count({
        where: { status: 'ACTIVE', includeBrandManifest: true },
      });
      if (activeCount >= MAX_ACTIVE_LISTINGS) return [];

      const candidates = await tx.auctionListing.findMany({
        where: { status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
      });
      candidates.sort((a, b) => {
        if (a.auctionType !== b.auctionType) return a.auctionType === 'BLITZ' ? -1 : 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      let freeSlots = MAX_ACTIVE_LISTINGS - activeCount;
      let freeExclusiveSlots = MAX_ACTIVE_EXCLUSIVE_LISTINGS - activeExclusiveCount;
      const justPromoted: { id: string; auctionType: string; virtualStudioId: string | null }[] = [];

      for (const candidate of candidates) {
        if (freeSlots <= 0) break;
        if (candidate.includeBrandManifest && freeExclusiveSlots <= 0) continue;
        const durationMs = candidate.auctionType === 'BLITZ' ? BLITZ_DURATION_MS : STANDARD_DURATION_MS;
        await tx.auctionListing.update({
          where: { id: candidate.id },
          data: { status: 'ACTIVE', expiresAt: new Date(Date.now() + durationMs) },
        });
        justPromoted.push({ id: candidate.id, auctionType: candidate.auctionType, virtualStudioId: candidate.virtualStudioId });
        freeSlots -= 1;
        if (candidate.includeBrandManifest) freeExclusiveSlots -= 1;
      }
      return justPromoted;
    });

    // Google Ads — ПОСЛЕ коммита транзакции, не внутри неё: внешний
    // сетевой вызов, держащий открытым advisory lock/транзакцию, был бы
    // и медленнее для конкурирующих вызовов promoteNextQueued(), и
    // рискованнее (если транзакция всё же откатится позже — сейчас
    // такого пути нет, но откладывать внешние эффекты до подтверждённого
    // коммита правильно в любом случае). best-effort, см. доккомментарий
    // activateGoogleAdsCampaignIfBlitz().
    for (const candidate of promoted) {
      void this.activateGoogleAdsCampaignIfBlitz(candidate.id, candidate.auctionType);
    }

    // Живой аукцион (ТЗ §7.4, п.1) — тот же приём, что у Google Ads
    // выше: best-effort, после коммита, только для кандидатов, у
    // которых уже есть virtualStudioId (назначается оператором заранее,
    // пока лот ещё QUEUED — см. AuctionService.assignVirtualStudio).
    // Лоты без назначенной студии этот вызов не трогает вовсе —
    // activateLiveStream() сам делает эту проверку первым делом.
    for (const candidate of promoted) {
      if (candidate.virtualStudioId) {
        void this.liveAuction.activateLiveStream(candidate.id);
      }
    }
  }

  /**
   * Включение Google Ads для только что ставшего ACTIVE блиц-лота (§22:
   * «как только заявка проходит модерацию и переходит в ACTIVE,
   * автоматически включается кампания в Google Ads»). Best-effort, тот
   * же принцип, что у notifyWinner() выше — сбой сети/API, отсутствие
   * credentials (GoogleAdsService.isConfigured() === false) или отказ
   * Google на любом шаге создания кампании не должны откатывать или
   * блокировать сам перевод лота в ACTIVE, который уже случился строкой
   * выше. См. подробный разбор реальных ограничений (минимум креативов,
   * conversion goals) в доккомментарии GoogleAdsService.
   */
  private async activateGoogleAdsCampaignIfBlitz(listingId: string, auctionType: string): Promise<void> {
    if (auctionType !== 'BLITZ') return;
    try {
      const listing = await this.prisma.auctionListing.findUnique({
        where: { id: listingId },
        include: { portfolioItem: true },
      });
      if (!listing) return;
      const siteUrl = process.env.MARKETPLACE_SITE_URL ?? 'http://localhost:3004';
      // Аудит-фикс: Number(env-строка) на невалидном/пустом значении даёт
      // NaN, а не ошибку — раньше это тихо превращалось в amountMicros:
      // "NaN", уходящее прямо в тело запроса к Google Ads. Теперь
      // невалидное значение явно откатывается на дефолт с предупреждением.
      const rawBudget = Number(process.env.GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS);
      if (process.env.GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS && !Number.isFinite(rawBudget)) {
        this.logger.warn(
          `GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS="${process.env.GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS}" не число — использован дефолт 5000000.`,
        );
      }
      const dailyBudgetMicros = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 5_000_000;
      const campaignResourceName = await this.googleAds.createBlitzCampaign({
        listingId: listing.id,
        title: listing.portfolioItem.title,
        thumbnailUrl: listing.portfolioItem.thumbnailUrl,
        // Без префикса локали — та же логика, что у notifyWinner() выше,
        // middleware маркетплейса сам разруливает дефолтную локаль.
        finalUrl: `${siteUrl}/auctions/${listing.id}`,
        dailyBudgetMicros,
      });
      if (campaignResourceName) {
        await this.prisma.auctionListing.update({
          where: { id: listingId },
          data: { googleAdsCampaignId: campaignResourceName },
        });
      }
    } catch (e) {
      this.logger.warn(`Не удалось создать кампанию Google Ads для блиц-лота ${listingId}: ${(e as Error).message}`);
    }
  }

  /**
   * Пауза кампании при уходе лота из ACTIVE (WON/EXPIRED/WITHDRAWN —
   * §22, «кампания сразу приостанавливается»). Best-effort — тот же
   * принцип, что у notifyWinner()/activateGoogleAdsCampaignIfBlitz()
   * выше: сбой сети/API не должен ронять сам переход статуса лота,
   * который к моменту вызова уже случился.
   *
   * Аудит-фикс (существенный): раньше `googleAdsCampaignId: null`
   * писался В ТОМ ЖЕ Prisma-update, что и сам переход статуса
   * (WITHDRAWN/EXPIRED/WON) — ДО того, как эта функция вообще успевала
   * попытаться вызвать `pauseCampaign()`. Значит если сетевой вызов
   * паузы падал (или — в serverless — сам процесс завершался раньше,
   * чем успевал долететь fire-and-forget вызов из withdraw()/placeBid(),
   * см. предупреждение в конце этого доккомментария) — ссылка на
   * кампанию уже была потеряна из БД НАВСЕГДА: ни повторить попытку, ни
   * даже найти осиротевшую кампанию в кабинете Google Ads по записи в
   * своей же БД было уже нельзя, а реклама на проданном/истёкшем лоте
   * продолжала бы крутиться и тратить бюджет — ровно то, чего требование
   * §22 («кампания сразу приостанавливается... тратить бюджет и вводить
   * пользователя в заблуждение») и было призвано не допустить.
   *
   * Теперь эта функция сама читает и обнуляет поле — и делает это
   * ТОЛЬКО после подтверждённого успеха `pauseCampaign()`, не раньше. До
   * этого поле остаётся заполненным — то есть служит тем же сигналом
   * «пауза ещё не подтверждена», что и раньше `watermarkStatus: FAILED`
   * до аудит-фикса на паузу знака. `reconcileGoogleAdsCampaigns()` —
   * подстраховка на случай, если даже этот вызов не выполнится
   * (serverless-функция уже отдала ответ и была остановлена раньше, чем
   * этот `void`-вызов из withdraw()/closeExpiredListings()/closeListing()
   * успел завершиться) — крон подхватит на следующем тике.
   */
  private async pauseGoogleAdsCampaignIfAny(listingId: string, campaignResourceName: string | null): Promise<void> {
    if (!campaignResourceName) return;
    try {
      await this.googleAds.pauseCampaign(campaignResourceName);
      await this.prisma.auctionListing.update({
        where: { id: listingId },
        data: { googleAdsCampaignId: null },
      });
    } catch (e) {
      this.logger.warn(
        `Не удалось поставить на паузу кампанию Google Ads (${campaignResourceName}, listing=${listingId}) — ` +
          `googleAdsCampaignId оставлен как есть, повторит reconcileGoogleAdsCampaigns() на следующем тике: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Подстраховка для pauseGoogleAdsCampaignIfAny() выше — раз в тик
   * (см. cron `auction-google-ads-sync`) находит терминальные (не
   * ACTIVE) заявки, у которых `googleAdsCampaignId` всё ещё не null —
   * то есть подтверждённая пауза ещё не случилась (сеть, отказ API, или
   * fire-and-forget вызов был прерван завершением serverless-функции до
   * того, как успел долететь), и повторяет попытку. Безопасно повторять
   * сколько угодно раз — пауза уже приостановленной на стороне Google
   * кампании идемпотентна, не ошибка.
   *
   * Намеренно НЕ делает симметричного повтора для СОЗДАНИЯ кампании
   * (переход QUEUED→ACTIVE) — это осознанно оставленный открытый пробел:
   * повторный вызов `createBlitzCampaign()` для того же лота без
   * предварительной проверки «а нет ли уже кампании с таким именем в
   * аккаунте» рискует наплодить дубликаты (новые бюджет+кампания+asset
   * group на каждый тик), а не починить одну пропущенную попытку. Чтобы
   * закрыть это по-настоящему, нужно либо хранить отдельное состояние
   * «попытка создания в процессе», либо запрашивать Google Ads по имени
   * кампании перед созданием — не входит в этот проход.
   *
   * §22 требует паузу при уходе с ACTIVE ОБЯЗАТЕЛЬНО, не как приятный
   * бонус (по запросу — «при окончании лота реклама должна быть отменена
   * обязательно»): чистого автоповтора недостаточно, если что-то ломает
   * саму паузу систематически (протухший refresh token, отозванный
   * доступ, смена API-версии) — в этом случае крон будет вечно повторять
   * одну и ту же неудачную попытку молча, а бюджет продолжит тратиться.
   * Поэтому лоты, застрявшие дольше GOOGLE_ADS_PAUSE_ALERT_AFTER_MS,
   * эскалируются человеку через TelegramNotifyService.alert() —
   * дедуплицировано (10-минутное окно, «и ещё N раз» в сводке), одним
   * fingerprint'ом БЕЗ id лота (см. доккомментарий alert() — переменная
   * часть в fingerprint ломает дедупликацию), чтобы систематический сбой
   * сразу нескольких лотов не размножался по одной тревоге на лот.
   */
  async reconcileGoogleAdsCampaigns(): Promise<{ paused: number; stillStuck: number }> {
    const stuck = await this.prisma.auctionListing.findMany({
      where: { status: { not: 'ACTIVE' }, googleAdsCampaignId: { not: null } },
      take: 20, // предел на тик — та же дисциплина, что у остальных тик-воркеров (предсказуемая стоимость шага)
    });
    let paused = 0;
    const stillStuck: { id: string; campaignResourceName: string; ageMs: number }[] = [];
    for (const listing of stuck) {
      try {
        await this.googleAds.pauseCampaign(listing.googleAdsCampaignId!);
        await this.prisma.auctionListing.update({
          where: { id: listing.id },
          data: { googleAdsCampaignId: null },
        });
        paused += 1;
      } catch (e) {
        this.logger.warn(`Повторная попытка паузы кампании Google Ads не удалась (listing=${listing.id}): ${(e as Error).message}`);
        stillStuck.push({
          id: listing.id,
          campaignResourceName: listing.googleAdsCampaignId!,
          ageMs: Date.now() - listing.updatedAt.getTime(),
        });
      }
    }

    const escalate = stillStuck.filter((s) => s.ageMs > GOOGLE_ADS_PAUSE_ALERT_AFTER_MS);
    if (escalate.length > 0) {
      const details = escalate
        .slice(0, 10)
        .map((s) => `${s.id} (${s.campaignResourceName})`)
        .join(', ');
      await this.notify.alert(
        'auction-google-ads-pause-stuck',
        `Не удаётся поставить на паузу кампанию Google Ads дольше ${Math.round(GOOGLE_ADS_PAUSE_ALERT_AFTER_MS / 60000)} мин ` +
          `для ${escalate.length} лот(ов): ${details}${escalate.length > 10 ? '…' : ''}. ` +
          `Требуется ручная пауза в кабинете Google Ads — реклама на проданном/истёкшем лоте продолжает тратить бюджет.`,
      );
    }

    return { paused, stillStuck: stillStuck.length };
  }

  // ── Модерация оператором — тот же паттерн, что admin/portfolio-items ──

  /**
   * Приоритет BLITZ перед STANDARD в очереди модерации (§22, «Модерация
   * очереди кандидатов») — сортировка по (auctionType, createdAt) на
   * стороне БД, не в JS: здесь пагинация (skip/take), в отличие от
   * promoteNextQueued выше, где весь список и так уже в памяти.
   * `asc` работает, потому что 'BLITZ' < 'STANDARD' по алфавиту — это
   * не архитектурная гарантия Prisma, а совпадение значений enum;
   * если когда-нибудь появится третий AuctionType или изменится это
   * сравнение, эту сортировку придётся пересмотреть явно.
   */
  async adminList(params: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminAuctionListResult> {
    const where = params.status ? { status: params.status as any } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auctionListing.findMany({
        where,
        orderBy: [{ auctionType: 'asc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { portfolioItem: true, creatorProfile: { include: { user: true } }, bids: true },
      }),
      this.prisma.auctionListing.count({ where }),
    ]);
    return {
      items: rows.map((l) => this.toAdminView(l)),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /**
   * Одобрение — не сразу ACTIVE: сначала QUEUED, ACTIVE только если
   * есть свободное место (§22, «Публикация по свободному месту»).
   * ИИ-оценка (§22, Этап 3) добавится здесь же, как вход для этого же
   * решения оператора, не заменяя его.
   */
  async adminApprove(id: string): Promise<AdminAuctionListingView> {
    await this.prisma.auctionListing.update({
      where: { id },
      data: { status: 'QUEUED', rejectionReason: null },
    });
    await this.promoteNextQueued();
    // Аудит-фикс: раньше re-fetch грузил только `bids` и отдавался через
    // toOwnView() — обычный AuctionListingView, БЕЗ portfolioItemTitle/
    // portfolioItemVideoUrl/creatorDisplayName/currentPriceUahEquivalent,
    // которые ожидает admin-фронтенд (AdminAuctionListing, см.
    // admin/src/app/auctions/page.tsx: `replace(updated)` подставляет
    // именно этот ответ в строку таблицы). Реальный эффект — превью-
    // видео/заголовок/ссылка на исполнителя в этой строке пропадали
    // сразу после клика «Одобрить», до следующего полного load() (тот
    // же класс расхождения, что чинит toAdminView() ниже — тот же
    // include, что уже использует adminList()).
    const fresh = await this.prisma.auctionListing.findUniqueOrThrow({
      where: { id },
      include: { portfolioItem: true, creatorProfile: { include: { user: true } }, bids: true },
    });
    return this.toAdminView(fresh);
  }

  async adminReject(id: string, dto: RejectAuctionListingDto): Promise<AdminAuctionListingView> {
    // Аудит-фикс — тот же класс, что в adminApprove() выше: include
    // расширен под toAdminView(), bids задаётся пустым массивом здесь
    // намеренно (тот же смысл, что и раньше — только что отклонённая
    // заявка ставок не имеет, отдельный запрос не нужен).
    const listing = await this.prisma.auctionListing.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: dto.reason },
      include: { portfolioItem: true, creatorProfile: { include: { user: true } } },
    });
    return this.toAdminView({ ...listing, bids: [] });
  }

  /**
   * Ручное подтверждение оплаты (см. комментарий в начале файла — self-
   * serve чек-аут через billing остаётся отдельным следующим шагом).
   * Комиссия здесь, а не при создании AuctionPayment — списывается
   * строго по факту состоявшейся сделки (§22).
   */
  /**
   * Реальный пробел, закрытый этим фиксом: раньше победителю ОБЫЧНЫХ
   * торгов (не «купить сейчас») было негде узнать, что он выиграл, и
   * перейти к оплате — сама /auctions/:id к моменту WON уже 404-ится
   * (§22, «не должна оставлять мёртвые публичные ссылки»). Показывает
   * по одной строке на лот, где у пользователя есть хотя бы одна
   * ставка — не всю историю ставок, только своя лучшая на каждый лот.
   */
  async listMyBids(userId: string): Promise<MyBidView[]> {
    const bids = await this.prisma.bid.findMany({
      where: { buyerId: userId },
      include: {
        listing: {
          include: {
            portfolioItem: true,
            payment: { include: { winningBid: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const seenListingIds = new Set<string>();
    const results: MyBidView[] = [];
    for (const bid of bids) {
      if (seenListingIds.has(bid.listingId)) continue;
      seenListingIds.add(bid.listingId);

      const myBidsOnListing = bids.filter((b) => b.listingId === bid.listingId);
      const myHighestBid = Math.max(...myBidsOnListing.map((b) => b.amount));
      const { listing } = bid;
      const isWinner = listing.payment?.winningBid?.buyerId === userId;

      results.push({
        listingId: listing.id,
        title: listing.portfolioItem.title,
        thumbnailUrl: listing.portfolioItem.thumbnailUrl,
        // myHighestBid из БД — минорные единицы, API-контракт MyBidView — мажорные.
        myBidAmount: toMajorUnits(myHighestBid),
        listingStatus: listing.status as MyBidView['listingStatus'],
        isWinner,
        paymentPaid: listing.payment?.paidAt != null,
      });
    }
    return results;
  }

  /**
   * Победивший покупатель начинает оплату (WayForPay — см.
   * BillingService.startAuctionCheckout). Проверяет, что вызывающий —
   * именно тот, кто выиграл (buyerId выигравшей Bid), не просто любой
   * залогиненный пользователь.
   */
  async startCheckout(
    userId: string,
    listingId: string,
  ): Promise<{ wayforpayFormUrl?: string; wayforpayFields?: Record<string, string> }> {
    const listing = await this.prisma.auctionListing.findUnique({
      where: { id: listingId },
      include: { payment: true, portfolioItem: true },
    });
    if (!listing || listing.status !== 'WON' || !listing.payment) {
      throw new NotFoundException('no pending payment for this listing');
    }
    if (listing.payment.paidAt) {
      throw new ConflictException('payment already confirmed');
    }
    if (listing.payment.paymentId) {
      throw new ConflictException('checkout already started for this listing — use the existing payment link');
    }
    const winningBid = await this.prisma.bid.findUnique({ where: { id: listing.payment.winningBidId } });
    if (!winningBid || winningBid.buyerId !== userId) {
      throw new ForbiddenException('only the winning bidder can pay for this listing');
    }

    // listing.payment.amount из БД — минорные единицы; startAuctionCheckout
    // (BillingService) ожидает МАЖОРНЫЕ (сам переводит их в минорные для
    // Payment.amount по своей же конвенции) — контракт этого метода не
    // трогаем, конвертируем на границе вызова.
    const { paymentId, checkout } = await this.billing.startAuctionCheckout(
      userId,
      listing.payment.id,
      toMajorUnits(listing.payment.amount),
      listing.payoutCurrency,
      listing.portfolioItem.title,
    );
    await this.prisma.auctionPayment.update({
      where: { id: listing.payment.id },
      data: { paymentId },
    });
    return checkout;
  }

  /**
   * Запасной ручной путь оператора — например, покупатель оплатил вне
   * self-serve чек-аута (банковский перевод и т.п.) и это нужно
   * зафиксировать. Основной путь — startCheckout выше + вебхук WayForPay,
   * который вызывает тот же AuctionPaymentService.applySuccess.
   */
  async adminConfirmPayment(id: string): Promise<AdminAuctionListingView> {
    const listing = await this.prisma.auctionListing.findUnique({ where: { id }, include: { payment: true } });
    if (!listing || listing.status !== 'WON' || !listing.payment) {
      throw new NotFoundException('no pending payment for this listing');
    }
    if (listing.payment.paidAt) {
      throw new ConflictException('payment already confirmed');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.auctionPayment.applySuccess(tx, listing.payment!.id);
    });

    // Аудит-фикс — тот же класс, что в adminApprove()/adminReject() выше.
    const fresh = await this.prisma.auctionListing.findUniqueOrThrow({
      where: { id },
      include: { portfolioItem: true, creatorProfile: { include: { user: true } }, bids: true },
    });
    return this.toAdminView(fresh);
  }

  // ── Живой аукцион (ТЗ §7, Этап 5) ────────────────────────────────────

  /**
   * POST /admin/auctions/:id/studio — назначить студию (и, опционально,
   * конкретный готовый VIDEO-фрагмент) лоту эфира. Оператор-only (§3):
   * у продавца нет доступа ни к созданию VirtualStudio, ни к выбору.
   *
   * Если `videoFragmentId` не задан — берётся самый свежий готовый
   * (`status: complete`) VIDEO-фрагмент этой студии; ТЗ (§7.1) не
   * заводит отдельного шага выбора конкретного фрагмента, только
   * назначение студии, так что разумный дефолт здесь — не блокировать
   * оператора обязательным вторым полем.
   *
   * Переназначение уже занятого фрагмента другому лоту — штатный сценарий
   * (§7.2, доккомментарий VirtualStudioFragment.liveAuctionListingId):
   * поле просто перезаписывается, у прежнего лота видео эфира исчезает
   * молча — операторская ответственность, не проверяется здесь отдельно.
   */
  async assignVirtualStudio(listingId: string, dto: AssignVirtualStudioDto): Promise<AdminAuctionListingView> {
    const listing = await this.prisma.auctionListing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('auction listing not found');
    if (listing.status !== 'QUEUED' && listing.status !== 'ACTIVE') {
      throw new BadRequestException('студию можно назначить лоту только в очереди (QUEUED) или уже идущим торгам (ACTIVE)');
    }
    // ПРАВКА 1.4 (§7.3 — открытый вопрос версии 1.2 «BLITZ ли только»
    // теперь решён явно): живой эфир имеет смысл только для BLITZ —
    // короткое, предсказуемое по бюджету окно (1-3 часа реального
    // трафика на TTS/видео), в отличие от STANDARD (3-7 суток), где
    // тот же непрерывный эфир либо бессмысленно долго горит впустую
    // между редкими ставками (авто-сворачивание §7.5 это смягчает, но
    // не отменяет саму нецелесообразность), либо разгоняет расход без
    // соразмерной отдачи. STANDARD-лот технически МОЖЕТ дойти сюда
    // (auctionType не проверяется при подаче заявки) — отклоняем здесь,
    // а не запретом на уровне схемы, чтобы сообщение было понятным
    // оператору, а не голым constraint-нарушением БД.
    if (listing.auctionType !== 'BLITZ') {
      throw new BadRequestException('живой эфир доступен только для BLITZ-лотов — у STANDARD нет технической/бизнес-ценности (см. ТЗ §7.3, ПРАВКА 1.4)');
    }
    // ПРАВКА 1.4 (§7.8) — продавец должен явно согласиться на живую
    // трансляцию своего лота (чекбокс при подаче заявки, тот же приём,
    // что antiSnipeEnabled). Без согласия оператор технически может
    // хотеть включить эфир, но не должен мочь это сделать в обход воли
    // продавца — отказ, а не молчаливое игнорирование чекбокса.
    if (!listing.liveStreamOptIn) {
      throw new BadRequestException('продавец не давал согласия на живую трансляцию для этого лота (liveStreamOptIn не включён при подаче заявки)');
    }

    const studio = await this.prisma.virtualStudio.findFirst({
      where: { id: dto.virtualStudioId, status: 'READY', deletedAt: null },
    });
    if (!studio || !studio.selectedVariantId) {
      throw new BadRequestException('студия не найдена, не в статусе READY, или у неё не выбран вариант референс-кадра');
    }

    const fragment = dto.videoFragmentId
      ? await this.prisma.virtualStudioFragment.findFirst({
          where: {
            id: dto.videoFragmentId,
            studioId: studio.id,
            kind: 'VIDEO',
            status: GenerationStatus.COMPLETE,
          },
        })
      : await this.prisma.virtualStudioFragment.findFirst({
          where: { studioId: studio.id, kind: 'VIDEO', status: GenerationStatus.COMPLETE },
          orderBy: { createdAt: 'desc' },
        });
    if (!fragment) {
      throw new BadRequestException('у выбранной студии нет готового видео-фрагмента для эфира (§3.4 — сначала сгенерируйте его в админке)');
    }

    const alreadyAssigned = listing.virtualStudioId != null;
    await this.prisma.$transaction([
      this.prisma.auctionListing.update({ where: { id: listingId }, data: { virtualStudioId: studio.id } }),
      this.prisma.virtualStudioFragment.update({ where: { id: fragment.id }, data: { liveAuctionListingId: listingId } }),
    ]);

    // Лот уже ACTIVE и студии раньше не было — эфир нужно завести прямо
    // сейчас (обычный путь через promoteNextQueued его уже не тронет,
    // переход в ACTIVE давно случился). Best-effort, тот же приём, что
    // и у самого promoteNextQueued() — см. доккомментарий там.
    if (listing.status === 'ACTIVE' && !alreadyAssigned) {
      void this.liveAuction.activateLiveStream(listingId);
    }

    // Аудит-фикс — тот же класс, что найден и исправлен в adminApprove()/
    // adminReject()/adminConfirmPayment(): admin-фронтенд (`admin/src/
    // app/auctions/page.tsx`, `assignAuctionVirtualStudio`) ожидает
    // полный AdminAuctionListingView (portfolioItemTitle/
    // portfolioItemVideoUrl/creatorDisplayName/currentPriceUahEquivalent
    // — без них `replace(updated)` стёр бы превью/заголовок/ссылку на
    // исполнителя из строки таблицы сразу после назначения студии).
    const fresh = await this.prisma.auctionListing.findUniqueOrThrow({
      where: { id: listingId },
      include: { portfolioItem: true, creatorProfile: { include: { user: true } }, bids: true },
    });
    return this.toAdminView(fresh);
  }

  /**
   * GET /auctions/:id/state — снимок состояния эфира для клиента,
   * подключившегося позже начала (§7.6). Не ограничено статусом ACTIVE
   * (в отличие от getPublic выше) — клиент, уже смотревший эфир, должен
   * увидеть, что лот закрылся (WON/EXPIRED), а не получить голый 404.
   *
   * Аудит (сверка с SilverFinance) — `cues` отдаёт весь готовый плейлист
   * (последние до 50 подсказок по `seq`), не одну «последнюю»: см.
   * доккомментарий AuctionLiveStateView.cues про то, зачем это нужно
   * плееру. `take: 50` берётся с конца (`seq desc`), затем разворачивается
   * в хронологический порядок — на очень горячем лоте (§7.7: «до сотен
   * ставок») это последние подсказки, а не первые pregen-три навсегда.
   */
  async getLiveState(listingId: string): Promise<AuctionLiveStateView> {
    const listing = await this.prisma.auctionListing.findUnique({
      where: { id: listingId },
    });
    if (!listing) throw new NotFoundException('auction listing not found');

    // Аудит L-4: раньше здесь стояло `include: { bids: true }`, и максимум
    // с количеством считались в памяти. Из всей выборки нужны ровно два
    // числа, а эндпоинт опрашивает КАЖДЫЙ зритель раз в 4 секунды (15
    // запросов в минуту на человека) — при заложенных в ТЗ §7.7 «сотнях
    // ставок» на горячем лоте это вычитывание всех ставок лота десятки
    // раз в секунду. Агрегат считает то же самое на стороне БД.
    const bidStats = await this.prisma.bid.aggregate({
      where: { listingId },
      _max: { amount: true },
      _count: { _all: true },
    });
    const highestBidMinor = bidStats._max.amount ?? null;
    const bidCount = bidStats._count._all;

    let videoUrl: string | null = null;
    if (listing.virtualStudioId) {
      const videoFragment = await this.prisma.virtualStudioFragment.findFirst({
        where: { liveAuctionListingId: listingId, kind: 'VIDEO' },
        orderBy: { createdAt: 'desc' },
      });
      videoUrl = videoFragment?.resultUrl ?? null;
    }

    const cueRows = await this.prisma.auctionLiveVoiceCue.findMany({
      where: { listingId, status: GenerationStatus.COMPLETE },
      orderBy: { seq: 'desc' },
      take: 50,
      include: { voiceFragment: true },
    });
    const cues = cueRows
      .reverse()
      .map((c) => this.toCueView(c))
      .filter((c): c is AuctionLiveVoiceCueView => c != null);

    return {
      listingId: listing.id,
      status: listing.status as AuctionLiveStateView['status'],
      liveStreamActive: listing.liveStreamActive,
      liveStreamStartedAt: listing.liveStreamStartedAt ? listing.liveStreamStartedAt.toISOString() : null,
      expiresAt: listing.expiresAt ? listing.expiresAt.toISOString() : null,
      highestBidAmount: highestBidMinor != null ? toMajorUnits(highestBidMinor) : null,
      bidCount,
      videoUrl,
      cues,
    };
  }

  /**
   * GET /auctions/:id/stream (SSE) опрашивает эту же проекцию каждый
   * тик — не отдельный push-канал, а поллинг с курсорами (createdAt
   * ставки / seq подсказки), см. доккомментарий AuctionController.stream:
   * SSE на Vercel serverless-функциях имеет открытый вопрос лимита
   * времени выполнения (§10.4 исходного ТЗ) — самозавершающийся,
   * переподключаемый поллинг обходит его без смены транспорта.
   */
  async getLiveUpdates(
    listingId: string,
    sinceBidAt: Date | null,
    sinceSeq: number,
  ): Promise<{ bids: BidView[]; cues: AuctionLiveVoiceCueView[] }> {
    const [bids, cues] = await Promise.all([
      this.prisma.bid.findMany({
        where: { listingId, ...(sinceBidAt ? { createdAt: { gt: sinceBidAt } } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.auctionLiveVoiceCue.findMany({
        where: { listingId, seq: { gt: sinceSeq }, status: GenerationStatus.COMPLETE },
        orderBy: { seq: 'asc' },
        include: { voiceFragment: true },
      }),
    ]);

    return {
      bids: bids.map((b) => ({
        id: b.id,
        listingId: b.listingId,
        amount: toMajorUnits(b.amount),
        createdAt: b.createdAt.toISOString(),
      })),
      cues: cues.map((c) => this.toCueView(c)).filter((c): c is AuctionLiveVoiceCueView => c != null),
    };
  }

  private toCueView(
    cue: {
      id: string;
      seq: number;
      kind: string;
      readyAt: Date | null;
      createdAt: Date;
      voiceFragment: { resultUrl: string | null } | null;
    } | null,
  ): AuctionLiveVoiceCueView | null {
    if (!cue?.voiceFragment?.resultUrl) return null;
    return {
      id: cue.id,
      seq: cue.seq,
      kind: cue.kind as AuctionLiveVoiceCueView['kind'],
      audioUrl: cue.voiceFragment.resultUrl,
      createdAt: (cue.readyAt ?? cue.createdAt).toISOString(),
    };
  }

  // ── Проекции ─────────────────────────────────────────────────────

  private toOwnView(
    listing: {
      id: string;
      creatorProfileId: string;
      portfolioItemId: string;
      brandManifestId: string | null;
      includeBrandManifest: boolean;
      auctionType: string;
      payoutCurrency: string;
      rightsConfirmedAt: Date;
      expiresAt: Date | null;
      aiAssessment: string | null;
      brandManifestAiAudit: string | null;
      startingPrice: number;
      reservePrice: number | null;
      buyNowPrice: number | null;
      status: string;
      createdAt: Date;
      antiSnipeEnabled: boolean;
      extensions: number;
      liveStreamOptIn: boolean;
      virtualStudioId: string | null;
      liveStreamActive: boolean;
    },
    bids: { amount: number }[],
  ): AuctionListingView {
    // Аудит-фикс (Float→Int минорные единицы): БД хранит цены/ставки в
    // минорных единицах (копейки/центы, см. common/money.ts) — весь
    // внешний API-контракт (AuctionListingView и т.д.) остаётся в
    // МАЖОРНЫХ, как и раньше, конвертация только здесь, на границе.
    const highestBidMinor = bids.length ? Math.max(...bids.map((b) => b.amount)) : null;
    return {
      id: listing.id,
      creatorProfileId: listing.creatorProfileId,
      portfolioItemId: listing.portfolioItemId,
      brandManifestId: listing.brandManifestId,
      includeBrandManifest: listing.includeBrandManifest,
      auctionType: listing.auctionType as AuctionListingView['auctionType'],
      payoutCurrency: listing.payoutCurrency as AuctionListingView['payoutCurrency'],
      rightsConfirmedAt: listing.rightsConfirmedAt.toISOString(),
      expiresAt: listing.expiresAt ? listing.expiresAt.toISOString() : null,
      aiAssessment: listing.aiAssessment,
      brandManifestAiAudit: listing.brandManifestAiAudit,
      startingPrice: toMajorUnits(listing.startingPrice),
      reservePrice: listing.reservePrice != null ? toMajorUnits(listing.reservePrice) : null,
      buyNowPrice: listing.buyNowPrice != null ? toMajorUnits(listing.buyNowPrice) : null,
      status: listing.status as AuctionListingView['status'],
      highestBidAmount: highestBidMinor != null ? toMajorUnits(highestBidMinor) : null,
      bidCount: bids.length,
      createdAt: listing.createdAt.toISOString(),
      antiSnipeEnabled: listing.antiSnipeEnabled,
      extensions: listing.extensions,
      liveStreamOptIn: listing.liveStreamOptIn,
      virtualStudioId: listing.virtualStudioId,
      liveStreamActive: listing.liveStreamActive,
    };
  }

  private toPublicView(listing: ListingWithBids): PublicAuctionListingView {
    const bids = listing.bids ?? [];
    const highestBidMinor = bids.length ? Math.max(...bids.map((b) => b.amount)) : null;
    return {
      id: listing.id,
      creatorProfileId: listing.creatorProfileId,
      creatorDisplayName: listing.creatorProfile?.user?.firstName ?? null,
      portfolioItemId: listing.portfolioItemId,
      title: listing.portfolioItem.title,
      // §9/§22 защита от пиратства — та же резолвинг-логика, что у PortfolioService.toView().
      videoUrl: publicVideoUrl(listing.portfolioItem),
      thumbnailUrl: listing.portfolioItem.thumbnailUrl,
      isExclusiveBundle: listing.includeBrandManifest,
      auctionType: listing.auctionType,
      payoutCurrency: listing.payoutCurrency,
      // Минорные единицы (БД) → мажорные (API-контракт), см. toOwnView выше.
      startingPrice: toMajorUnits(listing.startingPrice),
      buyNowPrice: listing.buyNowPrice != null ? toMajorUnits(listing.buyNowPrice) : null,
      highestBidAmount: highestBidMinor != null ? toMajorUnits(highestBidMinor) : null,
      bidCount: bids.length,
      expiresAt: listing.expiresAt.toISOString(),
      antiSnipeEnabled: listing.antiSnipeEnabled,
      extensions: listing.extensions,
    };
  }

  private toAdminView(listing: ListingWithBids): AdminAuctionListingView {
    // Аудит-фикс: fx-rates.ts (convertForDisplay) уже был написан именно
    // для этого — информационная UAH-оценка цены, задаваемой в другой
    // валюте, — но не имел ни одного вызова во всём проекте. Оператор,
    // модерируя очередь смешанных UAH/USD/EUR-лотов, не мог на глаз
    // сравнить их «насколько это дорого» без ручного пересчёта. null для
    // payoutCurrency === 'UAH' — конвертация в саму себя не несёт
    // информации (см. доккомментарий convertForDisplay).
    const ownView = this.toOwnView(listing as any, listing.bids ?? []);
    const currentPriceMajor = ownView.highestBidAmount ?? ownView.startingPrice;
    const currentPriceUahEquivalent =
      listing.payoutCurrency === 'UAH' ? null : convertForDisplay(currentPriceMajor, listing.payoutCurrency as AuctionCurrencyValue, 'UAH');
    return {
      ...ownView,
      creatorDisplayName: listing.creatorProfile?.user?.firstName ?? null,
      portfolioItemTitle: listing.portfolioItem.title,
      portfolioItemVideoUrl: listing.portfolioItem.videoUrl,
      currentPriceUahEquivalent,
    };
  }
}
