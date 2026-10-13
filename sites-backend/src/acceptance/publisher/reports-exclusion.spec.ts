/**
 * AI Publisher — приёмка P-E: тесты исключены из спроса (AT-CORE-06,
 * отчётная часть на базе; тест-флаг на приёме и история смены — P-D
 * `leads-test-flag.spec`). Тестовые сессия, заявка и квалификация, заявка
 * команды и внутренняя оплата есть в диагностике снимка и отсутствуют в
 * деловых суммах.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  PubDb,
  connectOwner,
  type PubWorld,
} from '../../prisma/publisher-schema.testing';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  T72,
  d,
  seedLead,
  seedPilotWorld,
  seedSession,
} from '../../modules/publisher/reports/testing/pilot-world.testing';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';

ciDescribe(
  '[AT-CORE-06] Тестовые данные и команда — в диагностике снимка, не в деловых суммах',
  () => {
    let s: ReportsStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    let w: PubWorld;

    beforeAll(async () => {
      s = await reportsStack();
      owner = await connectOwner();
      raw = new PubDb(owner);
      ({ w } = await seedPilotWorld(raw));
      const real = await seedSession(raw, w, d('2026-01-15T10:00:00Z'));
      const test = await seedSession(raw, w, d('2026-01-15T11:00:00Z'), true);
      const { prospect } = await seedLead(raw, w, {
        sessionRef: real,
        receivedAt: d('2026-01-16T10:00:00Z'),
        qualifiedAt: d('2026-01-17T10:00:00Z'),
      });
      await seedLead(raw, w, {
        sessionRef: test,
        receivedAt: d('2026-01-16T11:00:00Z'),
        qualifiedAt: d('2026-01-17T11:00:00Z'),
        test: true,
      });
      const team = await raw.prospect(w, { isTeamOrPartner: true });
      await seedLead(raw, w, {
        sessionRef: real,
        receivedAt: d('2026-01-18T10:00:00Z'),
        qualifiedAt: d('2026-01-19T10:00:00Z'),
        prospect: team,
      });
      for (const [payerKind, p] of [
        ['external', prospect],
        ['internal', team],
        ['test', team],
      ] as const) {
        await raw.child('pub_payments', w, {
          prospectId: p,
          recordType: 'payment_received',
          payerKind,
          amountMinor: 10_000,
          currency: 'UAH',
          occurredAt: d('2026-02-01T10:00:00Z'),
          paymentRef: `${payerKind}-${w.productId}`,
          status: 'confirmed',
          confirmedBy: 'member:m1',
          confirmedAt: d('2026-02-01T10:00:00Z'),
          isNewCustomer: 'yes',
          opKey: (await import('crypto')).randomUUID(),
        });
      }
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });

    it('D72: в деловых суммах один внешний проспект и одна внешняя оплата; тест и команда — только в diagnostics', async () => {
      const r = await s.db
        .forAccount(w.accountId)
        .$transaction((tx) =>
          s.mod
            .get(ReportsService)
            .create(
              tx,
              { id: w.productId, accountId: w.accountId },
              { kind: 'd72', snapshotAt: T72.toISOString() },
              'member:m1',
              new Date(),
            ),
        );
      const m = r.row.metrics as {
        sessions: { value: number };
        leads: Record<string, number>;
        revenue: Record<string, unknown>;
        diagnostics: Record<string, number>;
      };
      expect(m.sessions.value).toBe(1);
      expect(m.leads).toMatchObject({ qualifiedUnique: 1, inPeriod: 2 });
      expect(m.revenue).toMatchObject({
        byCurrency: { UAH: { receivedMinor: '10000', netMinor: '10000' } },
        externalPayingProspects: 1,
        excludedNonExternal: 2,
      });
      expect(m.diagnostics).toEqual({
        testSessions: 1,
        testLeads: 1,
        testQualified: 1,
        teamOrPartnerQualified: 1,
        excludedPayments: 2,
      });
    });
  },
);
