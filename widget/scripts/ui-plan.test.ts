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
import * as decisionsNs from '../../sites-backend/src/modules/assist-ui-core/decisions';
import { UNDO_AT, UNDO_KIND } from '../src/act/snapshot';
import { DICTS } from '../src/chat/i18n';
import {
  MARK_SYMBOL,
  OFFER_TIMEOUT_MS,
  UiPlanController,
  parsePlanView,
  uiPlanOff,
  type UiPlanUi,
} from '../src/chat/ui-plan';
import {
  parseFrameMessage,
  parseParentMessage,
  envelope,
} from '../src/shared/protocol';
import {
  skillsPhrase,
  undoPhrase,
  looksLikeCommand,
  maskLabel,
  NEVER_PATTERNS,
  neverTarget,
  parseStep,
  parseSteps,
  parseUiCommand,
  paymentPath,
  replyKind,
} from '../src/shared/ui-plan';

const cjs = <T>(ns: T): T => (ns as T & { default?: T }).default ?? ns;
const server = { ...cjs(wordsNs), ...cjs(directNs), ...cjs(snapNs) };

// ── Э6-тер (и): пара разметки `data-assist-undo`/`-at` — загрузчик ≡ сервер ──
{
  const kinds = server.MARKUP_UNDO_KINDS as readonly string[];
  assert.ok(kinds.length >= 3);
  for (const k of kinds)
    assert.ok(UNDO_KIND.test(k), `загрузчик принимает вид «${k}»`);
  for (const k of [
    'remove-from-cart2',
    'remove-from-',
    'remove-gift',
    'del-x',
    'checkout',
    'xremove-from-cart',
  ])
    assert.ok(
      !UNDO_KIND.test(k) && server.cleanUndoMarkup(k, null) === null,
      `вид «${k}» — ни там, ни там`
    );
  // Страница: что пропускает загрузчик, то и сервер (кроме оплаты и ПД —
  // их сервер режет сверх); чужое — ни там, ни там.
  for (const at of ['/', '/cart/', '/compare/%D0%BF', '/a_b-c.d~e/'])
    assert.ok(
      UNDO_AT.test(at) &&
        server.cleanUndoMarkup('remove-from-cart', at)?.at === at,
      `страница «${at}» — да`
    );
  for (const at of [
    '//evil.example/cart',
    '/\\evil.example/cart',
    'https://evil.example/cart',
    'cart/',
    '/cart?x=1',
    '/cart#a',
    '/cart*',
    '/u/ivan@example.com',
    '/кошик/',
    '/c art',
    `/${'a'.repeat(200)}`,
  ])
    assert.ok(
      !UNDO_AT.test(at) &&
        server.cleanUndoMarkup('remove-from-cart', at) === null,
      `страница «${at}» — нет`
    );
  assert.ok(
    UNDO_AT.test('/checkout/') &&
      server.cleanUndoMarkup('remove-from-cart', '/checkout/') === null,
    'оплату режет сервер'
  );
}

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
  // Мутант M10b: add-to-cart снимает только «Купити», а не соседнее
  // «підтвердити замовлення» той же категории.
  assert.equal(
    neverTarget('Купити — підтвердити замовлення', 'add-to-cart'),
    true
  );
  assert.equal(neverTarget('Купити зараз', 'add-to-cart'), false);
  assert.equal(neverTarget('Швидко купити', 'add-to-cart'), false);
  // Аудит 06.10: начало слова — без lookbehind (Safari < 16.4), а «внутри
  // слова» по-прежнему не срабатывает.
  for (const re of NEVER_PATTERNS)
    assert.ok(!/\(\?<[=!]/.test(re.source), `lookbehind: ${re.source}`);
  assert.equal(neverTarget('Перепаковка', null), false, 'не с начала слова');
  assert.equal(neverTarget('(Оплатити)', null), true, 'после скобки');
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
    'Дзвоніть (67) 123-45-67',
    'Доставка 2026-10-03 або 03.10.2026',
    'Телефон (067) 123-45-67',
    'Код 12.34.5678',
    'Запис 0671234567',
  ];
  for (const l of labels)
    assert.equal(maskLabel(l), server.maskLabel(l), `maskLabel «${l}»`);
  assert.ok(!maskLabel('ivan.petrenko@example.com').includes('@'));
  assert.ok(!/\d{4}/.test(maskLabel('Замовлення 4111 1111 1111 1111')));
  assert.ok(!/45-67/.test(maskLabel('Дзвоніть (67) 123-45-67')));
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

// ══ Э6-бис (д)+(е): цепочки, возврат, мемо — сторона iframe ═════════════

