/**
 * Э6-бис (а): общее iframe/act.js без браузера — сверка портов с сервером
 * (`sites-backend/src/modules/assist-ui-core`: стоп-лист «никогда», путь
 * оплаты, «команда или вопрос», «да/нет/стоп», маскирование подписей),
 * строгий разбор шагов и команд загрузчику (мусор — null, лишние поля не
 * проходят), бюджет снимка в протоколе.
 */
import assert from 'node:assert/strict';
import * as wordsNs from '../../sites-backend/src/modules/assist-ui-core/action-words';
import * as directNs from '../../sites-backend/src/modules/assist-ui-core/direct-plan';
import * as snapNs from '../../sites-backend/src/modules/assist-ui-core/snapshot';
import {
  looksLikeCommand,
  maskLabel,
  neverTarget,
  parseStep,
  parseSteps,
  parseUiCommand,
  paymentPath,
  replyKind,
} from '../src/shared/ui-plan';

const cjs = <T>(ns: T): T => (ns as T & { default?: T }).default ?? ns;
const server = { ...cjs(wordsNs), ...cjs(directNs), ...cjs(snapNs) };

// ── стоп-лист: всё, что сервер считает «никогда», загрузчик тоже ─────────
{
  const danger = [
    'Оплатити',
    'Оплатить заказ',
    'Pay now',
    'Proceed to checkout',
    'Видалити акаунт',
    'Удалить аккаунт',
    'Delete account',
    'Оформити замовлення',
    'Оформить заказ',
    'Place order',
    'Скасувати підписку',
    'Unsubscribe',
    'Скасувати замовлення',
    'Cancel order',
    'Оформить возврат',
    'Refund',
    'Списати бонуси',
    'Withdraw',
    'Вибрати все',
    'Select all',
    'Перейти до оформлення',
  ];
  for (const t of danger) {
    const kinds = server.actionKindsFor(t);
    assert.ok(
      kinds.some((k) => server.NEVER_KINDS.has(k)),
      `сервер: «${t}» — «никогда» (${kinds.join(',')})`
    );
    assert.equal(neverTarget(t, null), true, `загрузчик: «${t}» — «никогда»`);
  }
  const benign = [
    'Каталог',
    'Доставка',
    'Закрити банер',
    'Таблиця розмірів',
    'Пошук',
    'Додати в кошик',
    'Next page',
  ];
  for (const t of benign) {
    assert.equal(neverTarget(t, null), false, `«${t}» — не запрет`);
    assert.ok(
      !server.actionKindsFor(t).some((k) => server.NEVER_KINDS.has(k)),
      `сервер: «${t}» — не запрет`
    );
  }
  // «Купити» снимает только разметка add-to-cart, «Оплатити» — ничто.
  assert.equal(neverTarget('Купити', null), true);
  assert.equal(neverTarget('Купити', 'add-to-cart'), false);
  assert.equal(neverTarget('Купити і оплатити', 'add-to-cart'), true);
  assert.equal(neverTarget('Оплатити', 'add-to-cart'), true);
  // Скрытая подпись проверяется так же (вызов с текстом aria-label).
  assert.equal(neverTarget('Детальніше Оформити замовлення', null), true);
}

// ── путь оплаты ───────────────────────────────────────────────────────────
for (const [p, want] of [
  ['/checkout', true],
  ['/shop/payment/step-1', true],
  ['/oplata', true],
  ['/liqpay/return', true],
  ['/catalog', false],
  ['/paypal-info-blog', true],
  ['/display', false],
] as const) {
  assert.equal(paymentPath(p), want, `paymentPath ${p}`);
  assert.equal(server.paymentPath(p), want, `сервер paymentPath ${p}`);
}

// ── команда или вопрос; «да/нет/стоп» — как на сервере ────────────────────
{
  const phrases = [
    'відкрий доставку',
    'Открой каталог.',
    'open catalog',
    'будь ласка, натисни Купити',
    'оплати',
    'надішли заявку',
    'send the form',
    'Скільки коштує доставка?',
    'а що у вас з доставкою',
    'how much is shipping',
    'знайди футболку',
    'найди футболку!',
    'close the banner',
    'стоп',
    'так',
  ];
  for (const t of phrases)
    assert.equal(
      looksLikeCommand(t),
      server.looksLikeCommand(t),
      `looksLikeCommand «${t}»`
    );
  assert.equal(looksLikeCommand('відкрий доставку'), true);
  assert.equal(looksLikeCommand('Скільки коштує доставка?'), false);
  const replies = [
    'так',
    'Да, давай',
    'yes please',
    'ні',
    'не треба',
    'стоп',
    'Стоп!',
    'зупинись будь ласка',
    'так не треба',
    'stop it now please',
    'відкрий доставку',
    '',
  ];
  for (const t of replies)
    assert.equal(replyKind(t), server.replyKind(t), `replyKind «${t}»`);
  assert.equal(replyKind('Стоп!'), 'stop');
  assert.equal(replyKind('не треба'), 'no');
  assert.equal(replyKind('так'), 'yes');
}

