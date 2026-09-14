/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * BillingService (ТЗ §41.2-41.3, этап 62) — оркестрация покупки поверх
 * Stars и WayForPay: старт чекаута, идемпотентность вебхуков, применение
 * успешной оплаты (подписка/пакет кредитов).
 */

import { ServiceUnavailableException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { signStarsInvoicePayload } from './stars-invoice-payload.util';

const PAYMENT_TOKEN_KEY = 'a'.repeat(43) + '='; // произвольная валидная base64-строка для HMAC

function build() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    payment: {
      // creditsGranted=5 — соответствует умолчанию тестов ниже (пакет
      // 'small' по каталогу billing-pricing.ts). Тесты, которым важно
      // другое число, переопределяют мок сами.
      create: jest.fn().mockResolvedValue({
        id: 'pay1',
        userId: 'u1',
        method: 'STARS',
        creditsGranted: 5,
      }),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ telegramId: '777' }),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    // Спека отстала от кода: вебхуки идут в `$transaction` с advisory-
    // замком (Г-2.x); мок прозрачно передаёт тот же объект как `tx`.
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  const plans = { applyPurchasedPlan: jest.fn().mockResolvedValue(undefined) };
  const creditLedger = { grant: jest.fn().mockResolvedValue(undefined) };
  const stars = {
    configured: jest.fn().mockReturnValue(true),
    createInvoiceLink: jest.fn().mockResolvedValue('https://t.me/invoice/abc'),
    answerPreCheckoutQuery: jest.fn().mockResolvedValue(undefined),
    cancelSubscription: jest.fn().mockResolvedValue(true),
  };
  const wayforpay = {
    configured: jest.fn().mockReturnValue(true),
    buildPurchaseForm: jest.fn().mockReturnValue({
      url: 'https://secure.wayforpay.com/pay',
      fields: { merchantAccount: 'shop', merchantSignature: 'sig' },
    }),
    verifyServiceCallback: jest.fn().mockReturnValue(true),
    buildWebhookAck: jest.fn().mockImplementation((orderReference: string) => ({
      orderReference,
      status: 'accept',
      time: 1,
      signature: 'ack-sig',
    })),
  };
  const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
  // Г-6.4 (аудит round4): чекаут теперь проверяет акцепт оферты — по
  // умолчанию мок отдаёт "принято", чтобы существующие тесты чекаута не
  // трогали эту ось; тест самого гварда переопределяет мок отдельно.
  const legal = { assertAccepted: jest.fn().mockResolvedValue(undefined) };
  const svc = new BillingService(
    prisma as any,
    plans as any,
    creditLedger as any,
    stars as any,
    wayforpay as any,
    notify as any,
    legal as any,
  );
  return { svc, prisma, plans, creditLedger, stars, wayforpay, notify, legal };
}

const envBefore = { ...process.env };
beforeEach(() => {
  process.env.PAYMENT_TOKEN_KEY = PAYMENT_TOKEN_KEY;
  process.env.TMA_PUBLIC_URL = 'https://tma.example.com';
  process.env.API_PUBLIC_URL = 'https://api.example.com';
});
afterEach(() => {
  process.env = { ...envBefore };
});

describe('BillingService.getPrices — прайс для экрана покупки', () => {
  it('отдаёт обе подписки и хотя бы один пакет кредитов', () => {
    const { svc } = build();
    const prices = svc.getPrices();
    expect(prices.subscriptions.STANDARD.stars).toBeGreaterThan(0);
    expect(prices.subscriptions.PREMIUM.stars).toBeGreaterThan(0);
    expect(prices.creditPacks.length).toBeGreaterThan(0);
  });
});

