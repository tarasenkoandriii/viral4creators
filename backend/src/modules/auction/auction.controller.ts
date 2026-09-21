/**
 * Own side (TelegramIdentityGuard):
 *   POST   /auctions             подать заявку в очередь (§22.1)
 *   GET    /auctions/mine        свои заявки, любой статус
 *   GET    /auctions/my-bids     свои ставки/выигрыши как покупателя (закрывает реальный пробел — см. AuctionService.listMyBids)
 *   DELETE /auctions/:id         отозвать в любом статусе до WON
 *
 * Bid (TelegramIdentityGuard — ставка без identity бессмысленна):
 *   POST /auctions/:id/bids      сделать ставку (§22.1, настоящие торги)
 *   POST /auctions/:id/checkout  победивший покупатель начинает оплату (WayForPay)
 *
 * Public side (no guard — постоянный раздел витрины, §22.1):
 *   GET /auctions        список ACTIVE-лотов
 *   GET /auctions/:id    карточка лота — 404, если не ACTIVE (§22)
 *
 * Живой аукцион (ТЗ на живой аукцион §7.6, Этап 5 — те же контроллеры,
 * НЕ отдельный /api/live-auction, см. ПРАВКА 1.1 того ТЗ):
 *   GET  /auctions/:id/state   снимок эфира (публичный, PublicAuctionController)
 *   GET  /auctions/:id/stream  SSE: новые ставки/подсказки озвучки (публичный)
 *   POST /admin/auctions/:id/studio  назначить студию эфира лоту (AdminAuctionController)
 *
 * Admin (AdminSessionGuard, по образцу admin/portfolio-items):
 *   GET  /admin/auctions?status=&page=&pageSize=
 *   POST /admin/auctions/:id/approve
 *   POST /admin/auctions/:id/reject          { reason }
 *   POST /admin/auctions/:id/confirm-payment  ручное подтверждение (Этап 2, см. auction.service.ts)
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { AuctionService } from './auction.service';
import {
  AssignVirtualStudioDto,
  CreateAuctionListingDto,
  PlaceBidDto,
  RejectAuctionListingDto,
} from './dto/auction.dto';
import {
  AdminAuctionListResult,
  AdminAuctionListingView,
  AuctionLiveStateView,
  AuctionListingView,
  BidView,
  MyBidView,
  PublicAuctionListingView,
} from '../../common/types/marketplace.types';

/** §7.5/§10.4 — поллинг, не push: интервал опроса БД внутри одного SSE-тика. */
const LIVE_STREAM_POLL_MS = 2_000;
/** Комментарий-heartbeat (держит соединение через прокси/CDN, не считается событием). */
const LIVE_STREAM_HEARTBEAT_MS = 15_000;
/**
 * Открытый вопрос §10.4 исходного ТЗ — лимит времени serverless-функции
 * на Vercel для одного HTTP-вызова не проверен на этом стенде. Значение
 * ниже — консервативная нижняя граница (короче любого известного лимита
 * плана Hobby/Pro); клиентский EventSource переподключается сам по
 * умолчанию, так что самозавершение по таймауту здесь безопасно даже
 * если реальный лимит окажется куда больше — просто переподключение
 * будет случаться чаще необходимого. Если лимит окажется КОРОЧЕ этого
 * значения на проде — уменьшить константу, не менять транспорт.
 */
const LIVE_STREAM_MAX_DURATION_MS = 55_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

@UseGuards(TelegramIdentityGuard)
@Controller('auctions')
export class AuctionController {
  constructor(private readonly service: AuctionService) {}

  @Post()
  create(@Req() req: IdentifiedRequest, @Body() dto: CreateAuctionListingDto): Promise<AuctionListingView> {
    return this.service.create(req.telegramUserId, dto);
  }

  @Get('mine')
  mine(@Req() req: IdentifiedRequest): Promise<AuctionListingView[]> {
    return this.service.listMine(req.telegramUserId);
  }

  /** Закрывает реальный пробел — см. AuctionService.listMyBids. Статический путь, регистрируется раньше PublicAuctionController's :id. */
  @Get('my-bids')
  myBids(@Req() req: IdentifiedRequest): Promise<MyBidView[]> {
    return this.service.listMyBids(req.telegramUserId);
  }

  @Delete(':id')
  withdraw(@Req() req: IdentifiedRequest, @Param('id') id: string): Promise<AuctionListingView> {
    return this.service.withdraw(req.telegramUserId, id);
  }

  @Post(':id/bids')
  placeBid(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: PlaceBidDto,
  ): Promise<BidView> {
    return this.service.placeBid(req.telegramUserId, id, dto);
  }

  /** Только победивший покупатель — см. AuctionService.startCheckout. */
  @Post(':id/checkout')
  startCheckout(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<{ wayforpayFormUrl?: string; wayforpayFields?: Record<string, string> }> {
    return this.service.startCheckout(req.telegramUserId, id);
  }
}

@Controller('auctions')
export class PublicAuctionController {
  constructor(private readonly service: AuctionService) {}

  @Get()
  list(): Promise<PublicAuctionListingView[]> {
    return this.service.listPublic();
  }

