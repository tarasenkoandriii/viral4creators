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
@Injectable()
export class QaCiService {
  private readonly identity = new QaCiIdentity();
  constructor(
    private readonly catalog: QaCatalogService,
    private readonly runs: QaRunService,
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
      throw new BadRequestException('CI case versions differ from the catalog');
    const id = `qaci${claims.runId.padStart(20, '0')}${createHash('sha256').update(`${accountId}:${siteId}:${repositoryId}:${claims.runAttempt}:${parsed.project}`).digest('hex').slice(0, 24)}`;
    let run = await db.qaTestRun.findFirst({
      where: { id, accountId, siteId },
    });
    if (!run) {
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
    return { runId: id, ...result };
  }
}
