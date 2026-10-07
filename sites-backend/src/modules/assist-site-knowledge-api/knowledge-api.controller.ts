/**
 * Системный API знаний сайта — Э-С Ш5 (knowledge-api.ts, …service.ts):
 *   GET    /assist/v1/sites/:id/knowledge/site/documents
 *   PUT    /assist/v1/sites/:id/knowledge/site/documents/:key
 *   DELETE /assist/v1/sites/:id/knowledge/site/documents/:key
 * Заголовок `X-Assist-Signature` (brand.ts, как у вебхука целей).
 * @PublicRoute: подлинность — HMAC-подпись ключом интеграции сайта, не
 * initData. Тело на этом пути приходит СЫРОЙ строкой (app.setup.ts,
 * `KNOWLEDGE_API_PATH`, ≤ 128 КБ): подпись — по байтам, JSON разбирает
 * сервис ПОСЛЕ проверки подписи.
 * До подписи — общий лимит по IP `/assist/v1/sites/*` (Ш5 (11),
 * common/assist-v1-ip-limit.ts): каждый запрос здесь читает и расшифровывает
 * секрет сайта.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import { GOAL_WEBHOOK_SIGNATURE_HEADER } from '../../brand';
import { AssistV1IpLimit } from '../../common/assist-v1-ip-limit';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  KnowledgeApiService,
  type KnowledgeApiDeleteView,
  type KnowledgeApiListView,
  type KnowledgeApiPutView,
} from './knowledge-api.service';

const SIGNATURE = GOAL_WEBHOOK_SIGNATURE_HEADER.toLowerCase();

function rawOf(body: unknown): string {
  // Объект здесь — парсер настроен не так: подпись не сойдётся, это 401.
  return typeof body === 'string' ? body : '';
}

@Controller('assist/v1/sites')
@PublicRoute(
  'системный API знаний сайта: подлинность — HMAC-подпись ключом интеграции сайта',
)
@UseInterceptors(AssistV1IpLimit)
export class KnowledgeApiController {
  constructor(readonly svc: KnowledgeApiService) {}

  @Get(':id/knowledge/site/documents')
  list(
    @Param('id') siteId: string,
    @Headers(SIGNATURE) signature?: string,
  ): Promise<KnowledgeApiListView> {
    return this.svc.list({ siteId, rawBody: '', signature });
  }

  @Put(':id/knowledge/site/documents/:key')
  @HttpCode(200)
  put(
    @Param('id') siteId: string,
    @Param('key') key: string,
    @Body() body: unknown,
    @Headers(SIGNATURE) signature?: string,
  ): Promise<KnowledgeApiPutView> {
    return this.svc.put({ siteId, key, rawBody: rawOf(body), signature });
  }

  @Delete(':id/knowledge/site/documents/:key')
  @HttpCode(200)
  remove(
    @Param('id') siteId: string,
    @Param('key') key: string,
    @Headers(SIGNATURE) signature?: string,
  ): Promise<KnowledgeApiDeleteView> {
    return this.svc.remove({ siteId, key, rawBody: '', signature });
  }
}
