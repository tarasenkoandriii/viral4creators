/**
 * Э6-тер (к): «Из обучалки» в TMA — коды отказов те же, что у сервера,
 * тексты есть на трёх языках, клиент ходит по маршрутам контроллера и не
 * пропускает чужие идентификаторы в путь, разбор строгий.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, type ApiClient } from '../src/kit';
import {
  MEMO_TUTORIAL_ERROR_CODES,
  createMemoTutorialApi,
  memoTutorialErrorCode,
  parseMemoFromTutorial,
  parseMemoTutorialList,
} from '../src/lib/memo-tutorial-api';
import { MEMO_TUTORIAL_TEXTS } from '../src/screens/widget/memo-tutorial-texts';

const BACK = new URL(
  '../../sites-backend/src/modules/assist-site-voice-control/cabinet/',
  import.meta.url
);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Коды отказов — те же, что у сервера.
{
  const svc = read('memo-from-tutorial.service.ts');
  const m = /export type MemoTutorialErrorCode =([^;]+);/.exec(svc);
  assert.ok(m, 'нет MemoTutorialErrorCode на сервере');
  const server = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(server, [...MEMO_TUTORIAL_ERROR_CODES].sort());
}

// 2. Тексты: все ключи и все коды — на трёх языках, ключи одинаковые.
{
  const keys = (o: object) => Object.keys(o).sort().join(',');
  const uk = MEMO_TUTORIAL_TEXTS.uk;
  for (const l of ['uk', 'ru', 'en'] as const) {
    const t = MEMO_TUTORIAL_TEXTS[l];
    assert.equal(keys(t), keys(uk), `ключи ${l}`);
    for (const [k, v] of Object.entries(t))
      if (typeof v === 'string') assert.ok(v.trim(), `пусто ${l}.${k}`);
    for (const c of MEMO_TUTORIAL_ERROR_CODES)
      assert.ok(t.errors[c], `нет текста ${l}.${c}`);
  }
}

// 3. Маршруты — как у контроллера; чужие id в путь не уходят.
{
  const ctrl = read('memo-from-tutorial.controller.ts');
  assert.ok(ctrl.includes("@Get(':id/memo-tutorials')"));
  assert.ok(ctrl.includes("@Post(':id/memo-tutorials/:draftId')"));
  const calls: Array<[string, string]> = [];
  const client: ApiClient = {
    request: async <T>(method: string, path: string) => {
      calls.push([method, path]);
      if (method === 'GET')
        return {
          configured: true,
          items: [
            {
              draftId: 'dr_1',
              title: 'Кошик',
              requiresLogin: false,
              memo: null,
            },
            { draftId: '../x', title: 'bad' },
            {
              draftId: 'dr_2',
              title: 'Кабінет',
              memo: { number: 3, status: 'draft' },
            },
          ],
        } as T;
      return {
        memo: {
          number: 7,
          key: 'memo',
          status: 'draft',
          name: 'Кошик',
          view: 'mobile',
          origin: 'tutorial',
          draft: { steps: [] },
          gates: { ok: false, problems: [], risk: [], undo: [] },
          versions: [],
        },
        report: {
          unresolved: [2, 'x', -1],
          slotsOverflow: 1,
          dropped: { login: 4 },
          requiresLogin: true,
        },
      } as T;
    },
  };
  const api = createMemoTutorialApi(client);
  const l = await api.list('site_1');
  assert.equal(l.configured, true);
  assert.deepEqual(
    l.items.map((i) => [i.draftId, i.memo?.number ?? null, i.requiresLogin]),
    [
      ['dr_1', null, false],
      // Нет признака — «за входом» (закрытый отказ).
      ['dr_2', 3, true],
    ]
  );
  const r = await api.create('site_1', 'dr_1');
  assert.equal(r.memo.number, 7);
  assert.deepEqual(r.unresolved, [2]);
  assert.equal(r.droppedLogin, 4);
  assert.equal(r.requiresLogin, true);
  assert.deepEqual(calls, [
    ['GET', '/assist/sites/site_1/memo-tutorials'],
    ['POST', '/assist/sites/site_1/memo-tutorials/dr_1'],
  ]);
  await assert.rejects(api.create('site_1', '../dr'));
  await assert.rejects(api.list('a/b'));
}

// 4. Строгий разбор: мусор — умолчания; черновик без мемо — ошибка.
{
  assert.deepEqual(parseMemoTutorialList(null), {
    configured: false,
    items: [],
  });
  assert.throws(() => parseMemoFromTutorial({ report: {} }));
  assert.equal(
    memoTutorialErrorCode(
      new ApiError('MEMO_TUTORIAL_EXISTS', 'уже есть', 409)
    ),
    'MEMO_TUTORIAL_EXISTS'
  );
  assert.equal(
    memoTutorialErrorCode(new ApiError('SOMETHING', 'x', 500)),
    null
  );
}

console.log('memo-tutorial-api: ok');
