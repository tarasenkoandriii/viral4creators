/**
 * GET /we/v1/frame?pk=… — HTML iframe панели редактора голосовой карты с
 * динамическим `frame-ancestors` (verified-хосты «Сайта» без льготы, не
 * admin) — ТЗ §5-кватер.3 п.4. Неизвестный pk — тот же HTML с
 * `frame-ancestors 'none'` (не оракул).
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX } from '../../../brand';
import { SitesDb } from '../../../prisma/sites-db.service';
import { hostOriginOf } from '../../assist-site-setup/widget-settings.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { VoiceMapService } from '../voice-map.service';
import { editorFrameCsp, editorFrameHtml } from './editor-frame';

const PK_BODY = /^[0-9A-Za-z]{8,64}$/;

@Controller('we/v1')
@PublicRoute(
  'HTML iframe панели редактора голосовой карты: встраивание решает браузер по frame-ancestors',
)
export class EditorFrameController {
  constructor(
    private readonly db: SitesDb,
    private readonly maps: VoiceMapService,
  ) {}

  async ancestorsFor(pk: string, now = new Date()): Promise<string[]> {
    const prefix = [WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX].find((p) =>
      pk.startsWith(p),
    );
    if (!prefix || !PK_BODY.test(pk.slice(prefix.length))) return [];
    const site = await this.db
      .system(
        'панель редактора: сайт по публичному ключу (кабинета в запросе нет)',
      )
      .assistSite.findFirst({
        where: { OR: [{ publicKey: pk }, { testKey: pk }] },
        select: { siteId: true, accountId: true },
      });
    if (!site) return [];
    const hosts = await this.maps.siteHosts(
      this.db.forAccount(site.accountId),
      site.siteId,
      now,
    );
    const out = hosts.filter((h) => h.scheme === 'https').map(hostOriginOf);
    if (pk.startsWith(WIDGET_PK_TEST_PREFIX))
      out.push('http://localhost:*', 'http://127.0.0.1:*');
    return out;
  }

  @Get('frame')
  async frame(
    @Query('pk') pk: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let ancestors: string[] = [];
    try {
      ancestors = await this.ancestorsFor(typeof pk === 'string' ? pk : '');
    } catch {
      ancestors = [];
    }
    res.status(200);
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', editorFrameCsp(ancestors));
    // Не кэшировать: отзыв хоста — сразу (редактор меняет поведение для всех).
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(editorFrameHtml());
  }
}