describe('BillingService — акцепт оферты перед чекаутом (Г-6.4)', () => {
  it('оферта не принята — чекаут отклоняется до создания инвойса/формы', async () => {
    const { svc, legal, stars } = build();
    legal.assertAccepted.mockRejectedValue(new Error('оферта не принята'));
    await expect(
      svc.startSubscriptionCheckout('u1', 'STANDARD', 'STARS'),
    ).rejects.toThrow('оферта не принята');
    expect(stars.createInvoiceLink).not.toHaveBeenCalled();
  });

  it('пакет кредитов — та же проверка перед стартом', async () => {
    const { svc, legal, stars } = build();
    legal.assertAccepted.mockRejectedValue(new Error('оферта не принята'));
    await expect(
      svc.startCreditPackCheckout('u1', 'small', 'STARS'),
    ).rejects.toThrow('оферта не принята');
    expect(stars.createInvoiceLink).not.toHaveBeenCalled();
  });

  it('оферта принята — проверка проходит прозрачно, чекаут работает как раньше', async () => {
    const { svc, legal } = build();
    const result = await svc.startSubscriptionCheckout(
      'u1',
      'STANDARD',
      'STARS',
    );
    expect(legal.assertAccepted).toHaveBeenCalledWith('u1');
    expect(result.starsInvoiceUrl).toBeDefined();
  });
});

describe('BillingService.startSubscriptionCheckout — старт покупки', () => {
  it('Stars: возвращает ссылку инвойса, строка Payment не заводится заранее', async () => {
    const { svc, prisma, stars } = build();
    const result = await svc.startSubscriptionCheckout(
      'u1',
      'STANDARD',
      'STARS',
    );
    expect(result.starsInvoiceUrl).toBe('https://t.me/invoice/abc');
    expect(stars.createInvoiceLink).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: expect.any(Number),
        subscription: true,
      }),
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('М-1.1: действующая Stars-подписка отменяется в Telegram ДО нового подписочного инвойса (апгрейд без двойного списания)', async () => {
    const { svc, prisma, stars } = build();
    prisma.subscription.findUnique.mockResolvedValue({
      method: 'STARS',
      status: 'ACTIVE',
    });
    prisma.payment.findFirst.mockResolvedValue({ providerRef: 'charge-old' });
    const calls: string[] = [];
    stars.cancelSubscription.mockImplementation(async () => {
      calls.push('cancel');
      return true;
    });
    stars.createInvoiceLink.mockImplementation(async () => {
      calls.push('invoice');
      return 'https://t.me/invoice/new';
    });

    await svc.startSubscriptionCheckout('u1', 'PREMIUM', 'STARS');

    expect(stars.cancelSubscription).toHaveBeenCalledWith('777', 'charge-old');
    expect(calls).toEqual(['cancel', 'invoice']);
  });

  it('М-1.1: без действующей Stars-подписки (или с WayForPay/отменённой) в Telegram ничего не отменяется', async () => {
    const { svc, prisma, stars } = build();
    prisma.subscription.findUnique.mockResolvedValue({
      method: 'WAYFORPAY',
      status: 'ACTIVE',
    });
    await svc.startSubscriptionCheckout('u1', 'PREMIUM', 'STARS');
    expect(stars.cancelSubscription).not.toHaveBeenCalled();
  });

  it('Stars не настроен — 503, а не тихий отказ', async () => {
    const { svc, stars } = build();
    stars.configured.mockReturnValue(false);
    await expect(
      svc.startSubscriptionCheckout('u1', 'STANDARD', 'STARS'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('WayForPay: заводит PENDING-платёж ДО редиректа и подписывает форму', async () => {
    const { svc, prisma, wayforpay } = build();
    const result = await svc.startSubscriptionCheckout(
      'u1',
      'PREMIUM',
      'WAYFORPAY',
    );
    expect(result.wayforpayFormUrl).toBe('https://secure.wayforpay.com/pay');
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          method: 'WAYFORPAY',
          purpose: 'SUBSCRIPTION',
          plan: 'PREMIUM',
          status: 'PENDING',
        }),
      }),
    );
    expect(wayforpay.buildPurchaseForm).toHaveBeenCalled();
  });

  it('WayForPay не настроен — 503', async () => {
    const { svc, wayforpay } = build();
    wayforpay.configured.mockReturnValue(false);
    await expect(
      svc.startSubscriptionCheckout('u1', 'STANDARD', 'WAYFORPAY'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('BillingService.startCreditPackCheckout — покупка пакета кредитов', () => {
  it('неизвестный пакет — явная ошибка, а не тихий провал', async () => {
    const { svc } = build();
    await expect(
      svc.startCreditPackCheckout('u1', 'no-such-pack', 'STARS'),
    ).rejects.toThrow();
  });

  it('известный пакет через WayForPay — Payment.creditsGranted записан заранее', async () => {
    const { svc, prisma } = build();
    await svc.startCreditPackCheckout('u1', 'small', 'WAYFORPAY');
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purpose: 'CREDIT_PACK',
          creditsGranted: expect.any(Number),
          status: 'PENDING',
        }),
      }),
    );
  });
});

