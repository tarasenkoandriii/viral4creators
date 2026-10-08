/**
 * Крон `assist-billing-tick` (каждые 10 минут; ТЗ §3.10, §7.1; механика —
 * `billing-renewal` генератора): по шагам, каждый — своим условным UPDATE,
 * повтор тика ничего не удваивает.
 *
 *  1. Пробный: кабинетам с помощником без строки подписки — строка `trial`
 *     от первого сайта (удаление сайтов больше не перезапускает пробный).
 *  2. Просроченные счета: pending старше срока ссылки — expired (оплата
 *     после этого всё равно применится: деньги получены — колбэк ищет и
 *     expired, см. AssistPayments).
 *  3. Продление WayForPay по recToken (claim-before-charge, Г-2.7):
 *     захват строки подписки по СНИМКУ paidThrough, детерминированный
 *     orderReference `ren_<кабинет>_<paidThrough>_<попытка>` и строка
 *     pending ДО списания; отказ — попытка через сутки, пока идёт льгота.
 *     Stars продлевает сам Telegram (автопродление — колбэк).
 *  4. Истечение: после paidThrough (и льготы для автопродляемых) — expired,
 *     уведомление владельцу; виджет — форма заявки (мягкий стоп).
 *  5. Автодокупка: занят авто-пакет сверх лимита — списать его по recToken
 *     (`atu_<кабинет>_<период>_<n>`); не прошло — автодокупка выключается.
 *  6. Предупреждения 80% и 100% периода — один раз (условный UPDATE отметки).
 *
 * `scope.accountIds` — только тестам на общей базе (свои кабинеты).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { openPaymentToken, paymentRates, wayforpayConfig } from './billing-env';
import { BillingNotices } from './billing-notices';
import { chargeId } from './ids';
import { AssistPayments } from './payments.service';
import {
  ASSIST_PLANS,
  MICRO,
  TOPUP_PACK_UNITS,
  isPaidPlanId,
  planPrice,
  topupPrice,
} from './plans';
import { AssistPaymentProviders, CHARGE_STATUS_UNKNOWN } from './providers';
import { readState, readUsage } from './public/entitlements';
import { GRACE_MS, unitsLimit } from './subscription-state';

const DAY = 24 * 60 * 60 * 1000;
/** Повтор неудачного продления — не чаще раза в сутки (как крон генератора). */
const RENEW_RETRY_MS = DAY;
const BATCH = 50;

export interface BillingTickScope {
  accountIds: string[];
}

export interface BillingTickResult {
  trials: number;
  expiredPayments: number;
  renewed: number;
  renewFailed: number;
  expired: number;
  autoTopUps: number;
  notices: number;
}

