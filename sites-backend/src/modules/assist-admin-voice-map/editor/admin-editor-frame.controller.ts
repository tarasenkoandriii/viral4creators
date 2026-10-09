/**
 * GET /wa/v1/editor-frame?pk=… — HTML iframe панели редактора карты
 * «Админки» (заход 11, №117) с `frame-ancestors` = verified-хосты САМОЙ
 * админки (L1 `assist-admin`, https; `pk_test_` — ещё localhost-стенд).
 * В отличие от чата сотрудника (`/wa/v1/frame`) Telegram Web предком здесь
 * не бывает: редактор открывается только поверх страницы админки. Режим
 * «Админка» выключен, способ «только TMA», неизвестный pk — тот же HTML с
 * `frame-ancestors 'none'` (не оракул). Без кэша: отзыв хоста — сразу.
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WIDGET_PK_TEST_PREFIX } from '../../../brand';
import { SitesDb } from '../../../prisma/sites-db.service';
import { adminFrameCsp } from '../../assist-admin-chat/admin-frame';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AdminVoiceMapService } from '../admin-voice-map.service';
import { adminEditorFrameHtml } from './admin-editor-frame';

@Controller('wa/v1')
@PublicRoute(
  'HTML iframe панели редактора карты «Админки»: встраивание решает браузер по frame-ancestors',
)
export class AdminEditorFrameController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly db: SitesDb,
    private readonly maps: AdminVoiceMapService,
  ) {}

  async ancestorsFor(pk: string, now = new Date()): Promise<string[]> {
    const found = await this.sessions.siteByPk(pk);
    const s = found?.settings;
    if (
      !found ||
      !s ||
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both')
    )
      return [];
    const hosts = await this.maps.adminHosts(
      this.db.forAccount(found.accountId),
      found.siteId,
      now,
    );
    const out = hosts
      .filter((h) => h.scheme === 'https')
      .map((h) =>
        h.port === 443 ? `https://${h.host}` : `https://${h.host}:${h.port}`,
      );
    if (pk.startsWith(WIDGET_PK_TEST_PREFIX))
      out.push('http://localhost:*', 'http://127.0.0.1:*');
    return out;
  }

  @Get('editor-frame')
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
    res.setHeader('Content-Security-Policy', adminFrameCsp(ancestors));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(adminEditorFrameHtml());
  }
}
