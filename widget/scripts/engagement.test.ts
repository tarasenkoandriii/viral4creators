/**
 * Э3: разбор вовлечения, целей, передачи и сценариев на клиенте
 * (shared/engagement.ts, shared/scenarios.ts). Ловит: выключенные и
 * Э3-бис-триггеры, минимум 10 с, маски не с «/», шаг оплаты исключён
 * всегда, детекторы сервера (s2s/builtin) не доходят до загрузчика,
 * сценарий с битым шагом/ссылкой не на https — отбрасывается целиком.
 */
import assert from 'node:assert/strict';
import {
  parseEngagement,
  parseGoals,
  parseHandoff,
  MESSENGER_HREF,
} from '../src/shared/engagement';
import { parseScenarios } from '../src/shared/scenarios';
import { parsePublicConfig } from '../src/shared/config';

const trig = (o: Record<string, unknown>) => ({
  key: 'delivery',
  enabled: true,
  condition: { kind: 'time_on_page', seconds: 15 },
  pathMasks: ['/catalog/*'],
  text: { ru: 'Подсказать?', uk: 'Підказати?' },
  onAccept: { kind: 'prefill', question: { ru: 'Доставка?' } },
  ...o,
});

const e = parseEngagement({
  triggers: [
    trig({}),
    trig({ key: 'off', enabled: false }),
    trig({ key: 'early', condition: { kind: 'time_on_page', seconds: 2 } }),
    trig({ key: 'cart', condition: { kind: 'cart_exit' } }),
    trig({ key: 'ret', condition: { kind: 'return_visit' } }),
    trig({ key: 'Bad Key' }),
    trig({ key: 'notext', text: {} }),
    trig({ key: 'mask', pathMasks: ['catalog', '/ok'] }),
    trig({ key: 'acc', onAccept: { kind: 'send' } }),
    trig({
      key: 'scen',
      onAccept: { kind: 'scenario', scenarioKey: 'pick-tour' },
      condition: { kind: 'url_match', pathMask: '/tours*', seconds: 20 },
    }),
  ],
  limits: { perVisit: 2, excludedPaths: ['/cart'] },
});
assert.deepEqual(
  e.triggers.map((t) => t.key),
  ['delivery', 'early', 'mask', 'scen'],
  'выключенные, Э3-бис, без текста, с чужим действием — мимо'
);
assert.equal(
  (e.triggers[1].cond as { seconds: number }).seconds,
  10,
  'не раньше 10 с'
);
assert.deepEqual(e.triggers[2].pathMasks, ['/ok'], 'маска — только с «/»');
assert.equal(e.perVisit, 2);
assert.ok(e.excludedPaths.includes('/checkout*'), 'шаг оплаты — всегда');
assert.ok(e.excludedPaths.includes('/cart'));
assert.equal(parseEngagement({ limits: { perVisit: 5 } }).perVisit, 1);

const goals = parseGoals([
  {
    key: 'purchase',
    detectors: [
      { kind: 'url', config: { pathMask: '/thanks', fromPathMask: '/cart' } },
      { kind: 's2s', config: {} },
      { kind: 'builtin', config: { event: 'lead' } },
      { kind: 'js', config: {} },
    ],
  },
  { key: 'call', detectors: [{ kind: 'click', config: { auto: 'tel' } }] },
  {
    key: 'buy',
    detectors: [
      {
        kind: 'click',
        config: {
          descriptor: { role: 'button', text: '  Оформить   ЗАКАЗ ' },
          pathMask: null,
        },
      },
    ],
  },
  { key: 'only-s2s', detectors: [{ kind: 's2s', config: {} }] },
  { key: 'Bad', detectors: [{ kind: 'js', config: {} }] },
]);
assert.deepEqual(
  goals.map((g) => [g.key, g.detectors.map((d) => d.kind)]),
  [
    ['purchase', ['url', 'js']],
    ['call', ['auto']],
    ['buy', ['click']],
  ]
);
assert.equal(
  (goals[2].detectors[0] as { descriptor: { text: string } }).descriptor.text,
  'оформить заказ',
  'текст дескриптора — без регистра, пробелы схлопнуты'
);

assert.deepEqual(
  parseHandoff({ enabled: true, etaMinutes: 4, etaText: { ru: '~4 мин' } }),
  {
    enabled: true,
    etaMinutes: 4,
    etaText: { ru: '~4 мин' },
  }
);
assert.equal(
  parseHandoff({ enabled: 'yes', etaMinutes: -1 })!.etaMinutes,
  null
);
assert.equal(parseHandoff(null), null);

// Конфиг Э2 (без полей Э3) — умолчания.
const old = parsePublicConfig({ status: 'active', config: {} });
assert.deepEqual(old.goals, []);
assert.equal(old.handoff, null);
assert.deepEqual(old.engagement.triggers, []);

for (const ok of [
  'https://t.me/shop',
  'https://wa.me/380',
  'viber://chat?number=1',
  'https://api.whatsapp.com/send',
])
  assert.ok(MESSENGER_HREF.test(ok), ok);
assert.ok(!MESSENGER_HREF.test('https://evil.example/t.me/'));

const step = {
  key: 'where',
  question: { ru: 'Куда?' },
  answer: { type: 'choice', options: [{ key: 'sea', label: { ru: 'Море' } }] },
};
const scen = (o: Record<string, unknown>) => ({
  key: 'pick',
  enabled: true,
  title: { ru: 'Подобрать' },
  steps: [step],
  final: { kind: 'lead' },
  showInGreeting: true,
  ...o,
});
const sc = parseScenarios({
  scenarios: [
    scen({}),
    scen({ key: 'off', enabled: false }),
    scen({ key: 'badstep', steps: [{ ...step, answer: { type: 'date' } }] }),
    scen({
      key: 'http',
      final: { kind: 'link', url: 'http://x', label: { ru: 'x' } },
    }),
    scen({
      key: 'js',
      final: { kind: 'link', url: 'javascript:alert(1)', label: { ru: 'x' } },
    }),
  ],
});
assert.deepEqual(
  sc.map((s) => s.key),
  ['pick'],
  'выключенный, битый шаг, ссылка не https — мимо'
);
const sc2 = parseScenarios({
  scenarios: [
    scen({
      key: 'link',
      final: {
        kind: 'link',
        url: 'https://shop.ua/a',
        label: { ru: 'В каталог' },
      },
    }),
    scen({
      key: 'num',
      steps: [
        {
          key: 'n',
          question: { ru: 'Сколько?' },
          answer: { type: 'number', min: 1, max: 'x' },
        },
      ],
    }),
    ...Array.from({ length: 5 }, (_, i) => scen({ key: 'more' + i })),
  ],
});
assert.deepEqual(
  sc2.map((s) => s.key),
  ['link', 'num', 'more0', 'more1', 'more2'],
  'не больше 5'
);
assert.deepEqual(sc2[1].steps[0].answer, { type: 'number', min: 1, max: null });

console.log('engagement: триггеры, лимиты, цели, передача, сценарии — ок');
