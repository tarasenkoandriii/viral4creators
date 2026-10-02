/**
 * Строгий разбор публичных тел Э3 виджета (W): пакет счётчиков, цель,
 * дескриптор выбора цели, identify, openedBy. Чистые функции — без базы.
 */
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import {
  cleanIdentity,
  cleanOpenedBy,
  cleanPath,
  countableEvents,
  engagementKeys,
  pageBody,
  parseDescriptor,
  parseEventBatch,
  parseGoalRequest,
  parsePick,
} from './widget-engagement';

const PK = `${WIDGET_PK_LIVE_PREFIX}abcdefgh12345678`;

describe('parseEventBatch (POST /widget/v1/event)', () => {
  it('принимает белый список видов, ключ — формат ENGAGEMENT_KEY или null', () => {
    expect(
      parseEventBatch({
        pk: PK,
        events: [
          { kind: 'widget_view', key: null },
          { kind: 'proactive_shown', key: 'delivery-help' },
          { kind: 'open' },
        ],
      }),
    ).toEqual({
      pk: PK,
      events: [
        { kind: 'widget_view', key: null },
        { kind: 'proactive_shown', key: 'delivery-help' },
        { kind: 'open', key: null },
      ],
    });
  });

  it.each([
    [
      'неизвестное поле пакета',
      { pk: PK, events: [{ kind: 'open', key: null }], visitor: 'v1' },
    ],
    [
      'неизвестное поле события',
      { pk: PK, events: [{ kind: 'open', key: null, url: '/x' }] },
    ],
    ['неизвестный вид', { pk: PK, events: [{ kind: 'page_view', key: null }] }],
    [
      'ключ не по формату',
      { pk: PK, events: [{ kind: 'proactive_shown', key: 'Bad Key' }] },
    ],
    ['пустой пакет', { pk: PK, events: [] }],
    [
      'больше 20 событий',
      {
        pk: PK,
        events: Array.from({ length: 21 }, () => ({ kind: 'open', key: null })),
      },
    ],
    ['pk не строка', { pk: 1, events: [{ kind: 'open', key: null }] }],
  ])('%s → null (400 EVENT_INVALID)', (_n, body) => {
    expect(parseEventBatch(body)).toBeNull();
  });

  it('счётчик пишется только с ключом включённого триггера/сценария', () => {
    const keys = engagementKeys({
      engagement: {
        triggers: [
          { key: 't1', enabled: true },
          { key: 't-off', enabled: false },
        ],
        scenarios: [{ key: 's1', enabled: true }],
      },
    });
    expect(
      countableEvents(
        [
          { kind: 'proactive_shown', key: 't1' },
          { kind: 'proactive_shown', key: 't-off' },
          { kind: 'proactive_shown', key: 'made-up' },
          { kind: 'scenario_started', key: 's1' },
          { kind: 'scenario_done', key: 't1' },
          { kind: 'open', key: null },
          { kind: 'open', key: 't1' },
        ],
        keys,
      ),
    ).toEqual([
      { kind: 'proactive_shown', key: 't1' },
      { kind: 'scenario_started', key: 's1' },
      { kind: 'open', key: null },
    ]);
  });
});

describe('pageBody (JSON или text/plain от sendBeacon, ≤ 4 КБ)', () => {
  it('строка text/plain разбирается как JSON', () => {
    expect(pageBody('{"pk":"x"}', undefined)).toEqual({ pk: 'x' });
  });
  it('битая строка, массив, > 4 КБ — null', () => {
    expect(pageBody('{pk', undefined)).toBeNull();
    expect(pageBody([1], undefined)).toBeNull();
    expect(pageBody('{"a":"' + 'x'.repeat(5000) + '"}', undefined)).toBeNull();
    expect(pageBody({ a: 'x'.repeat(5000) }, undefined)).toBeNull();
    expect(pageBody({ a: 1 }, '5000')).toBeNull();
  });
});

