import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { QaRunService } from './qa-run.service';
import { parseQaReport } from './qa-report-input';
import { QaCiIdentity } from './qa-ci-identity';
import { QaFindingService } from './qa-finding.service';
import { findingFingerprint, parseFinding } from './qa-finding-input';
import { acceptanceStatus } from './qa-attempt-status';
@Injectable()
export class QaCiService {
  private readonly identity = new QaCiIdentity();
  constructor(
    private readonly catalog: QaCatalogService,
    private readonly runs: QaRunService,
    private readonly findings: QaFindingService,
  ) {}
  async deliver(authorization: string | undefined, input: unknown) {
    // Single explicit pilot binding. No account/site/repository selected by the caller.
    const values = [
      'QA_CI_REPOSITORY',
      'QA_CI_REPOSITORY_ID',
      'QA_CI_OWNER_ID',
      'QA_CI_WORKFLOW',
      'QA_CI_ACCOUNT_ID',
      'QA_CI_SITE_ID',
    ].map((k) => process.env[k]?.trim());
    if (values.some((v) => !v))
      throw new ServiceUnavailableException({
        code: 'QA_CI_DISABLED',
        message: 'CI report delivery is not configured.',
      });
    const [repository, repositoryId, ownerId, workflow, accountId, siteId] =
      values as string[];
    const claims = await this.identity.authenticate(
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : '',
      { repository, repositoryId, ownerId, workflow },
    );
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !['project', 'report'].includes(k))
    )
      throw new BadRequestException('Invalid CI report');
    const body = input as { project: unknown; report: unknown };
    const parsed = parseQaReport({ ...body, expectedRevision: 1 });
    if (parsed.metadata.testSourceSha !== claims.sha)
      throw new BadRequestException('Report source does not match CI identity');
    const m: AccountMembership = {
      accountId,
      memberId: `github:${repositoryId}:${claims.runId}`,
      telegramId: 0n,
      role: 'operator',
      productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
    };
    const db = await this.catalog.scoped(m, siteId, true);
    const id = `qaci${claims.runId.padStart(20, '0')}${createHash('sha256').update(`${accountId}:${siteId}:${repositoryId}:${claims.runAttempt}:${parsed.project}`).digest('hex').slice(0, 24)}`;
    let run = await db.qaTestRun.findFirst({
      where: { id, accountId, siteId },
    });
    if (!run) {
      const cases = await db.qaTestCase.findMany({
        where: {
          accountId,
          siteId,
          archived: false,
          caseKey: { in: parsed.cases.map((c) => c.caseKey) },
        },
      });
      if (
        cases.length !== parsed.cases.length ||
        parsed.cases.some(
          (c) =>
            !cases.some(
              (row) =>
                row.caseKey === c.caseKey && row.currentVersion === c.version,
            ),
        )
      )
        throw new BadRequestException(
          'CI case versions differ from the catalog',
        );

      try {
        run = await this.runs.create(
          m,
          siteId,
          {
            title: `GitHub #${claims.runId} · attempt ${claims.runAttempt} · ${parsed.project}`,
            caseIds: cases.map((c) => c.id),
          },
          id,
        );
      } catch (error) {
        run = await db.qaTestRun.findFirst({
          where: { id, accountId, siteId },
        });
        if (!run) throw error;
      }
    }
    const result = await this.runs.importReport(m, siteId, id, {
      ...body,
      expectedRevision: run.revision,
    });
    const audit = await this.sandboxAudit(m, siteId, id, parsed);
    return { runId: id, ...result, audit };
  }
  /** Bounded pilot: one non-submitting scenario on our verified sandbox, using saved CI proof. */
  private async sandboxAudit(
    m: AccountMembership,
    siteId: string,
    runId: string,
    report: ReturnType<typeof parseQaReport>,
  ) {
    const caseKey = 'SBX-TUTORIAL';
    if (
      report.metadata.source !== 'playwright' ||
      report.metadata.targetOrigin !== 'https://sandbox.viral4creators.app' ||
      !['desktop', 'mobile'].includes(report.project) ||
      !report.cases.some((c) => c.caseKey === caseKey && c.version === 1)
    )
      return { status: 'out_of_scope' };
    const db = await this.catalog.scoped(m, siteId, true);
    const host = await db.siteHost.findFirst({
      where: {
        accountId: m.accountId,
        siteId,
        host: 'sandbox.viral4creators.app',
        scheme: 'https',
        port: 443,
        status: 'verified',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!host) return { status: 'out_of_scope' };
    const attempts = await db.qaTestRunAttempt.findMany({
      where: {
        accountId: m.accountId,
        runId,
        caseKey,
        project: report.project,
        origin: 'automated',
        reportHash: report.reportHash,
      },
      orderBy: { sourceAttempt: 'asc' },
    });
    // Never synthesize browser success/failure from a caller's summary.
    if (
      attempts.length !==
      report.attempts.filter((a) => a.caseKey === caseKey).length
    )
      throw new ServiceUnavailableException('Saved audit proof is incomplete');
    const latest = attempts.at(-1);
    if (!latest)
      throw new ServiceUnavailableException('Saved audit proof is missing');
    const failed = attempts.find((a) => a.status === 'failed');
    const payload = parseFinding({
      title: 'Sandbox Tutorial: автоматическая проверка требует разбора',
      category: 'logic',
      severity: 'P2',
      status: 'needs_confirmation',
      url: 'https://sandbox.viral4creators.app/',
      context: `Playwright ${report.project}; SBX-TUTORIAL v1`,
      steps: 'Пройти три шага Tutorial, завершить и сбросить к первому шагу.',
      expected: 'Шаги завершаются; сброс возвращает первый шаг.',
      actual: 'Автоматическая проверка SBX-TUTORIAL завершилась ошибкой.',
      impact:
        'Сценарий Tutorial требует разбора. Причина и влияние на клиента ещё не подтверждены.',
      evidence: failed
        ? [`qa-run:${runId}; case:${caseKey}; attempt:${failed.id}`]
        : [],
      deployedSha: report.metadata.deployedSha,
      observedAt: (failed?.createdAt ?? new Date()).toISOString(),
      verification: null,
      ...(failed ? { source: { runId, caseKey, attemptId: failed.id } } : {}),
    });
    const fingerprint = findingFingerprint(payload);
    const lookup = () =>
      db.qaFinding.findFirst({
        where: {
          accountId: m.accountId,
          siteId,
          fingerprint,
        },
        select: { id: true },
      });
    let finding = await lookup();
    let created = false;
    if (failed && !finding) {
      try {
        finding = await this.findings.create(m, siteId, payload);
        created = true;
      } catch (error) {
        // Concurrent deliveries converge on the same unique observation; all other failures propagate.
        if (
          !(error instanceof Error) ||
          !('getResponse' in error) ||
          typeof error.getResponse !== 'function' ||
          (error.getResponse() as { code?: string })?.code !==
            'QA_FINDING_DUPLICATE'
        )
          throw error;
        finding = await lookup();
        if (!finding) throw error;
      }
    }
    // A passing retry is evidence for review, never permission to close/edit a human finding.
    return {
      status: acceptanceStatus(latest),
      flaky: !!failed && latest.status === 'passed',
      findingId: finding?.id ?? null,
      created,
      proof: {
        runId,
        caseKey,
        attemptId: latest.id,
        reportHash: report.reportHash,
      },
      requiresReview: !!finding,
    };
  }
}
