/**
 * P-D кабинет — чистые части: CSV без формул, просрочка первого контакта,
 * пауза доставки, текст уведомления без контактов, календарь SLA,
 * классификация касаний по реестру размещений, переходы оплат, CPL и
 * покрытие «не ноль при нуле», основание без контакта.
 */
import { DEFAULT_PARAMETER_VALUES } from '../contracts/parameters';
import { PubError } from '../core/errors';
import {
  calendarOf,
  classifyTouch,
  placementOf,
  type EnrichContext,
} from './lead-enrich.job';
import { csvCell, isOverdue, toCsv } from './lead-views';
import {
  erasedLeadColumns,
  erasedRequestHash,
  leadEraseEffect,
} from './erase-effect';
import { basisOf, erasedRequestHash as reexported } from './leads.service';
import {
  backoffMs,
  leadHashPath,
  notificationText,
} from './notifications.service';
import {
  CLIENT_PAYMENT_TRANSITIONS,
  paymentsSummary,
} from './payments.service';
import { noteOf } from './prospects.service';
import { primaryLinkedLeads } from './traffic-passport.service';
import {
  computeReport,
  type ReportInputs,
} from '../reports/metrics/report-compute';

describe('lead-views: CSV и просрочка', () => {
  it('формулы экранируются префиксом апострофа; кавычки и переводы строк — в кавычках', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const s of ['+1', '-1', '@a', '\tx', '\rx'])
      expect(csvCell(s).replace(/^"/, '')[0]).toBe("'");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(toCsv([{ a: 1, b: 'x' }], ['a', 'b'])).toBe('a,b\r\n1,x\r\n');
  });

  it('просрочка — только new, не удалённая и срок прошёл', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    const past = new Date('2026-10-20T09:00:00Z');
    expect(
      isOverdue({ status: 'new', contactDueAt: past, erasedAt: null }, now),
    ).toBe(true);
    expect(
      isOverdue(
        { status: 'contacted', contactDueAt: past, erasedAt: null },
        now,
      ),
    ).toBe(false);
    expect(
      isOverdue({ status: 'new', contactDueAt: null, erasedAt: null }, now),
    ).toBe(false);
    expect(
      isOverdue({ status: 'new', contactDueAt: past, erasedAt: now }, now),
    ).toBe(false);
  });
});

describe('notifications: пауза и текст', () => {
  it('экспоненциальная пауза с потолком 6 ч', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(4)).toBe(480_000);
    expect(backoffMs(30)).toBe(6 * 3600 * 1000);
  });

  it('текст — номер и продукт на языке получателя, ссылка — в кабинет', () => {
    for (const lang of ['uk', 'ru', 'en'] as const) {
      for (const kind of [
        'new_lead',
        'contact_overdue',
        'retention_review',
      ] as const) {
        const t = notificationText(lang, kind, 'L-ABCDEFGHIJ', 'Пілот');
        expect(t.text).toContain('L-ABCDEFGHIJ');
        expect(t.button.length).toBeGreaterThan(3);
      }
    }
    expect(leadHashPath('s1', 'l1')).toBe('/sites/s1/publisher/leads/l1');
  });
});

describe('lead-enrich: календарь и касания', () => {
  it('календарь SLA: кривой параметр — умолчание ТЗ', () => {
    expect(
      calendarOf({ calendar: { workdays: [], holidays: [], dayEnd: '18:00' } }),
    ).toEqual(DEFAULT_PARAMETER_VALUES.contact_sla.calendar);
    const ok = {
      workdays: [1, 2, 3],
      holidays: ['2026-12-25'],
      dayEnd: '17:30',
    };
    expect(calendarOf({ calendar: ok })).toEqual(ok);
    expect(calendarOf(null)).toEqual(
      DEFAULT_PARAMETER_VALUES.contact_sla.calendar,
    );
  });

  it('paid_placement — только по реестру (код поля или utm_content); «платная» метка без реестра — other_referral', () => {
    const ctx: EnrichContext = {
      ownHosts: ['ai-publisher.org'],
      placements: new Map([['pl-1', { id: 'P1', campaignId: 'C1' }]]),
      contents: new Map([['kak-vybraty', 'K1']]),
    };
    expect(placementOf(ctx, null, { content: 'pl-1' })).toEqual({
      id: 'P1',
      campaignId: 'C1',
    });
    expect(placementOf(ctx, 'pl-x', {})).toBeNull();
    expect(
      classifyTouch(ctx, {
        placementCodeRaw: 'pl-1',
        contentSlugRaw: 'kak-vybraty',
        utm: null,
        referrerHost: null,
      }),
    ).toEqual({
      placementId: 'P1',
      campaignId: 'C1',
      contentId: 'K1',
      channelGroup: 'paid_placement',
      source: null,
    });
    expect(
      classifyTouch(ctx, {
        placementCodeRaw: null,
        contentSlugRaw: null,
        utm: { medium: 'cpc', source: 'ads' },
        referrerHost: null,
      }),
    ).toMatchObject({
      channelGroup: 'other_referral',
      placementId: null,
      source: 'ads',
    });
    expect(
      classifyTouch(ctx, {
        placementCodeRaw: null,
        contentSlugRaw: null,
        utm: null,
        referrerHost: 'ai-publisher.org',
      }).channelGroup,
    ).toBe('direct_unknown');
  });
});

