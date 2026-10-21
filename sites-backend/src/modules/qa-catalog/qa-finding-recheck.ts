import { QaCatalogService } from './qa-catalog.service';
import { acceptanceStatus } from './qa-attempt-status';

type Db = Awaited<ReturnType<QaCatalogService['scoped']>>;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const version = (snapshot: unknown, key: string) => {
  const row = Array.isArray(snapshot)
    ? snapshot.map(record).find((c) => c.caseKey === key)
    : null;
  return row && Number.isSafeInteger(row.version)
    ? (row.version as number)
    : null;
};
const sha = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v) ? v : null;

/** Read-only evidence, never a human acceptance or mutation of the finding. */
export async function readFindingRecheck(
  db: Db,
  accountId: string,
  siteId: string,
  payload: unknown,
) {
  const source = record(record(payload).source);
  if (
    typeof source.runId !== 'string' ||
    typeof source.caseKey !== 'string' ||
    typeof source.attemptId !== 'string'
  )
    return null;
  const original = await db.qaTestRunAttempt.findFirst({
    where: {
      id: source.attemptId,
      runId: source.runId,
      caseKey: source.caseKey,
      accountId,
      run: { accountId, siteId },
    },
    include: { run: { select: { snapshot: true } } },
  });
  if (!original || original.origin !== 'automated' || !original.project)
    return null;
  const meta = record(original.sourceMetadata);
  const caseVersion = version(original.run.snapshot, source.caseKey);
  const started =
    typeof meta.startedAt === 'string' ? Date.parse(meta.startedAt) : NaN;
  if (
    !caseVersion ||
    !Number.isFinite(started) ||
    typeof meta.targetOrigin !== 'string'
  )
    return null;
  const rows = await db.qaTestRunAttempt.findMany({
    where: {
      accountId,
      caseKey: source.caseKey,
      project: original.project,
      origin: 'automated',
      createdAt: { gte: original.createdAt },
      run: { accountId, siteId },
    },
    include: { run: { select: { snapshot: true } } },
    orderBy: [{ createdAt: 'desc' }, { attemptNumber: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  const eligible = rows
    .filter((row) => {
      const m = record(row.sourceMetadata);
      const time =
        typeof m.startedAt === 'string' ? Date.parse(m.startedAt) : NaN;
      return (
        row.id !== original.id &&
        !!row.reportHash &&
        version(row.run.snapshot, source.caseKey as string) === caseVersion &&
        m.targetOrigin === meta.targetOrigin &&
        m.source === meta.source &&
        Number.isFinite(time) &&
        (time > started ||
          (row.runId === original.runId &&
            row.reportHash === original.reportHash &&
            (row.sourceAttempt ?? -1) > (original.sourceAttempt ?? -1)))
      );
    })
    .sort(
      (a, b) =>
        Date.parse(String(record(b.sourceMetadata).startedAt)) -
          Date.parse(String(record(a.sourceMetadata).startedAt)) ||
        (b.sourceAttempt ?? -1) - (a.sourceAttempt ?? -1),
    );
  const latest = eligible[0];
  if (!latest) return null;
  const m = record(latest.sourceMetadata);
  return {
    runId: latest.runId,
    caseKey: latest.caseKey,
    caseVersion,
    attemptId: latest.id,
    project: latest.project!,
    reportHash: latest.reportHash!,
    status: acceptanceStatus(latest),
    recordedStatus: latest.status,
    runnerStatus:
      typeof m.runnerStatus === 'string' &&
      ['passed', 'failed', 'timedout', 'interrupted'].includes(m.runnerStatus)
        ? m.runnerStatus
        : null,
    checkedAt: latest.createdAt.toISOString(),
    testSourceSha: sha(m.testSourceSha),
    deployedSha: sha(m.deployedSha),
    requiresReview: true as const,
  };
}
