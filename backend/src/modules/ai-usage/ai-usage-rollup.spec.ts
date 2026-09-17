/**
 * Свёртка журнала расходов — чистая часть (§I-Б.5 doc/TODO.md, этап 118).
 *
 * Ошибка здесь необратима: после свёртки сырых строк того месяца уже
 * нет, и пересчитать не из чего. Поэтому тестами закрыты не «функции»,
 * а три вещи, которыми можно потерять деньги из отчёта: границы месяца,
 * правило «что уже можно сворачивать» и сама группировка.
 */

import {
  RAW_RETENTION_DAYS,
  bucketsFromGrouped,
  mergeBuckets,
  mergeTotals,
  microToNumber,
  monthEnd,
  monthKey,
  monthStart,
  monthsReadyToRoll,
} from './ai-usage-rollup';

describe('границы месяца', () => {
  it('ключ — UTC, а не локальная зона контейнера', () => {
    // 23:30 31 декабря по UTC — это ещё декабрь. Локальная зона дала бы
    // январь и утащила декабрьские строки в чужой месяц.
    expect(monthKey(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12');
    expect(monthKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('конец месяца — начало следующего, строго', () => {
    expect(monthStart('2026-02').toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(monthEnd('2026-02').toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('декабрь переходит в январь следующего года', () => {
    expect(monthEnd('2026-12').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('високосный февраль не ломает границу', () => {
    expect(monthEnd('2024-02').toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });
});

describe('что уже можно сворачивать', () => {
  const NOW = new Date('2026-09-16T12:00:00Z');

  it('месяц, закончившийся меньше срока хранения назад, НЕ трогается', () => {
    // Иначе свёртка съела бы строки, по которым считаются окна 1/7/30
    // дней, и отчёт за вчера стал бы неполным — тихо.
    expect(monthsReadyToRoll(['2026-08', '2026-07'], NOW)).toEqual([]);
  });

  it('месяц старше срока хранения — сворачивается', () => {
    expect(monthsReadyToRoll(['2026-05', '2026-04'], NOW)).toEqual([
      '2026-04',
      '2026-05',
    ]);
  });

  it('текущий месяц не сворачивается никогда', () => {
    expect(monthsReadyToRoll(['2026-09'], NOW)).toEqual([]);
  });

  it('старое идёт первым — прерванный прогон продолжает, а не начинает заново', () => {
    expect(monthsReadyToRoll(['2026-03', '2026-01', '2026-02'], NOW)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
  });

  it('повторы и мусор в списке месяцев не ломают выборку', () => {
    expect(
      monthsReadyToRoll(['2026-01', '2026-01', 'мусор', '', '2026-1'], NOW),
    ).toEqual(['2026-01']);
  });

  it('граница ровно на сроке хранения считается пройденной', () => {
    const month = '2026-06';
    const exactly = new Date(
      monthEnd(month).getTime() + RAW_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    expect(monthsReadyToRoll([month], exactly)).toEqual([month]);
    expect(monthsReadyToRoll([month], new Date(exactly.getTime() - 1))).toEqual(
      [],
    );
  });
});

describe('строки GROUP BY → строки свёртки', () => {
  const row = (
    over: Partial<Parameters<typeof bucketsFromGrouped>[1][0]> = {},
  ) =>
    ({
      userId: 'u1',
      anonymous: false,
      provider: 'GEMINI',
      operation: 'analysis',
      model: 'gemini-2.5-flash',
      unpriced: false,
      _sum: { costMicroUsd: 300 },
      _count: { _all: 3 },
      ...over,
    }) as Parameters<typeof bucketsFromGrouped>[1][0];

  it('месяц штампуется, деньги и счётчик берутся из группировки базы', () => {
    const [bucket] = bucketsFromGrouped('2026-01', [row()]);
    expect(bucket.month).toBe('2026-01');
    expect(bucket.calls).toBe(3);
    expect(bucket.costMicroUsd).toBe(300n);
  });

  it('сумма приводится к BigInt, каким бы типом ни приехала', () => {
    // `sum(int4)` Postgres отдаёт как `bigint`, но через клиента может
    // приехать и числом. Если не привести, месячная сумма молча упёрлась
    // бы в 32 бита — а пересчитать после удаления сырых строк не из чего.
    expect(
      bucketsFromGrouped('2026-01', [
        row({ _sum: { costMicroUsd: 30_000_000_000n } }),
      ])[0].costMicroUsd,
    ).toBe(30_000_000_000n);
    expect(
      bucketsFromGrouped('2026-01', [
        row({ _sum: { costMicroUsd: 30_000_000_000 } }),
      ])[0].costMicroUsd,
    ).toBe(30_000_000_000n);
  });

  it('пустая сумма — ноль, а не исключение', () => {
    // `_sum` по группе без денег приходит как NULL.
    expect(
      bucketsFromGrouped('2026-01', [row({ _sum: { costMicroUsd: null } })])[0]
        .costMicroUsd,
    ).toBe(0n);
  });

  it('анонимный расход не сливается с расходом удалённого пользователя', () => {
    // У `userId === null` два смысла, и в потолке они уже разведены
    // флагом — свёртка обязана сохранить это различие.
    const folded = bucketsFromGrouped('2026-01', [
      row({ userId: null, anonymous: true }),
      row({ userId: null, anonymous: false }),
    ]);
    expect(folded).toHaveLength(2);
    expect(folded.map((b) => b.anonymous).sort()).toEqual([false, true]);
  });

  it('все шесть измерений доезжают до строки свёртки', () => {
    // Потерять измерение — значит потерять разрез отчёта навсегда:
    // сырых строк после свёртки нет.
    const [bucket] = bucketsFromGrouped('2026-01', [
      row({
        userId: 'u2',
        anonymous: true,
        provider: 'OPENAI',
        operation: 'prompt',
        model: 'gpt-5',
        unpriced: true,
      }),
    ]);
    expect(bucket).toEqual({
      month: '2026-01',
      userId: 'u2',
      anonymous: true,
      provider: 'OPENAI',
      operation: 'prompt',
      model: 'gpt-5',
      unpriced: true,
      calls: 3,
      costMicroUsd: 300n,
    });
  });

  it('пустой месяц даёт пустую свёртку, а не строку с нулями', () => {
    expect(bucketsFromGrouped('2026-01', [])).toEqual([]);
  });
});

describe('сложение отчёта из двух источников', () => {
  it('суммы складываются', () => {
    expect(
      mergeTotals(
        { costMicroUsd: 10, calls: 1 },
        { costMicroUsd: 5, calls: 2 },
      ),
    ).toEqual({ costMicroUsd: 15, calls: 3 });
  });

  it('разрезы складываются по ключу, а не затирают друг друга', () => {
    // Забыть второй источник — значит показать заниженные деньги;
    // затереть — то же самое, только незаметнее.
    const raw = new Map([
      ['GEMINI', { costMicroUsd: 10, calls: 1 }],
      ['VEO', { costMicroUsd: 7, calls: 1 }],
    ]);
    const rolled = new Map([
      ['GEMINI', { costMicroUsd: 90, calls: 9 }],
      ['OPENAI', { costMicroUsd: 3, calls: 1 }],
    ]);
    const merged = mergeBuckets(raw, rolled);
    expect(merged.get('GEMINI')).toEqual({ costMicroUsd: 100, calls: 10 });
    expect(merged.get('VEO')).toEqual({ costMicroUsd: 7, calls: 1 });
    expect(merged.get('OPENAI')).toEqual({ costMicroUsd: 3, calls: 1 });
  });

  it('исходные разрезы не мутируются', () => {
    const raw = new Map([['A', { costMicroUsd: 1, calls: 1 }]]);
    mergeBuckets(raw, new Map([['A', { costMicroUsd: 1, calls: 1 }]]));
    expect(raw.get('A')).toEqual({ costMicroUsd: 1, calls: 1 });
  });

  it('BigInt превращается в число — иначе ответ API не сериализуется', () => {
    expect(microToNumber(42n)).toBe(42);
    expect(microToNumber(42)).toBe(42);
    expect(microToNumber(null)).toBe(0);
    expect(microToNumber(undefined)).toBe(0);
  });
});