// ── маскирование подписей — как на сервере ────────────────────────────────
{
  const labels = [
    'ivan.petrenko@example.com',
    'Вітаємо, ivan@example.com!',
    '+380 50 123 45 67',
    'Замовлення 4111 1111 1111 1111',
    'ключ sk-abcdefghijklmnop',
    'Синя футболка — 450 грн',
    'Розмір M',
  ];
  for (const l of labels)
    assert.equal(maskLabel(l), server.maskLabel(l), `maskLabel «${l}»`);
  assert.ok(!maskLabel('ivan.petrenko@example.com').includes('@'));
  assert.ok(!/\d{4}/.test(maskLabel('Замовлення 4111 1111 1111 1111')));
  assert.equal(maskLabel('Синя футболка — 450 грн'), 'Синя футболка — 450 грн');
}

// ── строгий разбор шагов ─────────────────────────────────────────────────
{
  const ok = {
    i: 0,
    kind: 'click',
    risk: 'auto',
    target: {
      ref: 'e3',
      role: 'button',
      text: 'Каталог',
      assistId: 'nav-catalog',
    },
    expect: { path: '/catalog' },
    nav: true,
    state: 'dispatched',
  };
  const s = parseStep(ok);
  assert.ok(s);
  assert.equal(s.target?.ref, 'e3');
  assert.equal(s.state, 'dispatched');
  assert.deepEqual(s.expect, { path: '/catalog' });
  assert.equal(parseStep({ ...ok, kind: 'eval' }), null, 'неизвестный вид');
  assert.equal(parseStep({ ...ok, risk: 'yolo' }), null, 'неизвестный риск');
  assert.equal(parseStep({ ...ok, i: 21 }), null, 'индекс > 20');
  assert.equal(
    parseStep({ ...ok, target: { ref: 'x1' } }),
    null,
    'чужая ссылка'
  );
  assert.equal(
    parseStep({ ...ok, target: { ref: 'e1', selector: '<img src=x>' } })?.target
      ?.selector ?? null,
    null
  );
  assert.equal(
    parseStep({ ...ok, target: { ref: 'e1', href: 'javascript:alert(1)' } })
      ?.target?.href ?? null,
    null
  );
  assert.equal(
    parseStep({ ...ok, expect: { path: 'https://evil' } })?.expect ?? null,
    null,
    'expect.path — только путь'
  );
  assert.equal(parseStep({ ...ok, state: 'weird' })?.state, 'pending');
  assert.equal(parseSteps(new Array(21).fill(ok)), null, 'не больше 20 шагов');
  assert.equal(
    parseSteps([ok, { ...ok, kind: 'eval' }]),
    null,
    'один плохой — весь план отвергнут'
  );
}

// ── команды загрузчику ───────────────────────────────────────────────────
{
  assert.deepEqual(
    parseUiCommand({
      type: 'ui-snap',
      rid: 'abcdefgh12',
      deny: ['#x'],
      allow: [],
    }),
    {
      type: 'ui-snap',
      rid: 'abcdefgh12',
      deny: ['#x'],
      allow: [],
    }
  );
  assert.deepEqual(
    parseUiCommand({
      type: 'ui-snap',
      rid: 'abcdefgh12',
      deny: ['<b>', ' ', '.ok'],
      allow: [],
    })?.type,
    'ui-snap'
  );
  assert.deepEqual(
    (
      parseUiCommand({
        type: 'ui-snap',
        rid: 'abcdefgh12',
        deny: ['<b>', '.ok'],
        allow: [],
      }) as { deny: string[] }
    ).deny,
    ['.ok']
  );
  assert.equal(
    parseUiCommand({ type: 'ui-snap', rid: 'X', deny: [], allow: [] }),
    null
  );
  assert.equal(
    parseUiCommand({ type: 'ui-run', planId: 'p1', steps: [], from: 1 }),
    null,
    'from за концом'
  );
  assert.equal(
    parseUiCommand({ type: 'ui-run', planId: 'p 1', steps: [], from: 0 }),
    null
  );
  assert.equal(
    (
      parseUiCommand({
        type: 'ui-run',
        planId: 'p1',
        steps: [],
        from: 0,
        lang: 'de',
      }) as { lang: string }
    ).lang,
    'uk'
  );
  assert.equal(
    parseUiCommand({ type: 'ui-ack', planId: 'p1', index: -1 }),
    null
  );
  assert.equal(parseUiCommand({ type: 'ui-pause', on: 'yes' }), null);
  assert.deepEqual(parseUiCommand({ type: 'ui-pause', on: true }), {
    type: 'ui-pause',
    on: true,
  });
  assert.equal(parseUiCommand({ type: 'ui-eval', code: '1' }), null);
}

console.log(
  'ui-plan: сверка с сервером (стоп-лист, оплата, команда, да/нет/стоп, маски), разбор шагов и команд — ok'
);
