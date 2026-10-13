/**
 * AI Publisher — приёмка P-E: когорты и окна (AT-CORE-19, часть AT-CORE-07
 * и AT-CORE-06). Векторы TD-09 (`reports/testing/td09.testing.ts`) —
 * литералы UTC, пересчитанные вручную по правилам Europe/Kyiv; ожидаемые
 * числа ниже тоже посчитаны руками (комментарии — ход пересчёта), а не
 * функцией под тестом.
 */
import { pilotMilestones } from '../../modules/publisher/core/kyiv-time';
import {
  cohortCloseAt,
  cohortWindowClosed,
  cohortSessions,
  cohortSessionsFromAggregates,
  lateCohort,
  lateDecisionsAfter,
  leadInSessionWindow,
  placementWindowState,
  prospectAt,
  statusAt,
  uniqueQualifiedProspects,
} from '../../modules/publisher/reports/metrics/cohorts';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import {
  LATE_CLOSE,
  LATE_END,
  PL_A,
  T0,
  T42,
  T72,
  TD09_SESSIONS,
  WEEK1_END,
  td09Inputs,
} from '../../modules/publisher/reports/testing/td09.testing';

const d = (iso: string) => new Date(iso);
type Metrics = {
  sessions: {
    value: number | null;
    partialDays: string[];
    missingDays: string[];
  };
  leads: Record<string, unknown>;
  qualifiedPer100Sessions: { basis: string; value: Record<string, unknown> };
  windowClosed: boolean;
  signalD42: { verdict: string };
  membership: { leadIds: string[]; prospectIds: string[] };
  diagnostics: Record<string, number>;
  placements: Array<{ id: string; windowState: string; late: boolean }>;
};

