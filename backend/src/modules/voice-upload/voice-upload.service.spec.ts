/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  VOICE_UPLOAD_SWEEP_BATCH,
  VoiceUploadService,
  voiceUploadCutoff,
} from './voice-upload.service';
import { VOICE_RECORDING_MAX_AGE_MS } from '../../common/orphan-sweep';

const NOW = new Date('2026-09-30T12:00:00Z');

/** Строки учёта в памяти: `findMany` честно фильтрует по возрасту и `notIn`. */
function build(
  rows: Array<{ pathname: string; createdAt: Date }>,
  opts: { failPaths?: string[] } = {},
) {
  const store = new Map(rows.map((r) => [r.pathname, r]));
  const prisma = {
    voiceUpload: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const list: string[] =
          typeof where.pathname === 'string'
            ? [where.pathname]
            : where.pathname.in;
        let count = 0;
        for (const p of list) if (store.delete(p)) count++;
        return { count };
      }),
      findMany: jest.fn().mockImplementation(async ({ where, take }: any) => {
        const notIn: string[] = where.pathname?.notIn ?? [];
        return [...store.values()]
          .filter((r) => r.createdAt < where.createdAt.lt)
          .filter((r) => !notIn.includes(r.pathname))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((r) => ({ pathname: r.pathname }));
      }),
    },
  };
  const fail = new Set(opts.failPaths ?? []);
  const blob = {
    // Хранилище «принимает» порцию целиком или не принимает вовсе — как
    // `BlobService.deleteMany` с одним `del()` на порцию.
    deleteMany: jest
      .fn()
      .mockImplementation(async (paths: string[]) =>
        paths.some((p) => fail.has(p)) ? 0 : paths.length,
      ),
  };
  const service = new VoiceUploadService(prisma as any, blob as any);
  return { service, prisma, blob, store };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('VoiceUploadService', () => {
  it('граница — час: запись старше часа удаляется, моложе — нет', async () => {
    expect(voiceUploadCutoff(NOW).getTime()).toBe(
      NOW.getTime() - VOICE_RECORDING_MAX_AGE_MS,
    );
    const { service, blob, store } = build([
      { pathname: 'sessions/s/voice-1.webm', createdAt: minutesAgo(61) },
      { pathname: 'sessions/s/voice-2.webm', createdAt: minutesAgo(59) },
    ]);
    const r = await service.sweepExpired(NOW);
    expect(r).toEqual({ deleted: 1, failed: 0, hasMore: false });
    expect(blob.deleteMany).toHaveBeenCalledWith(
      ['sessions/s/voice-1.webm'],
      expect.any(Number),
    );
    expect([...store.keys()]).toEqual(['sessions/s/voice-2.webm']);
  });

  it('хранилище не приняло удаление — строка остаётся до следующего тика, прогон не зацикливается', async () => {
    const { service, store, prisma } = build(
      [
        {
          pathname: 'projects/p/greeting-voice-1.webm',
          createdAt: minutesAgo(90),
        },
      ],
      { failPaths: ['projects/p/greeting-voice-1.webm'] },
    );
    const r = await service.sweepExpired(NOW);
    expect(r).toEqual({ deleted: 0, failed: 1, hasMore: false });
    expect(store.has('projects/p/greeting-voice-1.webm')).toBe(true);
    // Выборка неполная — прогон окончен, повтора той же порции нет.
    expect(prisma.voiceUpload.findMany).toHaveBeenCalledTimes(1);
  });

  it('больше одной выборки — идёт следующей, пока есть просроченные', async () => {
    const rows = Array.from(
      { length: VOICE_UPLOAD_SWEEP_BATCH + 5 },
      (_, i) => ({
        pathname: `sessions/s/voice-${i}.webm`,
        createdAt: minutesAgo(120 + i),
      }),
    );
    const { service, store } = build(rows);
    const r = await service.sweepExpired(NOW);
    expect(r).toEqual({
      deleted: VOICE_UPLOAD_SWEEP_BATCH + 5,
      failed: 0,
      hasMore: false,
    });
    expect(store.size).toBe(0);
  });

  it('remember — upsert пути; forget — удаление строки и никогда не бросает', async () => {
    const { service, prisma } = build([]);
    await service.remember('sessions/s/voice-9.webm');
    expect(prisma.voiceUpload.upsert).toHaveBeenCalledWith({
      where: { pathname: 'sessions/s/voice-9.webm' },
      create: { pathname: 'sessions/s/voice-9.webm' },
      update: { createdAt: expect.any(Date) },
    });
    prisma.voiceUpload.deleteMany.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.forget('sessions/s/voice-9.webm'),
    ).resolves.toBeUndefined();
  });
});