describe('payments: переходы и сводка', () => {
  it('pending → confirmed|cancelled; confirmed → refunded; конечные — без переходов', () => {
    expect(CLIENT_PAYMENT_TRANSITIONS).toEqual({
      pending: ['confirmed', 'cancelled'],
      confirmed: ['refunded'],
      refunded: [],
      cancelled: [],
    });
  });

  it('сводка: выручка только внешняя подтверждённая; прочее — счётчиками по видам', () => {
    const row = (payerKind: string, status: string, amount: bigint) => ({
      id: 'x',
      prospectId: 'p',
      leadId: null,
      recordType: 'payment_received',
      payerKind,
      amountMinor: amount,
      currency: 'UAH',
      occurredAt: new Date(),
      paymentRef: 'r',
      confirmation: null,
      status,
      confirmedBy: null,
      confirmedAt: null,
      isNewCustomer: 'unknown',
      createdAt: new Date(),
    });
    expect(
      paymentsSummary([
        row('internal', 'confirmed', 5n),
        row('external', 'pending', 7n),
      ]),
    ).toEqual({
      revenueByCurrency: {},
      nonRevenueCount: {
        'internal:payment_received:confirmed': 1,
        'external:payment_received:pending': 1,
      },
      commercialValidation: false,
    });
    expect(
      paymentsSummary([
        row('external', 'confirmed', 7n),
        row('external', 'confirmed', 3n),
      ]).revenueByCurrency,
    ).toEqual({ UAH: '10' });
  });
});

describe('traffic: один проспект — одно размещение (основная модель, расчёт P-E)', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
  const inputs = (): ReportInputs => ({
    kind: 'ad_hoc',
    periodStart: at(0),
    periodEnd: at(23),
    snapshotAt: at(22),
    currency: 'UAH',
    experiment: null,
    sessionMode: 'session_ref',
    sessions: [
      {
        sessionRef: 's-a',
        startedAt: at(1),
        testFlag: false,
        placementId: 'pl-a',
        channelGroup: 'paid_placement',
      },
      {
        sessionRef: 's-b',
        startedAt: at(2),
        testFlag: false,
        placementId: 'pl-b',
        channelGroup: 'paid_placement',
      },
    ],
    aggregates: [],
    leads: [
      {
        id: 'l1',
        receivedAt: at(3),
        testFlag: false,
        sessionRef: 's-a',
        campaignId: null,
        placementId: 'pl-a',
      },
      {
        id: 'l2',
        receivedAt: at(4),
        testFlag: false,
        sessionRef: 's-b',
        campaignId: null,
        placementId: 'pl-b',
      },
    ],
    decisions: [
      { id: 'd1', leadId: 'l1', toStatus: 'qualified', decidedAt: at(5) },
      { id: 'd2', leadId: 'l2', toStatus: 'qualified', decidedAt: at(6) },
    ],
    links: [
      { leadId: 'l1', prospectId: 'p1', validFrom: at(3) },
      { leadId: 'l2', prospectId: 'p1', validFrom: at(4) },
    ],
    prospects: [{ id: 'p1', isExternal: true, isTeamOrPartner: false }],
    payments: [],
    placements: [
      { id: 'pl-a', placementCode: 'A', publishedAt: at(0) },
      { id: 'pl-b', placementCode: 'B', publishedAt: at(0) },
    ],
    expenses: [
      {
        id: 'e-a',
        category: 'placements',
        placementId: 'pl-a',
        aiMonth: false,
      },
      {
        id: 'e-b',
        category: 'placements',
        placementId: 'pl-b',
        aiMonth: false,
      },
    ],
    expenseEntries: [
      {
        expenseId: 'e-a',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 10_000n,
        occurredAt: at(1),
        confirmedAt: at(1),
      },
      {
        expenseId: 'e-a',
        kind: 'adjust',
        status: 'confirmed',
        amountMinor: 2_000n,
        occurredAt: at(2),
        confirmedAt: at(2),
      },
      {
        expenseId: 'e-a',
        kind: 'deliver',
        status: 'pending',
        amountMinor: 50_000n,
        occurredAt: at(2),
        confirmedAt: null,
      },
      {
        expenseId: 'e-b',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 30_000n,
        occurredAt: at(1),
        confirmedAt: at(1),
      },
    ],
    timeEntries: [],
    aiCalls: [],
    rates: { approved: false, rates: {} },
    aiFxRate: null,
    allowedCplInputs: {
      contributionMinor: null,
      pPayBp: null,
      shareBp: null,
      approved: false,
    },
    cacWindow: { until: 't72', days: null },
    searchDays: [],
    integrations: [],
  });

  it('две квалифицированные заявки одного проспекта из двух размещений → засчитан первому; прямой CPL = (deliver + adjust подтверждённые) / 1', () => {
    const i = inputs();
    expect([...primaryLinkedLeads(i)]).toEqual([['p1', 'l1']]);
    const rows = (
      computeReport(i).metrics as {
        placements: Array<{
          id: string;
          technicalQualified: number;
          directCpl: unknown;
        }>;
      }
    ).placements;
    expect(rows.map((r) => [r.id, r.technicalQualified, r.directCpl])).toEqual([
      ['pl-a', 1, { kind: 'value', value: '12000' }],
      [
        'pl-b',
        0,
        {
          kind: 'not_computable',
          reason: 'zero_denominator',
          inputs: {
            numeratorMinor: '30000',
            technicalQualifiedOfPlacements: 0,
          },
        },
      ],
    ]);
  });

  it('заявка вне 30-дневного окна сессии — не связана (unknown), прямой CPL её не считает', () => {
    const i = inputs();
    i.periodEnd = new Date(Date.UTC(2026, 11, 1));
    i.snapshotAt = new Date(Date.UTC(2026, 10, 30));
    i.leads = [{ ...i.leads[0], receivedAt: new Date(Date.UTC(2026, 10, 5)) }];
    i.links = [{ ...i.links[0], validFrom: i.leads[0].receivedAt }];
    i.decisions = [
      { ...i.decisions[0], decidedAt: new Date(Date.UTC(2026, 10, 6)) },
    ];
    expect(primaryLinkedLeads(i).size).toBe(0);
    const m = computeReport(i).metrics as {
      leads: { qualifiedUnique: number; unknownQualified: number };
      placements: Array<{ technicalQualified: number }>;
    };
    expect(m.leads).toMatchObject({ qualifiedUnique: 1, unknownQualified: 1 });
    expect(m.placements.map((r) => r.technicalQualified)).toEqual([0, 0]);
  });
});