// Решения владельца — одно место на сервере, повтор здесь сверяется (В-66).
{
  const d = cjs(decisionsNs);
  assert.equal(OFFER_TIMEOUT_MS, d.CHAIN_DECISIONS.offerTimeoutMs);
  assert.equal(d.CHAIN_DECISIONS.maxUndoSteps, 3);
  assert.deepEqual(MARK_SYMBOL, {
    none: '',
    nav: '',
    local: '↺',
    comp: '⇄',
    irrev: '⚠',
    manual: '✋',
  });
}

// «Отмени последнее» и «що ти вмієш» — закрытые списки (одиночное «скасуй» — «нет»).
{
  for (const t of [
    'Отмени последнее',
    'поверни як було!',
    'будь ласка, скасуй останнє',
    'Undo',
    'верни как было',
  ])
    assert.equal(undoPhrase(t), true, t);
  for (const t of ['скасуй', 'отмени', 'ні', 'верни деньги', 'відкрий кошик'])
    assert.equal(undoPhrase(t), false, t);
  assert.equal(skillsPhrase('Що ти вмієш?'), true);
  assert.equal(skillsPhrase('what can you do'), true);
  assert.equal(skillsPhrase('що ти вмієш робити з оплатою'), false);
}

// §5-бис.15 п.13 п.9: в текстах виджета нет «откатил/отменил/вернул всё как было».
{
  const bad =
    /(откат|відкот|rolled back|roll(ed)? back|отменил|скасував|всё вернул|все повернув|reverted)/iu;
  for (const lang of ['uk', 'ru', 'en'] as const) {
    const d = DICTS[lang] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith('vc')) continue;
      const list =
        typeof v === 'string'
          ? [v]
          : v && typeof v === 'object'
            ? Object.values(v as Record<string, string>)
            : [];
      for (const x of list)
        assert.ok(
          !bad.test(String(x)),
          `${lang}.${k}: «${x}» — запрещённое слово`
        );
    }
    // Новые ключи есть во всех языках.
    for (const k of [
      'vcPnrTail',
      'vcPnrCard',
      'vcDoneList',
      'vcOffer',
      'vcOfferUndo',
      'vcOfferKeep',
      'vcFieldBack',
      'vcFieldsGone',
      'vcUnknownPnr',
      'vcMemoDone',
      'vcRepeat',
      'vcSkills',
    ])
      assert.ok(
        typeof d[k] === 'string' && (d[k] as string).length > 0,
        `${lang}.${k}`
      );
  }
}

// Протокол: `ui-undo` — к чанку act.js сырым; итог `ui-undone` — только номера и итоги.
{
  const f = parseFrameMessage(
    envelope({ type: 'ui-undo', planId: 'p1', idx: [2, 0] })
  );
  assert.equal(f && f.type, 'ui-raw');
  const ok = parseParentMessage(
    envelope({
      type: 'ui-undone',
      planId: 'p1',
      results: [{ i: 2, result: 'done', value: 'Київ' }],
    })
  );
  assert.deepEqual(ok, {
    type: 'ui-undone',
    planId: 'p1',
    results: [{ i: 2, result: 'done' }],
  });
  assert.equal(
    parseParentMessage(
      envelope({
        type: 'ui-undone',
        planId: 'p1',
        results: [{ i: 1, result: 'ok' }],
      })
    ),
    null
  );
}

// Ответ плана: пометки, ТН, второе «Да», мемо, итоги — строгий разбор.
const STEP = (
  kind: string,
  text: string,
  over: Record<string, unknown> = {}
) => ({
  i: 0,
  kind,
  target: {
    ref: 'e1',
    assistId: null,
    role: 'button',
    text,
    selector: null,
    href: null,
  },
  value: null,
  expect: null,
  risk: 'confirm',
  reason: null,
  nav: false,
  say: null,
  state: 'pending',
  ...over,
});
{
  const v = parsePlanView({
    kind: 'plan',
    planId: 'p1',
    steps: [
      STEP('select', 'Розмір', { value: 'M' }),
      STEP('click', 'В кошик'),
      STEP('click', 'Надіслати'),
    ],
    marks: ['local', 'comp', 'evil'],
    pnr: 2,
    pnrConfirm: true,
    memo: { name: 'Кошик', goal: 'x'.repeat(500) },
    repeat: true,
    goalStatus: 'reached',
    chainStatus: '<b>',
  })!;
  assert.deepEqual(v.marks, ['local', 'comp', 'irrev']);
  assert.equal(v.pnr, 2);
  assert.equal(v.pnrConfirm, true);
  assert.equal(v.memo!.goal.length, 160);
  assert.equal(v.goalStatus, 'reached');
  assert.equal(v.chainStatus, null);
}

