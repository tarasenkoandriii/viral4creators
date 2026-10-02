import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clampPacks,
  createPayer,
  planAlert,
  type CheckoutRequest,
  type CheckoutResult,
  type InvoiceStatus,
  type PayDeps,
} from '../src/lib/billing-api';
import { billingEn } from '../src/i18n/billing-en';
import { billingRu } from '../src/i18n/billing-ru';
import { billingUk } from '../src/i18n/billing-uk';

// Экран «Тариф и оплата» (Э4; аудит фронта 02.10): логика экрана без DOM.

// ── 1. Предупреждения под счётчиком ──
const usage = (units: number, limit: number) => ({
  units,
  dialogs: units,
  limit,
  planUnits: limit,
  extraUnits: 0,
  autoAllowance: 0,
});
const plan = (
  id: 'trial' | 'start' | null,
  status: 'trial' | 'active' | 'grace' | 'expired' | 'none'
) => ({
  id,
  status,
  method: 'wayforpay',
  periodStart: null,
  periodEnd: null,
  paidThrough: null,
  renews: true,
  cancelAtPeriodEnd: false,
});
// Пробный ещё не начат (сайта нет) — НЕ «тариф не действует».
assert.equal(planAlert({ plan: plan(null, 'none'), usage: usage(0, 0) }), null);
assert.equal(
  planAlert({ plan: plan(null, 'expired'), usage: usage(0, 0) }),
  'expired'
);
assert.equal(
  planAlert({ plan: plan('start', 'grace'), usage: usage(10, 400) }),
  'grace'
);
assert.equal(
  planAlert({ plan: plan('start', 'grace'), usage: usage(400, 400) }),
  'full'
);
assert.equal(
  planAlert({ plan: plan('start', 'active'), usage: usage(320, 400) }),
  'warn'
);
assert.equal(
  planAlert({ plan: plan('start', 'active'), usage: usage(400, 400) }),
  'full'
);
assert.equal(
  planAlert({ plan: plan('start', 'active'), usage: usage(10, 400) }),
  null
);
for (const d of [billingUk, billingRu, billingEn]) {
  assert.ok(d.grace.trim().length > 20, 'текст льготы во всех языках');
}

// ── 2. Пакеты докупки: пустое поле и мусор — не NaN в запросе ──
assert.equal(clampPacks('', 10), 1);
assert.equal(clampPacks('abc', 10), 1);
assert.equal(clampPacks('3', 10), 3);
assert.equal(clampPacks('2.7', 10), 2);
assert.equal(clampPacks('99', 10), 10);
assert.equal(clampPacks('-4', 10), 1);
assert.ok(Number.isInteger(clampPacks(Number.NaN, 10)));

