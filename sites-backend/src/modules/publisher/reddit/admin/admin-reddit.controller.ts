/**
 * AI Publisher, P-R-ADM — внутренний API вкладки «Reddit» Админки платформы
 * (doc/ai-publisher/reddit-manual-mvp-adapted.md §«Админка», Р-RD-ADM-1…7;
 * контракт `<scratchpad>/admin-reddit-internal-contract.md`). Зовёт ТОЛЬКО
 * backend (`admin-panel/admin-reddit.controller.ts`, оператор — его
 * `assertOperator`) с секретом `SITES_INTERNAL_SECRET`.
 *
 *   GET          /internal/admin/reddit/status
 *   POST         /internal/admin/reddit/setup
 *   GET|POST|PATCH /internal/admin/reddit/rx/<путь REDDIT_ROUTES>   (39)
 *   GET|POST|PATCH /internal/admin/reddit/cx/<путь кабинета>         (24)
 *   GET          /internal/admin/reddit/params
 *   GET          /internal/admin/reddit/params/:key/proposals
 *   POST         /internal/admin/reddit/params/:key/propose
 *   POST         /internal/admin/reddit/params/:key/decide
 *   POST         /internal/admin/reddit/import/plan   (≤ 1 МБ, dry-run)
 *   POST         /internal/admin/reddit/import/apply  (≤ 1 МБ)
 *
 * Флаг `PUBLISHER_REDDIT_ENABLED` выключен — `status` отвечает
 * `enabled:false`, остальное — 404 `PUB_NOT_FOUND` без `details`.
 * Сети нет (Р-RD-0).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../../../telegram-auth/allow-apps.decorator';
import { PubExceptionFilter } from '../../core/errors';
import { AdminRedditGuard, AdminRedditUser } from './admin-reddit.guard';
import { AdminRedditService, type AdminTarget } from './admin-reddit.service';

export const ADMIN_REDDIT_PREFIX = 'internal/admin/reddit';

type Q = Record<string, unknown>;

/** Суффикс пути после `/internal/admin/reddit/<rx|cx>/`. */
function suffixOf(req: Request, target: AdminTarget): string {
  const path = req.path ?? (req.url ?? '').split('?')[0];
  const marker = `/${ADMIN_REDDIT_PREFIX}/${target}/`;
  const i = path.indexOf(marker);
  return i === -1 ? '' : path.slice(i + marker.length);
}

@Controller(ADMIN_REDDIT_PREFIX)
@PublicRoute(
  'внутренний API Админки платформы (вкладка «Reddit»): секрет X-Sites-Internal-Secret, оператор X-Admin-Actor',
)
@UseGuards(AdminRedditGuard)
@UseFilters(PubExceptionFilter)
export class AdminRedditController {
  constructor(private readonly svc: AdminRedditService) {}

  @Get('status')
  status() {
    return this.svc.status();
  }

  @Post('setup')
  async setup(
    @AdminRedditUser() user: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.svc.assertEnabled();
    const r = await this.svc.setup(user, raw);
    res.status(r.status);
    return r.body;
  }

  // ── Раздел Reddit (rx) и студия (cx) — те же обработчики ───────────────

  private pass(
    target: AdminTarget,
    user: string,
    req: Request,
    q: Q,
    raw: unknown,
    res: Response,
  ): Promise<void> {
    return this.svc.dispatch({
      userId: user,
      target,
      method: req.method,
      path: suffixOf(req, target),
      query: q,
      body: req.method === 'GET' ? undefined : raw,
      res,
    });
  }

  @Get('rx/*path')
  rxGet(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Res() res: Response,
  ) {
    return this.pass('rx', u, req, q, undefined, res);
  }

  @Post('rx/*path')
  rxPost(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Body() raw: unknown,
    @Res() res: Response,
  ) {
    return this.pass('rx', u, req, q, raw, res);
  }

  @Patch('rx/*path')
  rxPatch(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Body() raw: unknown,
    @Res() res: Response,
  ) {
    return this.pass('rx', u, req, q, raw, res);
  }

  @Get('cx/*path')
  cxGet(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Res() res: Response,
  ) {
    return this.pass('cx', u, req, q, undefined, res);
  }

  @Post('cx/*path')
  cxPost(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Body() raw: unknown,
    @Res() res: Response,
  ) {
    return this.pass('cx', u, req, q, raw, res);
  }

  @Patch('cx/*path')
  cxPatch(
    @AdminRedditUser() u: string,
    @Req() req: Request,
    @Query() q: Q,
    @Body() raw: unknown,
    @Res() res: Response,
  ) {
    return this.pass('cx', u, req, q, raw, res);
  }

  // ── Параметры гейта reddit_publish и P-R ───────────────────────────────

  @Get('params')
  params(@AdminRedditUser() u: string) {
    return this.svc.params(u);
  }

  @Get('params/:key/proposals')
  proposals(
    @AdminRedditUser() u: string,
    @Param('key') key: string,
    @Query() q: Q,
  ) {
    return this.svc.proposals(u, key, q);
  }

  @Post('params/:key/propose')
  propose(
    @AdminRedditUser() u: string,
    @Param('key') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.svc.propose(u, key, raw, res);
  }

  @Post('params/:key/decide')
  decide(
    @AdminRedditUser() u: string,
    @Param('key') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.svc.decide(u, key, raw, res);
  }

  // ── Импорт исследования (CSV, in-process) ──────────────────────────────

  @Post('import/plan')
  @HttpCode(200)
  importPlan(@AdminRedditUser() u: string, @Body() raw: unknown) {
    return this.svc.importResearch(u, raw, false);
  }

  @Post('import/apply')
  @HttpCode(200)
  importApply(@AdminRedditUser() u: string, @Body() raw: unknown) {
    return this.svc.importResearch(u, raw, true);
  }
}