// Контроллер: строка цепочки с пометками; второе «Да» перед ТН (стоп ДО
// клика); сбой — перечень и «Вернуть / Оставить»; возврат полей —
// загрузчику номерами, на сервер — только итоги (без значений).
// Контроллер на промисах: «повисшее» ожидание опустошит цикл событий, и
// Node выйдет с кодом 0, не дойдя до конца, — такой выход считаем провалом.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('ui-plan.test: не дошли до конца (повисшее ожидание)');
    process.exitCode = 1;
  }
});
void (async () => {
  let ui: UiPlanUi = uiPlanOff();
  const feed: string[] = [];
  const toParent: Array<Record<string, unknown>> = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const store = new Map<string, string>([['vcconsent', '1']]);
  let reply: (path: string, body: unknown) => unknown = () => null;
  const pc = new UiPlanController({
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => DICTS.uk,
    lang: () => 'uk',
    cfg: () => ({
      mode: 'on',
      denySelectors: [],
      allowSelectors: [],
      maxSteps: 6,
      memos: true,
    }),
    api: async (_m, path, body) => {
      calls.push({ path, body });
      return reply(path, body);
    },
    toParent: (m) => toParent.push(m as unknown as Record<string, unknown>),
    conversationId: () => null,
    setConversation: () => undefined,
    feed: (_r, t) => feed.push(t),
    storage: (_k, n, v) => {
      if (v === undefined) return store.get(n) ?? null;
      if (v === null) store.delete(n);
      else store.set(n, v);
      return null;
    },
    pageUrl: () => 'https://shop.example.com/p/1',
    listen: () => undefined,
    random: () => 'r'.repeat(16),
  });
  // Снимок отдаёт «загрузчик».
  const snapReply = () =>
    setTimeout(() => {
      const m = toParent.find((x) => x.type === 'ui-snap');
      if (m)
        pc.onParent({
          type: 'ui-snapshot',
          rid: m.rid as string,
          snapshot: {
            url: 'https://shop.example.com/p/1',
            title: '',
            elements: [],
          },
        });
    }, 0);
  const view = {
    kind: 'plan',
    planId: 'p1',
    status: 'confirmed',
    steps: [
      STEP('select', 'Розмір', { value: 'M', risk: 'auto' }),
      STEP('click', 'В кошик', { i: 1, risk: 'auto' }),
      STEP('click', 'Надіслати', { i: 2 }),
    ],
    marks: ['local', 'comp', 'irrev'],
    pnr: 2,
    currentStep: 0,
    stepsHash: 'h1',
  };
  reply = (path) => (path === '/widget/v1/ui-plan' ? view : null);
  snapReply();
  // «запис…» без глагола: у сайта есть мемо — тоже в план.
  assert.equal(pc.wants('запис на консультацію'), true);
  assert.equal(
    await pc.command('вибери M, додай в кошик і надішли', 'typed', null),
    true
  );
  const line = feed.at(-1)!;
  assert.match(
    line,
    /1 ↺ виберу «M» у «Розмір» · 2 ⇄ натисну «В кошик» · 3 ⚠ натисну «Надіслати» \(після цього скасувати не можна\)/
  );
  assert.equal(
    store.get('last'),
    'p1',
    '«отмени последнее» — последняя цепочка вкладки'
  );
  // Шаг 0 и 1 сделаны; на шаге 2 сервер просит второе «Да».
  const stepReply = (
    states: string[],
    status: string,
    extra: Record<string, unknown> = {}
  ) => ({
    ...view,
    status,
    steps: view.steps.map((x, i) => ({ ...x, state: states[i] })),
    ...extra,
  });
  reply = () => stepReply(['done', 'pending', 'pending'], 'running');
  pc.onParent({
    type: 'ui-step',
    planId: 'p1',
    index: 0,
    result: 'done',
    reason: null,
    url: null,
    ms: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  reply = () =>
    stepReply(['done', 'done', 'pending'], 'proposed', {
      pnrConfirm: true,
      currentStep: 2,
    });
  toParent.length = 0;
  pc.onParent({
    type: 'ui-step',
    planId: 'p1',
    index: 2,
    result: 'dispatched',
    reason: null,
    url: null,
    ms: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    toParent.map((m) => m.type),
    ['ui-stop'],
    'второе «Да»: исполнитель стоп ДО клика, ack нет'
  );
  assert.equal(ui.phase, 'confirm');
  assert.equal(ui.pnrCard, true);
  assert.deepEqual(
    ui.confirmSteps.map((x) => x.mark),
    ['irrev']
  );
  // Сбой: перечень сделанного и «Вернуть / Оставить».
  ui = { ...ui, phase: 'running' };
  reply = () =>
    stepReply(['done', 'done', 'failed'], 'failed', { chainStatus: 'kept' });
  pc.onParent({
    type: 'ui-step',
    planId: 'p1',
    index: 2,
    result: 'failed',
    reason: 'no_target',
    url: null,
    ms: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(
    feed.join('\n'),
    /Уже зроблено: ↺ виберу «M» у «Розмір», ⇄ натисну «В кошик»/
  );
  assert.equal(ui.phase, 'offer');
  assert.deepEqual(ui.offer, { fields: ['Розмір'], manual: ['В кошик'] });
  // «Вернуть» — сервер говорит, что вернуть; загрузчику — номера шагов.
  reply = (path) =>
    path.endsWith('/undo')
      ? {
          fields: [{ i: 0, text: 'Розмір' }],
          manual: [{ i: 1, text: 'В кошик' }],
          refused: null,
        }
      : { chainStatus: 'partially_compensated' };
  toParent.length = 0;
  await pc.offerAnswer(true);
  assert.deepEqual(toParent, [{ type: 'ui-undo', planId: 'p1', idx: [0] }]);
  assert.match(feed.at(-1)!, /Приберіть самі: «В кошик»/);
  pc.onParent({
    type: 'ui-undone',
    planId: 'p1',
    results: [{ i: 0, result: 'done' }],
  });
  await new Promise((r) => setTimeout(r, 5));
  const rep = calls.find((c) => c.path.endsWith('/undo-report'));
  assert.deepEqual(rep?.body, { results: [{ i: 0, result: 'done' }] });
  assert.match(feed.at(-1)!, /Повернув попереднє значення поля «Розмір»/);
  // «Відміни останнє» — прямой путь по последней цепочке вкладки.
  calls.length = 0;
  reply = () => ({ fields: [], manual: [], refused: 'after_pnr' });
  assert.equal(await pc.command('відміни останнє', 'typed', null), true);
  assert.equal(calls[0].path, '/widget/v1/ui-plan/p1/undo');
  assert.deepEqual(calls[0].body, { by: 'command' });
  assert.equal(feed.at(-1), DICTS.uk.vcAfterPnr);
  // Аудит 06.10: двойное «Да» (клик + клик, голос + клик), пока confirm в
  // пути, — один POST и один `ui-run`; кнопки карточки недоступны.
  {
    let cui: UiPlanUi = uiPlanOff();
    const cParent: Array<Record<string, unknown>> = [];
    const cCalls: string[] = [];
    const held: Array<() => void> = [];
    const cc = new UiPlanController({
      ui: () => cui,
      setUi: (p) => (cui = { ...cui, ...p }),
      t: () => DICTS.uk,
      lang: () => 'uk',
      cfg: () => ({
        mode: 'on',
        denySelectors: [],
        allowSelectors: [],
        maxSteps: 6,
        memos: false,
      }),
      api: async (_m, path) => {
        cCalls.push(path);
        if (path === '/widget/v1/ui-plan')
          return { ...view, status: 'proposed' };
        await new Promise<void>((r) => held.push(r));
        return { ...view, status: 'confirmed' };
      },
      toParent: (m) => cParent.push(m as unknown as Record<string, unknown>),
      conversationId: () => null,
      setConversation: () => undefined,
      feed: () => undefined,
      storage: (_k, n) => (n === 'vcconsent' ? '1' : null),
      pageUrl: () => 'https://shop.example.com/p/1',
      listen: () => undefined,
      random: () => 'q'.repeat(16),
    });
    setTimeout(() => {
      const m = cParent.find((x) => x.type === 'ui-snap');
      if (m)
        cc.onParent({
          type: 'ui-snapshot',
          rid: m.rid as string,
          snapshot: { url: 'https://shop.example.com/p/1', elements: [] },
        });
    }, 0);
    await cc.command('надішли заявку', 'typed', null);
    assert.equal(cui.phase, 'confirm');
    const c1 = cc.confirm(true);
    const c2 = cc.confirm(true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      cui.busy,
      true,
      'кнопки «Да/Ні» недоступны, пока confirm в пути'
    );
    // Отпускаем ВСЕ ответы: и второй POST (если бы он ушёл) завершится.
    for (const r of held.splice(0)) r();
    await Promise.all([c1, c2]);
    assert.equal(
      cCalls.filter((p) => p.endsWith('/confirm')).length,
      1,
      'один POST confirm'
    );
    assert.equal(
      cParent.filter((m) => m.type === 'ui-run').length,
      1,
      'один ui-run'
    );
    assert.equal(cui.busy, false);
  }
  console.log(
    'ui-plan (д)+(е): решения владельца, «отмени последнее», словарь без «откатил», протокол возврата, пометки ↺/⇄/⚠, второе «Да», «Вернуть/Оставить» — ok'
  );
  finished = true;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