// ── 3. Оплата с замком: повторное нажатие не создаёт второй счёт ──
function deps(
  result: CheckoutResult,
  opts: { invoice?: boolean } = {}
): {
  d: PayDeps;
  calls: CheckoutRequest[];
  opened: string[];
  tgLinks: string[];
  forms: number;
  closeInvoice: (s: InvoiceStatus) => void;
} {
  const st = {
    calls: [] as CheckoutRequest[],
    opened: [] as string[],
    tgLinks: [] as string[],
    forms: 0,
    closeInvoice: ((s: InvoiceStatus) => void s) as (s: InvoiceStatus) => void,
  };
  const d: PayDeps = {
    checkout: async (req) => {
      st.calls.push(req);
      return result;
    },
    openInvoice: opts.invoice
      ? (url, cb) => {
          st.opened.push(url);
          st.closeInvoice = cb;
        }
      : null,
    openTelegramLink: (url) => {
      st.tgLinks.push(url);
    },
    submitWayForPay: () => {
      st.forms++;
    },
  };
  return Object.assign(st, { d }) as never;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const sub: CheckoutRequest = {
  kind: 'subscription',
  planId: 'start',
  method: 'stars',
};
const stars: CheckoutResult = {
  paymentId: 'ap_1',
  method: 'stars',
  starsInvoiceUrl: 'https://t.me/$inv',
  wayforpay: null,
};

async function main() {
  // Stars через openInvoice: пока счёт открыт — второе нажатие «busy».
  {
    const s = deps(stars, { invoice: true });
    const payer = createPayer(s.d);
    const first = payer.pay(sub);
    await tick();
    assert.deepEqual(await payer.pay(sub), { kind: 'busy' });
    assert.equal(s.calls.length, 1, 'второй чекаут при открытом счёте');
    assert.deepEqual(s.opened, ['https://t.me/$inv']);
    s.closeInvoice('pending');
    // `pending` у Telegram — платёж в обработке, а не «закрыто»: опрашивать.
    assert.deepEqual(await first, { kind: 'follow', paymentId: 'ap_1' });
    // Пока экран опрашивает статус — замок держится.
    assert.deepEqual(await payer.pay(sub), { kind: 'busy' });
    assert.equal(s.calls.length, 1, 'второй счёт во время опроса статуса');
    payer.release();
    const again = payer.pay(sub);
    await tick();
    s.closeInvoice('cancelled');
    assert.deepEqual(await again, { kind: 'closed' });
    assert.equal(payer.isLocked(), false, 'закрытый счёт снимает замок');
    const third = payer.pay(sub);
    await tick();
    s.closeInvoice('failed');
    assert.deepEqual(await third, { kind: 'failed' });
    assert.equal(s.calls.length, 3);
  }
  // Без openInvoice (веб/старый клиент): ссылка t.me через openTelegramLink, замок до опроса.
  {
    const s = deps(stars);
    const payer = createPayer(s.d);
    assert.deepEqual(await payer.pay(sub), {
      kind: 'follow',
      paymentId: 'ap_1',
    });
    assert.deepEqual(s.tgLinks, ['https://t.me/$inv']);
    assert.deepEqual(await payer.pay(sub), { kind: 'busy' });
    assert.equal(s.calls.length, 1, 'вернулся из Telegram — второй счёт');
  }
  // WayForPay: форма отправлена — замок навсегда (страница уходит).
  {
    const s = deps({
      paymentId: 'ap_2',
      method: 'wayforpay',
      starsInvoiceUrl: null,
      wayforpay: { url: 'https://secure.wayforpay.com/pay', fields: {} },
    });
    const payer = createPayer(s.d);
    const req: CheckoutRequest = {
      kind: 'topup',
      packs: 2,
      method: 'wayforpay',
    };
    assert.deepEqual(await payer.pay(req), { kind: 'redirected' });
    assert.deepEqual(await payer.pay(req), { kind: 'busy' });
    assert.equal(s.forms, 1);
    assert.equal(s.calls.length, 1, 'второй счёт WayForPay');
  }
  // Ошибка сервера и «нет способа» — замок снят, можно повторить.
  {
    const s = deps({
      paymentId: 'ap_3',
      method: 'stars',
      starsInvoiceUrl: null,
      wayforpay: null,
    });
    const payer = createPayer(s.d);
    assert.deepEqual(await payer.pay(sub), { kind: 'no-method' });
    assert.equal(payer.isLocked(), false);
    const failing = createPayer({
      ...s.d,
      checkout: async () => {
        throw new Error('LEGAL_REQUIRED');
      },
    });
    await assert.rejects(failing.pay(sub));
    assert.equal(failing.isLocked(), false, 'ошибка чекаута оставила замок');
  }

  // ── 4. Экран пользуется замком и предупреждениями, а не своей копией ──
  const screen = readFileSync(
    new URL('../src/screens/BillingScreen.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(/createPayer\(/.test(screen), 'экран без замка оплаты');
  assert.equal(
    (screen.match(/billing\.checkout\(/g) ?? []).length,
    1,
    'чекаут вызывается мимо замка'
  );
  assert.ok(/planAlert\(ov\)/.test(screen) && /t\.grace/.test(screen));
  assert.ok(/clampPacks\(/.test(screen));
  // Кнопки оплаты — только у владельца (canPay с сервера).
  const payButtons = screen.match(/void pay\(|onPay\(/g) ?? [];
  assert.ok(payButtons.length >= 4);
  assert.ok(
    /\{ov\.canPay &&\s*p\.price/.test(screen) &&
      /\{ov\.canPay && \(\s*<TopupCard/.test(screen),
    'кнопки оплаты без проверки canPay'
  );

  console.log('ok billing-screen');
}

// Зависший промис (счёт так и не закрылся) не должен сойти за успех: без
// таймера Node просто вышел бы с кодом 0, не дойдя до проверок.
const watchdog = setTimeout(() => {
  console.error(
    'billing-screen: проверки не завершились (завис промис оплаты)'
  );
  process.exit(1);
}, 10000);
void main()
  .then(() => clearTimeout(watchdog))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
