/**
 * Э6-бис (е): мемо в TMA — статусы и коды ворот те же, что у сервера,
 * словари uk/ru/en покрывают их, разбор строгий, клиент ходит по маршрутам
 * контроллера и не пропускает чужие идентификаторы в путь.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { ApiError, type AccountMember, type ApiClient } from '../src/kit';
import {
  memoReadOnly,
  MEMO_GATE_CODES,
  MEMO_STATUSES,
  MEMO_VERSION_STATUSES,
  createMemoApi,
  memoEditorFocus,
  MEMO_PHRASE_DROPS,
  parseMemoDetail,
  parseMemoElements,
  parseMemoList,
  parseMemoSummary,
  parsePhraseSuggest,
} from '../src/lib/memo-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');
const quoted = (src: string, re: RegExp) => {
  const m = re.exec(src);
  assert.ok(m, `нет ${re} на сервере`);
  return [...m![1].matchAll(/'([A-Za-z_-]+)'/g)].map((x) => x[1]);
};

// 1. Повтор типов сервера.
{
  const core = read('assist-ui-core/memo.ts');
  assert.deepEqual(quoted(core, /MEMO_STATUSES = \[([\s\S]*?)\] as const/), [
    ...MEMO_STATUSES,
  ]);
  assert.deepEqual(
    quoted(core, /MEMO_VERSION_STATUSES = \[([\s\S]*?)\] as const/),
    [...MEMO_VERSION_STATUSES]
  );
  assert.deepEqual(
    quoted(core, /export type MemoGateCode =([^;]+);/).sort(),
    [...MEMO_GATE_CODES].sort()
  );
}

// 2. Словари: каждый статус и код ворот — на трёх языках.
for (const d of [appUk, appRu, appEn]) {
  const m = d.voiceControl.memo as unknown as {
    status: Record<string, string>;
    gates: Record<string, string>;
  };
  for (const s of MEMO_STATUSES) assert.ok(m.status[s], `нет статуса ${s}`);
  for (const c of MEMO_GATE_CODES) assert.ok(m.gates[c], `нет ворот ${c}`);
}

// 2-бис. Оператору — плашка «редактирует владелец/менеджер» вместо 403
// (запрос не уходит); владельцу и менеджеру — раздел; 403 сервера — плашка.
{
  const me = (role: string, assist: string) =>
    ({
      memberId: 'm1',
      telegramId: '1',
      role,
      productRoles: { qa: 'none', assist, assistAdmin: 'none' },
    }) as unknown as AccountMember;
  assert.equal(memoReadOnly(me('operator', 'manager'), null), true);
  assert.equal(memoReadOnly(me('manager', 'operator'), null), true);
  assert.equal(memoReadOnly(me('owner', 'operator'), null), false);
  assert.equal(memoReadOnly(me('manager', 'manager'), null), false);
  assert.equal(
    memoReadOnly(
      me('manager', 'manager'),
      new ApiError('PRODUCT_ROLE_REQUIRED', 'x', 403)
    ),
    true
  );
  assert.equal(
    memoReadOnly(me('manager', 'manager'), new ApiError('X', 'x', 500)),
    false
  );
  for (const d of [appUk, appRu, appEn]) {
    const m = d.voiceControl.memo as unknown as {
      readOnly: string;
      review: Record<string, string>;
    };
    assert.ok(m.readOnly && m.review.voice_map);
  }
}

// 3. Разбор строгий.
{
  assert.equal(parseMemoSummary({ number: 1, status: 'evil' }), null);
  assert.equal(parseMemoSummary({ number: '1', status: 'draft' }), null);
  const l = parseMemoList({
    items: [{ number: 2, status: 'published', key: 'cart' }, 5, null],
    used: 1,
    limit: 'x',
  });
  assert.equal(l.items.length, 1);
  assert.equal(l.items[0].number, 2);
  assert.equal(l.limit, 0);
}

// 3-бис. Правка с телефона и ИИ-фразы: «Відкрити в редакторі» с шагом
// (needs_review — шаг причины, карта — шаг с этой целью; маска — без пути),
// разбор элементов и отчёта фраз, причины отсева — те же, что у сервера.
{
  const step = (page: string, mapKey: string | null = null) => ({
    page,
    action: 'click',
    target: { pin: { text: 'x', role: 'button' }, mapKey },
  });
  const detail = (over: Record<string, unknown>) =>
    parseMemoDetail({
      number: 7,
      status: 'draft',
      draft: {
        steps: [step('/catalog/*'), step('/product/1', 'buy'), step('/cart')],
      },
      ...over,
    })!;
  assert.deepEqual(memoEditorFocus(detail({})), { focus: 'memo-7-1' });
  assert.deepEqual(
    memoEditorFocus(
      detail({
        status: 'needs_review',
        reviewReason: { code: 'failures', step: 2 },
      })
    ),
    { focus: 'memo-7-3', path: '/cart' }
  );
  assert.deepEqual(
    memoEditorFocus(
      detail({
        status: 'needs_review',
        reviewReason: { code: 'voice_map', key: 'buy' },
      })
    ),
    { focus: 'memo-7-2', path: '/product/1' }
  );
  // Шаг за пределами — первый; не needs_review — шаг причины не берётся.
  assert.equal(
    memoEditorFocus(
      detail({
        status: 'needs_review',
        reviewReason: { code: 'failures', step: 40 },
      })
    ).focus,
    'memo-7-1'
  );
  assert.equal(
    memoEditorFocus(detail({ reviewReason: { code: 'failures', step: 2 } }))
      .focus,
    'memo-7-1'
  );
  // Формат панели редактора: /^memo-(\d{1,6})(?:-(\d{1,2}))?$/.
  assert.ok(/^memo-\d{1,6}-\d{1,2}$/.test(memoEditorFocus(detail({})).focus));

  const el = parseMemoElements({
    page: '/product/1',
    view: 'mobile',
    items: [
      { uiElementId: 'el_1', label: 'В кошик', action: 'click', stale: true },
      { uiElementId: '../x', label: 'evil' },
      5,
    ],
  });
  assert.equal(el.view, 'mobile');
  assert.equal(el.items.length, 1);
  assert.equal(el.items[0].stale, true);

  const ps = parsePhraseSuggest({
    memo: { number: 1, status: 'draft', draft: {} },
    report: {
      langs: ['uk', 'de'],
      kept: { uk: 3, ru: 'x' },
      dropped: { text: 2, evil: 1 },
    },
  });
  assert.deepEqual(ps.langs, ['uk']);
  assert.deepEqual(ps.kept, { uk: 3 });
  assert.deepEqual(ps.dropped, { text: 2 });
  const core = read('assist-site-voice-control/cabinet/memo-phrase-suggest.ts');
  assert.deepEqual(quoted(core, /export type PhraseDropCode =([^;]+);/), [
    ...MEMO_PHRASE_DROPS,
  ]);
  for (const d of [appUk, appRu, appEn]) {
    const m = d.voiceControl.memo;
    assert.ok(m.addStep && m.replaceTarget && m.openEditor && m.suggestPhrases);
    assert.ok(m.openEditorStep.includes('{n}'));
    assert.ok(m.suggestDone.includes('{list}'));
    for (const a of ['click', 'fill', 'select', 'check'] as const)
      assert.ok(m.pickActions[a], a);
  }
}

// 4. Клиент: маршруты контроллера, опасные идентификаторы не уходят в путь.
void (async () => {
  const calls: string[] = [];
  const client = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith('/check-token'))
        return { url: 'javascript:alert(1)', version: 1 };
      return {};
    },
  } as unknown as ApiClient;
  const api = createMemoApi(client);
  await api.list('s1');
  await api.build('s1', 3);
  await api.publish('s1', 3, 2);
  await api.stats('s1', 3, 7);
  await api.remove('s1', 3);
  await api.fromSuggestion('s1', 'p_1');
  await api.elements('s1', 3, { step: 1 });
  await api.elements('s1', 3, { page: '/catalog/*' });
  await api.applyElement('s1', 3, {
    expectedRevision: 2,
    uiElementId: 'el_1',
    mode: 'add',
  });
  await api.suggestPhrases('s1', 3, 4);
  assert.deepEqual(calls, [
    'GET /assist/sites/s1/memos',
    'POST /assist/sites/s1/memos/3/versions',
    'POST /assist/sites/s1/memos/3/versions/2/publish',
    'GET /assist/sites/s1/memos/3/stats?days=7',
    'DELETE /assist/sites/s1/memos/3',
    'POST /assist/sites/s1/memo-suggestions/p_1',
    'GET /assist/sites/s1/memos/3/elements?step=1',
    'GET /assist/sites/s1/memos/3/elements?page=%2Fcatalog%2F*',
    'POST /assist/sites/s1/memos/3/steps/element',
    'POST /assist/sites/s1/memos/3/suggest-phrases',
  ]);
  await assert.rejects(
    api.applyElement('s1', 3, {
      expectedRevision: 2,
      uiElementId: '../x',
      mode: 'add',
    })
  );
  // Маршруты правки с телефона и фраз — в контроллере.
  const tma = read(
    'assist-site-voice-control/cabinet/memo-tma-edit.controller.ts'
  );
  for (const r of [
    "':id/memos/:n/elements'",
    "':id/memos/:n/steps/element'",
    "':id/memos/:n/suggest-phrases'",
  ])
    assert.ok(tma.includes(r), r);
  await assert.rejects(api.list('../x'));
  await assert.rejects(api.get('s1', 0));
  await assert.rejects(api.fromSuggestion('s1', 'a/b'));
  // Ссылка проверки — только https.
  await assert.rejects(api.checkToken('s1', 3));
  // Маршруты клиента есть в контроллере.
  const ctl = read('assist-site-voice-control/cabinet/memo.controller.ts');
  for (const r of [
    "':id/memos'",
    "':id/memos/:n/versions'",
    "':id/memos/:n/versions/:v/publish'",
    "':id/memos/:n/stats'",
    "':id/memo-suggestions/:planId'",
    "':id/memos/:n/check-token'",
  ])
    assert.ok(ctl.includes(r), r);
  console.log('memo-api: типы сервера, словари, разбор, клиент — ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
