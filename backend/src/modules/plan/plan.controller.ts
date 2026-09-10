/**
 *   GET   /api/me/plan    текущий режим + матрица возможностей
 *   PATCH /api/me/plan    сменить режим (пока бесплатно и самостоятельно)
 *
 * GET намеренно ОТКРЫТ, гвард стоит только на PATCH. Причина: матрица
 * возможностей не секрет, а анонимный путь (обычный браузер без входа)
 * обязан рисовать те же замки, что и вошедший пользователь. Требуй GET
 * идентичность — анонимный интерфейс не знал бы ни своего режима, ни
 * границ пакетов и показывал бы кнопки, которые сервер потом запретит.
 * Без идентичности ответ честный: Lite (`planOfUser(undefined)`).
 *
 * Сменить режим анонимно нельзя: режим живёт на строке пользователя,
 * записывать его некуда.
 */

import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import { PlanService } from './plan.service';
import { PlanId, PLAN_IDS, PLANS } from '../../common/plans';
import { localeFromRequest } from '../../common/locale';

export class SetPlanRequestDto {
  @IsIn(PLAN_IDS as unknown as string[])
  plan!: PlanId;
}

export interface PlanStateView {
  plan: PlanId;
  /** Полная матрица — интерфейс рисует замки из неё, а не из своих копий. */
  plans: typeof PLANS;
  /** Пока false — переключение бесплатное и мгновенное. */
  billingEnabled: boolean;
  /**
   * Блокировка (§25.3) — чтобы интерфейс сказал об этом спокойно и
   * заранее, а не красной ошибкой в ответ на нажатие кнопки.
   */
  blocked: { isBlocked: boolean; reason: string | null };
  /**
   * Дневной лимит (§26.4) БЕЗ сумм: наружу уходят только два признака.
   * Показывать пользователю «вы потратили $1.20 из $2.00» значит
   * объяснять внутреннюю кухню вместо ответа на его вопрос — тем более
   * что все режимы сейчас бесплатны.
   */
  budget: { exhausted: boolean; nearlyExhausted: boolean };
  /** Этап 62 (ТЗ §41.4): активная подписка, если есть. null — Lite или
   * без покупок; у анонимного пути — всегда null. */
  subscription: {
    plan: PlanId;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
  /** Этап 62: баланс купленных кредитов на генерацию. У анонимного пути
   * — всегда 0 (кредиты требуют identity, см. CreditLedgerService). */
  credits: { balance: number };
}

@Controller('me/plan')
export class PlanController {
  constructor(private readonly service: PlanService) {}

  @Get()
  async get(@Req() req: TelegramIdentifiedRequest): Promise<PlanStateView> {
    return this.service.stateOf(
      req.telegramUserId ?? null,
      localeFromRequest(req),
    );
  }

  @Patch()
  @UseGuards(TelegramIdentityGuard)
  async set(
    @Req() req: IdentifiedRequest,
    @Body() dto: SetPlanRequestDto,
  ): Promise<PlanStateView> {
    await this.service.setPlan(req.telegramUserId, dto.plan);
    return this.service.stateOf(req.telegramUserId, localeFromRequest(req));
  }
}
