/**
 * Публичные маршруты Э6 «видео-ответы и показать на экране» (ТЗ помощника
 * §4.9, §4.11, §4.12):
 *   POST /widget/v1/video          { videoId } → { url, title, expiresAt }:
 *                                  подписанная ссылка на ролик (10 мин)
 *   GET  /widget/v1/video/:token   302 на ролик (Blob генератора) — по
 *                                  подписи и заново по базе: та же проверка,
 *                                  что у POST (сайт помощника есть, тариф с
 *                                  видео, ролик включён и не за логином) —
 *                                  ссылка живёт 10 мин, тариф за это время
 *                                  могли снять (аудит Э6)
 *   POST /widget/v1/highlight-miss { elementId, pageUrl } — загрузчик не
 *                                  нашёл элемент карты: сигнал «карта устарела»
 *                                  (Э-С Ш4: по элементу и виду вёрстки, с
 *                                  квитанцией показа, порогом и окном —
 *                                  assist-site-media/public/ui-map.ts)
 *   POST /widget/v1/highlight-seen { elementId, pageUrl } — загрузчик нашёл
 *                                  элемент (Ш4 (4), Р-З9-3): те же квитанция
 *                                  и вид, голос «найден» с порогом снимка;
 *                                  мгновенного сброса нет
 *
 * Ссылка (третий барьер против ролика чужого сайта, шапка
 * assist-site-media/public/site-videos.ts): ролик ищется по siteId
 * посетителя (visitor-token), включён владельцем, не за логином, тариф с
 * видео; токен подписан вместе с сайтом, а редирект ещё раз берёт строку
 * по (id, siteId токена). Адрес Blob в ответах JSON не появляется никогда —
 * только в `Location` редиректа с коротким сроком ссылки (вопрос владельцу
 * — приватный Blob: doc/DEPLOYMENT.md §6.15).
 *
 * В лог — только id и коды (§6.6).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { videoLinkKey } from '../../config/media-env';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { EventCounts } from '../assist-analytics/public/event-counts.service';
import { readState } from '../assist-billing/public/entitlements';
import { MEDIA_DEFAULTS } from '../assist-site-media/media-config';
import {
  playableVideo,
  videoAllowedByPlan,
} from '../assist-site-media/public/site-videos';
import {
  markUiMapStale,
  recordUiMiss,
  recordUiSeen,
} from '../assist-site-media/public/ui-map';
import {
  UI_MAP_STALE,
  visitorViewport,
  type UiVisitorViewport,
} from '../site-core/ui-map/ui-map-model';
import {
  signVideoLink,
  verifyVideoLink,
} from '../assist-site-media/public/video-link';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { WidgetRateLimit } from './rate-limit';
import { uiVoteIpHash } from './vote-ip-hash';
import { tokenRequestOrigin } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';
import { findSiteById } from './site-access';
import { widgetError } from './widget-errors';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';

const TOKEN_HEADER = WIDGET_VISITOR_TOKEN_HEADER.toLowerCase();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class WidgetVideoLinkDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  videoId!: string;
}

export class WidgetHighlightMissDto {
  @IsString()
  @Matches(/^u[0-9a-f]{8}$/)
  elementId!: string;

  @IsString()
  @MaxLength(2000)
  pageUrl!: string;
}

export interface WidgetVideoLinkResponse {
  /** Путь на origin API виджета: `/widget/v1/video/<токен>`. */
  url: string;
  title: string;
  expiresAt: string;
}

