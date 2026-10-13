/**
 * AI Publisher — приёмка P-E: неизменяемые снимки и снимки-наследники
 * (AT-CORE-19, db-часть; юнит-векторы — `reports-cohorts.spec`).
 * Календарь (пересчитан вручную, Europe/Kyiv, зима → весенний переход):
 *   t0  = 2026-01-12 10:00 EET  = 2026-01-12T08:00:00Z
 *   t42 = 2026-02-23 10:00 EET  = 2026-02-23T08:00:00Z
 *   t72 = 2026-03-25 10:00 EET  = 2026-03-25T08:00:00Z
 *   t90 = 2026-04-12 10:00 EEST = 2026-04-12T07:00:00Z (после 29.03)
 */
import { ciDescribe, testPrisma } from '../../prisma/ci-describe.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  PubDb,
  connectOwner,
  type PubWorld,
} from '../../prisma/publisher-schema.testing';
import { pilotMilestones } from '../../modules/publisher/core/kyiv-time';
import { PubPorts } from '../../modules/publisher/core/ports';
import { ReportStalenessJob } from '../../modules/publisher/reports/report-jobs';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';
import {
  T0,
  T42,
  T72,
  T90,
  d,
  seedLead,
  seedPilotWorld,
  seedSession,
} from '../../modules/publisher/reports/testing/pilot-world.testing';

