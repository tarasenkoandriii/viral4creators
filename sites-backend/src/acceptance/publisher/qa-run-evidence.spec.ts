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
} from '../../modules/qa-catalog/qa-run-evidence';

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
        await prisma.qaTestRunAttempt.create({
          data: {
            accountId,
            runId: run.id,
            caseKey: c.id,
            attemptNumber: i + 1,
            status: statuses[i],
            comment: statuses[i] === 'passed' ? '' : 'збій',
            createdByMemberId: memberId,
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
    });
    expect(ev!.cases['AT-CORE-14'].status).toBe('failed');
    expect(ev!.cases['AT-CORE-08'].status).toBeNull();
    // D0 не содержит AT-CORE-14 и AT-CORE-08 — открыт; закупка — нет.
    expect(launchEvidenceCheck('launch_evidence_d0', ev)).toMatchObject({
      ok: true,
      required: 21,
    });
    expect(launchEvidenceCheck('launch_evidence_purchase', ev)).toEqual({
      ok: false,
      reason: 'qa_run_incomplete',
      required: 30,
      missing: [{ caseKey: 'AT-CORE-14', problem: 'status', status: 'failed' }],
    });
    // Чужой кабинет и кривой id — как несуществующий прогон.
    const other = await seedAccount(prisma);
    expect(await reader.runEvidence(other.accountId, runId)).toBeNull();
    expect(
      await reader.runEvidence(acc.accountId, 'qa-run-free-text'),
    ).toBeNull();
    expect(await reader.runEvidence(acc.accountId, "x' OR 1=1 --")).toBeNull();
  });
});
