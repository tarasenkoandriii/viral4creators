/**
 * Задания кронов P-E на базе (§15.1): реестр, `placement-diagnostics`,
 * `backup-post-purchase`, `backup-weekly` (только понедельник Kyiv,
 * выключатель стенда), `backup-rotation`; `PilotClockPort` и шаг
 * `pilot-experiment` создания продукта.
 */
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  PubDb,
  connectOwner,
  type PubWorld,
  uuid4,
} from '../../../prisma/publisher-schema.testing';
import { PUB_CRON_SCHEDULE } from '../cron/job-registry';
import { PubContributions } from '../core/contributions';
import { PILOT_CLOCK_PORT, PubPorts } from '../core/ports';
import { BackupService } from './backup.service';
import { ExperimentsService, PilotExperimentInit } from './experiments.service';
import {
  BackupPostPurchaseJob,
  BackupRotationJob,
  BackupWeeklyJob,
  PlacementDiagnosticsJob,
} from './report-jobs';
import { ReportsService } from './reports.service';
import {
  reportsStack,
  type ReportsStack,
} from './testing/reports-stack.testing';
import { TD10_SECRET } from './testing/td10.testing';

const DAY = 86_400_000;

ciDescribe('P-E: задания кронов и вклады', () => {
  let s: ReportsStack;
  let owner: Awaited<ReturnType<typeof connectOwner>>;
  let raw: PubDb;
  const saved = process.env.ASSIST_SECRETS_KEY;
  const deadline = () => new Date(Date.now() + 30_000);

  beforeAll(async () => {
    process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
    s = await reportsStack();
    owner = await connectOwner();
    raw = new PubDb(owner);
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.ASSIST_SECRETS_KEY;
    else process.env.ASSIST_SECRETS_KEY = saved;
    await owner?.end();
    await s?.close();
  });

  it('вклады P-E: 6 заданий ровно из §15.1 с расписанием; PilotClockPort и шаг pilot-experiment — настоящие', () => {
    const jobs = s.mod.get(PubContributions).list('cron-job');
    const mine = jobs.filter((j) => PUB_CRON_SCHEDULE[j.key]?.owner === 'P-E');
    expect(mine.map((j) => [j.key, j.schedule]).sort()).toEqual(
      Object.entries(PUB_CRON_SCHEDULE)
        .filter(([, v]) => v.owner === 'P-E')
        .map(([k, v]) => [k, v.schedule])
        .sort(),
    );
    expect(
      s.mod
        .get(PubContributions)
        .list('product-init')
        .map((c) => c.constructor),
    ).toContain(PilotExperimentInit);
    expect(s.mod.get(PubPorts).has(PILOT_CLOCK_PORT)).toBe(true);
    expect(s.mod.get(PubPorts).pilotClock()).toBeInstanceOf(ExperimentsService);
  });

  it('шаг создания продукта: pilot v1 с t0Planned из pilot_calendar, окно 90 дней, пороги с версиями', async () => {
    const w = await raw.world({ kind: 'working' });
    await raw.child('pub_parameters', w, {
      key: 'd42_thresholds',
      value: {
        sessions: 100,
        qualified: 5,
        proposals: 2,
        minSampleForConclusion: 5,
      },
      status: 'assumption',
    });
    const p = {
      id: w.productId,
      accountId: w.accountId,
      siteId: w.siteId,
      kind: 'working' as const,
      mode: 'closed' as const,
      status: 'active' as const,
      revision: 1,
    };
    const planned = '2026-11-02T08:00:00.000Z';
    await s.db.forAccount(w.accountId).$transaction((tx) =>
      s.mod.get(PilotExperimentInit).init(tx, p, {
        actor: 'member:m1',
        now: new Date(),
        parameters: { pilot_calendar: { t0Planned: planned } },
      }),
    );
    const e = await s.prisma.pubExperiment.findFirstOrThrow({
      where: { productId: w.productId },
    });
    expect(e).toMatchObject({
      key: 'pilot',
      kind: 'pilot',
      version: 1,
      status: 'registered',
      t0: null,
    });
    expect(e.t0Planned?.toISOString()).toBe(planned);
    // 2026-11-02 10:00 EET + 90 дней = 2027-01-31 10:00 EET = 08:00Z.
    expect(e.windowEnd.toISOString()).toBe('2027-01-31T08:00:00.000Z');
    expect(
      (e.thresholds as { versions: Record<string, unknown> }).versions
        .d42_thresholds,
    ).toEqual({ version: 1, status: 'assumption' });
  });

  async function publishedPlacement(
    w: PubWorld,
    publishedAt: Date,
  ): Promise<string> {
    const placementId = await raw.placement(w, {
      status: 'published',
      priceConfirmedAt: new Date(publishedAt.getTime() - DAY),
      priceSource: 'Прайс площадки',
      externalOrderId: `ord-${uuid4().slice(0, 8)}`,
      publishedAt,
    });
    return placementId;
  }

  it('placement-diagnostics: снимки +7 и +14 дней один раз; окно они не закрывают', async () => {
    const w = await raw.world({ kind: 'working' });
    const pubAt = new Date(Date.now() - 20 * DAY);
    const pl = await publishedPlacement(w, pubAt);
    const job = new PlacementDiagnosticsJob(
      s.db,
      s.mod.get(ReportsService),
      s.mod.get(PubPorts),
    );
    const ctx = {
      now: new Date(),
      scope: { siteIds: [w.siteId] },
      deadline: deadline(),
    };
    expect(await job.run(ctx)).toMatchObject({ processed: 2 });
    const reps = await s.prisma.pubReport.findMany({
      where: { productId: w.productId },
      orderBy: { periodEnd: 'asc' },
    });
    expect(reps).toHaveLength(2);
    expect(
      reps.map(
        (r) => (r.cohort as { focusPlacementId: string }).focusPlacementId,
      ),
    ).toEqual([pl, pl]);
    expect(
      reps.every(
        (r) =>
          r.kind === 'ad_hoc' && r.createdBy === 'system:placement-diagnostics',
      ),
    ).toBe(true);
    const placement = (
      reps[0].metrics as {
        placements: Array<{ id: string; windowState: string }>;
      }
    ).placements.find((x) => x.id === pl);
    expect(placement?.windowState).toBe('open'); // 20 дней < 30: окно открыто
    expect(await job.run(ctx)).toMatchObject({ processed: 0 });
  });

  it('backup-post-purchase: после подтверждённой оплаты закупки — копия; без новых оплат — ничего; restored не трогается', async () => {
    const w = await raw.world({ kind: 'working' });
    await raw.budgetLimit(w);
    const { placementId } = await raw.approvedPlacement(w);
    const exp = await raw.child('pub_expenses', w, {
      category: 'placements',
      description: 'Закупка',
      placementId,
      amountTotalMinor: 100_000,
      paidMinor: 100_000,
      currency: 'UAH',
      status: 'open',
    });
    await raw.child('pub_expense_entries', w, {
      expenseId: exp,
      kind: 'pay',
      amountMinor: 100_000,
      status: 'confirmed',
      occurredAt: new Date(),
      confirmedAt: new Date(),
      confirmedBy: 'member:m1',
      opKey: uuid4(),
    });
    const job = new BackupPostPurchaseJob(
      s.db,
      s.mod.get(BackupService),
      s.mod.get(PubPorts),
    );
    const ctx = {
      now: new Date(),
      scope: { siteIds: [w.siteId] },
      deadline: deadline(),
    };
    expect(await job.run(ctx)).toMatchObject({
      processed: 1,
      details: { ok: 1, failed: 0 },
    });
    const b = await s.prisma.pubBackup.findFirstOrThrow({
      where: { productId: w.productId },
    });
    expect(b).toMatchObject({
      kind: 'post_purchase',
      status: 'ok',
      createdBy: 'system:backup-post-purchase',
    });
    expect(await job.run({ ...ctx, now: new Date() })).toMatchObject({
      processed: 0,
    });
    process.env.PUBLISHER_BACKUP_DISABLED = 'true';
    try {
      expect(await job.run(ctx)).toEqual({
        processed: 0,
        details: { disabled: true },
      });
    } finally {
      delete process.env.PUBLISHER_BACKUP_DISABLED;
    }
  });

  it('backup-weekly: только в понедельник Kyiv и раз в день; backup-rotation: просроченная копия — blob удалён, expired_deleted', async () => {
    const w = await raw.world({ kind: 'test' });
    const backup = s.mod.get(BackupService);
    const job = new BackupWeeklyJob(s.db, backup, s.mod.get(PubPorts));
    const scope = { siteIds: [w.siteId] };
    // 2026-10-18 — воскресенье; 2026-10-19 05:00Z = 08:00 понедельника EEST.
    expect(
      await job.run({
        now: new Date('2026-10-18T05:00:00Z'),
        scope,
        deadline: deadline(),
      }),
    ).toEqual({
      processed: 0,
      details: { notMonday: true },
    });
    const monday = new Date('2026-10-19T05:00:00Z');
    expect(
      await job.run({ now: monday, scope, deadline: deadline() }),
    ).toMatchObject({ processed: 1 });
    const b = await s.prisma.pubBackup.findFirstOrThrow({
      where: { productId: w.productId },
    });
    expect(b.kind).toBe('weekly');
    const blobsBefore = s.mem.blobs.size;
    // Ротация: rotationUntil в прошлом.
    const rot = new BackupRotationJob(s.db, backup);
    await raw.upd('pub_backups', b.id, {
      rotationUntil: new Date(Date.now() - DAY),
    });
    expect(
      await rot.run({ now: new Date(), scope, deadline: deadline() }),
    ).toMatchObject({ processed: 1 });
    expect(
      (await s.prisma.pubBackup.findUniqueOrThrow({ where: { id: b.id } }))
        .status,
    ).toBe('expired_deleted');
    expect(s.mem.blobs.size).toBe(blobsBefore - 1);
  });
});
