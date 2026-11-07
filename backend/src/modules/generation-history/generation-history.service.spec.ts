/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory persistence fixture */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import {
  GenerationHistoryService,
  GenerationHistoryInput,
} from './generation-history.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

function build() {
  const rows = new Map<string, any>();
  const sessions = new Map([
    ['s-A', 'A'],
    ['s-B', 'B'],
  ]);
  const matches = (row: any, where: any) =>
    row.userId === where.userId && (!where.id || row.id === where.id);
  const db: any = {
    session: {
      findFirst: jest.fn(async ({ where }: any) =>
        sessions.get(where.id) === where.userId ? { id: where.id } : null,
      ),
    },
    generationHistoryEvent: { upsert: jest.fn().mockResolvedValue({}) },
    generationHistoryRun: {
      upsert: jest.fn(async ({ where, create }: any) => {
        if (!rows.has(where.id))
          rows.set(where.id, {
            ...create,
            createdAt: new Date('2026-11-01'),
            updatedAt: new Date('2026-11-01'),
          });
        return { ...rows.get(where.id) };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (
          row &&
          matches(row, where) &&
          row.revision < where.revision.lt &&
          !where.status.notIn.includes(row.status)
        ) {
          Object.assign(row, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          [...rows.values()].find((row) => matches(row, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where, take, select }: any) =>
        [...rows.values()]
          .filter(
            (row) =>
              row.userId === where.userId &&
              (!where.OR ||
                where.OR.some((q: any) =>
                  q.id
                    ? row.createdAt.getTime() === q.createdAt.getTime() &&
                      row.id < q.id.lt
                    : row.createdAt < q.createdAt.lt,
                )),
          )
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(0, take)
          .map((row) =>
            Object.fromEntries(
              Object.keys(select).map((key) => [key, row[key]]),
            ),
          ),
      ),
    },
  };
  db.$queryRaw = jest.fn(
    async (_sql: unknown, sessionId: string, userId: string) =>
      sessions.get(sessionId) === userId ? [{ id: sessionId }] : [],
  );
  db.$transaction = (fn: any) => fn(db);
  return { service: new GenerationHistoryService(db), db, rows, sessions };
}
const input = (
  over: Partial<GenerationHistoryInput> = {},
): GenerationHistoryInput => ({
  id: 'run-A',
  userId: 'A',
  sessionId: 's-A',
  module: 'product-video',
  source: 'ui',
  status: 'processing',
  revision: 1,
  ...over,
});

describe('private durable generation history foundation', () => {
  it('duplicate and older events keep one attempt and latest revision', async () => {
    const { service, rows } = build();
    await service.record(input());
    await service.record(input());
    await service.record(input({ revision: 0, status: 'queued' }));
    expect(rows.size).toBe(1);
    expect(rows.get('run-A').revision).toBe(1);
    await service.record(input({ revision: 2, status: 'complete' }));
    await service.record(input({ revision: 3, status: 'processing' }));
    expect(rows.get('run-A').status).toBe('complete');
  });

  it('rejects foreign/unowned session before writing a run', async () => {
    const { service, db } = build();
    await expect(
      service.record(input({ sessionId: 's-B' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.record(input({ sessionId: 'guest' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.generationHistoryRun.upsert).not.toHaveBeenCalled();
  });

  it('cannot reassign a runId to another owner or context', async () => {
    const { service, rows } = build();
    await service.record(input());
    await expect(
      service.record(input({ userId: 'B', sessionId: 's-B', revision: 9 })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.get('run-A').userId).toBe('A');
    expect(rows.get('run-A').revision).toBe(1);
  });

  it('reads only caller history after temporary session disappears; no private snapshot fields', async () => {
    const { service, sessions } = build();
    await service.record(input());
    await service.record(input({ id: 'run-B', userId: 'B', sessionId: 's-B' }));
    sessions.delete('s-A');
    const page = await service.list('A');
    expect(page.items.map((row) => row.id)).toEqual(['run-A']);
    expect(page.items[0]).not.toHaveProperty('userId');
    expect(page.items[0]).not.toHaveProperty('prompt');
    expect(page.coverage).toBe('session-video-partial');
    await expect(
      service.record(input({ revision: 2, status: 'complete' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('validates limits, revisions and metadata before DB use', async () => {
    const { service, db } = build();
    await expect(
      service.list('A', 20, ['a', 'b'] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const limit of [0, -1, 101, 1.5, NaN])
      await expect(service.list('A', limit)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    await expect(
      service.record(input({ revision: -1 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.record(input({ model: 'x'.repeat(201) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.record(input({ durationSeconds: 0 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.generationHistoryRun.upsert).not.toHaveBeenCalled();
  });

  it('does not accept another user cursor; uses stable id tie-break pagination', async () => {
    const { service } = build();
    await service.record(input({ id: 'a' }));
    await service.record(input({ id: 'b' }));
    await service.record(
      input({ id: 'foreign', userId: 'B', sessionId: 's-B' }),
    );
    await expect(service.list('A', 1, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const first = await service.list('A', 1);
    expect(first.items.map((row) => row.id)).toEqual(['b']);
    expect(first.nextCursor).toBe('b');
    const second = await service.list('A', 1, first.nextCursor!);
    expect(second.items.map((row) => row.id)).toEqual(['a']);
    expect(second.nextCursor).toBeNull();
  });
});
