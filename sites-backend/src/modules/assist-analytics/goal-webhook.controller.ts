/**
 * Вебхук целей сервер-сервер — A (ТЗ §5-тер.1, §5-тер.14; приёмка
 * §5-тер.16 п.4–5, п.18 «подпись чужим секретом — 401»):
 *   POST /assist/v1/sites/:id/goal-events
 *     заголовки: X-Assist-Signature (brand.ts), Idempotency-Key = orderId
 *     тело: GoalWebhookEvent (≤ 4 КБ; сырое тело нужно для подписи —
 *     express.raw на этом пути в app.setup.ts, координатор)
 *   401 SIGNATURE_INVALID (нет/старая/чужая подпись — одинаковым ответом),
 *   400 IDEMPOTENCY_KEY_REQUIRED / WEBHOOK_BODY_INVALID, 422 GOAL_ORDER_ID_INVALID,
 *   200 GoalWebhookResult.
 * @PublicRoute: подлинность — подпись секретом сайта, не initData. Основная
 * роль (секрет из assist_site_integrations). Повтор того же ключа — без
 * дубля; refunded/cancelled по учтённому orderId — обновить статус
 * (вычет в свёртке); page-событие того же заказа ≤ 30 мин — слить с
 * приоритетом verified (§5-тер.16 п.5). Лимит — 120/мин на сайт; до
 * подписи — общий лимит по IP `/assist/v1/sites/*` (Ш5 (11),
 * common/assist-v1-ip-limit.ts: каждый запрос читает секрет сайта).
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { GOAL_WEBHOOK_SIGNATURE_HEADER } from '../../brand';
import { AssistV1IpLimit } from '../../common/assist-v1-ip-limit';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import type { GoalWebhookResult } from './api-types';
import { GoalWebhookService } from './goal-webhook.service';

@Controller('assist/v1/sites')
@PublicRoute(
  'вебхук целей бэкенда заказчика: подлинность — HMAC-подпись секретом сайта',
)
@UseInterceptors(AssistV1IpLimit)
export class GoalWebhookController {
  constructor(readonly svc: GoalWebhookService) {}

  @Post(':id/goal-events')
  @HttpCode(200)
  receive(
    @Param('id') siteId: string,
    @Body() rawBody: unknown,
    @Headers(GOAL_WEBHOOK_SIGNATURE_HEADER.toLowerCase()) signature?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<GoalWebhookResult> {
    // app.setup.ts отдаёт на этом пути СЫРОЕ тело строкой (подпись — по
    // байтам); объект здесь — значит, парсер настроен не так: подпись не
    // сойдётся, это 401, а не «примем как есть».
    return this.svc.receive({
      siteId,
      rawBody: typeof rawBody === 'string' ? rawBody : '',
      signature,
      idempotencyKey,
    });
  }
}
