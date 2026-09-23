/**
 * LiveAuctionOrchestratorService — docs-tz/TZ-Virtualnaya-Studiya-i-AI-
 * Vedushaya.md §7.4, Этап 5. Новый файл внутри уже существующего
 * `modules/auction/`, НЕ отдельный модуль (ПРАВКА 1.1, §10.5.7 того же
 * ТЗ) — оркестрация живого эфира лота, вызывается best-effort хуками из
 * `AuctionService.promoteNextQueued()` (переход в ACTIVE) и
 * `AuctionService.placeBid()` (после создания `Bid`), а не из
 * какого-то нового `BidService`.
 *
 * Идея эфира (§7.1) — постоянное видео (один VirtualStudioFragment
 * kind=VIDEO, назначенный лоту оператором через
 * AuctionService.assignVirtualStudio) + меняющаяся озвучка поверх. На
 * каждое событие (переход в ACTIVE, ставка) этот сервис синтезирует
 * НОВЫЙ голосовой VirtualStudioFragment через уже существующий
 * `TtsProviderResolverService` (§4.3, тот же пайплайн, что и у ручных
 * голосовых фрагментов в админке) и заводит `AuctionLiveVoiceCue`,
 * ссылающийся на него.
 *
 * Всё здесь best-effort в том же смысле, что `notifyWinner`/
 * `activateGoogleAdsCampaignIfBlitz` в auction.service.ts: сбой TTS,
 * отсутствие настроенного провайдера или гонка с параллельным вызовом
 * не должны ронять сам приём ставки или продвижение очереди — эфир
 * просто недополучит одну реплику, а не завалит запрос покупателя.
 *
 * Конкурентность `seq` (открытый вопрос §10.2 исходного ТЗ) — решена
 * тем же приёмом, что уже применён в `AuctionService.promoteNextQueued`:
 * `pg_advisory_xact_lock(hashtext(...))` внутри короткой транзакции,
 * которая только резервирует номер и создаёт `status: 'pending'`-заглушку
 * — сам синтез (внешний HTTP-вызов) идёт ПОСЛЕ коммита этой транзакции,
 * чтобы не держать лок и не блокировать конкурентные ставки на время
 * сетевого вызова.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { GoogleIndexingService } from './google-indexing.service';
import { GenerationStatus } from '../../common/types/generation.types';
import { AuctionCurrencyValue } from '../../common/types/marketplace.types';
import { toMajorUnits } from '../../common/money';

/** §7.5 — «если за N минут не поступило ни одной ставки» (по умолчанию 15). */
const LIVE_NO_BID_COLLAPSE_MIN = 15;

/**
 * Аудит (сверка с SilverFinance, docs-tz/…/TZ-Blitz-Auction.md §6.7 —
 * `LIVE_MAX_EVENT_CLIPS_PER_MIN`) — исходная версия этого файла синтезировала
 * новую платную TTS-подсказку на КАЖДУЮ принятую ставку без ограничения
 * частоты. На горячем блиц-лоте (§7.7 исходного ТЗ прямо предупреждает про
 * «до сотен ставок», а антиснайпер может создавать всплеск ставок под самый
 * дедлайн) это означает неограниченную серию платных вызовов провайдера
 * озвучки за секунды — риск и по бюджету, и по rate-limit самого провайдера.
 * SilverFinance для точно той же механики («клип статистики на каждую
 * ставку», их §6.2.B) уже наступила на эти грабли и завела явный потолок
 * (`recent >= MAX_EVENT_CLIPS_PER_MIN` → пропустить генерацию, ставка всё
 * равно принимается). Тот же приём здесь: троттлинг только на СИНТЕЗ
 * подсказки, саму ставку он не трогает — `getLiveState()`
 * (highestBidAmount/bidCount) обновляется независимо от того, успела ли
 * подсказка сгенерироваться.
 */
const MAX_EVENT_CUES_PER_MIN = 4;

