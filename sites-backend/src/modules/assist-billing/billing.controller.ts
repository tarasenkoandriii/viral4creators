/**
 * Кабинет «Тариф и оплата» (Э4; ТЗ §3.10, §4.16 `GET /assist/billing/plans`,
 * `POST /assist/billing/checkout`):
 *   GET   /assist/billing                 сводка (все участники; платежи — владельцу)
 *   POST  /assist/billing/legal           { accept: ['terms','dpa'], evalConsent? } (владелец)
 *   POST  /assist/billing/checkout        { kind, planId|packs, method } (владелец)
 *   GET   /assist/billing/payments/:id    статус платежа после возврата (владелец)
 *   PATCH /assist/billing/auto-topup      { enabled, capUsd } (владелец)
 *   POST  /assist/billing/cancel          { cancel: boolean } (владелец)
 * Вебхук WayForPay — billing-webhook.controller.ts; Stars — вебхук бота
 * Помощника (telegram-webhook → AssistPayments.handleTelegramUpdate).
 *
 * Тело — не DTO: форма маленькая и строгая, лишнее поле — 400.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireAccountRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import type {
  AutoTopUpRequest,
  BillingOverview,
  CheckoutRequest,
  CheckoutResult,
  LegalAcceptRequest,
  PaymentStatusView,
} from './api-types';
import { AssistBilling, billingError } from './billing.service';
import { TOPUP_MAX_PACKS, isPaidPlanId } from './plans';

type Obj = Record<string, unknown>;

function bad(message: string) {
  return billingError('BILLING_INVALID', message, HttpStatus.BAD_REQUEST);
}

function objectOf(body: unknown, keys: readonly string[]): Obj {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Ожидается JSON-объект');
  }
  const o = body as Obj;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw bad(`Лишнее поле «${k}»`);
  }
  return o;
}

export function parseCheckout(body: unknown): CheckoutRequest {
  const o = objectOf(body, ['kind', 'planId', 'packs', 'method']);
  if (o.method !== 'stars' && o.method !== 'wayforpay') {
    throw bad('method: stars | wayforpay');
  }
  if (o.kind === 'subscription') {
    if (o.packs !== undefined) throw bad('packs — только для докупки');
    if (!isPaidPlanId(o.planId)) {
      throw billingError(
        'PLAN_INVALID',
        'Тариф: start | business | pro',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { kind: 'subscription', planId: o.planId, method: o.method };
  }
  if (o.kind === 'topup') {
    if (o.planId !== undefined) throw bad('planId — только для тарифа');
    const packs = o.packs;
    if (
      typeof packs !== 'number' ||
      !Number.isInteger(packs) ||
      packs < 1 ||
      packs > TOPUP_MAX_PACKS
    ) {
      throw bad(`packs — целое от 1 до ${TOPUP_MAX_PACKS}`);
    }
    return { kind: 'topup', packs, method: o.method };
  }
  throw bad('kind: subscription | topup');
}

export function parseLegal(body: unknown): LegalAcceptRequest {
  const o = objectOf(body, ['accept', 'evalConsent']);
  const accept = o.accept;
  if (
    !Array.isArray(accept) ||
    accept.length > 2 ||
    !accept.every((d) => d === 'terms' || d === 'dpa') ||
    new Set(accept).size !== accept.length
  ) {
    throw bad("accept: массив из 'terms' и/или 'dpa'");
  }
  if (o.evalConsent !== undefined && typeof o.evalConsent !== 'boolean') {
    throw bad('evalConsent — boolean');
  }
  return {
    accept: accept as Array<'terms' | 'dpa'>,
    evalConsent: o.evalConsent as boolean | undefined,
  };
}

export function parseAutoTopUp(body: unknown): AutoTopUpRequest {
  const o = objectOf(body, ['enabled', 'capUsd']);
  if (typeof o.enabled !== 'boolean') throw bad('enabled — boolean');
  if (
    typeof o.capUsd !== 'number' ||
    !Number.isFinite(o.capUsd) ||
    o.capUsd < 0
  ) {
    throw bad('capUsd — число ≥ 0');
  }
  return { enabled: o.enabled, capUsd: o.capUsd };
}

@Controller('assist/billing')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
export class AssistBillingController {
  constructor(private readonly billing: AssistBilling) {}

  @Get()
  overview(@Membership() m: AccountMembership): Promise<BillingOverview> {
    return this.billing.overview(m);
  }

  @Post('legal')
  @HttpCode(200)
  @RequireAccountRoles('owner')
  legal(
    @Membership() m: AccountMembership,
    @Body() body: unknown,
  ): Promise<BillingOverview['legal']> {
    return this.billing.acceptLegal(m, parseLegal(body));
  }

  @Post('checkout')
  @HttpCode(200)
  @RequireAccountRoles('owner')
  checkout(
    @Membership() m: AccountMembership,
    @Body() body: unknown,
  ): Promise<CheckoutResult> {
    return this.billing.checkout(m, parseCheckout(body));
  }

  @Get('payments/:id')
  @RequireAccountRoles('owner')
  payment(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
  ): Promise<PaymentStatusView> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw bad('id платежа');
    return this.billing.payment(m, id);
  }

  @Patch('auto-topup')
  @RequireAccountRoles('owner')
  autoTopUp(
    @Membership() m: AccountMembership,
    @Body() body: unknown,
  ): Promise<BillingOverview> {
    return this.billing.setAutoTopUp(m, parseAutoTopUp(body));
  }

  @Post('cancel')
  @HttpCode(200)
  @RequireAccountRoles('owner')
  cancel(
    @Membership() m: AccountMembership,
    @Body() body: unknown,
  ): Promise<BillingOverview> {
    const o = objectOf(body, ['cancel']);
    if (typeof o.cancel !== 'boolean') throw bad('cancel — boolean');
    return this.billing.setCancel(m, o.cancel);
  }
}
