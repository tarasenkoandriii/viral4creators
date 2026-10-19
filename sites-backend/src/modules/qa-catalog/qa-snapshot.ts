import { BadRequestException } from '@nestjs/common';
import { QaCatalogService } from './qa-catalog.service';
import { parseCaseInput } from './qa-case-input';
export type QaTransaction = Parameters<
  Parameters<Awaited<ReturnType<QaCatalogService['scoped']>>['$transaction']>[0]
>[0];
/** Freeze current revisions; plans and ad-hoc runs share the same boundary. */
export async function freezeQaCases(
  tx: QaTransaction,
  accountId: string,
  siteId: string,
  ids: string[],
) {
  const cases = await tx.qaTestCase.findMany({
    where: { id: { in: ids }, accountId, siteId, archived: false },
  });
  if (cases.length !== ids.length)
    throw new BadRequestException({ code: 'QA_CASE_SELECTION_INVALID' });
  const revisions = await tx.qaTestCaseRevision.findMany({
    where: {
      accountId,
      OR: cases.map((c) => ({ caseId: c.id, version: c.currentVersion })),
    },
  });
  const snapshot = ids.map((id) => {
    const c = cases.find((c) => c.id === id)!;
    const revision = revisions.find(
      (r) => r.caseId === id && r.version === c.currentVersion,
    );
    if (!revision)
      throw new BadRequestException({ code: 'QA_CASE_SELECTION_INVALID' });
    return {
      caseId: c.id,
      caseKey: c.caseKey,
      version: c.currentVersion,
      payload: parseCaseInput(revision.payload),
    };
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 1024 * 1024)
    throw new BadRequestException({ code: 'QA_CASE_SELECTION_INVALID' });
  return snapshot;
}
