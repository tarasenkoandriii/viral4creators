/**
 * GET /wa/v1/frame?pk=… — HTML iframe чата сотрудника с динамическим
 * `frame-ancestors` (verified-хосты самой админки, `adminHostIds`) —
 * ТЗ §4.12, У-13. Неизвестный pk, выключенный режим или способ «только
 * TMA» — тот же HTML с `frame-ancestors 'none'` (не оракул).
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WIDGET_PK_TEST_PREFIX } from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { extraAdminAncestors } from '../../config/admin-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { adminFrameCsp, adminFrameHtml } from './admin-frame';
import { AdminSessionService } from './admin-session.service';

@Controller('wa/v1')
@PublicRoute(
  'HTML iframe чата сотрудника: встраивание решает браузер по frame-ancestors',
)
export class AdminFrameController {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly db: SitesDb,
  ) {}

  /** Origin-ы, которым можно встроить чат сотрудника этого pk. */
  async ancestorsFor(pk: string, now = new Date()): Promise<string[]> {
    const found = await this.sessions.siteByPk(pk);
    const s = found?.settings;
    if (
      !found ||
      !s ||
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both') ||
      s.adminHostIds.length === 0
    ) {
      return [];
    }
    const hosts = await this.db.forAccount(found.accountId).siteHost.findMany({
      where: { siteId: found.siteId, id: { in: s.adminHostIds } },
    });
    const out = hosts
      .filter((h) => evaluateHostAccess(h, 'assist-admin', now).ok)
      .map((h) => `https://${h.host}`);
    // Э-С Ш6: «админка» — Telegram Mini App → и Telegram Web предком.
    out.push(...extraAdminAncestors(found.siteId, out));
    if (pk.startsWith(WIDGET_PK_TEST_PREFIX)) {
      out.push('http://localhost:*', 'http://127.0.0.1:*');
    }
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
    res.setHeader('Content-Security-Policy', adminFrameCsp(ancestors));
    res.setHeader(
      'Cache-Control',
      `public, max-age=0, s-maxage=${WIDGET_DEFAULTS.frameCacheSeconds}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(adminFrameHtml());
  }
}