/**
 * Аудит (сверка с SilverFinance, `liveStream.ts`'s `STALE_GENERATING_MS`) —
 * `emitCue()` резервирует `seq` и создаёт `status: 'pending'`-заглушку ДО
 * платного вызова провайдера; если процесс, делающий этот вызов, падает или
 * убивается serverless-таймаутом между резервированием и записью
 * `complete`/`failed` (сеть до провайдера зависла, контейнер убит), запись
 * так и останется 'pending' навсегда — не мешает работе (клиент видит только
 * COMPLETE-подсказки), но копится как невидимый мусор без единой точки
 * уборки. `collapseInactiveStreams()` (тот же тик крона) заодно подчищает
 * такие зависшие записи.
 */
const STALE_PENDING_CUE_MS = 2 * 60_000;

const CURRENCY_LABEL: Record<AuctionCurrencyValue, string> = {
  UAH: 'грн',
  USD: '$',
  EUR: '€',
};

function formatMoney(
  amountMinor: number,
  currency: AuctionCurrencyValue,
): string {
  return `${toMajorUnits(amountMinor)} ${CURRENCY_LABEL[currency]}`;
}

function buildLotDescText(listing: {
  portfolioItem: { title: string; collectionTag: string | null };
  startingPrice: number;
  payoutCurrency: AuctionCurrencyValue;
  auctionType: string;
}): string {
  const category = listing.portfolioItem.collectionTag
    ? `, категория «${listing.portfolioItem.collectionTag}»`
    : '';
  const kind = listing.auctionType === 'BLITZ' ? 'Блиц-лот' : 'Лот';
  return `${kind} «${listing.portfolioItem.title}»${category}. Старт торгов — ${formatMoney(listing.startingPrice, listing.payoutCurrency)}.`;
}

function buildInviteText(): string {
  return 'Ставки принимаются прямо сейчас — чем выше ставка, тем ближе победа. Не упустите этот лот!';
}

function buildPraiseText(): string {
  return 'viral4creators — маркетплейс эксклюзивного UGC-видео от проверенных исполнителей. Каждый лот — готовый ролик, который можно использовать сразу после покупки.';
}

function buildBidStatsText(
  participantCount: number,
  amountMinor: number,
  currency: AuctionCurrencyValue,
): string {
  const participants =
    participantCount === 1 ? 'один участник' : `${participantCount} участников`;
  return `Новая ставка — ${formatMoney(amountMinor, currency)}. В торгах уже участвует ${participants}.`;
}

/**
 * Этап 6 (§7.8) — публичная страница лота на маркетплейсе, тот же URL,
 * что уже строит `AuctionService`'s `activateGoogleAdsCampaignIfBlitz`
 * (`finalUrl`) для Google Ads: `${MARKETPLACE_SITE_URL}/auctions/:id`,
 * без префикса локали — middleware маркетплейса сам редиректит на
 * дефолтную. Единая точка построения этого URL здесь и в
 * `AuctionService`, а не общий импортируемый хелпер — тот же принцип,
 * что уже применён к дублированию `siteUrl` внутри самого
 * `auction.service.ts` (`notifyWinner`/`activateGoogleAdsCampaignIfBlitz`
 * не делят один хелпер друг с другом).
 */
function listingUrl(listingId: string): string {
  const siteUrl = process.env.MARKETPLACE_SITE_URL ?? 'http://localhost:3004';
  return `${siteUrl}/auctions/${listingId}`;
}

@Injectable()
export class LiveAuctionOrchestratorService {
  private readonly logger = new Logger(LiveAuctionOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
    private readonly tts: TtsProviderResolverService,
    private readonly googleIndexing: GoogleIndexingService,
  ) {}