ciDescribe(
  '[AT-CORE-19] Снимки D42/D72 неизменяемы; позднее решение — снимок-наследник, исходный не меняется',
  () => {
    let s: ReportsStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    let w: PubWorld;
    let reports: ReportsService;
    let l3: string;
    let d72Id: string;

    beforeAll(async () => {
      s = await reportsStack();
      owner = await connectOwner();
      raw = new PubDb(owner);
      reports = s.mod.get(ReportsService);
      ({ w } = await seedPilotWorld(raw));
      // Вехи календаря — ручной пересчёт, сверка с функцией.
      expect(pilotMilestones(T0)).toMatchObject({
        t42: T42,
        t72: T72,
        t90: T90,
      });
      const s1 = await seedSession(raw, w, d('2026-01-13T10:00:00Z'));
      await seedSession(raw, w, T42); // ровно в t42 — вне когорты
      const sTest = await seedSession(raw, w, d('2026-01-20T10:00:00Z'), true);
      await seedLead(raw, w, {
        sessionRef: s1,
        receivedAt: d('2026-01-14T10:00:00Z'),
        qualifiedAt: d('2026-02-01T10:00:00Z'),
      });
      await seedLead(raw, w, {
        sessionRef: sTest,
        receivedAt: d('2026-01-21T10:00:00Z'),
        qualifiedAt: d('2026-01-22T10:00:00Z'),
        test: true,
      });
      // L3: в окне s1 (до 2026-02-12 12:00 EET), квалифицирована ПОСЛЕ t72.
      ({ lead: l3 } = await seedLead(raw, w, {
        sessionRef: s1,
        receivedAt: d('2026-02-10T10:00:00Z'),
      }));
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });

    const tx = <T>(
      fn: Parameters<
        ReturnType<ReportsStack['db']['forAccount']>['$transaction']
      >[0],
    ) => s.db.forAccount(w.accountId).$transaction(fn) as Promise<T>;
    const product = () => ({ id: w.productId, accountId: w.accountId });

    it('D72 раньше t72 — PUB_WINDOW_OPEN; ровно в t72 — снимок: квалификация на snapshotAt, pending отдельно, тест исключён', async () => {
      await expect(
        tx((t) =>
          reports.create(
            t,
            product(),
            { kind: 'd72', snapshotAt: '2026-03-25T07:59:59.999Z' },
            'member:m1',
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'PUB_WINDOW_OPEN' });
      const r = await tx<{
        row: {
          id: string;
          metrics: unknown;
          inputsHash: string;
          snapshotAt: Date;
          periodStart: Date;
          periodEnd: Date;
        };
      }>((t) =>
        reports.create(
          t,
          product(),
          { kind: 'd72', snapshotAt: T72.toISOString() },
          'member:m1',
          new Date(),
        ),
      );
      d72Id = r.row.id;
      expect([r.row.snapshotAt, r.row.periodStart, r.row.periodEnd]).toEqual([
        T72,
        T0,
        T42,
      ]);
      expect(r.row.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      const m = r.row.metrics as {
        sessions: { value: number };
        leads: Record<string, number>;
        diagnostics: Record<string, number>;
        windowClosed: boolean;
      };
      expect(m.sessions.value).toBe(1);
      expect(m.leads).toMatchObject({
        inPeriod: 2,
        linked: 2,
        qualifiedUnique: 1,
        linkedQualified: 1,
        pending: 1,
      });
      expect(m.diagnostics).toMatchObject({
        testSessions: 1,
        testLeads: 1,
        testQualified: 1,
      });
      expect(m.windowClosed).toBe(true);
    });

    it('снимок неизменяем: UPDATE и DELETE строки отчёта — 23514', async () => {
      await expect(
        raw.q(
          `UPDATE "sites"."pub_reports" SET "decision" = 'підправлено' WHERE "id" = $1`,
          [d72Id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        raw.q(`DELETE FROM "sites"."pub_reports" WHERE "id" = $1`, [d72Id]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('позднее решение → report-staleness создаёт наследника (late_decision) и задачу аналитику; повтор — ничего', async () => {
      const before = await s.prisma.pubReport.findUniqueOrThrow({
        where: { id: d72Id },
      });
      await raw.child('pub_lead_decisions', w, {
        leadId: l3,
        fromStatus: 'new',
        toStatus: 'qualified',
        confirmedInterestAt: d('2026-03-30T10:00:00Z'),
        decidedAt: d('2026-03-30T10:00:00Z'),
        decidedBy: 'member:m1',
      });
      await raw.upd('pub_leads', l3, {
        status: 'qualified',
        prospectId: (
          await s.prisma.pubLeadProspectLink.findFirstOrThrow({
            where: { leadId: l3 },
          })
        ).prospectId,
      });
      const job = new ReportStalenessJob(s.db, reports, s.mod.get(PubPorts));
      const ctx = {
        now: new Date(),
        scope: { siteIds: [w.siteId] },
        deadline: new Date(Date.now() + 30_000),
      };
      // Наследник D72 (1) + снимки вех, которых не было (D42, D90 — 2, аудит
      // P-E S3-8: t42/t90 давно прошли, снимков нет — делает система).
      expect(await job.run(ctx)).toMatchObject({
        processed: 3,
        details: { successors: 1, milestones: 2 },
      });
      const auto = await s.prisma.pubReport.findMany({
        where: {
          productId: w.productId,
          createdBy: 'system:report-milestones',
        },
        orderBy: { kind: 'asc' },
      });
      expect(auto.map((r) => [r.kind, r.periodStart, r.periodEnd])).toEqual([
        ['d42', T0, T42],
        ['d90', T0, T90],
      ]);
      const due = await s.prisma.pubReviewTask.findMany({
        where: {
          productId: w.productId,
          triggerRef: { startsWith: 'milestone:' },
        },
        orderBy: { triggerRef: 'asc' },
      });
      expect(due.map((t) => [t.reason, t.triggerRef])).toEqual([
        ['other', 'milestone:d42'],
        ['other', 'milestone:d90'],
      ]);
      const succ = await s.prisma.pubReport.findFirstOrThrow({
        where: { supersedesReportId: d72Id },
      });
      expect(succ).toMatchObject({
        kind: 'd72',
        recomputeReason: 'late_decision',
        createdBy: 'system:report-staleness',
      });
      expect(
        (succ.metrics as { leads: Record<string, number> }).leads,
      ).toMatchObject({ qualifiedUnique: 2, pending: 0 });
      // Исходный снимок не изменился, принадлежность обращения окну сохранена (inPeriod/linked).
      const after = await s.prisma.pubReport.findUniqueOrThrow({
        where: { id: d72Id },
      });
      expect(after).toEqual(before);
      expect(
        (succ.metrics as { leads: Record<string, number> }).leads,
      ).toMatchObject({ inPeriod: 2, linked: 2 });
      const task = await s.prisma.pubReviewTask.findFirstOrThrow({
        where: { productId: w.productId, objectId: succ.id },
      });
      expect(task).toMatchObject({
        reason: 'report_late_decision',
        triggerRef: d72Id,
        status: 'open',
      });
      // Повтор: головы без поздних изменений в проход не попадают (фильтр
      // до LIMIT, аудит P-E S3-2) — голов с изменениями 0, хотя голов 3.
      expect(await job.run(ctx)).toMatchObject({
        processed: 0,
        details: { heads: 0, successors: 0, milestones: 0 },
      });
    });

    it('inputsHash воспроизводим: правка посторонней колонки строки (новый кортеж в куче) не меняет порядок входов и hash', async () => {
      const spec = {
        kind: 'd72' as const,
        periodStart: T0,
        periodEnd: T42,
        snapshotAt: T72,
        experiment: await tx<Awaited<ReturnType<ReportsService['pilotAtT0']>>>(
          (t) => reports.pilotAtT0(t, product()),
        ),
      };
      const before = await tx<
        Awaited<ReturnType<ReportsService['buildInputs']>>
      >((t) => reports.buildInputs(t, product(), spec));
      // Первая заявка переезжает в конец кучи (UPDATE — новый кортеж).
      const first = before.leads[0];
      await raw.upd('pub_leads', first.id, {
        responsibleDisplayName: 'Інший відповідальний',
      });
      const after = await tx<
        Awaited<ReturnType<ReportsService['buildInputs']>>
      >((t) => reports.buildInputs(t, product(), spec));
      expect(after.leads.map((l) => l.id)).toEqual(
        before.leads.map((l) => l.id),
      );
      expect(computeReport(after).inputsHash).toBe(
        computeReport(before).inputsHash,
      );
    });

    it('решение по отчёту — новая строка-копия (те же snapshotAt и inputsHash); решение по заменённому — PUB_CONFLICT', async () => {
      const succ = await s.prisma.pubReport.findFirstOrThrow({
        where: { supersedesReportId: d72Id },
      });
      const r = await tx<{
        row: {
          id: string;
          decision: string | null;
          inputsHash: string;
          snapshotAt: Date;
          supersedesReportId: string | null;
        };
      }>((t) =>
        reports.decide(
          t,
          product(),
          succ,
          'Продовжити обмежену перевірку',
          'member:m1',
        ),
      );
      expect(r.row).toMatchObject({
        decision: 'Продовжити обмежену перевірку',
        inputsHash: succ.inputsHash,
        snapshotAt: succ.snapshotAt,
        supersedesReportId: succ.id,
        recomputeReason: 'decision',
      });
      const orig = await s.prisma.pubReport.findUniqueOrThrow({
        where: { id: d72Id },
      });
      await expect(
        tx((t) =>
          reports.decide(t, product(), orig, 'Ще одне рішення', 'member:m1'),
        ),
      ).rejects.toMatchObject({
        code: 'PUB_CONFLICT',
      });
    });

    it('два параллельных решения по одному снимку — один наследник, второй 409 (замок цепочки); пересчёт переносит решение в наследника', async () => {
      // Голова цепочки D72 — строка с решением из предыдущего теста.
      const head = await s.prisma.pubReport.findFirstOrThrow({
        where: {
          productId: w.productId,
          kind: 'd72',
          recomputeReason: 'decision',
        },
      });
      // Два отдельных клиента (свои соединения) — транзакции действительно
      // параллельны, а не встают в очередь одного пула.
      const p2 = testPrisma();
      const db2 = new SitesDb(p2);
      // Барьер: обе транзакции прочитали снимок (и проверили «нет
      // наследника» — без замка) до того, как любая из них вставит решение.
      let arrived = 0;
      let release!: () => void;
      const both = new Promise<void>((r) => (release = r));
      const one = (text: string, db: SitesDb) =>
        db.forAccount(w.accountId).$transaction(
          async (t) => {
            const prev = await reports.get(t, product(), head.id);
            await reports.isSuperseded(t, product(), prev.id);
            if (++arrived === 2) release();
            await Promise.race([
              both,
              new Promise((r) => setTimeout(r, 5_000)),
            ]);
            return reports.decide(t, product(), prev, text, 'member:m1');
          },
          { timeout: 30_000 },
        );
      const res = await Promise.allSettled([
        one('Рішення А: зупинити закупки', s.db),
        one('Рішення Б: масштабувати', db2),
      ]);
      await p2.$disconnect();
      expect(res.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(
        (res.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ).toMatchObject({ code: 'PUB_CONFLICT' });
      const kids = await s.prisma.pubReport.findMany({
        where: { supersedesReportId: head.id },
      });
      expect(kids).toHaveLength(1);
      // Пересчёт головы с решением — наследник с тем же решением.
      const re = await tx<{
        row: { decision: string | null; recomputeReason: string | null };
      }>((t) =>
        reports.recompute(
          t,
          product(),
          kids[0],
          'manual',
          'member:m1',
          new Date(),
        ),
      );
      expect(re.row).toMatchObject({
        decision: kids[0].decision,
        recomputeReason: 'manual',
      });
    });
  },
);