describe('свободный текст: основание без контакта, заметка ≤ 2000', () => {
  it('основание: обязательно, 3..2000, без телефона/email', () => {
    expect(basisOf('Строк минув')).toBe('Строк минув');
    expect(() => basisOf(undefined)).toThrow(PubError);
    expect(() => basisOf('ок')).toThrow(PubError);
    expect(() => basisOf('Писати на ivan@example.com')).toThrow(PubError);
    expect(() => basisOf('Дзвонити 067 123 45 67')).toThrow(PubError);
  });
  it('заметка: пустая — null, длинная — 400', () => {
    expect(noteOf('  ')).toBeNull();
    expect(noteOf(' текст ')).toBe('текст');
    expect(() => noteOf('я'.repeat(2001))).toThrow(PubError);
    expect(() => noteOf(42)).toThrow(PubError);
  });
});

describe('эффект стирания заявки — общее правило P-D и P-E (Р-PUB-Z2-3)', () => {
  const L = (id: string, prospectId: string | null, erased = false) => ({
    id,
    prospectId,
    erased,
  });

  it('заметка проспекта стирается, только если живых заявок не осталось', () => {
    const leads = [L('a', 'p1'), L('b', 'p1'), L('c', 'p2'), L('d', null)];
    expect([...leadEraseEffect(leads, new Set(['a'])).prospectNotes]).toEqual(
      [],
    );
    expect([
      ...leadEraseEffect(leads, new Set(['a', 'b'])).prospectNotes,
    ]).toEqual(['p1']);
    // Вторая заявка уже стёрта раньше — стирание первой закрывает проспект.
    const prev = [L('a', 'p1'), L('b', 'p1', true), L('c', 'p2')];
    expect([...leadEraseEffect(prev, new Set(['a'])).prospectNotes]).toEqual([
      'p1',
    ]);
    // Проспект, не затронутый текущим стиранием, не трогается, даже если
    // все его заявки стёрты раньше (его заметку стёрло то стирание).
    const old = [L('x', 'p3', true), L('a', 'p1')];
    expect([...leadEraseEffect(old, new Set(['a'])).prospectNotes]).toEqual([
      'p1',
    ]);
    // Заявка без проспекта — только сама заявка.
    const e = leadEraseEffect(leads, new Set(['d']));
    expect([...e.leads]).toEqual(['d']);
    expect([...e.prospectNotes]).toEqual([]);
  });

  it('колонки заявки: erasedAt и обезличенный requestHash от id; P-D реэкспортирует ту же функцию', () => {
    const at = new Date('2026-10-13T10:00:00Z');
    const c = erasedLeadColumns('lead1', at);
    expect(c.erasedAt).toBe(at);
    expect(c.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.requestHash).toBe(erasedRequestHash('lead1'));
    expect(c.requestHash).not.toBe(erasedRequestHash('lead2'));
    expect(reexported).toBe(erasedRequestHash);
  });
});
