/**
 * Чистая часть «Админки: действия» (Э8): хеш, карточка «было → станет»,
 * слово danger, сумма, «без вашей просьбы», ссылки компенсации,
 * подпись, статусы; импорт OpenAPI с телом и `x-assist-*`.
 */
import { createHmac } from 'crypto';
import {
  checkLinks,
  detectAmountParam,
  parseOpenApi,
  OpenApiImportError,
  type OperationParam,
} from '../assist-admin-mode/openapi-import';
import { validateArgs } from '../assist-admin-mode/connector-exec';
import {
  ACTION_LIMITS,
  ACTION_TEXT,
  amountOf,
  cardShowsAllArgs,
  apiErrorText,
  confirmPhraseFor,
  effectiveStatus,
  itemsCount,
  jsonAt,
  linkedArgs,
  normalizePhrase,
  proposalFields,
  proposalHash,
  requestedByEmployee,
  signRequest,
} from './action-core';

const P: OperationParam[] = [
  { name: 'id', in: 'path', required: true, type: 'string' },
  { name: 'status', in: 'body', required: true, type: 'string' },
  { name: 'ids', in: 'body', required: false, type: 'array', items: 'string' },
];

describe('action-core', () => {
  it('хеш: порядок ключей не важен, значение — важно, операция — важна', () => {
    const a = proposalHash('op1', { id: '1', status: 'paid' });
    expect(proposalHash('op1', { status: 'paid', id: '1' })).toBe(a);
    expect(proposalHash('op1', { id: '1', status: 'shipped' })).not.toBe(a);
    expect(proposalHash('op2', { id: '1', status: 'paid' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('карточка: все строки массива, «было» — из preview (верх и data.*), id пути без «было»', () => {
    const f = proposalFields(
      P,
      { id: '7', status: 'shipped', ids: ['1', '2', '3', '4', '5'] },
      { data: { status: 'paid' }, id: '7' },
    );
    expect(f).toEqual([
      { name: 'id', in: 'path', after: '7' },
      { name: 'status', in: 'body', before: 'paid', after: 'shipped' },
      {
        name: 'ids',
        in: 'body',
        before: null,
        after: ['1', '2', '3', '4', '5'],
      },
    ]);
    // Без preview — ни одного «было».
    expect(proposalFields(P, { id: '7', status: 'x' }, undefined)[1]).toEqual({
      name: 'status',
      in: 'body',
      after: 'x',
    });
    // Аудит Э8: аргумент максимальной длины (500 в validateArgs) — целиком,
    // без невидимого хвоста; длиннее (только «было» из снимка) — усечён.
    const full = proposalFields(
      P,
      { id: 'x', status: 'y'.repeat(500) },
      undefined,
    );
    expect(full[1].after).toBe('y'.repeat(500));
    const long = proposalFields(
      P,
      { id: 'x', status: 'y'.repeat(600) },
      undefined,
    );
    expect((long[1].after as string).length).toBe(
      ACTION_LIMITS.fieldValueChars + 1,
    );
    // Аргументов больше, чем строк карточки, — не предлагается.
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, i]));
    expect(cardShowsAllArgs(many(ACTION_LIMITS.fieldsMax))).toBe(true);
    expect(cardShowsAllArgs(many(ACTION_LIMITS.fieldsMax + 1))).toBe(false);
    // bidi/невидимые символы не прячут отправляемое значение.
    expect(
      proposalFields(P, { id: 'x', status: 'ok\u202Edap\u200B' }, undefined)[1]
        .after,
    ).toBe('ok\ufffddap\ufffd');
  });

  it('слово danger: слово владельца или «ПІДТВЕРДЖУЮ» + число строк; нормализация', () => {
    expect(confirmPhraseFor(null, 'uk', { ids: ['a', 'b', 'c'] })).toBe(
      'ПІДТВЕРДЖУЮ 3',
    );
    expect(confirmPhraseFor('скасувати', 'uk', { id: '1' })).toBe(
      'СКАСУВАТИ 1',
    );
    expect(confirmPhraseFor(null, 'ru', {})).toBe('ПОДТВЕРЖДАЮ 1');
    expect(normalizePhrase('  подтверждаю,   3! ')).toBe('ПОДТВЕРЖДАЮ 3');
    expect(normalizePhrase('Ёлка')).toBe('ЕЛКА');
    expect(itemsCount({ a: [1, 2], b: [1, 2, 3, 4] })).toBe(4);
  });

  it('сумма: нет параметра — null; не указана — missing; модуль числа', () => {
    expect(amountOf(null, { amount: 5 })).toBeNull();
    expect(amountOf('amount', {})).toBe('missing');
    expect(amountOf('amount', { amount: 'abc' })).toBe('missing');
    expect(amountOf('amount', { amount: '-120.5' })).toBe(120.5);
  });

  it('«без вашей просьбы»: write — глагол изменения, danger — только разрушительный', () => {
    expect(requestedByEmployee('Зміни статус 1042 на shipped', 'write')).toBe(
      true,
    );
    expect(requestedByEmployee('Поменяй адрес доставки', 'write')).toBe(true);
    expect(requestedByEmployee('ок, дякую', 'write')).toBe(false);
    expect(requestedByEmployee('Покажи замовлення 1042', 'danger')).toBe(false);
    expect(requestedByEmployee('Зміни статус 1042', 'danger')).toBe(false);
    expect(requestedByEmployee('Видали замовлення 1042', 'danger')).toBe(true);
    expect(requestedByEmployee('Отмени заказ 5', 'danger')).toBe(true);
    expect(requestedByEmployee('please refund order 5', 'danger')).toBe(true);
  });

  it('ссылки компенсации: $.request и $.preview, отсутствующее значение — null', () => {
    const link = {
      operationId: 'updateOrderStatus',
      params: { id: '$.request.id', status: '$.preview.status' },
    };
    expect(
      linkedArgs(link, { id: '7', status: 'x' }, { status: 'paid' }),
    ).toEqual({
      id: '7',
      status: 'paid',
    });
    expect(linkedArgs(link, { id: '7' }, null)).toBeNull();
    expect(
      linkedArgs(
        { operationId: 'x', params: { a: '$.preview.obj' } },
        {},
        { obj: { k: 1 } },
      ),
    ).toBeNull();
    expect(jsonAt({ a: [{ b: 2 }] }, 'a[0].b')).toBe(2);
    expect(jsonAt({ a: 1 }, '__proto__')).toBeUndefined();
  });

  it('подпись: метод, ключ идемпотентности и адрес в строке', () => {
    const a = signRequest('s', 'patch', 'k-1', '/v1/x?y=1', '{}', 100.9);
    expect(a).toMatch(/^t=100,v1=[0-9a-f]{64}$/);
    expect(signRequest('s', 'POST', 'k-1', '/v1/x?y=1', '{}', 100)).not.toBe(a);
    // Аудит Э8: тот же запрос с другим Idempotency-Key — другая подпись
    // (повтор в окне времени не обходит дедупликацию получателя).
    expect(signRequest('s', 'PATCH', 'k-2', '/v1/x?y=1', '{}', 100)).not.toBe(
      a,
    );
    expect(a).toBe(
      `t=100,v1=${createHmac('sha256', 's').update('100.PATCH.k-1./v1/x?y=1.{}').digest('hex')}`,
    );
  });

  it('статус: просрочено и зависшее исполнение', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(
      effectiveStatus(
        {
          status: 'pending',
          expiresAt: new Date(now.getTime() - 1),
          decidedAt: null,
        },
        now,
      ),
    ).toBe('expired');
    expect(
      effectiveStatus(
        {
          status: 'executing',
          expiresAt: now,
          decidedAt: new Date(now.getTime() - 61_000),
        },
        now,
      ),
    ).toBe('unknown');
    expect(
      effectiveStatus(
        { status: 'done', expiresAt: new Date(0), decidedAt: null },
        now,
      ),
    ).toBe('done');
  });

  it('текст ошибки API: message из JSON, без HTML/управляющих, маска, усечение', () => {
    expect(apiErrorText('{"error":{"message":"bad <b>x</b>"}}', (s) => s)).toBe(
      'bad x',
    );
    expect(apiErrorText('x'.repeat(400), (s) => s)!.length).toBe(
      ACTION_LIMITS.errorTextChars + 1,
    );
    expect(
      apiErrorText('mail a@b.ua', (s) => s.replace(/\S+@\S+/, '[e]')),
    ).toBe('mail [e]');
  });

  it('тексты серверных действий не обещают «откатил/отменил» (§5-бис.15 п.10)', () => {
    const all = JSON.stringify(ACTION_TEXT, (_k, v) =>
      typeof v === 'function' ? v('X', null) : v,
    );
    expect(all).not.toMatch(/откатил|відкотив|rolled back|вернул как было/i);
  });
});

describe('openapi-import Э8: тело, x-assist-*, денежный параметр', () => {
  const base = (paths: unknown) =>
    JSON.stringify({
      openapi: '3.0.3',
      servers: [{ url: 'https://api.x.example/v1' }],
      paths,
    });
  const body = (props: Record<string, unknown>, required: string[] = []) => ({
    required: true,
    content: {
      'application/json': {
        schema: { type: 'object', required, properties: props },
      },
    },
  });

  it('тело JSON: скаляры и массивы скаляров; вложенный обязательный — unsupported', () => {
    const s = parseOpenApi(
      base({
        '/a': {
          post: {
            operationId: 'createA',
            requestBody: body(
              {
                name: { type: 'string', maxLength: 20 },
                tags: { type: 'array', items: { type: 'string' } },
                n: { type: 'integer' },
              },
              ['name'],
            ),
          },
        },
        '/b': {
          post: {
            operationId: 'createB',
            requestBody: body({ addr: { type: 'object', properties: {} } }, [
              'addr',
            ]),
          },
        },
      }),
    );
    const a = s.operations.find((o) => o.operationId === 'createA')!;
    expect(a.params).toEqual([
      {
        name: 'name',
        in: 'body',
        required: true,
        type: 'string',
        maxLength: 20,
      },
      {
        name: 'tags',
        in: 'body',
        required: false,
        type: 'array',
        items: 'string',
        maxItems: 100,
      },
      { name: 'n', in: 'body', required: false, type: 'integer' },
    ]);
    expect(a.unsupported).toBe(false);
    expect(
      s.operations.find((o) => o.operationId === 'createB')!.unsupported,
    ).toBe(true);
    expect(validateArgs(a.params, { name: 'x', tags: ['a'], n: '5' })).toEqual({
      path: {},
      query: {},
      body: { name: 'x', tags: ['a'], n: 5 },
    });
  });

  it('x-assist-compensation: нет операции / ниже классом / не отображён обязательный / $.preview без preview — отказ импорта', () => {
    const paths = (comp: unknown, preview?: unknown) => ({
      '/o/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: { operationId: 'getO' },
        patch: {
          operationId: 'setO',
          requestBody: body({ s: { type: 'string' } }, ['s']),
          'x-assist-compensation': comp,
          ...(preview ? { 'x-assist-preview': preview } : {}),
        },
        delete: { operationId: 'delO', 'x-assist-compensation': undefined },
      },
      '/o/{id}/restore': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        post: { operationId: 'restoreO' },
      },
    });
    const bad = (p: unknown, re: RegExp) => {
      let err: unknown = null;
      try {
        parseOpenApi(base(p));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OpenApiImportError);
      expect((err as Error).message).toMatch(re);
    };
    bad(paths({ operationId: 'nope', params: {} }), /nope/);
    bad(
      paths({ operationId: 'setO', params: { id: '$.request.id' } }),
      /не отображён/,
    );
    bad(
      paths({
        operationId: 'setO',
        params: { id: '$.request.id', s: '$.preview.s' },
      }),
      /x-assist-preview/,
    );
    bad(
      paths({
        operationId: 'setO',
        params: { id: '$.request.zzz', s: '$.request.s' },
      }),
      /zzz/,
    );
    bad(
      paths({
        operationId: 'setO',
        params: { id: 'javascript:1', s: '$.request.s' },
      }),
      /x-assist-compensation/,
    );
    bad(
      paths(
        {
          operationId: 'setO',
          params: { id: '$.request.id', s: '$.request.s' },
        },
        { operationId: 'setO', params: { id: '$.request.id' } },
      ),
      /не чтение/,
    );
    const ok = parseOpenApi(
      base(
        paths(
          {
            operationId: 'setO',
            params: { id: '$.request.id', s: '$.preview.s' },
          },
          { operationId: 'getO', params: { id: '$.request.id' } },
        ),
      ),
    );
    const setO = ok.operations.find((o) => o.operationId === 'setO')!;
    expect(setO.compensation?.operationId).toBe('setO');
    expect(setO.preview?.operationId).toBe('getO');
    // danger, компенсируемая write — ниже классом.
    const lower = checkLinks(
      {
        operationId: 'delO',
        params: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        kind: 'danger',
        preview: null,
        compensation: {
          operationId: 'restoreO',
          params: { id: '$.request.id' },
        },
      },
      () => ({
        kind: 'write',
        params: [{ name: 'id', in: 'path', required: true, type: 'string' }],
      }),
    );
    expect(lower?.problem).toMatch(/ниже классом/);
  });

  it('денежный параметр — только числовой у изменяющей операции', () => {
    const num = (name: string): OperationParam => ({
      name,
      in: 'body',
      required: true,
      type: 'number',
    });
    expect(detectAmountParam('danger', [num('amount')])).toBe('amount');
    expect(detectAmountParam('write', [num('refund_amount')])).toBe(
      'refund_amount',
    );
    expect(detectAmountParam('write', [num('total')])).toBe('total');
    expect(detectAmountParam('read', [num('amount')])).toBeNull();
    expect(detectAmountParam('write', [num('quantity')])).toBeNull();
    expect(
      detectAmountParam('write', [{ ...num('amount'), type: 'string' }]),
    ).toBeNull();
  });

  it('x-assist-idempotent', () => {
    const s = parseOpenApi(
      base({
        '/n': { post: { operationId: 'addN', 'x-assist-idempotent': true } },
      }),
    );
    expect(s.operations[0].idempotent).toBe(true);
  });
});