describe('BillingService — вебхук Telegram (Stars)', () => {
  function successfulPayment(
    overrides: Partial<{
      userId: string;
      purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
      target: string;
    }> = {},
  ) {
    const payload = signStarsInvoicePayload(
      {
        userId: overrides.userId ?? 'u1',
        purpose: overrides.purpose ?? 'CREDIT_PACK',
        target: overrides.target ?? 'small',
      },
      PAYMENT_TOKEN_KEY,
    );
    return {
      telegram_payment_charge_id: 'charge-1',
      invoice_payload: payload,
      total_amount: 250,
    };
  }

  it('pre_checkout_query с валидным payload — подтверждается', async () => {
    const { svc, stars } = build();
    const payload = signStarsInvoicePayload(
      { userId: 'u1', purpose: 'CREDIT_PACK', target: 'small' },
      PAYMENT_TOKEN_KEY,
    );
    await svc.handleTelegramUpdate({
      pre_checkout_query: { id: 'q1', invoice_payload: payload },
    });
    expect(stars.answerPreCheckoutQuery).toHaveBeenCalledWith('q1', true);
  });

  it('pre_checkout_query с испорченным payload — отклоняется, а не падает', async () => {
    const { svc, stars } = build();
    await svc.handleTelegramUpdate({
      pre_checkout_query: { id: 'q1', invoice_payload: 'мусор' },
    });
    expect(stars.answerPreCheckoutQuery).toHaveBeenCalledWith(
      'q1',
      false,
      expect.any(String),
    );
  });

  it('successful_payment — создаёт SUCCEEDED Payment и начисляет кредиты', async () => {
    const { svc, prisma, creditLedger } = build();
    await svc.handleTelegramUpdate({
      message: { successful_payment: successfulPayment() },
    });
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          providerRef: 'charge-1',
        }),
      }),
    );
    expect(creditLedger.grant).toHaveBeenCalledWith(
      'u1',
      expect.any(Number),
      'pay1',
      expect.anything(), // tx
    );
  });

  it('successful_payment — подписка применяется через PlanService.applyPurchasedPlan', async () => {
    const { svc, plans, prisma } = build();
    prisma.payment.create.mockResolvedValue({
      id: 'pay2',
      userId: 'u1',
      method: 'STARS',
    });
    await svc.handleTelegramUpdate({
      message: {
        successful_payment: successfulPayment({
          purpose: 'SUBSCRIPTION',
          target: 'STANDARD',
        }),
      },
    });
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'STANDARD');
    expect(prisma.subscription.create).toHaveBeenCalled();
  });

  it('повторная доставка того же charge_id — не падает и не начисляет дважды (advisory-замок + findUnique под ним)', async () => {
    const { svc, creditLedger, prisma } = build();
    // Идемпотентность теперь не через P2002, а через чтение под
    // `pg_advisory_xact_lock` в той же транзакции (Г-2.x).
    prisma.payment.findUnique.mockResolvedValueOnce({ id: 'pay-existing' });
    await svc.handleTelegramUpdate({
      message: { successful_payment: successfulPayment() },
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(creditLedger.grant).not.toHaveBeenCalled();
  });

  it('successful_payment с нераспознанным payload — тревога, деньги не теряются молча', async () => {
    const { svc, notify, prisma } = build();
    await svc.handleTelegramUpdate({
      message: {
        successful_payment: {
          telegram_payment_charge_id: 'charge-x',
          invoice_payload: 'мусор',
          total_amount: 100,
        },
      },
    });
    expect(notify.alert).toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('BillingService — вебхук WayForPay', () => {
  it('неверная подпись — квитанция отдаётся, но ничего не применяется', async () => {
    const { svc, wayforpay, notify, prisma } = build();
    wayforpay.verifyServiceCallback.mockReturnValue(false);
    const ack = await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ref1',
      amount: 100,
      currency: 'UAH',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      merchantSignature: 'bad',
    });
    expect(ack.status).toBe('accept');
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:bad-signature',
      expect.any(String),
    );
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('неизвестный orderReference — квитанция отдаётся, тревога уходит', async () => {
    const { svc, prisma, notify } = build();
    prisma.payment.findUnique.mockResolvedValue(null);
    const ack = await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ghost',
      amount: 100,
      currency: 'UAH',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      merchantSignature: 'sig',
    });
    expect(ack.status).toBe('accept');
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:unknown-order',
      expect.any(String),
    );
  });

  it('повторный вебхук на уже обработанный платёж — не применяется дважды', async () => {
    const { svc, prisma, creditLedger } = build();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      status: 'SUCCEEDED',
      purpose: 'CREDIT_PACK',
      plan: null,
    });
    await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ref1',
      amount: 19900,
      currency: 'UAH',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      merchantSignature: 'sig',
    });
    expect(creditLedger.grant).not.toHaveBeenCalled();
  });

  it('отклонённая транзакция — Payment помечается FAILED, кредиты не начисляются', async () => {
    const { svc, prisma, creditLedger, notify } = build();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      status: 'PENDING',
      purpose: 'CREDIT_PACK',
      plan: null,
    });
    await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ref1',
      amount: 19900,
      currency: 'UAH',
      transactionStatus: 'Declined',
      reasonCode: 1101,
      merchantSignature: 'sig',
    });
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(creditLedger.grant).not.toHaveBeenCalled();
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:declined',
      expect.any(String),
    );
  });

  it('одобренная транзакция пакета кредитов — начисляет кредиты из Payment.creditsGranted', async () => {
    // Регресс: раньше применение пыталось найти пакет по `Payment.plan`
    // (которое для CREDIT_PACK всегда пусто) и НИЧЕГО не начисляло ни разу
    // — число кредитов уже резолвится и сохраняется на строке ещё в
    // startCreditPackCheckout(), пересчитывать его здесь не нужно и не по
    // чему (id пакета на строке не хранится, только итоговое число).
    const { svc, prisma, creditLedger } = build();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      status: 'PENDING',
      purpose: 'CREDIT_PACK',
      plan: null,
      creditsGranted: 20,
    });
    prisma.payment.update.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      method: 'WAYFORPAY',
      creditsGranted: 20,
    });
    await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ref1',
      amount: 69900,
      currency: 'UAH',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      merchantSignature: 'sig',
    });
    expect(creditLedger.grant).toHaveBeenCalledWith(
      'u1',
      20,
      'pay1',
      expect.anything(), // tx
    );
  });

  it('WayForPay: пакет кредитов без сохранённого числа — не падает, но и не начисляет', async () => {
    const { svc, prisma, creditLedger } = build();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      status: 'PENDING',
      purpose: 'CREDIT_PACK',
      plan: null,
      creditsGranted: null,
    });
    prisma.payment.update.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      method: 'WAYFORPAY',
      creditsGranted: null,
    });
    await expect(
      svc.handleWayForPayWebhook({
        merchantAccount: 'shop',
        orderReference: 'ref1',
        amount: 69900,
        currency: 'UAH',
        transactionStatus: 'Approved',
        reasonCode: 1100,
        merchantSignature: 'sig',
      }),
    ).resolves.toBeDefined();
    expect(creditLedger.grant).not.toHaveBeenCalled();
  });

  it('одобренная транзакция подписки — продлевает существующую (берёт максимум из дат)', async () => {
    const { svc, prisma, plans } = build();
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      status: 'PENDING',
      purpose: 'SUBSCRIPTION',
      plan: 'STANDARD',
    });
    prisma.payment.update.mockResolvedValue({
      id: 'pay1',
      userId: 'u1',
      method: 'WAYFORPAY',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      currentPeriodEnd: future,
    });
    await svc.handleWayForPayWebhook({
      merchantAccount: 'shop',
      orderReference: 'ref1',
      amount: 79900,
      currency: 'UAH',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      merchantSignature: 'sig',
      recToken: 'rec-abc',
    });
    expect(prisma.subscription.update).toHaveBeenCalled();
    const data = prisma.subscription.update.mock.calls[0][0].data;
    expect(new Date(data.currentPeriodEnd).getTime()).toBeGreaterThan(
      future.getTime(),
    );
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'STANDARD');
  });
});