describe('[AT-CORE-19] Предварительные окна: когорта [t0,t42), окно 30 дней, pending, поздние решения', () => {
  it('границы когорты: сессия ровно в t42 вне, t42 − 1 мс внутри, ровно t0 внутри, t0 − 1 мс вне; тестовая исключена', () => {
    const sessions = td09Inputs().sessions;
    const inCohort = cohortSessions(sessions, T0, T42)
      .map((s) => s.sessionRef)
      .sort();
    const expected = Object.entries(TD09_SESSIONS)
      .filter(([, v]) => v.inCohort)
      .map(([k]) => k)
      .sort();
    expect(inCohort).toEqual(expected);
    expect(inCohort).toEqual([
      's_dst',
      's_last',
      's_rev',
      's_spam',
      's_t0',
      's_team',
    ]);
  });

  it('окно обращения — 30 календарных дней Kyiv от САМОЙ сессии, граница включена (осенний и весенний переходы)', () => {
    // t42 − 1 мс = 2026-12-01 09:59:59.999 EET → +30 дней = 2026-12-31 09:59:59.999 EET = 07:59:59.999Z
    const sLast = { startedAt: d('2026-12-01T07:59:59.999Z') };
    expect(
      leadInSessionWindow({ receivedAt: d('2026-12-31T07:59:59.999Z') }, sLast),
    ).toBe(true);
    expect(
      leadInSessionWindow({ receivedAt: d('2026-12-31T08:00:00.000Z') }, sLast),
    ).toBe(false);
    // 2026-10-24 11:00 EEST (+03) → 2026-11-23 11:00 EET (+02) = 09:00Z, а не 08:00Z «+720 ч».
    const sDst = { startedAt: d('2026-10-24T08:00:00.000Z') };
    expect(
      leadInSessionWindow({ receivedAt: d('2026-11-23T09:00:00.000Z') }, sDst),
    ).toBe(true);
    expect(
      leadInSessionWindow({ receivedAt: d('2026-11-23T09:00:00.001Z') }, sDst),
    ).toBe(false);
    // Весна: 2027-02-26 03:30 EET → 2027-03-28 03:30 не существует → 04:30 EEST = 01:30Z.
    const sSpring = { startedAt: d('2027-02-26T01:30:00.000Z') };
    expect(
      leadInSessionWindow(
        { receivedAt: d('2027-03-28T01:30:00.000Z') },
        sSpring,
      ),
    ).toBe(true);
    expect(
      leadInSessionWindow(
        { receivedAt: d('2027-03-28T01:30:00.001Z') },
        sSpring,
      ),
    ).toBe(false);
    // Обращение раньше сессии — не её.
    expect(
      leadInSessionWindow({ receivedAt: d('2026-10-24T07:59:59.999Z') }, sDst),
    ).toBe(false);
  });

  it('D72 (snapshotAt = t72): квалификация только подтверждённая к snapshotAt, pending отдельно, проспект один раз', () => {
    const r = computeReport(td09Inputs());
    const m = r.metrics as unknown as Metrics;
    // Сессии когорты: s_t0, s_dst, s_team, s_spam, s_rev, s_last = 6.
    expect(m.sessions.value).toBe(6);
    // Заявки [t0, t72] без тестовой L5: L1 L2 L3 L4 L6 L7 L8 L9 L10 L11.
    // ВНЕ когорты (аудит P-E S1-2), сессия известна:
    //  - L2 — сессия s_last в когорте, но заявка через 1 мс после её окна;
    //  - L8 — сессия s_t42 ровно в t42 (следующий период), L9 — s_late (поздняя).
    // В когорте: L1 L3 L4 L6 L7 L10 L11 = 7; связаны в окне: L1 (ровно граница),
    // L3 (через переход), L4, L6, L7, L11 = 6; L10 без сессии — неизвестная.
    // Квалифицированы на t72 внешние: P1 (L4+L1 — один), P3 = 2; P6 — команда;
    // L11 — квалификация отменена до снимка. Оба связаны → покрытие 2/2.
    // pending: L10 (new), L11 (contacted) = 2.
    expect(m.leads).toEqual({
      inPeriod: 7,
      linked: 6,
      pending: 2,
      qualifiedUnique: 2,
      linkedQualified: 2,
      unknownQualified: 0,
      coverage: { kind: 'value', value: 1 },
      proposalsToDistinct: 2,
      outsideCohort: { nextPeriod: 2, afterSessionWindow: 1 },
    });
    // 2 связанных / 6 сессий × 100 = 33,33; окно закрыто ровно в t72 → не предварительно.
    expect(m.windowClosed).toBe(true);
    expect(m.qualifiedPer100Sessions).toEqual({
      basis: 'linked_cohort',
      value: { kind: 'value', value: 33.33 },
    });
    expect(m.membership.leadIds).toEqual([
      'L1',
      'L10',
      'L11',
      'L3',
      'L4',
      'L6',
      'L7',
    ]);
  });

  it('D42 (snapshotAt = t42): окна ещё открыты — показатель предварительный; заявки после t42 не видны', () => {
    const r = computeReport(td09Inputs({ kind: 'd42', snapshotAt: T42 }));
    const m = r.metrics as unknown as Metrics;
    // До t42 пришли L3, L4, L6, L7, L10, L11 (L8 — 2026-12-01 09:00Z > t42 08:00Z).
    // Квалифицированы внешние: P1 (L4), P3 (L3); предложение — только P1 (L3 — 29.12).
    expect(m.leads).toMatchObject({
      inPeriod: 6,
      qualifiedUnique: 2,
      linkedQualified: 2,
      proposalsToDistinct: 1,
      pending: 2,
    });
    expect(m.windowClosed).toBe(false);
    expect(m.qualifiedPer100Sessions.value).toEqual({
      kind: 'value',
      value: 33.33,
      preliminary: true,
    });
  });

  it('позднее решение после снимка находится lateDecisionsAfter, наследник с тем же определением меняет счёт, исходный — нет', () => {
    // L10 (заявка без сессии — «неизвестная», в когорте) квалифицирована
    // 2027-01-01 10:00Z — после t72.
    const lateDecision = {
      id: 'd10',
      leadId: 'L10',
      toStatus: 'qualified' as const,
      decidedAt: d('2027-01-01T10:00:00.000Z'),
    };
    const base = td09Inputs();
    const inputs = td09Inputs({
      decisions: [...base.decisions, lateDecision],
    });
    const d72 = computeReport(inputs);
    const membership = (d72.metrics as unknown as Metrics).membership;
    const late = lateDecisionsAfter(
      { snapshotAt: T72, ...membership },
      inputs.decisions,
      [],
    );
    // d2 (L2, 31.12 09:00Z) — тоже после t72, но L2 вне когорты (после окна
    // своей сессии) — наследника не вызывает.
    expect(late.map((x) => [x.id, x.kind])).toEqual([['d10', 'decision']]);
    // Наследник 2027-01-02: P10 квалифицирован (неизвестный); P2 — нет: L2 вне когорты.
    const later = computeReport({
      ...inputs,
      snapshotAt: d('2027-01-02T10:00:00.000Z'),
    });
    expect((later.metrics as unknown as Metrics).leads).toMatchObject({
      qualifiedUnique: 3,
      linkedQualified: 2,
      unknownQualified: 1,
      pending: 1,
      outsideCohort: { nextPeriod: 2, afterSessionWindow: 1 },
    });
    // Исходный снимок воспроизводим: тот же вход — тот же hash и те же числа.
    const again = computeReport(
      td09Inputs({ decisions: [...base.decisions, lateDecision] }),
    );
    expect(again.inputsHash).toBe(d72.inputsHash);
    expect(again.metrics).toEqual(d72.metrics);
    expect(later.inputsHash).not.toBe(d72.inputsHash);
  });

  it('заявки ИЗВЕСТНЫХ сессий вне [t0, t42) — не «неизвестные» когорты: пять квалифицированных из сессий после t42 не дают сигнала D42', () => {
    // Вариант аудита P-E S1-2: пять внешних квалифицированных пришли из сессий
    // 11–15.12.2026 (после t42 = 01.12 08:00Z) — следующий период.
    const base = td09Inputs();
    const extra = [11, 12, 13, 14, 15].map((day) => ({
      ref: `s_dec${day}`,
      at: d(`2026-12-${day}T10:00:00.000Z`),
      lead: `LX${day}`,
      prospect: `PX${day}`,
    }));
    const r = computeReport({
      ...base,
      sessions: [
        ...base.sessions,
        ...extra.map((x) => ({
          sessionRef: x.ref,
          startedAt: x.at,
          testFlag: false,
          placementId: null,
          channelGroup: 'organic_search' as const,
        })),
      ],
      leads: [
        ...base.leads,
        ...extra.map((x) => ({
          id: x.lead,
          receivedAt: new Date(x.at.getTime() + 3_600_000),
          testFlag: false,
          sessionRef: x.ref,
          campaignId: 'camp',
          placementId: null,
        })),
      ],
      decisions: [
        ...base.decisions,
        ...extra.map((x) => ({
          id: `dec_${x.lead}`,
          leadId: x.lead,
          toStatus: 'qualified' as const,
          decidedAt: new Date(x.at.getTime() + 86_400_000),
        })),
      ],
      links: [
        ...base.links,
        ...extra.map((x) => ({
          leadId: x.lead,
          prospectId: x.prospect,
          validFrom: x.at,
        })),
      ],
      prospects: [
        ...base.prospects,
        ...extra.map((x) => ({
          id: x.prospect,
          isExternal: true,
          isTeamOrPartner: false,
        })),
      ],
    });
    const m = r.metrics as unknown as Metrics;
    // Те же 2 квалифицированных, что без них; пять новых — «следующий период» (2 + 5 = 7).
    expect(m.leads).toMatchObject({
      qualifiedUnique: 2,
      unknownQualified: 0,
      outsideCohort: { nextPeriod: 7, afterSessionWindow: 1 },
    });
    expect(
      (m.signalD42 as unknown as { parts: { qualified: { value: number } } })
        .parts.qualified.value,
    ).toBe(2);
  });

  it('поздняя публикация после D42 — отдельная когорта с явным концом и закрытием через 30 дней; основной результат не меняется', () => {
    expect(
      lateCohort({ publishedAt: d('2026-12-05T10:00:00.000Z') }, LATE_END),
    ).toEqual({
      start: d('2026-12-05T10:00:00.000Z'),
      end: LATE_END,
      closeAt: LATE_CLOSE,
    });
    expect(() => lateCohort({ publishedAt: LATE_END }, LATE_END)).toThrow(
      RangeError,
    );
    const base = td09Inputs();
    const exp = {
      ...(base.experiment as NonNullable<typeof base.experiment>),
      lateCohortEnd: LATE_END,
    };
    const late = computeReport({
      ...base,
      kind: 'late_cohort',
      experiment: exp,
      snapshotAt: d('2027-02-10T10:00:00.000Z'),
    });
    const lm = late.metrics as unknown as Metrics;
    expect(lm.sessions.value).toBe(1); // s_late
    expect(lm.leads).toMatchObject({
      inPeriod: 1,
      qualifiedUnique: 1,
      linkedQualified: 1,
    });
    expect(late.cohort).toMatchObject({
      start: '2026-12-05T10:00:00.000Z',
      end: LATE_END.toISOString(),
      closeAt: LATE_CLOSE.toISOString(),
    });
    // Основной D72 той же базы не включает P9 (его сессия s_late — вне когорты).
    const main = computeReport({ ...base, experiment: exp });
    expect((main.metrics as unknown as Metrics).leads).toMatchObject({
      qualifiedUnique: 2,
    });
    expect(
      (main.metrics as unknown as Metrics).placements.find(
        (p) => p.id === 'pl_late',
      ),
    ).toMatchObject({ late: true });
  });

  it('состояние 30-дневного окна размещения: опубликовано незадолго до отчёта — открыто; граница включена; потом закрыто', () => {
    const p = { publishedAt: d('2026-12-05T10:00:00.000Z') }; // 12:00 EET
    expect(placementWindowState({ publishedAt: null }, T72)).toBe(
      'not_published',
    );
    expect(placementWindowState(p, d('2026-12-05T09:59:59.999Z'))).toBe(
      'not_published',
    );
    expect(placementWindowState(p, d('2026-12-20T10:00:00.000Z'))).toBe('open');
    // +30 дней = 2027-01-04 12:00 EET = 10:00Z.
    expect(placementWindowState(p, d('2027-01-04T10:00:00.000Z'))).toBe('open');
    expect(placementWindowState(p, d('2027-01-04T10:00:00.001Z'))).toBe(
      'closed',
    );
    // Окно — от ПОСЛЕДНЕЙ сессии размещения (§9.3, аудит P-E S3-6): сессия
    // 2026-12-05 14:00 EET (12:00Z) → +30 дней = 2027-01-04 14:00 EET = 12:00Z.
    const lastSession = d('2026-12-05T12:00:00.000Z');
    expect(
      placementWindowState(p, d('2027-01-04T10:00:00.001Z'), lastSession),
    ).toBe('open');
    expect(
      placementWindowState(p, d('2027-01-04T12:00:00.000Z'), lastSession),
    ).toBe('open');
    expect(
      placementWindowState(p, d('2027-01-04T12:00:00.001Z'), lastSession),
    ).toBe('closed');
    // Сессия после снимка окно не продлевает.
    expect(
      placementWindowState(
        p,
        d('2027-01-04T10:00:00.001Z'),
        d('2027-01-05T00:00:00.000Z'),
      ),
    ).toBe('closed');
    const m = computeReport(
      td09Inputs({ snapshotAt: d('2026-12-20T10:00:00.000Z') }),
    ).metrics as unknown as Metrics;
    expect(m.placements.find((x) => x.id === 'pl_late')?.windowState).toBe(
      'open',
    );
    expect(m.placements.find((x) => x.id === PL_A)?.windowState).toBe('closed');
  });

  it('ночной t0 перед весенним переходом: закрытие окон = max(t72, t42 + 30 дней) — одно правило для снимка и заключения', () => {
    // Проба аудита P-E P1, пересчёт вручную: t0 = 2027-02-14 03:30 EET = 01:30Z.
    // t42 = 2027-03-28 03:30 — такого времени нет (03:00 EET → 04:00 EEST) →
    // 04:30 EEST = 01:30Z; t72 = 2027-04-27 03:30 EEST = 00:30Z.
    const t0 = d('2027-02-14T01:30:00.000Z');
    const m = pilotMilestones(t0);
    expect([m.t42, m.t72]).toEqual([
      d('2027-03-28T01:30:00.000Z'),
      d('2027-04-27T00:30:00.000Z'),
    ]);
    // Последняя сессия когорты t42 − 1 мс = 04:29:59.999 EEST → +30 дней =
    // 2027-04-27 04:29:59.999 EEST = 01:29:59.999Z — позже t72.
    expect(
      leadInSessionWindow(
        { receivedAt: d('2027-04-27T01:29:59.999Z') },
        { startedAt: new Date(m.t42.getTime() - 1) },
      ),
    ).toBe(true);
    // Закрытие — 2027-04-27 04:30 EEST = 01:30Z, а не t72 (00:30Z).
    expect(cohortCloseAt(m.t42, m.t72)).toEqual(d('2027-04-27T01:30:00.000Z'));
    expect(
      cohortWindowClosed(m.t42, d('2027-04-27T01:00:00.000Z'), m.t72),
    ).toBe(false);
    expect(
      cohortWindowClosed(m.t42, d('2027-04-27T01:30:00.000Z'), m.t72),
    ).toBe(true);
    // Обычный календарь TD-09: t42 + 30 дней = t72 — то же правило.
    expect(cohortCloseAt(T42, T72)).toEqual(T72);
  });

  it('неделя 1 = [t0, t0 + 7 дней Kyiv) через переход: 169 часов, затраты — только недели', () => {
    expect(WEEK1_END.getTime() - T0.getTime()).toBe(169 * 3_600_000);
    const r = computeReport(
      td09Inputs({
        kind: 'weekly',
        periodStart: T0,
        periodEnd: WEEK1_END,
        snapshotAt: WEEK1_END,
      }),
    );
    const m = r.metrics as unknown as Metrics;
    expect(m.sessions.value).toBe(2); // s_t0, s_dst
    expect(m.leads).toMatchObject({ inPeriod: 1, qualifiedUnique: 1 }); // L4
    // Затраты недели: только «оказано» закупки А ровно в t0 — 1 500 грн, без неизвестных частей.
    expect(
      (r.costs as { economic: { operational: unknown } }).economic.operational,
    ).toEqual({
      kind: 'value',
      value: '150000',
    });
  });

  it('режим без session_ref: суточные агрегаты Kyiv, первые/последние сутки помечены, нет суток — неизвестно, а не ноль', () => {
    // 2026-10-20 … 2026-12-01 включительно = 12 + 30 + 1 = 43 даты; t0 и t42 в 10:00 → обе границы неполные.
    const dates: string[] = [];
    for (
      let day = Date.UTC(2026, 9, 20);
      day <= Date.UTC(2026, 11, 1);
      day += 86_400_000
    ) {
      dates.push(new Date(day).toISOString().slice(0, 10));
    }
    expect(dates).toHaveLength(43);
    const all = dates.map((date) => ({ date, sessions: 3 }));
    expect(cohortSessionsFromAggregates(all, T0, T42)).toEqual({
      sessions: 129,
      partialDays: ['2026-10-20', '2026-12-01'],
      missingDays: [],
    });
    const gap = all.filter((x) => x.date !== '2026-11-11');
    expect(cohortSessionsFromAggregates(gap, T0, T42)).toEqual({
      sessions: null,
      partialDays: ['2026-10-20', '2026-12-01'],
      missingDays: ['2026-11-11'],
    });
    const r = computeReport(
      td09Inputs({ sessionMode: 'imported_aggregate', aggregates: all }),
    );
    const m = r.metrics as unknown as Metrics;
    expect(m.sessions.value).toBe(129);
    // Без сессионной связи — отношение ОДНОГО периода [t0, t42) (аудит P-E
    // S1-2): заявки до t42 — L3 (P3), L4 (P1) квалифицированы внешние = 2
    // (L1, L8 пришли после t42 — в «на 100» не входят, хотя в qualifiedUnique
    // режима агрегатов остаются неизвестными): 2 × 100 / 129 = 1,5504 → 1,55.
    expect(m.qualifiedPer100Sessions).toEqual({
      basis: 'period_ratio',
      value: { kind: 'value', value: 1.55 },
    });
    expect(m.leads).toMatchObject({ qualifiedUnique: 3 });
    const r2 = computeReport(
      td09Inputs({ sessionMode: 'imported_aggregate', aggregates: gap }),
    );
    expect(
      (r2.metrics as unknown as Metrics).qualifiedPer100Sessions.value,
    ).toEqual({
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { qualifiedUnique: 2, sessions: null },
    });
    expect(
      (r2.sources as { completeness: { state: string } }).completeness.state,
    ).toBe('unknown');
  });
});