  /**
   * Хук из `AuctionService.promoteNextQueued()` (переход лота в ACTIVE)
   * и из `AuctionService.assignVirtualStudio()` (студия назначена лоту,
   * который уже ACTIVE). Идемпотентна: повторный вызов на лоте, где
   * pregen-подсказки уже заведены, ничего не делает — это позволяет
   * звать её из двух разных мест без риска задвоить LOT_DESC/INVITE/
   * PRAISE.
   */
  async activateLiveStream(listingId: string): Promise<void> {
    try {
      const listing = await this.prisma.auctionListing.findUnique({
        where: { id: listingId },
        include: { portfolioItem: true },
      });
      if (!listing || !listing.virtualStudioId || listing.status !== 'ACTIVE')
        return;

      const activated = await this.prisma.auctionListing.updateMany({
        where: { id: listingId, liveStreamActive: false },
        data: {
          liveStreamActive: true,
          liveStreamStartedAt: listing.liveStreamStartedAt ?? new Date(),
          liveStreamEndedAt: null,
        },
      });
      // Этап 6 (§7.8) — только на РЕАЛЬНЫЙ переход в эфир (activated.count
      // > 0), не на каждый идемпотентный повторный вызов этого метода
      // (он зовётся и из promoteNextQueued, и из assignVirtualStudio) —
      // иначе один и тот же «эфир начался» дублировался бы вызовами
      // Google без надобности. Best-effort — см. доккомментарий
      // GoogleIndexingService, не блокирует и не может провалить запуск.
      if (activated.count > 0) {
        void this.googleIndexing.notify(listingUrl(listingId), 'URL_UPDATED');
      }

      const existingPregen = await this.prisma.auctionLiveVoiceCue.count({
        where: { listingId, triggeredBy: 'PREGEN' },
      });
      if (existingPregen > 0) return;

      // LOT_DESC переиспользует резюме ANALYSIS-фрагмента студии, если
      // оператор его уже сгенерировал (§3.3/§7.4) — иначе собирается из
      // самих данных лота.
      const analysisFragment =
        await this.prisma.virtualStudioFragment.findFirst({
          where: {
            studioId: listing.virtualStudioId,
            kind: 'ANALYSIS',
            status: GenerationStatus.COMPLETE,
          },
          orderBy: { createdAt: 'desc' },
        });
      const lotDescText =
        analysisFragment?.resultText?.trim() || buildLotDescText(listing);

      const pregen: Array<{
        kind: 'LOT_DESC' | 'INVITE' | 'PRAISE';
        text: string;
      }> = [
        { kind: 'LOT_DESC', text: lotDescText },
        { kind: 'INVITE', text: buildInviteText() },
        { kind: 'PRAISE', text: buildPraiseText() },
      ];
      for (const cue of pregen) {
        await this.emitCue(
          listingId,
          listing.virtualStudioId,
          cue.kind,
          'PREGEN',
          null,
          cue.text,
        );
      }
    } catch (error) {
      this.logger.warn(
        `activateLiveStream(${listingId}) failed (best-effort): ${this.extractErrorMessage(error)}`,
      );
    }
  }

