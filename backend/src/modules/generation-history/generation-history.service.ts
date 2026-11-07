import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { writeGenerationHistoryRun } from '../../common/generation-history-write';
import { PrismaService } from '../../prisma/prisma.service';

const STATUSES = [
  'queued',
  'processing',
  'complete',
  'failed',
  'cancelled',
  'unknown',
] as const;
const PUBLIC_FIELDS = {
  id: true,
  sessionId: true,
  module: true,
  source: true,
  status: true,
  revision: true,
  provider: true,
  model: true,
  resolution: true,
  durationSeconds: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Internal producer contract. Never accepted from a public HTTP body. */
export interface GenerationHistoryInput {
  id: string;
  userId: string;
  sessionId: string;
  module: string;
  source: 'ui' | 'api' | 'background' | 'unknown';
  status: (typeof STATUSES)[number];
  revision: number;
  provider?: string;
  model?: string;
  resolution?: string;
  durationSeconds?: number;
}

@Injectable()
export class GenerationHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent, monotonic ingestion; producer must supply a stable runId/revision. */
  async record(input: GenerationHistoryInput): Promise<void> {
    const stringValues = [
      input.id,
      input.userId,
      input.sessionId,
      input.module,
    ];
    if (
      stringValues.some(
        (v) => typeof v !== 'string' || !v.trim() || v.length > 200,
      ) ||
      !STATUSES.includes(input.status) ||
      !['ui', 'api', 'background', 'unknown'].includes(input.source) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      input.revision > 2147483647 ||
      [input.provider, input.model, input.resolution].some(
        (v) => v !== undefined && (typeof v !== 'string' || v.length > 200),
      ) ||
      (input.durationSeconds !== undefined &&
        (!Number.isSafeInteger(input.durationSeconds) ||
          input.durationSeconds <= 0 ||
          input.durationSeconds > 86400))
    ) {
      throw new BadRequestException('Invalid generation history event');
    }
    await this.prisma.$transaction(async (tx) => {
      // Even internal writers may not attach a run to a different user's session.
      // Shared row lock serializes with explicit session deletion. TTL may
      // remove the temporary session afterwards, but cannot undo this record.
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "sessions"
        WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
          AND "deletedAt" IS NULL
        FOR SHARE
      `;
      if (!owned.length)
        throw new NotFoundException('Generation context not found');
      await writeGenerationHistoryRun(tx, {
        id: input.id,
        userId: input.userId,
        sessionId: input.sessionId,
        module: input.module,
        source: input.source,
        status: input.status,
        revision: input.revision,
        provider: input.provider,
        model: input.model,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
      });
    });
  }

  async list(userId: string, limit = 20, before?: string) {
    if (!userId) throw new BadRequestException('Identity required');
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before !== undefined &&
        (typeof before !== 'string' || !before || before.length > 200))
    ) {
      throw new BadRequestException('Invalid pagination');
    }
    const cursor = before
      ? await this.prisma.generationHistoryRun.findFirst({
          where: { id: before, userId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (before && !cursor)
      throw new NotFoundException('History cursor not found');
    const rows = await this.prisma.generationHistoryRun.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: PUBLIC_FIELDS,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      coverage: 'session-video-partial' as const,
    };
  }
}
