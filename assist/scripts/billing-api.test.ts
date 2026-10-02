import assert from 'node:assert/strict';
import {
  parseCheckout,
  parseOverview,
  safeInvoiceUrl,
  safeWayForPayForm,
  uahAmount,
  usageLevel,
} from '../src/lib/billing-api';
import { parseRoute, routeHref } from '../src/lib/router';

// Э4: экран «Тариф и оплата» — разбор строгий, чужие адреса не открываем.

const ov = parseOverview({
  plan: {
    id: 'business',
    status: 'active',
    method: 'wayforpay',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-31T00:00:00.000Z',
    paidThrough: '2026-10-31T00:00:00.000Z',
    renews: true,
    cancelAtPeriodEnd: false,
  },
  usage: {
    units: 1000,
    dialogs: 990,
    limit: 1200,
    planUnits: 1200,
    extraUnits: 0,
    autoAllowance: 0,
  },
  autoTopUp: { enabled: false, capUsd: 0, spentUsd: 0, available: true },
  plans: [
    {
      id: 'trial',
      priceUsdMonthly: 0,
      dialogsPerMonth: 50,
      price: null,
      overageUsdPer100: null,
    },
    {
      id: 'start',
      priceUsdMonthly: 19,
      dialogsPerMonth: 400,
      price: { uahMinor: 78900, stars: 1463 },
      overageUsdPer100: 6,
    },
    { id: 'gold', priceUsdMonthly: 1, dialogsPerMonth: 1 },
  ],
  topup: {
    packUnits: 100,
    maxPacks: 10,
    priceUsdPer100: 5.5,
    pricePerPack: { uahMinor: 22900, stars: 424 },
  },
  methods: { stars: true, wayforpay: 'yes' },
  legal: {
    terms: { version: 'v1', url: 'javascript:alert(1)', accepted: true },
    dpa: {
      version: 'v1',
      url: 'https://legal.example.com/dpa',
      accepted: false,
    },
    evalConsent: true,
  },
  payments: [
    {
      id: 'ap_1',
      kind: 'subscription',
      status: 'succeeded',
      currency: 'UAH',
      amountMinor: -5,
    },
  ],
  canPay: 1,
});
assert.equal(ov.plan.id, 'business');
assert.deepEqual(
  ov.plans.map((p) => p.id),
  ['trial', 'start']
); // неизвестный тариф не рисуется
assert.equal(ov.plans[0].price, null);
assert.deepEqual(ov.plans[1].price, { uahMinor: 78900, stars: 1463 });
assert.equal(ov.methods.wayforpay, false); // строго true
assert.equal(ov.legal.terms.url, null); // не https — ссылки нет
assert.equal(ov.legal.dpa.url, 'https://legal.example.com/dpa');
assert.equal(ov.payments[0].amountMinor, 0);
assert.equal(ov.canPay, false);
assert.deepEqual(ov.dialogWeights, { text: 1, voice: 2, admin: 3 });

// Неизвестный статус/тариф — «нет тарифа», а не падение экрана.
const broken = parseOverview({ plan: { id: 'x', status: 'weird' } });
assert.equal(broken.plan.id, null);
assert.equal(broken.plan.status, 'none');
assert.equal(broken.topup, null);

// Ссылки оплаты — только Telegram и WayForPay.
assert.equal(safeInvoiceUrl('https://t.me/$abc'), 'https://t.me/$abc');
assert.equal(safeInvoiceUrl('https://evil.example.com/$abc'), null);
assert.equal(safeInvoiceUrl('http://t.me/$abc'), null);
assert.deepEqual(
  safeWayForPayForm({
    url: 'https://secure.wayforpay.com/pay',
    fields: { a: '1', b: 2 },
  }),
  { url: 'https://secure.wayforpay.com/pay', fields: { a: '1' } }
);
assert.equal(
  safeWayForPayForm({
    url: 'https://secure.wayforpay.com.evil.io/pay',
    fields: {},
  }),
  null
);
const co = parseCheckout({
  paymentId: 'ap_1',
  method: 'stars',
  starsInvoiceUrl: 'https://evil.io/x',
});
assert.equal(co.starsInvoiceUrl, null);

// Пороги §3.10: 80% — предупреждение, 100% — мягкий стоп; без лимита — стоп.
assert.equal(usageLevel({ units: 319, limit: 400 }).level, 'ok');
assert.equal(usageLevel({ units: 320, limit: 400 }).level, 'warn');
assert.equal(usageLevel({ units: 400, limit: 400 }).level, 'full');
assert.equal(usageLevel({ units: 0, limit: 0 }).level, 'full');
assert.equal(uahAmount(78900), '789');
assert.equal(uahAmount(45750), '457.50');

// Маршруты: #/billing и #/billing/<платный тариф>; trial и мусор — нет.
assert.deepEqual(parseRoute('#/billing'), { name: 'billing', plan: null });
assert.deepEqual(parseRoute('#/billing/pro'), { name: 'billing', plan: 'pro' });
assert.equal(parseRoute('#/billing/trial').name, 'not-found');
assert.equal(parseRoute('#/billing/gold').name, 'not-found');
assert.equal(routeHref({ name: 'billing', plan: 'start' }), '#/billing/start');
assert.equal(routeHref({ name: 'billing', plan: null }), '#/billing');

console.log('ok billing-api');
