/**
 * AI Publisher — приёмка P-E: пороги не переписываются задним числом
 * (AT-CORE-23, юнит-часть; db-часть — `reports-experiment-immutable.spec`).
 */
import {
  searchSignalD90,
  signalD42,
} from '../../modules/publisher/reports/metrics/economics';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import { td09Inputs } from '../../modules/publisher/reports/testing/td09.testing';

describe('[AT-CORE-23] Порог не переписан задним числом: результат ниже порога — not_met', () => {
  const th = { sessions: 100, qualified: 5, proposals: 2 };

  it('ниже порога — not_met; ровно на пороге — met; неизвестные сессии при прочих выполненных — inconclusive', () => {
    expect(
      signalD42(
        {
          sessions: 99,
          qualifiedUnique: 5,
          linked: 3,
          unknown: 2,
          proposalsToDistinct: 2,
        },
        th,
      ).verdict,
    ).toBe('not_met');
    expect(
      signalD42(
        {
          sessions: 100,
          qualifiedUnique: 5,
          linked: 3,
          unknown: 2,
          proposalsToDistinct: 2,
        },
        th,
      ),
    ).toEqual({
      verdict: 'met',
      parts: {
        sessions: { value: 100, threshold: 100, state: 'met' },
        qualified: {
          value: 5,
          threshold: 5,
          state: 'met',
          linked: 3,
          unknown: 2,
        },
        proposals: { value: 2, threshold: 2, state: 'met' },
      },
    });
    expect(
      signalD42(
        {
          sessions: null,
          qualifiedUnique: 5,
          linked: 0,
          unknown: 5,
          proposalsToDistinct: 2,
        },
        th,
      ).verdict,
    ).toBe('inconclusive');
    // Неизвестные сессии не спасают невыполненный порог заявок.
    expect(
      signalD42(
        {
          sessions: null,
          qualifiedUnique: 4,
          linked: 0,
          unknown: 4,
          proposalsToDistinct: 2,
        },
        th,
      ).verdict,
    ).toBe('not_met');
  });

  it('снимок берёт ЗАМОРОЖЕННЫЕ пороги эксперимента: снижение параметра после старта на вывод не влияет', () => {
    const base = td09Inputs();
    const r = computeReport(base);
    // TD-09: 6 сессий < 100, 2 квалифицированных когорты (P1, P3) < 5, 2 предложения ≥ 2.
    expect((r.metrics as { signalD42: unknown }).signalD42).toEqual({
      verdict: 'not_met',
      parts: {
        sessions: { value: 6, threshold: 100, state: 'not_met' },
        qualified: {
          value: 2,
          threshold: 5,
          state: 'not_met',
          linked: 2,
          unknown: 0,
        },
        proposals: { value: 2, threshold: 2, state: 'met' },
      },
    });
    // «Подтянутый» текущий параметр (allowed CPL и т. п.) в снимок не попадает: вход — пороги эксперимента.
    const lowered = computeReport({
      ...base,
      allowedCplInputs: {
        contributionMinor: 1,
        pPayBp: 1,
        shareBp: 1,
        approved: true,
      },
    });
    expect((lowered.metrics as { signalD42: unknown }).signalD42).toEqual(
      (r.metrics as { signalD42: unknown }).signalD42,
    );
    expect(
      (lowered.metrics as { economics: { allowedOperationalCpl: unknown } })
        .economics.allowedOperationalCpl,
    ).toEqual({
      kind: 'value',
      value: '1666',
    });
  });

  it('поисковый сигнал D90: 3 из 6 проиндексированы и 2 с кликами — met; неполные данные — inconclusive', () => {
    const th90 = { indexedPages: 3, pagesWithClicks28d: 2 };
    expect(
      searchSignalD90({ indexedPages: 3, pagesWithClicks28d: 2 }, th90).verdict,
    ).toBe('met');
    expect(
      searchSignalD90({ indexedPages: 2, pagesWithClicks28d: 2 }, th90).verdict,
    ).toBe('not_met');
    expect(
      searchSignalD90({ indexedPages: null, pagesWithClicks28d: 2 }, th90)
        .verdict,
    ).toBe('inconclusive');
    // Из суточных данных Search Console: на последнюю дату проиндексированы /a /b /c, клики у /a и /b за 28 дней.
    const days = ['a', 'b', 'c', 'd'].flatMap((p) => [
      {
        date: '2027-01-10',
        page: `/${p}`,
        clicks: p === 'a' ? 3 : 0,
        indexed: false,
      },
      {
        date: '2027-01-17',
        page: `/${p}`,
        clicks: p === 'b' ? 1 : 0,
        indexed: p !== 'd',
      },
    ]);
    const r = computeReport(
      td09Inputs({
        kind: 'd90',
        searchDays: days,
        snapshotAt: new Date('2027-01-18T08:00:00.000Z'),
      }),
    );
    expect((r.metrics as { searchSignalD90: unknown }).searchSignalD90).toEqual(
      {
        verdict: 'met',
        parts: { indexedPages: 'met', pagesWithClicks28d: 'met' },
        inputs: { indexedPages: 3, pagesWithClicks28d: 2 },
      },
    );
  });

  it('[AT-CORE-12] режим session_ref: сборщик событий degraded/устарел за период — сессии «неопределённо», а не «не выполнено»; «на 100» помечено', () => {
    const base = td09Inputs();
    const exp = base.experiment as NonNullable<typeof base.experiment>;
    // Пороги, при которых прочие части выполнены: 2 квалифицированных, 2 предложения; сессий 5 ≤ 6.
    const lowTh = {
      ...exp,
      thresholds: {
        ...exp.thresholds,
        d42: {
          sessions: 5,
          qualified: 2,
          proposals: 2,
          minSampleForConclusion: 5,
        },
      },
    };
    const ok = computeReport({ ...base, experiment: lowTh });
    expect(
      (ok.metrics as { signalD42: { verdict: string } }).signalD42.verdict,
    ).toBe('met');
    const degraded = computeReport({
      ...base,
      experiment: lowTh,
      integrations: base.integrations.map((g) =>
        g.kind === 'events_collector'
          ? { ...g, status: 'degraded' as const }
          : g,
      ),
    });
    const m = degraded.metrics as {
      signalD42: {
        verdict: string;
        parts: { sessions: { value: number | null; state: string } };
      };
      sessions: { value: number; complete: boolean };
      qualifiedPer100Sessions: { value: unknown };
    };
    expect(m.signalD42.verdict).toBe('inconclusive');
    expect(m.signalD42.parts.sessions).toMatchObject({
      value: null,
      state: 'unknown',
    });
    // Подсчитанные сессии видны (нижняя оценка), но неполные.
    expect(m.sessions).toMatchObject({ value: 6, complete: false });
    expect(m.qualifiedPer100Sessions.value).toEqual({
      kind: 'value',
      value: 33.33,
      preliminary: true,
      unknownParts: ['sessions:collector_incomplete'],
    });
    // Последняя синхронизация за 49 ч до конца когорты (порог 48 ч) — тоже неполно.
    const stale = computeReport({
      ...base,
      experiment: lowTh,
      integrations: base.integrations.map((g) =>
        g.kind === 'events_collector'
          ? { ...g, lastSuccessAt: new Date('2026-11-29T07:00:00.000Z') }
          : g,
      ),
    });
    expect(
      (stale.metrics as { signalD42: { verdict: string } }).signalD42.verdict,
    ).toBe('inconclusive');
    // Ровно 48 ч — ещё полно.
    const edge = computeReport({
      ...base,
      experiment: lowTh,
      integrations: base.integrations.map((g) =>
        g.kind === 'events_collector'
          ? { ...g, lastSuccessAt: new Date('2026-11-29T08:00:00.000Z') }
          : g,
      ),
    });
    expect(
      (edge.metrics as { signalD42: { verdict: string } }).signalD42.verdict,
    ).toBe('met');
  });

  it('D90 — только страницы пилота: клики и индексация чужих страниц импорта не засчитываются', () => {
    const days = ['a', 'b', 'c', 'x', 'y'].map((p) => ({
      date: '2027-01-17',
      page: `/${p}`,
      clicks: 1,
      indexed: true,
    }));
    const at = new Date('2027-01-18T08:00:00.000Z');
    const all = computeReport(
      td09Inputs({ kind: 'd90', searchDays: days, snapshotAt: at }),
    );
    expect(
      (all.metrics as { searchSignalD90: { inputs: unknown } }).searchSignalD90
        .inputs,
    ).toEqual({ indexedPages: 5, pagesWithClicks28d: 5 });
    // Пилот — /a и /b/ (путь с завершающим «/» тот же): 2 < 3 — not_met.
    const pilot = computeReport(
      td09Inputs({
        kind: 'd90',
        searchDays: days,
        snapshotAt: at,
        pilotPages: ['/a', '/b/'],
      }),
    );
    expect(
      (pilot.metrics as { searchSignalD90: unknown }).searchSignalD90,
    ).toEqual({
      verdict: 'not_met',
      parts: { indexedPages: 'not_met', pagesWithClicks28d: 'met' },
      inputs: { indexedPages: 2, pagesWithClicks28d: 2 },
    });
  });
});
