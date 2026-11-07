import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface HistoryRunWrite {
  id: string;
  userId: string;
  sessionId: string;
  module: string;
  source: 'ui' | 'api' | 'background' | 'unknown';
  status:
    | 'queued'
    | 'processing'
    | 'complete'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  revision: number;
  provider?: string;
  model?: string;
  resolution?: string;
  durationSeconds?: number;
}

/** Caller holds the live owned session row lock; never use as public ingestion. */
export async function writeGenerationHistoryRun(
  tx: Prisma.TransactionClient,
  input: HistoryRunWrite,
): Promise<void> {
  const row = await tx.generationHistoryRun.upsert({
    where: { id: input.id },
    create: input,
    update: {},
    select: {
      userId: true,
      sessionId: true,
      module: true,
      source: true,
      status: true,
      revision: true,
    },
  });
  if (
    row.userId !== input.userId ||
    row.sessionId !== input.sessionId ||
    row.module !== input.module ||
    row.source !== input.source
  ) {
    throw new NotFoundException('Generation context not found');
  }
  // Baseline records only the state actually observed, including pre-journal runs.
  await tx.generationHistoryEvent.upsert({
    where: { runId_revision: { runId: input.id, revision: row.revision } },
    create: {
      runId: input.id,
      revision: row.revision,
      kind: 'snapshot',
      status: row.status,
    },
    update: {},
  });
  const changed = await tx.generationHistoryRun.updateMany({
    where: {
      id: input.id,
      userId: input.userId,
      revision: { lt: input.revision },
      status: { notIn: ['complete', 'failed', 'cancelled'] },
    },
    data: {
      status: input.status,
      revision: input.revision,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.resolution !== undefined
        ? { resolution: input.resolution }
        : {}),
      ...(input.durationSeconds !== undefined
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
  });
  if (changed.count > 0) {
    await tx.generationHistoryEvent.upsert({
      where: { runId_revision: { runId: input.id, revision: input.revision } },
      create: {
        runId: input.id,
        revision: input.revision,
        kind: 'transition',
        fromStatus: row.status,
        status: input.status,
      },
      update: {},
    });
  }
}
