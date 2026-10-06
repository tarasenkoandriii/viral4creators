/**
 * Э6-тер (к): «Голос → Мемо» — шаблоны платформы, публикация пакетом,
 * бейдж «сверх тарифа», условия цели «счётчик/поле», отчёт импорта мемо в
 * файле карты. Разбор строгий, маршруты клиента есть в контроллерах
 * сервера, причины отказов покрыты словарями uk/ru/en.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import type { ApiClient } from '../src/kit';
import {
  goalExpectForSave,
  parseMemoDetail,
  parseMemoSummary,
} from '../src/lib/memo-api';
import {
  MEMO_TEMPLATE_PLATFORMS,
  createMemoTemplatesApi,
  parseMemoBatchPublished,
  parseMemoTemplates,
  parseMemoTemplatesApplied,
} from '../src/lib/memo-templates-api';
import { parseVoiceMapImported } from '../src/lib/voice-map-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Сервер: платформы с шаблонами мемо и коды отказов — те же.
{
  const vm = read('assist-ui-core/voice-map.ts');
  for (const p of MEMO_TEMPLATE_PLATFORMS)
    assert.ok(new RegExp(`\\n  ${p}: \\{[\\s\\S]*?memos: \\[`).test(vm), p);
  const drafts = read('assist-site-voice-control/cabinet/memo-drafts.ts');
  const draftCodes = [...drafts.matchAll(/code: '([a-z_]+)'/g)].map(
    (m) => m[1]
  );
  assert.deepEqual([...new Set(draftCodes)].sort(), [
    'limit',
    'name_taken',
    'no_name',
  ]);
  const io = read('assist-ui-core/memo-io.ts');
  const ioCodes = [...io.matchAll(/no\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ioCodes)].sort(), [
    'format',
    'no_name',
    'too_many',
  ]);
  for (const d of [appUk, appRu, appEn]) {
    const reasons = d.voiceControl.memo.template.reasons as Record<
      string,
      string
    >;
    for (const c of [
      ...draftCodes,
      'MEMO_CHECK_REQUIRED',
      'MEMO_GATES',
      'other',
    ])
      assert.ok(reasons[c], `нет причины ${c}`);
    const imp = d.voiceControl.voiceMap.importReasons as Record<string, string>;
    for (const c of [...draftCodes, ...ioCodes, 'other'])
      assert.ok(imp[c], `нет причины импорта ${c}`);
    assert.ok(d.voiceControl.memo.overPlan && d.voiceControl.memo.overPlanHint);
    assert.ok(/\{t\}.*\{d\}/.test(d.voiceControl.memo.goalCounter));
  }
}

// 2. «Сверх тарифа» и условия цели в черновике (сохраняются при правке).
{
  assert.equal(
    parseMemoSummary({ number: 1, status: 'published', overPlan: true })
      ?.overPlan,
    true
  );
  assert.equal(
    parseMemoSummary({ number: 1, status: 'published', overPlan: 'yes' })
      ?.overPlan,
    false
  );
  const d = parseMemoDetail({
    number: 2,
    status: 'draft',
    draft: {
      goal: {
        expect: [
          {
            kind: 'counter',
            target: { assistId: 'nav-cart', text: '' },
            delta: 1,
          },
          {
            kind: 'field',
            target: { assistId: null, text: 'пошук' },
            slot: 'q',
          },
          { kind: 'counter', target: 'evil', delta: 1.5 },
        ],
      },
    },
  });
  assert.deepEqual(d?.draft.goal.expect, [
    { kind: 'counter', target: { assistId: 'nav-cart', text: '' }, delta: 1 },
    { kind: 'field', slot: 'q', target: { assistId: null, text: 'пошук' } },
    { kind: 'counter' },
  ]);
}

// 2-бис. «Сохранить» карточки не стирает счётчик/поле/слот цели.
{
  const counter = {
    kind: 'counter',
    target: { assistId: 'nav-cart', text: '' },
    delta: 1,
  };
  assert.deepEqual(
    goalExpectForSave(
      [
        { kind: 'url', path: '/old*' },
        { kind: 'text', text: 'старий' },
        counter,
        { kind: 'slot', slot: 'q' },
      ],
      ' /cart* ',
      ''
    ),
    [{ kind: 'url', path: '/cart*' }, counter, { kind: 'slot', slot: 'q' }]
  );
}

// 3. Разбор ответов шаблонов, пакета и импорта — строгий.
{
  const t = parseMemoTemplates({
    platform: 'woocommerce',
    templates: [
      {
        platform: 'woocommerce',
        key: 'open-cart',
        names: { uk: 'Відкрити кошик', de: 'x' },
        goal: { uk: 'Кошик відкрито' },
        exists: true,
      },
      { platform: 'shopify', key: 'x' },
      { platform: 'woocommerce', key: '../evil' },
    ],
  });
  assert.equal(t.platform, 'woocommerce');
  assert.deepEqual(t.templates, [
    {
      platform: 'woocommerce',
      key: 'open-cart',
      names: { uk: 'Відкрити кошик' },
      goal: { uk: 'Кошик відкрито' },
      exists: true,
    },
  ]);
  assert.equal(parseMemoTemplates({ platform: 'tilda' }).platform, null);
  assert.deepEqual(
    parseMemoTemplatesApplied({
      created: [
        { number: 3, key: 'put-in-cart', gates: 'ok' },
        { number: 4, key: 'find-product', gates: ['text', '<b>'] },
        { number: 0, key: 'x', gates: 'ok' },
      ],
      rejected: [{ key: 'open-cart', code: 'name_taken' }],
      unresolved: [{ key: 'find-product', binds: ['search-submit'] }],
    }),
    {
      created: [
        { number: 3, key: 'put-in-cart', gates: 'ok' },
        { number: 4, key: 'find-product', gates: ['text', 'other'] },
      ],
      rejected: [{ key: 'open-cart', code: 'name_taken' }],
      unresolved: [{ key: 'find-product', binds: ['search-submit'] }],
    }
  );
  assert.deepEqual(
    parseMemoBatchPublished({
      results: [
        { number: 2, version: 1, ok: true, code: null },
        { number: 3, version: 1, ok: false, code: 'MEMO_CHECK_REQUIRED' },
        { number: 'x', ok: true },
      ],
    }).results,
    [
      { number: 2, version: 1, ok: true, code: null },
      { number: 3, version: 1, ok: false, code: 'MEMO_CHECK_REQUIRED' },
    ]
  );
  const imp = parseVoiceMapImported({
    accepted: 3,
    rejected: [{}],
    signed: true,
    memos: {
      created: [
        { number: 2, key: 'put-in-cart', name: 'Покласти в кошик' },
        { number: 3, key: 'Bad Key' },
      ],
      rejected: [
        { index: 2, key: 'pay-now', code: 'never_step', path: 'steps[0]' },
        { index: 3, key: null, code: '<script>' },
      ],
    },
  });
  assert.deepEqual(imp, {
    accepted: 3,
    rejected: 1,
    signed: true,
    memos: {
      created: [{ number: 2, key: 'put-in-cart', name: 'Покласти в кошик' }],
      rejected: [
        { index: 2, key: 'pay-now', code: 'never_step' },
        { index: 3, key: null, code: 'other' },
      ],
    },
  });
  // Старый сервер без `memos` — пустой отчёт, не падение.
  assert.deepEqual(parseVoiceMapImported({ accepted: 1 }).memos, {
    created: [],
    rejected: [],
  });
}

// 4. Клиент: маршруты контроллера, чужие идентификаторы не уходят в путь.
void (async () => {
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {};
    },
  } as unknown as ApiClient;
  const api = createMemoTemplatesApi(client);
  await api.list('s1');
  await api.apply('s1', 'woocommerce');
  await api.apply('s1', 'woocommerce', ['open-cart']);
  await api.publishBatch('s1');
  await api.publishBatch('s1', [2, 3]);
  assert.deepEqual(calls, [
    ['GET', '/assist/sites/s1/memo-templates', undefined],
    ['POST', '/assist/sites/s1/memo-templates', { platform: 'woocommerce' }],
    [
      'POST',
      '/assist/sites/s1/memo-templates',
      { platform: 'woocommerce', keys: ['open-cart'] },
    ],
    ['POST', '/assist/sites/s1/memo-batch/publish', {}],
    ['POST', '/assist/sites/s1/memo-batch/publish', { numbers: [2, 3] }],
  ]);
  await assert.rejects(api.list('../x'));
  const ctl = read(
    'assist-site-voice-control/cabinet/memo-templates.controller.ts'
  );
  for (const r of ["':id/memo-templates'", "':id/memo-batch/publish'"])
    assert.ok(ctl.includes(r), `нет маршрута ${r}`);
  console.log(
    'memo-templates-api: шаблоны, пакет, сверх тарифа, условия цели, отчёт импорта — ok'
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
