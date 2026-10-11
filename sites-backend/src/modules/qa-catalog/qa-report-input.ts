import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseVersion } from './qa-case-input';
const invalid = (): never => {
  throw new BadRequestException({
    code: 'QA_REPORT_INVALID',
    message: 'Проверьте отчёт, проект браузера и версии кейсов.',
  });
};
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : invalid());
const key = (v: unknown): string =>
  typeof v === 'string' && /^[A-Z][A-Z0-9-]{1,63}$/.test(v) ? v : invalid();
const project = (v: unknown): string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : invalid();
export function parseQaReport(input: unknown) {
  const b = obj(input);
  if (
    Object.keys(b).some(
      (k) => !['expectedRevision', 'project', 'report'].includes(k),
    )
  )
    return invalid();
  const expectedRevision = parseVersion(b.expectedRevision),
    selectedProject = project(b.project),
    report = obj(b.report);
  if (
    Buffer.byteLength(JSON.stringify(report), 'utf8') > 512 * 1024 ||
    report.schemaVersion !== 1 ||
    report.unknownTests !== 0 ||
    !['passed', 'failed', 'timedout', 'interrupted'].includes(
      String(report.runnerStatus),
    )
  )
    return invalid();
  const rawCases = list(report.cases),
    rawResults = list(report.results);
  if (!rawCases.length || rawCases.length > 100 || rawResults.length > 1000)
    return invalid();
  const cases = rawCases.map((v) => {
    const c = obj(v);
    if (!['manual', 'automated'].includes(String(c.type))) return invalid();
    const projects = list(c.projects).map(project);
    if (!projects.length || new Set(projects).size !== projects.length)
      return invalid();
    return {
      caseKey: key(c.id),
      version: parseVersion(c.version),
      type: c.type as string,
      projects,
    };
  });
  if (new Set(cases.map((c) => c.caseKey)).size !== cases.length)
    return invalid();
  const results = rawResults.map((v) => {
    const a = obj(v),
      caseKey = key(a.caseId),
      p = project(a.project),
      c = cases.find((c) => c.caseKey === caseKey);
    if (
      !c ||
      !c.projects.includes(p) ||
      c.version !== a.caseVersion ||
      a.origin !== 'automated' ||
      c.type !== 'automated' ||
      !Number.isSafeInteger(a.attempt) ||
      (a.attempt as number) < 0 ||
      (a.attempt as number) > 100 ||
      typeof a.durationMs !== 'number' ||
      !Number.isFinite(a.durationMs) ||
      a.durationMs < 0 ||
      !['passed', 'failed', 'blocked', 'skipped'].includes(String(a.status))
    )
      return invalid();
    return {
      caseKey,
      project: p,
      sourceAttempt: a.attempt as number,
      status: a.status as string,
      durationMs: a.durationMs,
    };
  });
  if (
    new Set(results.map((a) => `${a.caseKey}:${a.project}:${a.sourceAttempt}`))
      .size !== results.length
  )
    return invalid();
  const selectedCases = cases.filter(
    (c) => c.type === 'automated' && c.projects.includes(selectedProject),
  );
  const attempts = results
    .filter((a) => a.project === selectedProject)
    .sort(
      (a, b) =>
        a.caseKey.localeCompare(b.caseKey) || a.sourceAttempt - b.sourceAttempt,
    );
  if (
    !selectedCases.length ||
    !attempts.length ||
    selectedCases.some((c) => {
      const rows = attempts.filter((a) => a.caseKey === c.caseKey);
      return !rows.length || rows.some((a, i) => a.sourceAttempt !== i);
    })
  )
    return invalid();
  const rawMeta = obj(report.metadata),
    sha = (v: unknown) =>
      v === null || v === undefined
        ? null
        : typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v)
          ? v.toLowerCase()
          : invalid();
  if (
    rawMeta.source !== 'playwright' ||
    typeof rawMeta.startedAt !== 'string' ||
    rawMeta.startedAt.length > 40 ||
    !Number.isFinite(Date.parse(rawMeta.startedAt))
  )
    return invalid();
  const metadata = {
    source: 'playwright',
    startedAt: new Date(rawMeta.startedAt).toISOString(),
    testSourceSha: sha(rawMeta.testSourceSha),
    deployedSha: sha(rawMeta.deployedSha),
    runnerStatus: report.runnerStatus as string,
  };
  const canonical = {
    project: selectedProject,
    cases: selectedCases.sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    attempts,
    metadata,
  };
  const reportHash = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return { expectedRevision, ...canonical, reportHash };
}
export function validateReportSnapshot(
  snapshot: unknown,
  report: ReturnType<typeof parseQaReport>,
) {
  const items = list(snapshot).map(obj),
    automatic = items.filter((c) => obj(c.payload).type === 'automated');
  if (
    automatic.length !== report.cases.length ||
    report.cases.some(
      (c) =>
        !automatic.some(
          (s) => s.caseKey === c.caseKey && s.version === c.version,
        ),
    )
  )
    return invalid();
}