describe('[AT-CORE-07] Две задачи одного prospect_id — один потенциальный клиент; отказ и отмена квалификации', () => {
  it('статус и проспект берутся на snapshotAt; P1 с двумя заявками — одна единица', () => {
    const i = td09Inputs();
    expect(statusAt(i.decisions, 'L11', d('2026-11-08T12:00:00.000Z'))).toBe(
      'qualified',
    );
    expect(statusAt(i.decisions, 'L11', T72)).toBe('contacted');
    expect(statusAt(i.decisions, 'L10', T72)).toBe('new');
    expect(prospectAt(i.links, 'L1', T72)).toBe('P1');
    expect(prospectAt(i.links, 'L1', d('2026-12-31T07:59:59.998Z'))).toBeNull();
    const q = uniqueQualifiedProspects(
      i.leads,
      i.decisions,
      i.links,
      i.prospects,
      T72,
      { externalOnly: true },
    );
    // Все заявки без ограничения периодом: P1, P3, P8, P9 (поздняя когорта) — P6 команда, P5 тест.
    expect([...q].sort()).toEqual(['P1', 'P3', 'P8', 'P9']);
  });

  it('смена идентификации после снимка воспроизводима: снимок на прежний момент берёт прежнюю связь', () => {
    const i = td09Inputs();
    // L3 позже вручную привязана к P1 (слияние): после — P1 и P3 сливаются в одного.
    const links = [
      ...i.links,
      {
        leadId: 'L3',
        prospectId: 'P1',
        validFrom: d('2027-01-05T10:00:00.000Z'),
      },
    ];
    const before = uniqueQualifiedProspects(
      i.leads,
      i.decisions,
      links,
      i.prospects,
      T72,
      { externalOnly: true },
    );
    const after = uniqueQualifiedProspects(
      i.leads,
      i.decisions,
      links,
      i.prospects,
      d('2027-01-06T10:00:00.000Z'),
      {
        externalOnly: true,
      },
    );
    expect([...before].sort()).toEqual(['P1', 'P3', 'P8', 'P9']);
    expect([...after].sort()).toEqual(['P1', 'P2', 'P8', 'P9']);
  });
});

describe('[AT-CORE-06] Тестовые сессии, заявки и квалификации — в диагностике, не в деловых суммах', () => {
  it('L5 (testFlag) и s_test видны в diagnostics и отсутствуют в метриках; команда/партнёр и внутренняя оплата — отдельно', () => {
    const r = computeReport(td09Inputs());
    const m = r.metrics as unknown as Metrics;
    expect(m.diagnostics).toEqual({
      testSessions: 1,
      testLeads: 1,
      testQualified: 1,
      teamOrPartnerQualified: 1,
      excludedPayments: 2,
    });
    expect(m.membership.leadIds).not.toContain('L5');
    expect(m.membership.prospectIds).not.toContain('P5');
  });
});
