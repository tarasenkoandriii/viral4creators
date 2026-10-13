/**
 * Пилот в базе для db/http-тестов P-E (календарь пересчитан вручную,
 * Europe/Kyiv, зима → весенний переход 29.03.2026):
 *   t0  = 2026-01-12 10:00 EET  = 2026-01-12T08:00:00Z
 *   t42 = 2026-02-23 10:00 EET  = 2026-02-23T08:00:00Z
 *   t72 = 2026-03-25 10:00 EET  = 2026-03-25T08:00:00Z
 *   t90 = 2026-04-12 10:00 EEST = 2026-04-12T07:00:00Z
 * Рабочий продукт `live` с открытым приёмом (владелец схемы, автокоммит),
 * `analytics_storage = session` утверждён, эксперимент `pilot` с вехами,
 * сборщик событий `connected`.
 */
import {
  json,
  rid,
  type PubDb,
  type PubWorld,
} from '../../../../prisma/publisher-schema.testing';

export const T0 = new Date('2026-01-12T08:00:00.000Z');
export const T42 = new Date('2026-02-23T08:00:00.000Z');
export const T72 = new Date('2026-03-25T08:00:00.000Z');
export const T90 = new Date('2026-04-12T07:00:00.000Z');
export const d = (iso: string) => new Date(iso);

export async function seedPilotWorld(
  raw: PubDb,
): Promise<{ w: PubWorld; pilot: string }> {
  const w = await raw.world({ kind: 'working' });
  await raw.openForIntake(w);
  await raw.decidedParam(w, 'analytics_storage', json('session'), 'approved');
  const pilot = await raw.experiment(w, {
    key: 'pilot',
    kind: 'pilot',
    registeredAt: d('2026-01-01T08:00:00Z'),
    windowStart: T0,
    windowEnd: T90,
    t0: T0,
    t42: T42,
    t72: T72,
    t90: T90,
    status: 'running',
    appliedAt: T0,
    thresholds: {
      d42: {
        sessions: 100,
        qualified: 5,
        proposals: 2,
        minSampleForConclusion: 5,
      },
      d90: { indexedPages: 3, pagesTotal: 6, pagesWithClicks28d: 2 },
      allowedCpl: { contributionMinor: null, pPayBp: null, shareBp: null },
      lateCohort: { closeAfterDays: 30, explicitEndRequired: true },
      versions: {},
    },
  });
  // Сборщик событий подключён и синхронизирован (полнота сессий
  // `session_ref`, аудит P-E S2-3): иначе сигнал по сессиям — «неопределённо».
  await raw.child('pub_integrations', w, {
    kind: 'events_collector',
    status: 'connected',
    manual: true,
    lastSuccessAt: new Date(),
    staleAfterHours: 48,
  });
  return { w, pilot };
}

export async function seedLead(
  raw: PubDb,
  w: PubWorld,
  o: {
    sessionRef?: string;
    receivedAt: Date;
    qualifiedAt?: Date;
    test?: boolean;
    prospect?: string;
  },
): Promise<{ lead: string; prospect: string }> {
  const prospect = o.prospect ?? (await raw.prospect(w));
  const lead = await raw.lead(w, {
    receivedAt: o.receivedAt,
    sessionRef: o.sessionRef ?? null,
    ...(o.test ? { testFlag: true, testReason: 'manual' } : {}),
    ...(o.qualifiedAt ? { status: 'qualified', prospectId: prospect } : {}),
  });
  await raw.child('pub_lead_prospect_links', w, {
    leadId: lead,
    prospectId: prospect,
    validFrom: o.receivedAt,
    reason: 'new',
    decidedBy: 'system:lead-enrich',
  });
  if (o.qualifiedAt) {
    await raw.child('pub_lead_decisions', w, {
      leadId: lead,
      fromStatus: 'new',
      toStatus: 'qualified',
      confirmedInterestAt: o.qualifiedAt,
      decidedAt: o.qualifiedAt,
      decidedBy: 'member:m1',
    });
  }
  return { lead, prospect };
}

export async function seedSession(
  raw: PubDb,
  w: PubWorld,
  at: Date,
  test = false,
): Promise<string> {
  const ref = rid('sr').replace(/[^A-Za-z0-9_-]/g, '');
  await raw.child('pub_sessions', w, {
    sessionRef: ref,
    startedAt: at,
    landingPath: '/a',
    utm: {},
    consentState: 'not_required',
    testFlag: test,
    createdBy: 'public',
  });
  return ref;
}