@Injectable()
export class AssistBillingTick {
  private readonly logger = new Logger(AssistBillingTick.name);
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: AssistPayments,
    private readonly providers: AssistPaymentProviders,
    @Optional() private readonly notices?: BillingNotices,
  ) {}

  async run(scope?: BillingTickScope): Promise<BillingTickResult> {
    const out: BillingTickResult = {
      trials: await this.materializeTrials(scope),
      expiredPayments: await this.expirePayments(scope),
      renewed: 0,
      renewFailed: 0,
      expired: 0,
      autoTopUps: 0,
      notices: 0,
    };
    const r = await this.renewWayForPay(scope);
    out.renewed = r.renewed;
    out.renewFailed = r.failed;
    out.expired = await this.expireSubscriptions(scope);
    out.autoTopUps = await this.autoTopUps(scope);
    out.notices = await this.usageNotices(scope);
    return out;
  }

  private scopeSql(
    scope: BillingTickScope | undefined,
    col: string,
    n: number,
  ) {
    return scope ? ` AND ${col} = ANY($${n}::text[])` : '';
  }

  async materializeTrials(scope?: BillingTickScope): Promise<number> {
    const trial = ASSIST_PLANS.trial;
    return this.prisma.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_subscriptions"
         ("accountId", "planId", "status", "method", "anchorAt", "paidThrough", "updatedAt")
       SELECT a."accountId", 'trial', 'active', 'trial', min(a."createdAt"),
              min(a."createdAt") + ($1::int * interval '1 day'), now()
         FROM "sites"."assist_sites" a
        WHERE NOT EXISTS (SELECT 1 FROM "sites"."assist_subscriptions" s WHERE s."accountId" = a."accountId")
          ${this.scopeSql(scope, 'a."accountId"', 2)}
        GROUP BY a."accountId"
       ON CONFLICT DO NOTHING`,
      trial.periodDays,
      ...(scope ? [scope.accountIds] : []),
    );
  }

  async expirePayments(scope?: BillingTickScope): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_payments" SET "status" = 'expired', "updatedAt" = now()
        WHERE "status" = 'pending' AND "expiresAt" IS NOT NULL AND "expiresAt" < $1
          AND "kind" IN ('subscription', 'topup')
          ${this.scopeSql(scope, '"accountId"', 2)}`,
      this.now(),
      ...(scope ? [scope.accountIds] : []),
    );
  }

  /** №60: любая версия ключа связки `ASSIST_SECRETS_KEY`. */
  private recToken(enc: string | null): string | null {
    return openPaymentToken(enc, this.env)?.value ?? null;
  }

  async renewWayForPay(
    scope?: BillingTickScope,
  ): Promise<{ renewed: number; failed: number }> {
    const cfg = wayforpayConfig(this.env);
    const res = { renewed: 0, failed: 0 };
    if (!cfg) return res;
    const now = this.now();
    const due = await this.prisma.assistSubscription.findMany({
      where: {
        method: 'wayforpay',
        status: 'active',
        cancelAtPeriodEnd: false,
        recTokenEnc: { not: null },
        paidThrough: { lte: now, gt: new Date(now.getTime() - GRACE_MS) },
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      take: BATCH,
      orderBy: { paidThrough: 'asc' },
    });
    const rates = paymentRates(this.env);
    for (const sub of due) {
      if (!isPaidPlanId(sub.planId)) continue;
      // Захват по СНИМКУ paidThrough: второй тик/инстанс отступает.
      const claimed = await this.prisma.assistSubscription.updateMany({
        where: {
          accountId: sub.accountId,
          paidThrough: sub.paidThrough,
          OR: [
            { renewClaimedAt: null },
            {
              renewClaimedAt: { lt: new Date(now.getTime() - RENEW_RETRY_MS) },
            },
          ],
        },
        data: { renewClaimedAt: now },
      });
      if (claimed.count !== 1) continue;
      const token = this.recToken(sub.recTokenEnc);
      if (!token) {
        res.failed++;
        await this.prisma.assistSubscription.updateMany({
          where: { accountId: sub.accountId },
          data: {
            lastRenewError: 'recToken не расшифрован',
            renewAttempts: { increment: 1 },
          },
        });
        continue;
      }
      const price = planPrice(sub.planId, rates);
      const id = chargeId(
        'ren',
        sub.accountId,
        sub.paidThrough.getTime(),
        sub.renewAttempts + 1,
      );
      await this.prisma.assistPayment.createMany({
        data: [
          {
            id,
            accountId: sub.accountId,
            kind: 'renewal',
            planId: sub.planId,
            method: 'wayforpay',
            status: 'pending',
            currency: 'UAH',
            amountMinor: price.uahMinor,
            amountMicroUsd: BigInt(Math.round(price.usd * MICRO)),
          },
        ],
        skipDuplicates: true,
      });
      const existing = await this.prisma.assistPayment.findUnique({
        where: { id },
        select: { status: true },
      });
      if (existing?.status !== 'pending') continue; // уже применён/отказан
      let outcome: 'applied' | 'failed' | 'pending' | 'duplicate';
      try {
        const r = await this.providers.charge(
          cfg,
          {
            recToken: token,
            orderReference: id,
            amountMinor: price.uahMinor,
            currency: 'UAH',
            productName: `Помощник ${sub.planId} — продление 30 дней`,
          },
          now,
        );
        outcome = await this.payments.settleCharge(id, {
          ok: r.ok,
          status: r.transactionStatus,
          reason: `${r.transactionStatus} (${r.reasonCode})`,
          raw: r.rawPayload,
          recToken: r.recToken,
        });
      } catch (e) {
        // Сеть: статус неизвестен — строка pending, тот же orderReference
        // при повторе (WayForPay не спишет дважды по одному orderReference).
        this.logger.warn(`продление ${sub.accountId}: ${(e as Error).name}`);
        outcome = 'pending';
      }
      if (outcome === 'applied' || outcome === 'duplicate') {
        res.renewed++;
      } else if (outcome === 'failed') {
        res.failed++;
        await this.prisma.assistSubscription.updateMany({
          where: { accountId: sub.accountId },
          data: {
            renewAttempts: { increment: 1 },
            lastRenewError: 'отказ банка',
          },
        });
        await this.notices
          ?.usage(sub.accountId, 'renew_failed')
          .catch(() => undefined);
      }
    }
    return res;
  }

  async expireSubscriptions(scope?: BillingTickScope): Promise<number> {
    const now = this.now();
    const candidates = await this.prisma.assistSubscription.findMany({
      where: {
        status: 'active',
        paidThrough: { lte: now },
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      select: {
        accountId: true,
        paidThrough: true,
        method: true,
        cancelAtPeriodEnd: true,
      },
      take: BATCH * 4,
    });
    let n = 0;
    for (const s of candidates) {
      const renews =
        (s.method === 'stars' || s.method === 'wayforpay') &&
        !s.cancelAtPeriodEnd;
      if (renews && now.getTime() < s.paidThrough.getTime() + GRACE_MS)
        continue;
      const done = await this.prisma.assistSubscription.updateMany({
        where: {
          accountId: s.accountId,
          status: 'active',
          paidThrough: s.paidThrough,
        },
        data: { status: 'expired', autoTopUp: false },
      });
      if (done.count === 1) {
        n++;
        await this.notices
          ?.usage(s.accountId, 'expired')
          .catch(() => undefined);
      }
    }
    return n;
  }

  async autoTopUps(scope?: BillingTickScope): Promise<number> {
    const cfg = wayforpayConfig(this.env);
    if (!cfg) return 0;
    const now = this.now();
    const subs = await this.prisma.assistSubscription.findMany({
      where: {
        autoTopUp: true,
        method: 'wayforpay',
        status: 'active',
        recTokenEnc: { not: null },
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      take: BATCH,
    });
    const rates = paymentRates(this.env);
    let n = 0;
    for (const sub of subs) {
      const state = await readState(this.prisma, sub.accountId, now);
      if (!state.planId || !state.periodKey || !state.periodStart) continue;
      const usage = await readUsage(
        this.prisma,
        sub.accountId,
        state.periodKey,
      );
      // Авто-пакет занят: единиц больше, чем тариф + уже оплаченная докупка.
      if (usage.units <= unitsLimit(state, usage.extraUnits)) continue;
      const price = topupPrice(state.planId, 1, rates);
      const token = this.recToken(sub.recTokenEnc);
      if (!price || !token) continue;
      const id = chargeId(
        'atu',
        sub.accountId,
        state.periodStart.getTime(),
        usage.autoPacks + 1,
      );
      await this.prisma.assistPayment.createMany({
        data: [
          {
            id,
            accountId: sub.accountId,
            kind: 'auto_topup',
            planId: state.planId,
            units: TOPUP_PACK_UNITS,
            method: 'wayforpay',
            status: 'pending',
            currency: 'UAH',
            amountMinor: price.uahMinor,
            amountMicroUsd: BigInt(Math.round(price.usd * MICRO)),
            periodKey: state.periodKey,
          },
        ],
        skipDuplicates: true,
      });
      const row = await this.prisma.assistPayment.findUnique({
        where: { id },
        select: { status: true },
      });
      if (row?.status !== 'pending') continue;
      let outcome: 'applied' | 'failed' | 'pending' | 'duplicate' = 'pending';
      let unknown = false;
      try {
        const r = await this.providers.charge(
          cfg,
          {
            recToken: token,
            orderReference: id,
            amountMinor: price.uahMinor,
            currency: 'UAH',
            productName: `Помощник: +${TOPUP_PACK_UNITS} диалогов`,
          },
          now,
        );
        unknown = r.transactionStatus === CHARGE_STATUS_UNKNOWN;
        outcome = await this.payments.settleCharge(id, {
          ok: r.ok,
          status: r.transactionStatus,
          reason: `${r.transactionStatus} (${r.reasonCode})`,
          raw: r.rawPayload,
          recToken: r.recToken,
        });
      } catch (e) {
        this.logger.warn(`автодокупка ${sub.accountId}: ${(e as Error).name}`);
      }
      if (outcome === 'applied') n++;
      // Аудит Э4: исход списания неизвестен (ответ без transactionStatus —
      // providers.charge): платёж остаётся pending (поздний Approved-вебхук
      // его применит), но следующий пакет не открывается и повторов того же
      // CHARGE каждые 10 минут нет — как при отказе.
      if (outcome === 'failed' || (outcome === 'pending' && unknown)) {
        // Следующий пакет не открывается: риск — не больше одного пакета.
        await this.prisma.assistSubscription.updateMany({
          where: { accountId: sub.accountId },
          data: { autoTopUp: false },
        });
        await this.notices
          ?.usage(sub.accountId, 'autotopup_failed')
          .catch(() => undefined);
      }
    }
    return n;
  }

  /**
   * Отметка «предупреждение отправлено» — условным UPDATE: два прохода
   * (крон + ручной вызов) не отправят одно предупреждение дважды.
   */
  async claimNotice(
    accountId: string,
    periodKey: string,
    kind: 'warn80' | 'warn100',
    now: Date,
  ): Promise<boolean> {
    const col = kind === 'warn100' ? 'warned100At' : 'warned80At';
    const won = await this.prisma.assistAccountUsage.updateMany({
      where: { accountId, periodKey, [col]: null },
      data: kind === 'warn100' ? { warned100At: now } : { warned80At: now },
    });
    if (won.count === 1 && kind === 'warn100') {
      // 100% покрывает 80%: после «исчерпан» — не слать «80%».
      await this.prisma.assistAccountUsage.updateMany({
        where: { accountId, periodKey, warned80At: null },
        data: { warned80At: now },
      });
    }
    return won.count === 1;
  }

  async usageNotices(scope?: BillingTickScope): Promise<number> {
    const now = this.now();
    const rows = await this.prisma.assistAccountUsage.findMany({
      where: {
        units: { gt: 0 },
        updatedAt: { gt: new Date(now.getTime() - 2 * DAY) },
        OR: [{ warned80At: null }, { warned100At: null }],
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      take: BATCH * 4,
    });
    let sent = 0;
    for (const u of rows) {
      const state = await readState(this.prisma, u.accountId, now);
      if (!state.planId || state.periodKey !== u.periodKey) continue;
      const limit = unitsLimit(state, u.extraUnits);
      const full =
        u.units >= limit && (!state.autoTopUp || u.exhaustedAt !== null);
      const kind =
        full && !u.warned100At
          ? 'warn100'
          : u.units >= Math.ceil(limit * 0.8) && !u.warned80At
            ? 'warn80'
            : null;
      if (!kind) continue;
      if (!(await this.claimNotice(u.accountId, u.periodKey, kind, now))) {
        continue;
      }
      sent++;
      await this.notices
        ?.usage(u.accountId, kind, { used: u.units, limit })
        .catch(() => undefined);
    }
    return sent;
  }
}
