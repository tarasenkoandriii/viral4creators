/**
 * Вкладка «Reddit» админки платформы (пакет P-R-ADM, Р-RD-ADM-1…5):
 * мост Админка → генератор → внутренний API sites-backend
 * `/internal/admin/reddit/*` (`AdminRedditClient`). Здесь — только вход
 * оператора (`AdminSessionGuard` + `assertOperator`; актор = его userId) и
 * форма запроса; продукт (платформенный), роли, правила Reddit, журнал и
 * аудит — на стороне sites-backend.
 *
 * Маршруты — ровно таблица `ADMIN_REDDIT_ROUTES` (1:1 к внутренним, тот же
 * метод и путь после `admin/reddit/`): каждый объявлен здесь явно, никакого
 * `*`. Статус ответа (200/201) — как у sites-backend; ответы не кешируются.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from './admin-panel.service';
import { AdminRedditCall, AdminRedditClient } from './admin-reddit.client';
import type { AdminRedditRouteName } from './admin-reddit.routes';

type Query_ = Record<string, unknown>;

/** Заголовки CSV-выгрузки, которые видит скрипт Админки (CORS). */
export const CSV_EXPOSED_HEADERS = 'Content-Disposition, X-Next-Before';

@Controller('admin/reddit')
@UseGuards(AdminSessionGuard)
export class AdminRedditController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly client: AdminRedditClient,
  ) {}

  /** Сначала оператор — до sites-backend не оператор не доходит. */
  private async fwd(
    req: AdminAuthenticatedRequest,
    res: Response,
    name: AdminRedditRouteName,
    call: AdminRedditCall,
  ): Promise<unknown> {
    await this.adminPanel.assertOperator(req.userId);
    const out = await this.client.call(name, req.userId, call);
    res.status(out.status);
    res.setHeader('Cache-Control', 'no-store');
    return out.data;
  }

  /**
   * Списки с выгрузкой (`?format=csv`): ответ пишется здесь же — CSV файлом
   * (`ResponseInterceptor` обернул бы строку в конверт), JSON — тем же
   * конвертом, что у интерцептора. Ошибки — исключениями, как везде.
   * Следующая часть файла — тот же запрос с `?before=<X-Next-Before>`.
   */
  private async send(
    req: AdminAuthenticatedRequest,
    res: Response,
    name: AdminRedditRouteName,
    call: AdminRedditCall,
  ): Promise<void> {
    await this.adminPanel.assertOperator(req.userId);
    const out = await this.client.call(name, req.userId, call);
    res.status(out.status);
    res.setHeader('Cache-Control', 'no-store');
    if (out.csv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${out.csv.filename}"`,
      );
      // Админка — другой origin: без этого браузер не отдаст скрипту имя
      // файла и курсор следующей части (склейка > 5000 строк). Только на
      // CSV-ответах этого контроллера — общий CORS не тронут.
      res.setHeader('Access-Control-Expose-Headers', CSV_EXPOSED_HEADERS);
      if (out.csv.nextBefore) {
        res.setHeader('X-Next-Before', out.csv.nextBefore);
      }
      res.send(out.csv.text);
      return;
    }
    res.json({
      success: true,
      data: out.data,
      meta: { timestamp: new Date().toISOString(), requestId: uuidv4() },
    });
  }

  @Get('status')
  status(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'status', {});
  }

  @Post('setup')
  setup(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'setup', { body });
  }

  @Get('params')
  listParams(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listParams', {});
  }

  @Get('params/:key/proposals')
  listProposals(
    @Req() req: AdminAuthenticatedRequest,
    @Param('key') key: string,
    @Query() query: Query_,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listProposals', { params: { key }, query });
  }

  @Post('params/:key/propose')
  proposeParam(
    @Req() req: AdminAuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'proposeParam', { params: { key }, body });
  }

  @Post('params/:key/decide')
  decideParam(
    @Req() req: AdminAuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'decideParam', { params: { key }, body });
  }

  @Post('import/plan')
  importPlan(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'importPlan', { body });
  }

  @Post('import/apply')
  importApply(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'importApply', { body });
  }

  @Get('rx/projects')
  listProjects(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listProjects', { query });
  }

  @Post('rx/projects')
  createProject(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createProject', { body });
  }

  @Get('rx/projects/:id')
  getProject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getProject', { params: { id } });
  }

  @Patch('rx/projects/:id')
  patchProject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchProject', { params: { id }, body });
  }

  @Post('rx/projects/:id/archive')
  archiveProject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'archiveProject', { params: { id }, body });
  }

  @Get('rx/communities')
  listCommunities(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listCommunities', { query });
  }

  @Post('rx/communities')
  createCommunity(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createCommunity', { body });
  }

  @Get('rx/communities/:id')
  getCommunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getCommunity', { params: { id } });
  }

  @Patch('rx/communities/:id')
  patchCommunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchCommunity', { params: { id }, body });
  }

  @Get('rx/communities/:id/rules')
  listRules(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listRules', { params: { id } });
  }

  @Post('rx/communities/:id/rules')
  createRules(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createRules', { params: { id }, body });
  }

  @Get('rx/communities/:id/rules/:sid/source')
  getRulesSource(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getRulesSource', { params: { id, sid } });
  }

  @Post('rx/rules/:id/review')
  reviewRules(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'reviewRules', { params: { id }, body });
  }

  @Get('rx/opportunities')
  listOpportunities(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listOpportunities', { query });
  }

  @Post('rx/opportunities')
  createOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createOpportunity', { body });
  }

  @Get('rx/opportunities/:id')
  getOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getOpportunity', { params: { id } });
  }

  @Get('rx/opportunities/:id/excerpts')
  listOpportunityExcerpts(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listOpportunityExcerpts', { params: { id } });
  }

  @Patch('rx/opportunities/:id')
  patchOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchOpportunity', { params: { id }, body });
  }

  @Post('rx/opportunities/:id/score')
  scoreOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'scoreOpportunity', { params: { id }, body });
  }

  @Post('rx/opportunities/:id/qualify')
  qualifyOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'qualifyOpportunity', { params: { id }, body });
  }

  @Post('rx/opportunities/:id/skip')
  skipOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'skipOpportunity', { params: { id }, body });
  }

  @Post('rx/opportunities/:id/archive')
  archiveOpportunity(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'archiveOpportunity', { params: { id }, body });
  }

  @Get('rx/keywords')
  listKeywords(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listKeywords', { query });
  }

  @Post('rx/keywords')
  createKeyword(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createKeyword', { body });
  }

  @Patch('rx/keywords/:id')
  patchKeyword(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchKeyword', { params: { id }, body });
  }

  @Get('rx/briefs')
  listBriefs(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listBriefs', { query });
  }

  @Post('rx/briefs')
  createBrief(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createBrief', { body });
  }

  @Get('rx/briefs/:id')
  getBrief(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getBrief', { params: { id } });
  }

  @Patch('rx/briefs/:id')
  patchBrief(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchBrief', { params: { id }, body });
  }

  @Post('rx/briefs/:id/ready')
  briefReady(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'briefReady', { params: { id }, body });
  }

  @Post('rx/briefs/:id/archive')
  archiveBrief(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'archiveBrief', { params: { id }, body });
  }

  @Post('rx/briefs/:id/generate')
  generateDraft(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'generateDraft', { params: { id }, body });
  }

  @Get('rx/briefs/:id/contents')
  listBriefContents(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listBriefContents', { params: { id } });
  }

  @Post('rx/briefs/:id/contents')
  createContent(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createContent', { params: { id }, body });
  }

  @Get('rx/contents/:cid')
  getContent(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getContent', { params: { cid } });
  }

  @Post('rx/contents/:cid/check')
  checkContent(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'checkContent', { params: { cid }, body });
  }

  @Post('rx/contents/:cid/copy')
  copyContent(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'copyContent', { params: { cid }, body });
  }

  @Post('rx/contents/:cid/report-publication')
  reportPublication(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'reportPublication', { params: { cid }, body });
  }

  @Get('rx/publications')
  listPublications(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listPublications', { query });
  }

  @Get('cx/contents/:cid/versions')
  listVersions(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listVersions', { params: { cid } });
  }

  @Get('cx/contents/:cid/versions/:vid')
  getVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getVersion', { params: { cid, vid } });
  }

  @Post('cx/contents/:cid/versions')
  createVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createVersion', { params: { cid }, body });
  }

  @Patch('cx/contents/:cid/versions/:vid')
  patchVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'patchVersion', { params: { cid, vid }, body });
  }

  @Post('cx/contents/:cid/versions/:vid/submit')
  submitVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'submitVersion', { params: { cid, vid }, body });
  }

  @Get('cx/contents/:cid/versions/:a/diff/:b')
  diffVersions(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Param('a') a: string,
    @Param('b') b: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'diffVersions', { params: { cid, a, b } });
  }

  @Post('cx/contents/:cid/transition')
  transitionContent(
    @Req() req: AdminAuthenticatedRequest,
    @Param('cid') cid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'transitionContent', { params: { cid }, body });
  }

  @Get('cx/versions/:vid/qa-checks')
  listQaChecks(
    @Req() req: AdminAuthenticatedRequest,
    @Param('vid') vid: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listQaChecks', { params: { vid } });
  }

  @Post('cx/versions/:vid/qa-checks')
  qaCheck(
    @Req() req: AdminAuthenticatedRequest,
    @Param('vid') vid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'qaCheck', { params: { vid }, body });
  }

  @Post('cx/versions/:vid/approve')
  approveVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('vid') vid: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'approveVersion', { params: { vid }, body });
  }

  @Post('cx/approvals/:id/revoke')
  revokeApproval(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'revokeApproval', { params: { id }, body });
  }

  @Get('cx/sources')
  listSources(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listSources', { query });
  }

  @Post('cx/sources')
  createSource(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createSource', { body });
  }

  @Post('cx/sources/:id/revoke')
  revokeSource(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'revokeSource', { params: { id }, body });
  }

  @Get('cx/offers')
  listOffers(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'listOffers', { query });
  }

  @Post('cx/offers')
  createOffer(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createOffer', { body });
  }

  @Post('cx/offers/:id/activate')
  activateOffer(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'activateOffer', { params: { id }, body });
  }

  @Get('cx/brand-facts')
  listBrandFacts(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: Query_,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(req, res, 'listBrandFacts', { query });
  }

  @Post('cx/brand-facts')
  createBrandFact(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'createBrandFact', { body });
  }

  @Post('cx/brand-facts/:id/activate')
  activateBrandFact(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'activateBrandFact', { params: { id }, body });
  }

  @Post('cx/brand-facts/:id/resolve')
  resolveBrandFact(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'resolveBrandFact', { params: { id }, body });
  }

  @Post('cx/brand-facts/:id/retire')
  retireBrandFact(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'retireBrandFact', { params: { id }, body });
  }

  @Post('cx/publications/:id/transition')
  transitionPublication(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'transitionPublication', {
      params: { id },
      body,
    });
  }

  @Get('cx/ai/calls/:callId')
  getAiCall(
    @Req() req: AdminAuthenticatedRequest,
    @Param('callId') callId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.fwd(req, res, 'getAiCall', { params: { callId } });
  }
}
