/**
 * clusterItems — чистая кластеризация очереди (§4-тер.3 п.2, §4-тер.15 п.9):
 * порог косинуса к центроиду, язык, «разные посетители без suspicious»,
 * участники существующих кластеров, детерминированность.
 */
import { bagOfWordsVector } from '../assist-sandbox/testing/k3-stack.testing';
import {
  clusterItems,
  cosine,
  distinctVisitorsOf,
  unit,
  type ClusterInput,
} from './clustering';

const T0 = Date.UTC(2026, 9, 1);
let n = 0;
function item(
  q: string,
  over: Partial<ClusterInput> = {},
): ClusterInput & { q: string } {
  n++;
  return {
    id: `i${String(n).padStart(3, '0')}`,
    embedding: bagOfWordsVector(q),
    visitorId: `v${n}`,
    suspicious: false,
    lang: 'uk',
    createdAt: new Date(T0 + n * 1000),
    clusterId: null,
    q,
    ...over,
  };
}

describe('clusterItems', () => {
  it('три посетителя с одним вопросом — один кластер, distinctVisitors = 3; другой вопрос — свой кластер', () => {
    const a = item('чи є самовивіз у дніпрі');
    const b = item('чи є самовивіз у дніпрі');
    const c = item('чи є самовивіз у дніпрі сьогодні');
    const d = item('скільки коштує доставка кур’єром');
    const out = clusterItems([d, c, b, a], [], 0.85);
    expect(out).toHaveLength(2);
    const pickup = out.find((x) => x.itemIds.includes(a.id))!;
    expect(pickup.itemIds.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(pickup.distinctVisitors).toBe(3);
    expect(pickup.clusterKey).toMatch(/^new:/);
    expect(out.find((x) => x.itemIds.includes(d.id))!.itemIds).toEqual([d.id]);
  });

  it('20 одинаковых вопросов одного suspicious-посетителя кластер не растят (distinctVisitors)', () => {
    const real = [item('де забрати замовлення'), item('де забрати замовлення')];
    const bot = Array.from({ length: 20 }, () =>
      item('де забрати замовлення', { visitorId: 'bot', suspicious: true }),
    );
    const [c] = clusterItems([...real, ...bot], [], 0.85);
    expect(c.itemIds).toHaveLength(22);
    expect(c.distinctVisitors).toBe(2);
    // Посетитель без suspicious, но тот же — один (разные посетители, не сообщения).
    expect(
      distinctVisitorsOf([
        { visitorId: 'x', suspicious: false },
        { visitorId: 'x', suspicious: false },
        { visitorId: null, suspicious: false },
      ]),
    ).toBe(1);
  });

  it('язык разделяет кластеры, порог отсекает непохожее', () => {
    const uk = item('доставка у львів', { lang: 'uk' });
    const ru = item('доставка у львів', { lang: 'ru' });
    const out = clusterItems([uk, ru], [], 0.85);
    expect(out).toHaveLength(2);
    const loose = clusterItems(
      [item('доставка у львів'), item('доставка у київ')],
      [],
      0.99,
    );
    expect(loose).toHaveLength(2);
    expect(
      clusterItems(
        [item('доставка у львів'), item('доставка у київ')],
        [],
        0.6,
      ),
    ).toHaveLength(1);
  });

  it('существующий кластер принимает похожий новый элемент; его участники остаются в нём', () => {
    const old = item('чи працюєте у неділю', { clusterId: 'c1' });
    const fresh = item('чи працюєте у неділю');
    const out = clusterItems(
      [fresh, old],
      [
        {
          id: 'c1',
          centroid: bagOfWordsVector('чи працюєте у неділю'),
          lang: 'uk',
        },
      ],
      0.85,
    );
    expect(out).toHaveLength(1);
    expect(out[0].clusterKey).toBe('c1');
    expect(out[0].itemIds).toEqual([old.id, fresh.id]);
    // Существующий кластер без участников во входе — не в ответе.
    expect(
      clusterItems(
        [item('інше питання')],
        [
          {
            id: 'c9',
            centroid: bagOfWordsVector('щось зовсім інше'),
            lang: 'uk',
          },
        ],
        0.85,
      ).map((x) => x.clusterKey),
    ).toEqual(['new:0']);
  });

  it('детерминирована: порядок входа не меняет результат; битый вектор пропускается', () => {
    const xs = [
      item('оплата частинами'),
      item('оплата частинами можлива'),
      item('гарантія на чайник'),
      item('без вектора', { embedding: [] }),
      item('нулі', { embedding: new Array(768).fill(0) }),
    ];
    const a = clusterItems(xs, [], 0.85);
    const b = clusterItems([...xs].reverse(), [], 0.85);
    expect(b).toEqual(a);
    expect(a.flatMap((x) => x.itemIds)).toHaveLength(3);
  });

  it('cosine/unit: разные длины и нули — 0/null', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([0, 0], [0, 0])).toBe(0);
    expect(unit([0, 0])).toBeNull();
    expect(unit([3, 4])).toEqual([0.6, 0.8]);
  });
});
