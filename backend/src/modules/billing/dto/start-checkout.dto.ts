/**
 * Тело запросов старта оплаты (ТЗ §41.2, этап 62). `class-validator`,
 * тот же приём, что `SetPlanRequestDto` (`plan/plan.controller.ts`).
 */

import { IsIn, IsString } from 'class-validator';
import { PlanId } from '../../../common/plans';
import { PaymentMethodValue } from '../billing.types';

const PAYMENT_METHODS: PaymentMethodValue[] = ['STARS', 'WAYFORPAY'];
/** LITE не продаётся — это бесплатный дефолт, не тариф (§41, решение 4). */
const PAID_PLANS: Array<Extract<PlanId, 'STANDARD' | 'PREMIUM'>> = [
  'STANDARD',
  'PREMIUM',
];

export class StartSubscriptionCheckoutDto {
  @IsIn(PAID_PLANS as unknown as string[])
  plan!: 'STANDARD' | 'PREMIUM';

  @IsIn(PAYMENT_METHODS as unknown as string[])
  method!: PaymentMethodValue;
}

export class StartCreditPackCheckoutDto {
  @IsString()
  packId!: string;

  @IsIn(PAYMENT_METHODS as unknown as string[])
  method!: PaymentMethodValue;
}