  /**
   * Живой аукцион (§7.6) — снимок эфира для клиента, подключившегося
   * позже начала: текущая цена/статус + весь готовый плейлист подсказок
   * (`cues`, не только последняя — см. доккомментарий AuctionLiveStateView),
   * из которого клиент строит собственную ротацию pregen-реплик в паузах
   * между ставками (SSE ниже отдаёт только НОВЫЕ подсказки с момента
   * подключения — этот эндпоинт нужен именно для начального снимка).
   */
  @Get(':id/state')
  state(@Param('id') id: string): Promise<AuctionLiveStateView> {
    return this.service.getLiveState(id);
  }

  /**
   * Живой аукцион (§7.5) — SSE-события `bid` (новая ставка, для
   * мгновенного текстового оверлея, пока озвучка ещё генерируется) и
   * `cue` (готовая подсказка озвучки — id/seq/kind/audioUrl). Реализован
   * поллингом курсоров (createdAt ставки / seq подсказки) внутри одного
   * HTTP-вызова, самозавершающимся через `LIVE_STREAM_MAX_DURATION_MS`
   * — см. доккомментарий константы про открытый вопрос лимита
   * serverless-функций (§10.4 исходного ТЗ). `@Res()` без passthrough —
   * тот же приём, что уже применён в `AssistantController.chat` для
   * ручного управления `text/event-stream`, включая обработку `close`
   * у запроса/ответа как сигнала отключения клиента.
   *
   * Аудит (сверка с SilverFinance) — их `liveStream.ts`/`stream/route.ts`
   * в итоге отдают точно такой же полный `getStreamState()` через обычный
   * `GET`, опрашиваемый клиентом каждые 4с (комментарий в их коде: «MVP
   * uses polling, matching the bidding model»), а не настоящий SSE/WS,
   * несмотря на то что их же исходное ТЗ (§6.4) просило SSE/WebSocket —
   * тот же риск лимита serverless-функции, что и наш §10.4, на практике
   * решился в пользу простого поллинга. Здесь это не повод выкидывать SSE
   * (он даёт более низкую задержку, когда работает, и безопасно
   * деградирует за счёт самозавершения), но именно поэтому `GET .../state`
   * выше спроектирован как самодостаточный источник истины: клиент,
   * которому не подходит/не открылся SSE, может просто поллить `state`
   * напрямую — ровно тот путь, который в проде выбрал SilverFinance.
   */
  @Get(':id/stream')
  async stream(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    req.on?.('close', onClose);
    res.on?.('close', onClose);

    try {
      try {
        await this.service.getLiveState(id);
      } catch {
        res.status(404).json({ success: false, error: { code: 'not_found', message: 'auction listing not found' } });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // С МОМЕНТА ПОДКЛЮЧЕНИЯ, не с начала эфира — история до подключения
      // приходит через GET .../state (see above), стрим отдаёт только новое.
      let sinceBidAt: Date | null = new Date();
      let sinceSeq = 0;
      const startedAt = Date.now();
      let lastHeartbeatAt = Date.now();

      while (!abortController.signal.aborted && Date.now() - startedAt < LIVE_STREAM_MAX_DURATION_MS) {
        let updates;
        try {
          updates = await this.service.getLiveUpdates(id, sinceBidAt, sinceSeq);
        } catch {
          break; // лот удалён/БД недоступна — просто закрываем соединение, клиент переподключится
        }
        for (const bid of updates.bids) {
          if (res.writableEnded) break;
          res.write(`event: bid\ndata: ${JSON.stringify(bid)}\n\n`);
          sinceBidAt = new Date(bid.createdAt);
        }
        for (const cue of updates.cues) {
          if (res.writableEnded) break;
          res.write(`event: cue\ndata: ${JSON.stringify(cue)}\n\n`);
          sinceSeq = Math.max(sinceSeq, cue.seq);
        }
        if (res.writableEnded) break;
        if (Date.now() - lastHeartbeatAt > LIVE_STREAM_HEARTBEAT_MS) {
          res.write(': heartbeat\n\n');
          lastHeartbeatAt = Date.now();
        }
        await sleep(LIVE_STREAM_POLL_MS, abortController.signal);
      }
    } catch {
      // Сюда попадают только сбои самой записи в уже открытый ответ
      // (например, разорванное соединение) — best-effort, закрываем ниже.
    } finally {
      req.off?.('close', onClose);
      res.off?.('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<PublicAuctionListingView> {
    return this.service.getPublic(id);
  }
}

@UseGuards(AdminSessionGuard)
@Controller('admin/auctions')
export class AdminAuctionController {
  constructor(
    private readonly service: AuctionService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AdminAuctionListResult> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminList({
      status,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(Math.max(parseInt(pageSize ?? '20', 10) || 20, 1), 100),
    });
  }

  @Post(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminAuctionListingView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminApprove(id);
  }

  @Post(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectAuctionListingDto,
  ): Promise<AdminAuctionListingView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminReject(id, dto);
  }

  @Post(':id/confirm-payment')
  async confirmPayment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminAuctionListingView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminConfirmPayment(id);
  }

  /** Живой аукцион (§7.6, Этап 5) — назначить студию эфира лоту. */
  @Post(':id/studio')
  async assignStudio(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AssignVirtualStudioDto,
  ): Promise<AdminAuctionListingView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.assignVirtualStudio(id, dto);
  }
}
