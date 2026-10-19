/**
 * Р-PUB-Z2-27 (предаудит DEF-C-07 / B1-F-03): сводка сохранённого прогона
 * qa-catalog для гейтов запуска Publisher — на настоящих таблицах QA.
 * Токен провайдера qa-catalog ≡ токен порта Publisher (модули друг друга не
 * импортируют — совпадение проверяется здесь); последняя попытка решает
 * статус; чужой кабинет и кривой id — как несуществующий прогон.
 */
import { ciDescribe, testPrisma } from '../../prisma/ci-describe.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { launchEvidenceCheck } from '../../modules/publisher/core/launch-evidence';
import { QA_RUN_EVIDENCE_PORT } from '../../modules/publisher/core/ports';
import {
  AT_CATALOG,
  AT_CATALOG_VERSION,
  qaCaseInput,
} from '../../modules/publisher/reports/qa/at-catalog';
import { seedAccount } from '../../modules/publisher/testing/fixtures.testing';
import {
  QA_RUN_EVIDENCE_TOKEN,
  QaRunEvidenceReader,
  attemptCodeSha,
  releaseCodeSha,
} from '../../modules/qa-catalog/qa-run-evidence';

/** Выпускаемая версия и прежняя (IA-AB-04). */
const REL = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

ciDescribe('Р-PUB-Z2-27: прогон qa-catalog как доказательство приёмки', () => {
  let prisma: PrismaService;
  let reader: QaRunEvidenceReader;

  beforeAll(() => {
    prisma = testPrisma();
    reader = new QaRunEvidenceReader(new SitesDb(prisma));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRun(
    accountId: string,
    siteId: string,
    memberId: string,
    statusOf: (id: string) => string[],
    shaOf: (id: string) => string | null = () => REL,
  ): Promise<string> {
    const snapshot = [];
    for (const c of AT_CATALOG) {
      const tc = await prisma.qaTestCase.create({
        data: {
          accountId,
          siteId,
          caseKey: c.id,
          title: c.title,
          currentVersion: AT_CATALOG_VERSION,
        },
      });
      snapshot.push({
        caseId: tc.id,
        caseKey: c.id,
        version: AT_CATALOG_VERSION,
        payload: qaCaseInput(c),
      });
    }
    const run = await prisma.qaTestRun.create({
      data: {
        accountId,
        siteId,
        title: 'AT P0',
        snapshot,
        createdByMemberId: memberId,
      },
    });
    for (const c of AT_CATALOG) {
      const statuses = statusOf(c.id);
      for (let i = 0; i < statuses.length; i++) {
        // Как импорт отчёта jest (qa-run.service `importReport`): попытка
        // automated с метаданными отчёта, commit — `testSourceSha`.
        await prisma.qaTestRunAttempt.create({
          data: {
            accountId,
            runId: run.id,
            caseKey: c.id,
            attemptNumber: i + 1,
            status: statuses[i],
            comment: statuses[i] === 'passed' ? '' : 'збій',
            createdByMemberId: memberId,
            origin: 'automated',
            project: 'jest',
            sourceAttempt: i,
            reportHash: 'c'.repeat(64),
            durationMs: 1,
            sourceMetadata: {
              source: 'jest',
              startedAt: '2026-10-19T00:00:00.000Z',
              testSourceSha: shaOf(c.id),
              deployedSha: null,
              runnerStatus: 'passed',
            },
          },
        });
      }
    }
    return run.id;
  }

  it('токен провайдера qa-catalog = токен порта Publisher', () => {
    expect(QA_RUN_EVIDENCE_TOKEN).toBe(QA_RUN_EVIDENCE_PORT);
  });

  it('последняя попытка решает: упал, затем прошёл — passed; без попыток — null; гейты D0/закупки по статусам', async () => {
    const acc = await seedAccount(prisma);
    const runId = await seedRun(
      acc.accountId,
      acc.siteId,
      acc.owner.memberId,
      (id) =>
        id === 'AT-CORE-02'
          ? ['failed', 'passed']
          : id === 'AT-CORE-14'
            ? ['passed', 'failed']
            : id === 'AT-CORE-08'
              ? []
              : ['passed'],
    );
    const ev = await reader.runEvidence(acc.accountId, runId);
    expect(ev).toMatchObject({ runId, siteId: acc.siteId });
    expect(Object.keys(ev!.cases)).toHaveLength(AT_CATALOG.length);
    expect(ev!.cases['AT-CORE-02']).toEqual({
      version: AT_CATALOG_VERSION,
      status: 'passed',
      codeSha: REL,
    });
    expect(ev!.cases['AT-CORE-14'].status).toBe('failed');
    expect(ev!.cases['AT-CORE-08'].status).toBeNull();
    // D0 не содержит AT-CORE-14 и AT-CORE-08 — открыт; закупка — нет.
    expect(launchEvidenceCheck('launch_evidence_d0', ev, REL)).toMatchObject({
      ok: true,
      required: 21,
    });
    expect(launchEvidenceCheck('launch_evidence_purchase', ev, REL)).toEqual({
      ok: false,
      reason: 'qa_run_incomplete',
      required: 30,
      missing: [{ caseKey: 'AT-CORE-14', problem: 'status', status: 'failed' }],
      releaseSha: REL,
    });
    // Чужой кабинет и кривой id — как несуществующий прогон.
    const other = await seedAccount(prisma);
    expect(await reader.runEvidence(other.accountId, runId)).toBeNull();
    expect(
      await reader.runEvidence(acc.accountId, 'qa-run-free-text'),
    ).toBeNull();
    expect(await reader.runEvidence(acc.accountId, "x' OR 1=1 --")).toBeNull();
  });

  it('IA-AB-04: прогон на прежнем commit (все 44 passed) не принимается для выпуска текущей версии; commit — из отчёта последней попытки', async () => {
    const acc = await seedAccount(prisma);
    const runId = await seedRun(
      acc.accountId,
      acc.siteId,
      acc.owner.memberId,
      (id) => (id === 'AT-CORE-03' ? ['passed', 'passed'] : ['passed']),
      () => OLD,
    );
    const ev = await reader.runEvidence(acc.accountId, runId);
    expect(ev!.cases['AT-CORE-01']).toEqual({
      version: AT_CATALOG_VERSION,
      status: 'passed',
      codeSha: OLD,
    });
    const d0 = launchEvidenceCheck('launch_evidence_d0', ev, REL);
    expect(d0).toMatchObject({
      ok: false,
      reason: 'qa_run_incomplete',
      releaseSha: REL,
    });
    expect(d0.ok ? [] : d0.missing.map((m) => m.problem)).toEqual(
      Array(21).fill('code_version'),
    );
    // Та же версия, что в отчёте, — принимается; неизвестная — нет.
    expect(launchEvidenceCheck('launch_evidence_d0', ev, OLD).ok).toBe(true);
    expect(launchEvidenceCheck('launch_evidence_d0', ev, null)).toMatchObject({
      ok: false,
      reason: 'code_version_unknown',
    });
  });

  it('IA-AB-04: версия процесса — PUBLISHER_RELEASE_SHA → VERCEL_GIT_COMMIT_SHA → GITHUB_SHA; commit попытки — deployedSha ?? testSourceSha', () => {
    expect(releaseCodeSha({})).toBeNull();
    expect(releaseCodeSha({ GITHUB_SHA: OLD })).toBe(OLD);
    expect(
      releaseCodeSha({
        VERCEL_GIT_COMMIT_SHA: REL.toUpperCase(),
        GITHUB_SHA: OLD,
      }),
    ).toBe(REL);
    expect(
      releaseCodeSha({
        PUBLISHER_RELEASE_SHA: OLD,
        VERCEL_GIT_COMMIT_SHA: REL,
      }),
    ).toBe(OLD);
    expect(releaseCodeSha({ PUBLISHER_RELEASE_SHA: 'main' })).toBeNull();
    expect(attemptCodeSha({ testSourceSha: OLD, deployedSha: REL })).toBe(REL);
    expect(attemptCodeSha({ testSourceSha: OLD, deployedSha: null })).toBe(OLD);
    expect(
      attemptCodeSha({ testSourceSha: 'x', deployedSha: null }),
    ).toBeNull();
    expect(attemptCodeSha(null)).toBeNull();
    expect(typeof reader.releaseSha()).not.toBe('undefined');
  });
});