  /**
   * Хук из `AuctionService.placeBid()`, ПОСЛЕ коммита транзакции ставки
   * — только если у лота есть virtualStudioId (§7.3, ПРАВКА 1.1). Если
   * эфир был свёрнут авто-сворачиванием (§7.5) — эта же ставка снимает
   * таймер и возвращает эфир в обычный режим, ровно как требует ТЗ.
   */
  async onBidPlaced(
    listingId: string,
    bid: { id: string; amount: number },
  ): Promise<void> {
    try {
      const listing = await this.prisma.auctionListing.findUnique({
        where: { id: listingId },
      });
      if (!listing || !listing.virtualStudioId) return;

      if (!listing.liveStreamActive) {
        await this.prisma.auctionListing.update({
          where: { id: listingId },
          data: { liveStreamActive: true, liveStreamEndedAt: null },
        });
        // Этап 6 (§7.8) — реактивация после авто-сворачивания тоже
        // считается «эфир начался» для Google (isLiveBroadcast снова
        // true), не только самый первый запуск в activateLiveStream().
        void this.googleIndexing.notify(listingUrl(listingId), 'URL_UPDATED');
      }

      // Аудит (сверка с SilverFinance, см. доккомментарий MAX_EVENT_CUES_PER_MIN
      // выше) — троттлинг платного синтеза на горячем лоте. Реактивация эфира
      // выше это не трогает: видео должно остаться "в эфире" даже если под
      // капотом мы сейчас не даём разрешения на новую подсказку.
      const throttleSince = new Date(Date.now() - 60_000);
      const recentCues = await this.prisma.auctionLiveVoiceCue.count({
        where: {
          listingId,
          kind: 'BID_STATS',
          createdAt: { gte: throttleSince },
        },
      });
      if (recentCues >= MAX_EVENT_CUES_PER_MIN) return;

      const participants = await this.prisma.bid.groupBy({
        by: ['buyerId'],
        where: { listingId },
      });
      const text = buildBidStatsText(
        participants.length,
        bid.amount,
        listing.payoutCurrency as AuctionCurrencyValue,
      );
      await this.emitCue(
        listingId,
        listing.virtualStudioId,
        'BID_STATS',
        'BID',
        bid.id,
        text,
      );
    } catch (error) {
      this.logger.warn(
        `onBidPlaced(${listingId}) failed (best-effort): ${this.extractErrorMessage(error)}`,
      );
    }
  }