describe('parseGoalRequest (POST /widget/v1/goal)', () => {
  const base = {
    pk: PK,
    goalKey: 'thanks',
    detector: 'url',
    docId: 'doc_12345678',
    path: '/thanks',
  };

  it('загрузчик: pk обязателен, полей iframe нет', () => {
    const g = parseGoalRequest(base, false);
    expect(g).toMatchObject({
      ok: true,
      pk: PK,
      goalKey: 'thanks',
      orderId: null,
    });
    expect(parseGoalRequest({ ...base, pk: undefined }, false)).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(
      parseGoalRequest(
        { ...base, assist: { proactive: null, scenario: null, link: true } },
        false,
      ),
    ).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(
      parseGoalRequest(
        { ...base, lastAssistClickAt: new Date().toISOString() },
        false,
      ),
    ).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('e-mail/телефон в orderId — GOAL_ORDER_ID_INVALID (422, §5-тер.16 п.1)', () => {
    expect(
      parseGoalRequest({ ...base, orderId: 'ivan@example.com' }, false),
    ).toEqual({
      ok: false,
      code: 'GOAL_ORDER_ID_INVALID',
    });
    expect(
      parseGoalRequest({ ...base, orderId: '+380 67 123 45 67' }, false),
    ).toEqual({
      ok: false,
      code: 'GOAL_ORDER_ID_INVALID',
    });
    expect(
      parseGoalRequest({ ...base, orderId: 'A-1001' }, false),
    ).toMatchObject({
      ok: true,
      orderId: 'A-1001',
    });
  });

  it('путь — без query (там бывает e-mail), неизвестное поле — 400', () => {
    expect(
      parseGoalRequest({ ...base, path: '/thanks?email=a@b.c' }, false),
    ).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(parseGoalRequest({ ...base, extra: 1 }, false)).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(parseGoalRequest({ ...base, detector: 's2s' }, false)).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(parseGoalRequest({ ...base, currency: 'uah' }, false)).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(parseGoalRequest({ ...base, value: -1 }, false)).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
  });

  it('iframe: диалог, клик и assist разрешены', () => {
    const g = parseGoalRequest(
      {
        goalKey: 'thanks',
        detector: 'click',
        docId: 'doc_12345678',
        path: null,
        conversationId: 'c1',
        lastAssistClickAt: '2026-10-02T10:00:00.000Z',
        assist: { proactive: 'p1', scenario: null, link: true },
        value: 10.555,
        currency: 'UAH',
      },
      true,
    );
    expect(g).toMatchObject({
      ok: true,
      pk: null,
      conversationId: 'c1',
      value: 10.56,
      assist: { proactive: 'p1', scenario: null, link: true },
    });
  });
});

describe('parseDescriptor / parsePick (режим выбора цели)', () => {
  it('поле ввода выбрать нельзя (§5-тер.16 п.6)', () => {
    for (const tag of ['input', 'textarea', 'select', 'option']) {
      expect(
        parseDescriptor({
          assistGoal: null,
          assistId: null,
          role: null,
          text: 'x',
          tag,
        }),
      ).toBeNull();
    }
    expect(
      parseDescriptor({ role: 'textbox', text: 'x', tag: 'div' }),
    ).toBeNull();
  });
  it('кнопка с текстом — да; без опоры (нет id и текста) — нет', () => {
    expect(
      parseDescriptor({
        assistGoal: null,
        assistId: null,
        role: 'button',
        text: ' Купить ',
        tag: 'button',
      }),
    ).toEqual({
      assistGoal: null,
      assistId: null,
      role: 'button',
      text: 'Купить',
      tag: 'button',
    });
    expect(parseDescriptor({ role: 'button', tag: 'button' })).toBeNull();
    expect(parseDescriptor({ text: 'x', selector: '#a' })).toBeNull();
  });
  it('pick — строго', () => {
    const ok = {
      pickerSession: 'a'.repeat(43),
      kind: 'click',
      descriptor: {
        assistGoal: 'buy',
        assistId: null,
        role: 'button',
        text: 'Купить',
        tag: 'button',
      },
      path: '/product/1',
      label: 'Купить',
    };
    expect(parsePick(ok)).toMatchObject({ kind: 'click', path: '/product/1' });
    expect(parsePick({ ...ok, kind: 'hover' })).toBeNull();
    expect(parsePick({ ...ok, path: 'product' })).toBeNull();
    expect(parsePick({ ...ok, value: 'secret' })).toBeNull();
  });
});

describe('cleanIdentity (identify → только с лидом/передачей)', () => {
  it('режет до формы WidgetIdentity', () => {
    expect(
      cleanIdentity({
        name: ' Іван ',
        email: 'ivan@example.com',
        externalId: 'cust-42',
        userHash: 'a'.repeat(64),
        phone: '+380671234567',
      }),
    ).toEqual({
      name: 'Іван',
      email: 'ivan@example.com',
      externalId: 'cust-42',
      userHash: 'a'.repeat(64),
    });
  });
  it('неверное поле — null; userHash без externalId — null; пусто — null', () => {
    expect(cleanIdentity({ email: 'not-email', name: 'A' })).toEqual({
      name: 'A',
      email: null,
      externalId: null,
      userHash: null,
    });
    expect(
      cleanIdentity({ name: 'A', userHash: 'b'.repeat(64) })?.userHash,
    ).toBeNull();
    expect(cleanIdentity({ userHash: 'b'.repeat(64) })).toBeNull();
    expect(cleanIdentity('x')).toBeNull();
  });
});

describe('cleanOpenedBy', () => {
  const keys = () => ({
    triggers: new Set(['t1']),
    scenarios: new Set(['s1']),
  });
  it('user и ключи опубликованного вида', () => {
    expect(cleanOpenedBy('user', keys)).toBe('user');
    expect(cleanOpenedBy('proactive:t1', keys)).toBe('proactive:t1');
    expect(cleanOpenedBy('scenario:s1', keys)).toBe('scenario:s1');
  });
  it('чужой ключ/формат — null', () => {
    expect(cleanOpenedBy('proactive:s1', keys)).toBeNull();
    expect(cleanOpenedBy('scenario:zzz', keys)).toBeNull();
    expect(cleanOpenedBy('admin', keys)).toBeNull();
    expect(cleanOpenedBy(5, keys)).toBeNull();
  });
});

describe('cleanPath', () => {
  it('только путь', () => {
    expect(cleanPath('/a/b')).toBe('/a/b');
    expect(cleanPath('a')).toBeNull();
    expect(cleanPath('/a#x')).toBeNull();
    expect(cleanPath('/a\nb')).toBeNull();
  });
});
