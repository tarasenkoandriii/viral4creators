/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  VOICE_UPLOAD_SWEEP_BATCH,
  VoiceUploadService,
  voiceUploadCutoff,
} from './voice-upload.service';
import { VOICE_RECORDING_MAX_AGE_MS } from '../../common/orphan-sweep';
import { SONIOX_PENDING_DELETE_KEY } from '../voice/soniox-stt.client';

const NOW = new Date('2026-09-30T12:00:00Z');

/** Строки учёта в памяти: `findMany` честно фильтрует по возрасту и `notIn`. */
function build(
  rows: Array<{ pathname: string; createdAt: Date }>,
  opts: { failPaths?: string[]; sonioxQueue?: string } = {},
) {
  const store = new Map(rows.map((r) => [r.pathname, r]));
  // Очередь неудалённого у Soniox (C4 захода 8) — строка `PlatformSetting`.
  let setting: { key: string; value: string } | null =
    opts.sonioxQueue === undefined
      ? null
      : { key: SONIOX_PENDING_DELETE_KEY, value: opts.sonioxQueue };
  const prisma = {
    platformSetting: {
      findUnique: jest.fn(async () => (setting ? { ...setting } : null)),
      create: jest.fn(async ({ data }: any) => (setting = { ...data })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!setting || setting.value !== where.value) return { count: 0 };
        setting = { key: setting.key, value: data.value };
        return { count: 1 };
      }),
    },
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
  return { service, prisma, blob, store, queue: () => setting?.value ?? null };
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
    expect(r).toEqual({
      deleted: 1,
      failed: 0,
      hasMore: false,
      soniox: { deleted: 0, dropped: 0, left: 0 },
      // Ключа Soniox в этих проверках нет — уборка по списку пропущена.
      sonioxStale: expect.objectContaining({ sonioxSkipped: true }),
    });
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
    expect(r).toEqual({
      deleted: 0,
      failed: 1,
      hasMore: false,
      soniox: { deleted: 0, dropped: 0, left: 0 },
      // Ключа Soniox в этих проверках нет — уборка по списку пропущена.
      sonioxStale: expect.objectContaining({ sonioxSkipped: true }),
    });
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
      soniox: { deleted: 0, dropped: 0, left: 0 },
      // Ключа Soniox в этих проверках нет — уборка по списку пропущена.
      sonioxStale: expect.objectContaining({ sonioxSkipped: true }),
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

  describe('тем же тиком — очередь неудалённого у Soniox (C4 захода 8)', () => {
    const saved = { ...process.env };
    const realFetch = global.fetch;
    beforeEach(() => {
      process.env.SONIOX_API_KEY = 'sk';
    });
    afterAll(() => {
      process.env = saved;
      global.fetch = realFetch;
    });

    it('метла повторяет удаление: удалено — снято, 409 — ждёт следующего тика', async () => {
      const since = NOW.toISOString();
      const { service, queue } = build(
        [{ pathname: 'sessions/s/voice-1.webm', createdAt: minutesAgo(61) }],
        {
          sonioxQueue: JSON.stringify([
            { kind: 'transcription', id: 't1', since, attempts: 0 },
            { kind: 'transcription', id: 't2', since, attempts: 0 },
          ]),
        },
      );
      const old = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
      const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
        // Списки провайдера: своя старая транскрипция и чужая.
        if ((init?.method ?? 'GET') === 'GET') {
          const kind = url.includes('/transcriptions?')
            ? 'transcriptions'
            : 'files';
          const items =
            kind === 'transcriptions'
              ? [
                  {
                    id: 'own',
                    created_at: old,
                    client_reference_id: 'v4c-gen:stt',
                  },
                  {
                    id: 'foreign',
                    created_at: old,
                    client_reference_id: 'da:x',
                  },
                ]
              : [];
          return {
            ok: true,
            status: 200,
            json: async () => ({ [kind]: items, next_page_cursor: null }),
          } as Response;
        }
        const status =
          url.endsWith('/transcriptions/t1') ||
          url.endsWith('/transcriptions/own')
            ? 204
            : 409;
        return { ok: status < 300, status } as Response;
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const r = await service.sweepExpired(NOW);
      expect(r).toEqual({
        deleted: 1,
        failed: 0,
        hasMore: false,
        soniox: { deleted: 1, dropped: 0, left: 1 },
        sonioxStale: {
          sonioxFilesDeleted: 0,
          sonioxTranscriptionsDeleted: 1,
          sonioxBusy: 0,
          sonioxFailed: 0,
          sonioxForeignSkipped: 1,
        },
      });
      const deletes = fetchMock.mock.calls
        .filter((c) => c[1]?.method === 'DELETE')
        .map((c) => String(c[0]).replace(/^.*\/v1/, ''));
      // Очередь, затем своё по списку; чужое не тронуто.
      expect(deletes).toEqual([
        '/transcriptions/t1',
        '/transcriptions/t2',
        '/transcriptions/own',
      ]);
      expect(JSON.parse(queue()!)).toEqual([
        expect.objectContaining({ id: 't2', attempts: 1, lastStatus: 409 }),
      ]);
    });

    it('сбой очереди не роняет уборку записей', async () => {
      const { service, prisma, store } = build([
        { pathname: 'sessions/s/voice-1.webm', createdAt: minutesAgo(61) },
      ]);
      prisma.platformSetting.findUnique.mockRejectedValue(new Error('db down'));
      const r = await service.sweepExpired(NOW);
      expect(r.deleted).toBe(1);
      expect(store.size).toBe(0);
    });
  });
});