  /**
   * §7.5 — авто-сворачивание эфира без ставок за `LIVE_NO_BID_COLLAPSE_MIN`
   * минут. Сам аукцион продолжается (`AuctionListing.status` не трогается)
   * — сворачивается только трансляция. Заодно подчищает зависшие
   * 'pending'-подсказки (см. доккомментарий STALE_PENDING_CUE_MS выше —
   * аудит, сверка с SilverFinance). Вызывается краном
   * `/api/cron/live-auction-tick`.
   */
  async collapseInactiveStreams(): Promise<{
    collapsed: number;
    reapedStalePendingCues: number;
  }> {
    const staleCutoff = new Date(Date.now() - STALE_PENDING_CUE_MS);
    const reaped = await this.prisma.auctionLiveVoiceCue.updateMany({
      where: {
        status: GenerationStatus.PENDING,
        createdAt: { lt: staleCutoff },
      },
      data: { status: GenerationStatus.FAILED },
    });

    const cutoff = new Date(Date.now() - LIVE_NO_BID_COLLAPSE_MIN * 60_000);
    const candidates = await this.prisma.auctionListing.findMany({
      where: { liveStreamActive: true, status: 'ACTIVE' },
      include: { bids: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    let collapsed = 0;
    for (const listing of candidates) {
      const lastActivityAt =
        listing.bids[0]?.createdAt ?? listing.liveStreamStartedAt;
      if (!lastActivityAt || lastActivityAt.getTime() > cutoff.getTime())
        continue;
      // Аудит — каждый лот в своём try/catch: без этого один сбойный
      // update (например, гонка с конкурентным закрытием того же лота
      // ровно в этот момент) прервал бы цикл раньше срока и оставил бы
      // остальные кандидаты этого тика необработанными до следующего
      // прогона крона через 2 минуты. Тот же принцип, что уже
      // применён в `closeExpiredListings` — но там единственный лот на
      // итерацию проходит через `closeListing`, которая уже сама по
      // себе транзакционна; здесь лоты независимы друг от друга, и
      // изоляция сбоя дешевле, чем ждать следующего тика для всех.
      try {
        await this.prisma.auctionListing.update({
          where: { id: listing.id },
          data: { liveStreamActive: false, liveStreamEndedAt: new Date() },
        });
        // Этап 6 (§7.8) — эфир свернулся, разметка BroadcastEvent должна
        // обновиться на isLiveBroadcast:false как можно быстрее.
        void this.googleIndexing.notify(listingUrl(listing.id), 'URL_UPDATED');
        collapsed++;
      } catch (error) {
        this.logger.warn(
          `collapseInactiveStreams: listing ${listing.id} failed (continuing with the rest): ${this.extractErrorMessage(error)}`,
        );
      }
    }
    return { collapsed, reapedStalePendingCues: reaped.count };
  }

  // ── Синтез одной подсказки ──────────────────────────────────────────

  /**
   * Резервирует `seq` (сериализовано по лоту через advisory lock — та
   * же техника, что `promoteNextQueued`'s `pg-advisory-xact-lock`),
   * заводит `status: 'pending'`-заглушку, затем — уже вне транзакции —
   * синтезирует речь и переиспользует существующий пайплайн голосовых
   * фрагментов (§4.3, тот же приём, что `VirtualStudioService.
   * createVoiceFragment`). Не бросает исключений наружу — вызывающие
   * методы выше уже сами best-effort, но эмиссия одной подсказки не
   * должна ронять весь пакет pregen-подсказок, если одна из трёх не
   * синтезировалась.
   */
  private async emitCue(
    listingId: string,
    studioId: string,
    kind: 'LOT_DESC' | 'INVITE' | 'PRAISE' | 'BID_STATS',
    triggeredBy: 'PREGEN' | 'BID',
    bidId: string | null,
    text: string,
  ): Promise<void> {
    let cueId: string;
    try {
      const cue = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-auction-voice-cue:${listingId}`}))`;
        const agg = await tx.auctionLiveVoiceCue.aggregate({
          where: { listingId },
          _max: { seq: true },
        });
        const seq = (agg._max.seq ?? 0) + 1;
        return tx.auctionLiveVoiceCue.create({
          data: {
            listingId,
            seq,
            kind,
            triggeredBy,
            bidId,
            status: GenerationStatus.PENDING,
          },
        });
      });
      cueId = cue.id;
    } catch (error) {
      this.logger.warn(
        `reserving voice cue seq for listing ${listingId} failed: ${this.extractErrorMessage(error)}`,
      );
      return;
    }

    try {
      const provider = await this.tts.resolve();
      if (!provider.configured()) {
        await this.prisma.auctionLiveVoiceCue.update({
          where: { id: cueId },
          data: { status: GenerationStatus.FAILED },
        });
        return;
      }
      const outcome = await provider.synthesize({
        text,
        voiceId: null,
        language: 'ru',
      });
      if (!outcome.ok) {
        await this.prisma.auctionLiveVoiceCue.update({
          where: { id: cueId },
          data: { status: GenerationStatus.FAILED },
        });
        return;
      }

      // Тот же операционный ключ, что у ручных голосовых фрагментов
      // студии (§4.3) — это буквально тот же вызов провайдера,
      // отдельная позиция в ai-pricing.ts не заводится намеренно.
      await this.aiUsage.record({
        operation: 'virtual-studio-voice',
        model: `${provider.providerKey}-tts`,
        characters: outcome.characters,
      });

      const pathname = `virtual-studio/${studioId}/live-voice-cue-${cueId}.mp3`;
      const { url } = await this.blob.uploadBuffer(
        pathname,
        outcome.audio,
        outcome.mimeType,
      );

      const fragment = await this.prisma.virtualStudioFragment.create({
        data: {
          studioId,
          kind: 'VOICE',
          status: GenerationStatus.COMPLETE,
          provider: provider.providerKey,
          text,
          resultUrl: url,
          readyAt: new Date(),
        },
      });

      await this.prisma.auctionLiveVoiceCue.update({
        where: { id: cueId },
        data: {
          voiceFragmentId: fragment.id,
          status: GenerationStatus.COMPLETE,
          readyAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.warn(
        `synthesizing voice cue ${cueId} failed: ${this.extractErrorMessage(error)}`,
      );
      try {
        await this.prisma.auctionLiveVoiceCue.update({
          where: { id: cueId },
          data: { status: GenerationStatus.FAILED },
        });
      } catch {
        // best-effort — если и это не записалось, подсказка просто
        // останется 'pending' навечно, клиент её не увидит (§7.5 отдаёт
        // только COMPLETE-подсказки), но приём ставки уже отработал.
      }
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown error';
  }
}