@Controller('widget/v1')
@PublicRoute(
  'видео и подсветка виджета на сайте заказчика: допуск — гвард origin, visitor-token; ссылка на ролик — подпись со сроком',
)
export class WidgetMediaController {
  /** Часы и env — подменяются тестами. */
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sessions: WidgetSessionService,
    private readonly rate: WidgetRateLimit,
    private readonly db: AssistPublicDb,
    private readonly counts: EventCounts,
  ) {}

  @Post('video')
  @HttpCode(200)
  async videoLink(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetVideoLinkDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetVideoLinkResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const now = this.now();
    await this.rate.enforce(
      [
        {
          scope: 'widget-video-visitor-min',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: MEDIA_DEFAULTS.videoLinksPerVisitorPerMinute,
          windowMs: MINUTE,
        },
        {
          scope: 'widget-video-ip-site-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: MEDIA_DEFAULTS.videoLinksPerIpPerMinute,
          windowMs: MINUTE,
        },
      ],
      now,
    );
    const key = videoLinkKey(this.env);
    const video = key
      ? await this.servableVideo(
          ctx.site.accountId,
          ctx.site.siteId,
          dto.videoId,
          now,
        )
      : null;
    if (!key || !video) throw widgetError('VIDEO_UNAVAILABLE');
    const expUnix =
      Math.floor(now.getTime() / 1000) + MEDIA_DEFAULTS.videoLinkTtlSec;
    const signed = signVideoLink(key, {
      siteId: ctx.site.siteId,
      videoId: video.id,
      expUnix,
    });
    if (!ctx.site.preview) {
      await this.counts
        .record({
          siteId: ctx.site.siteId,
          events: [{ kind: 'video_play', key: null }],
          now,
        })
        .catch(() => undefined);
    }
    return {
      url: `/widget/v1/video/${signed}`,
      title: video.title,
      expiresAt: new Date(expUnix * 1000).toISOString(),
    };
  }

  @Get('video/:token')
  async videoRedirect(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const key = videoLinkKey(this.env);
    const now = this.now();
    const check = key
      ? verifyVideoLink(key, token, Math.floor(now.getTime() / 1000))
      : null;
    // Сайт помощника из токена — заново из базы (аккаунт для тарифа).
    const site =
      check && check.ok ? await findSiteById(this.db, check.siteId) : null;
    const video =
      check && check.ok && site
        ? await this.servableVideo(
            site.accountId,
            check.siteId,
            check.videoId,
            now,
          )
        : null;
    if (!video) throw widgetError('VIDEO_UNAVAILABLE');
    res.status(302);
    res.setHeader('Location', video.url);
    // Ссылка личная и короткая: ни общий кэш, ни Referer на хранилище.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end();
  }

  /**
   * Общая проверка выдачи ролика для POST (ссылка) и GET (редирект):
   * тариф кабинета с видео, ролик этого сайта включён и не за логином
   * (`playableVideo`, барьер 3). `null` — не выдаём.
   */
  private async servableVideo(
    accountId: string,
    siteId: string,
    videoId: unknown,
    now: Date,
  ): Promise<{ id: string; title: string; url: string } | null> {
    const plan = await readState(this.db, accountId, now);
    if (!videoAllowedByPlan(plan.planId)) return null;
    return playableVideo(this.db, siteId, videoId, this.env);
  }

  @Post('highlight-miss')
  @HttpCode(200)
  async highlightMiss(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetHighlightMissDto,
    @Req() req: Request,
  ): Promise<{ ok: true; recorded: boolean }> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const now = this.now();
    await this.rate.enforce(
      [
        {
          scope: 'widget-uimiss-visitor-min',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: MEDIA_DEFAULTS.highlightMissPerVisitorPerMinute,
          windowMs: MINUTE,
        },
        {
          scope: 'widget-uimiss-ip-site-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: MEDIA_DEFAULTS.highlightMissPerIpPerMinute,
          windowMs: MINUTE,
        },
        // Ш4: и в сутки с IP на сайт — накрутка устаревания с одного адреса.
        {
          scope: 'widget-uimiss-ip-site-day',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: UI_MAP_STALE.missesPerIpSitePerDay,
          windowMs: DAY,
        },
      ],
      now,
    );
    const v = await this.highlightVisitor(ctx, req, now);
    const miss = await recordUiMiss(this.db, {
      accountId: ctx.site.accountId,
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
      ipHash: v.ipHash,
      pageUrl: dto.pageUrl,
      siteHosts: v.siteHosts,
      elementId: dto.elementId,
      viewport: v.viewport,
      now,
    });
    const recorded = miss.outcome === 'recorded';
    if (recorded) {
      // Э6: справочный счётчик снимков страницы (сводка истории).
      await markUiMapStale(this.db, {
        siteId: ctx.site.siteId,
        pageUrl: dto.pageUrl,
        siteHosts: v.siteHosts,
        elementId: dto.elementId,
      });
    }
    if (recorded && !ctx.site.preview) {
      await this.counts
        .record({
          siteId: ctx.site.siteId,
          events: [{ kind: 'highlight_miss', key: dto.elementId }],
          now,
        })
        .catch(() => undefined);
    }
    return { ok: true, recorded };
  }

  /**
   * Ш4 (4), Р-З9-3: загрузчик НАШЁЛ элемент подсветки — голос «найден»
   * (assist-site-media/public/ui-map.ts `recordUiSeen`). `recorded` — голос
   * принят (элемент был под сомнением у вида посетителя и это первый голос
   * посетителя и IP); ответ одинаковой формы при любом исходе.
   */
  @Post('highlight-seen')
  @HttpCode(200)
  async highlightSeen(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() dto: WidgetHighlightMissDto,
    @Req() req: Request,
  ): Promise<{ ok: true; recorded: boolean }> {
    const ctx = await this.sessions.authenticate({
      token,
      requestOrigin: tokenRequestOrigin(req),
    });
    const now = this.now();
    // Те же пороги, что у промахов, но свои окна: «найдено» бывает чаще.
    await this.rate.enforce(
      [
        {
          scope: 'widget-uiseen-visitor-min',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: MEDIA_DEFAULTS.highlightMissPerVisitorPerMinute,
          windowMs: MINUTE,
        },
        {
          scope: 'widget-uiseen-ip-site-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: MEDIA_DEFAULTS.highlightMissPerIpPerMinute,
          windowMs: MINUTE,
        },
      ],
      now,
    );
    const v = await this.highlightVisitor(ctx, req, now);
    const seen = await recordUiSeen(
      this.db,
      {
        accountId: ctx.site.accountId,
        siteId: ctx.site.siteId,
        visitorId: ctx.visitor.visitorId,
        ipHash: v.ipHash,
        pageUrl: dto.pageUrl,
        siteHosts: v.siteHosts,
        elementId: dto.elementId,
        viewport: v.viewport,
        now,
      },
      {
        // Сутки на IP+сайт — только на ГОЛОС (элемент под сомнением): он
        // может снять «устарел». Обычное «найдено» без сомнений меняет лишь
        // `lastSeenAt` и суточный лимит не тратит (аудит пакета A, P3-3).
        beforeVote: () =>
          this.rate.enforce(
            [
              {
                scope: 'widget-uiseen-ip-site-day',
                key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
                limit: UI_MAP_STALE.missesPerIpSitePerDay,
                windowMs: DAY,
              },
            ],
            now,
          ),
      },
    );
    return {
      ok: true,
      recorded: seen.outcome === 'voted' || seen.outcome === 'reset',
    };
  }

  /**
   * Общее для итога подсветки: хосты сайта (без хостов «Админки» — ТЗ §10,
   * аудит Э6-бис (б) (8)) + origin родителя, вид вёрстки по заголовкам
   * iframe (тот же браузер, что страница: элемент, скрытый мобильной
   * вёрсткой, не делает карту устаревшей для компьютера, Ш4) и хеш IP с
   * солью на окно (неделя: «разные IP за 7 дней» не обходится сменой суток;
   * суточный ipHash токена — только лимиты).
   */
  private async highlightVisitor(
    ctx: Awaited<ReturnType<WidgetSessionService['authenticate']>>,
    req: Request,
    now: Date,
  ): Promise<{
    siteHosts: string[];
    viewport: UiVisitorViewport;
    ipHash: string;
  }> {
    const hosts = await this.db.siteHost.findMany({
      where: {
        siteId: ctx.site.siteId,
        status: 'verified',
        ...PUBLIC_SITE_HOST,
      },
      select: { host: true },
    });
    const siteHosts = hosts.map((h) => h.host);
    try {
      siteHosts.push(new URL(ctx.site.parentOrigin).hostname);
    } catch {
      /* origin уже проверен гвардом */
    }
    const viewport = visitorViewport({
      userAgent: req.headers?.['user-agent'] ?? null,
      chUaMobile:
        (req.headers?.['sec-ch-ua-mobile'] as string | undefined) ?? null,
    });
    const ipHash = await uiVoteIpHash(this.db, {
      siteId: ctx.site.siteId,
      req,
      fallback: ctx.visitor.ipHash,
      now,
      env: this.env,
    });
    return { siteHosts, viewport, ipHash };
  }
}
