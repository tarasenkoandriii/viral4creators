/**
 * Маршруты гида «Админка» (Э-С Ш6).
 *
 * TMA (вошедший пользователь, конверт `ResponseInterceptor`):
 *   GET  /guide-assist/config     какой гид: legacy | assist (+ pk, origin)
 *   POST /guide-assist/identity   employee-JWT для `V4CAssist('identify-admin')`
 *
 * Коннектор платформы (сырой JSON, без конверта — его читает модель):
 *   GET /guide-assist/v1/openapi.json        спецификация для импорта
 *   GET /guide-assist/v1/knowledge.md        знания гида для «Админки»
 *   GET /guide-assist/v1/projects            Bearer + X-V4C-Actor
 *   GET /guide-assist/v1/projects/:id/facts  Bearer + X-V4C-Actor
 *   GET /guide-assist/v1/account             Bearer + X-V4C-Actor
 *
 * `config` открыт и анониму (ответ — `legacy`): мини-апп спрашивает его на
 * старте, и 401 на каждом анонимном заходе был бы шумом.
 */
import {
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import type { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import {
  GuideAssistDisabledError,
  GuideAssistService,
  type GuideAssistClientConfig,
} from './guide-assist.service';
import { buildGuideOpenApi, factsServerUrl } from './guide-assist-openapi';
import {
  buildGuideKnowledge,
  guideKnowledgeStamp,
} from './guide-assist-knowledge';
import {
  GuideConnectorGuard,
  type ConnectorRequest,
} from './guide-connector.guard';

/** Код отказа выдачи JWT — мини-апп по нему возвращается к старому гиду. */
export const GUIDE_ASSIST_DISABLED = 'GUIDE_ASSIST_DISABLED';

@Controller('guide-assist')
export class GuideAssistController {
  constructor(private readonly guide: GuideAssistService) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  config(
    @Req() req: TelegramIdentifiedRequest,
  ): Promise<GuideAssistClientConfig> {
    return this.guide.clientConfig(req.telegramUserId ?? null);
  }

  /**
   * POST: JWT — учётные данные, GET-ответ браузер и прокси вправе
   * кешировать. Лимит по человеку: мини-апп просит свежий токен раз в
   * ~10 мин, 30 в минуту — только дребезг или чужой скрипт.
   */
  @Post('identity')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(TelegramIdentityGuard, RateLimitGuard)
  @RateLimit([
    { name: 'guide-assist-identity', limit: 30, windowSec: 60, by: 'user' },
  ])
  async identity(
    @Req() req: IdentifiedRequest,
  ): Promise<{ jwt: string; exp: number }> {
    try {
      return await this.guide.issueIdentity(req.telegramUserId);
    } catch (e) {
      if (e instanceof GuideAssistDisabledError) {
        throw new NotFoundException({
          code: GUIDE_ASSIST_DISABLED,
          message: e.message,
        });
      }
      throw e;
    }
  }
}

/**
 * Лимит API фактов: окно на ЧЕЛОВЕКА (id из `X-V4C-Actor`, его ставит
 * `GuideConnectorGuard`) и широкое окно на адрес — все вызовы коннектора
 * идут с адресов платформы, и одно общее окно 120/мин по IP выбирал бы
 * за всех один разговорчивый сотрудник (аудит Ш6). Платформа сама держит
 * 10 сообщений/мин на сотрудника, на сообщение — до нескольких вызовов.
 */
export const GUIDE_FACTS_RATE_LIMIT = [
  { name: 'guide-facts-user', limit: 60, windowSec: 60, by: 'user' as const },
  { name: 'guide-facts', limit: 1200, windowSec: 60 },
];

function sendJson(res: Response, body: unknown): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

@Controller('guide-assist/v1')
export class GuideFactsController {
  constructor(private readonly guide: GuideAssistService) {}

  /** Спецификация без секретов. Выключенный API — 404 (не оракул ключа). */
  @Get('openapi.json')
  openapi(@Res() res: Response): void {
    const server = factsServerUrl(process.env.API_PUBLIC_URL);
    if (!this.guide.factsConfig() || !server) throw new NotFoundException();
    sendJson(res, buildGuideOpenApi(server));
  }

  /** Знания гида: описание мастера, данных пользователей нет. */
  @Get('knowledge.md')
  knowledge(@Req() req: Request, @Res() res: Response): void {
    const stamp = `"${guideKnowledgeStamp()}"`;
    res.setHeader('ETag', stamp);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === stamp) {
      res.status(304).end();
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.end(buildGuideKnowledge());
  }

  @Get('projects')
  @UseGuards(GuideConnectorGuard, RateLimitGuard)
  @RateLimit(GUIDE_FACTS_RATE_LIMIT)
  async projects(
    @Req() req: ConnectorRequest,
    @Res() res: Response,
  ): Promise<void> {
    sendJson(res, await this.guide.listProjects(req.guideUserId!));
  }

  @Get('projects/:projectId/facts')
  @UseGuards(GuideConnectorGuard, RateLimitGuard)
  @RateLimit(GUIDE_FACTS_RATE_LIMIT)
  async facts(
    @Req() req: ConnectorRequest,
    @Param('projectId') projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendJson(res, await this.guide.projectFacts(req.guideUserId!, projectId));
  }

  @Get('account')
  @UseGuards(GuideConnectorGuard, RateLimitGuard)
  @RateLimit(GUIDE_FACTS_RATE_LIMIT)
  async account(
    @Req() req: ConnectorRequest,
    @Res() res: Response,
  ): Promise<void> {
    sendJson(res, await this.guide.accountSummary(req.guideUserId!));
  }
}
