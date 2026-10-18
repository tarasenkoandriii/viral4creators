/** Operator-only live regression. All database writes roll back; only synthetic blobs are temporary. */
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { activateOnAsset } from '../postprod/tutorial-video-asset-writes';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';
import {
  APPROVAL_FIXTURE_A,
  APPROVAL_FIXTURE_B,
  APPROVAL_FIXTURE_PLAN,
} from './tutorial-approval-fixtures';

export interface ApprovalProbeResult {
  ok: true;
  runId: string;
  observedAt: string;
  sha256: { first: string; replacement: string };
  checks: string[];
  rolledBack: true;
  blobsRemoved: true;
}
class ProbeRollback extends Error {
  constructor(readonly checks: string[]) {
    super('rollback synthetic approval probe');
  }
}
function check(value: unknown, name: string, checks: string[]): asserts value {
  if (!value)
    throw new InternalServerErrorException(
      `Проверка приёмки не пройдена: ${name}`,
    );
  checks.push(name);
}
@Injectable()
export class TutorialApprovalProbeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}

  async run(operatorId: string): Promise<ApprovalProbeResult> {
    const plan = APPROVAL_FIXTURE_PLAN;
    const runId = `qa-approval-${randomUUID()}`;
    const pathnames = [
      `tutorial-videos/${runId}/first.mp4`,
      `tutorial-videos/${runId}/replacement.mp4`,
    ];
    const sha256 = {
      first: createHash('sha256').update(APPROVAL_FIXTURE_A).digest('hex'),
      replacement: createHash('sha256')
        .update(APPROVAL_FIXTURE_B)
        .digest('hex'),
    };
    let checks: string[] | undefined;
    let removed = 0;
    try {
      const first = await this.blob.uploadBuffer(
        `tutorial-videos/${runId}/first.mp4`,
        APPROVAL_FIXTURE_A,
        'video/mp4',
      );
      const replacement = await this.blob.uploadBuffer(
        `tutorial-videos/${runId}/replacement.mp4`,
        APPROVAL_FIXTURE_B,
        'video/mp4',
      );
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const passed: string[] = [];
            await tx.tutorialVideoAsset.create({
              data: {
                id: runId,
                subjectKey: '__qa_exact_approval__',
                locale: 'en',
                title: 'Synthetic approval regression',
                blobUrl: first.url,
                assemblyStatus: 'complete',
                durationMs: plan.durationMs,
              },
            });
            const versions = [];
            for (const [i, url] of [first.url, replacement.url].entries()) {
              versions.push(
                await tx.tutorialVideoVersion.create({
                  data: {
                    assetId: runId,
                    kind: 'qa-probe',
                    motion: 'fade',
                    manifestVersion: 1,
                    idempotencyKey: `qa-${i}`,
                    status: 'complete',
                    blobUrl: url,
                    videoMs: 200,
                    requestedBy: operatorId,
                  },
                }),
              );
            }
            await tx.tutorialVideoAsset.update({
              where: { id: runId },
              data: { activeVersionId: versions[0].id },
            });
            // Same production approval implementation, isolated transaction client.
            // No settings/media/quality dependencies: never sync or queue the test.
            const service = new TutorialVideoAdminService(
              tx as unknown as PrismaService,
            );
            const approved = await service.setReviewed(
              runId,
              true,
              { expectedBlobUrl: first.url, expectedVersionId: versions[0].id },
              operatorId,
            );
            const proof = approved.reviewApproval as {
              sha256?: string;
              versionId?: string;
              approvedBy?: string;
            } | null;
            check(
              approved.reviewed &&
                proof?.sha256 === sha256.first &&
                proof.versionId === versions[0].id &&
                proof.approvedBy === operatorId,
              'exact-file-version-sha',
              passed,
            );
            let staleRejected = false;
            try {
              await service.setReviewed(
                runId,
                true,
                {
                  expectedBlobUrl: first.url,
                  expectedVersionId: versions[1].id,
                },
                operatorId,
              );
            } catch (e) {
              if (e instanceof ConflictException) staleRejected = true;
              else throw e;
            }
            check(staleRejected, 'stale-version-rejected', passed);
            check(
              await activateOnAsset(tx as unknown as PrismaService, runId, {
                versionId: versions[1].id,
                blobUrl: replacement.url,
                plan,
              }),
              'real-activation-writer',
              passed,
            );
            const replaced = await tx.tutorialVideoAsset.findUniqueOrThrow({
              where: { id: runId },
            });
            check(
              !replaced.reviewed && replaced.reviewApproval === null,
              'replacement-revokes-approval',
              passed,
            );
            const second = await service.setReviewed(
              runId,
              true,
              {
                expectedBlobUrl: replacement.url,
                expectedVersionId: versions[1].id,
              },
              operatorId,
            );
            check(
              second.reviewed &&
                (second.reviewApproval as { sha256?: string } | null)
                  ?.sha256 === sha256.replacement &&
                sha256.first !== sha256.replacement,
              'replacement-needs-new-sha',
              passed,
            );
            await tx.tutorialVideoAsset.update({
              where: { id: runId },
              data: { tempoManifest: { qa: 'changed-provenance' } },
            });
            const changed = await tx.tutorialVideoAsset.findUniqueOrThrow({
              where: { id: runId },
            });
            check(
              !changed.reviewed && changed.reviewApproval === null,
              'provenance-revokes-approval',
              passed,
            );
            throw new ProbeRollback(passed);
          },
          { timeout: 60000 },
        );
        throw new InternalServerErrorException(
          'Тест приёмки не выполнил откат',
        );
      } catch (e) {
        if (!(e instanceof ProbeRollback)) throw e;
        checks = e.checks;
      }
      check(
        (await this.prisma.tutorialVideoAsset.count({
          where: { id: runId },
        })) === 0,
        'test-row-rolled-back',
        checks,
      );
      check(
        (await this.prisma.tutorialVideoVersion.count({
          where: { assetId: runId },
        })) === 0,
        'test-versions-rolled-back',
        checks,
      );
    } finally {
      removed = await this.blob.deleteMany(pathnames);
    }
    check(removed === pathnames.length, 'synthetic-blobs-removed', checks!);
    return {
      ok: true,
      runId,
      observedAt: new Date().toISOString(),
      sha256,
      checks: checks!,
      rolledBack: true,
      blobsRemoved: true,
    };
  }
}
