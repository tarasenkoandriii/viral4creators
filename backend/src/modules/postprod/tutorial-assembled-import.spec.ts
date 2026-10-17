/* eslint-disable @typescript-eslint/no-explicit-any -- isolated persistence doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({ Prisma: { DbNull: Symbol('null') } }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
jest.mock('../tutorial-runner/mp4-probe', () => ({ probeMp4: jest.fn() }));
import { head } from '@vercel/blob';
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import { TutorialVideoVersionsService } from './tutorial-video-versions.service';

const actor = { kind: 'operator', userId: 'operator' } as const;
const oldUrl = 'https://blob/tutorial-videos/original.mp4';
const pathname =
  'tutorial-video-sources/a1/imports-upload/12345678-1234-1234-1234-123456789012';
function setup() {
  const asset: any = {
    id: 'a1',
    clientSiteDraftId: 'd1',
    assemblyStatus: 'complete',
    blobUrl: oldUrl,
    activeVersionId: null,
    durationMs: 9000,
    createdAt: new Date(),
  };
  const version: any = {
    id: 'v1',
    assetId: 'a1',
    kind: 'import',
    status: 'complete',
    videoMs: 1000,
    createdAt: new Date(),
  };
  const tx: any = {
    tutorialVideoAsset: {
      findUnique: jest.fn(async () => asset),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    tutorialVideoVersion: {
      count: jest.fn(async () => 0),
      upsert: jest.fn(),
      create: jest.fn(async ({ data }) => ({ ...version, ...data })),
    },
  };
  const prisma: any = {
    tutorialVideoVersion: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn) => fn(tx)),
  };
  const blob: any = {
    uploadBuffer: jest.fn(async () => ({
      url: 'https://blob/tutorial-videos/import.mp4',
    })),
    createUploadUrl: jest.fn(),
  };
  const ffmpeg: any = { submit: jest.fn() };
  const usage: any = { record: jest.fn() };
  const tts: any = { resolve: jest.fn() };
  const media: any = { syncForDraft: jest.fn() };
  const service = new TutorialVideoVersionsService(
    prisma,
    blob,
    ffmpeg,
    usage,
    {} as any,
    tts,
    media,
  );
  jest.spyOn(service, 'requireAsset').mockResolvedValue({
    asset,
    framesPurgedAt: null,
    ownerUserId: 'owner',
    projectId: 'p1',
  });
  (head as jest.Mock).mockResolvedValue({
    size: 12,
    contentType: 'video/mp4',
    url: 'https://blob/upload',
  });
  (probeMp4 as jest.Mock).mockReturnValue({
    durationSeconds: 1,
    tracks: [
      {
        kind: 'video',
        samples: 25,
        width: 720,
        height: 1560,
        durationSeconds: 1,
      },
      { kind: 'audio', durationSeconds: 1 },
    ],
  });
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(Buffer.from('local-mp4')));
  return {
    service,
    asset,
    version,
    tx,
    prisma,
    blob,
    ffmpeg,
    usage,
    tts,
    media,
  };
}
afterEach(() => jest.restoreAllMocks());
it('preserves original, registers and activates exact bytes without paid providers or usage', async () => {
  const w = setup();
  const result = await w.service.importAssembled(actor, 'a1', pathname, oldUrl);
  expect(result.version.kind).toBe('import');
  expect(result.version.active).toBe(true);
  expect(w.tx.tutorialVideoVersion.upsert.mock.calls[0][0].create.blobUrl).toBe(
    oldUrl,
  );
  expect(
    w.tx.tutorialVideoAsset.updateMany.mock.calls[0][0].where.blobUrl,
  ).toBe(oldUrl);
  expect(w.blob.uploadBuffer.mock.calls[0][1]).toEqual(
    Buffer.from('local-mp4'),
  );
  expect(w.ffmpeg.submit).not.toHaveBeenCalled();
  expect(w.tts.resolve).not.toHaveBeenCalled();
  expect(w.usage.record).not.toHaveBeenCalled();
  expect(w.media.syncForDraft).toHaveBeenCalledWith('d1');
});
it('reuses a saved hash after a lost response without reactivation or upload', async () => {
  const w = setup();
  w.prisma.tutorialVideoVersion.findUnique.mockResolvedValue(w.version);
  expect(
    (await w.service.importAssembled(actor, 'a1', pathname, oldUrl)).reused,
  ).toBe(true);
  expect(w.blob.uploadBuffer).not.toHaveBeenCalled();
  expect(w.prisma.$transaction).not.toHaveBeenCalled();
});
it('rejects a foreign upload before reading storage', async () => {
  const w = setup();
  await expect(
    w.service.importAssembled(
      actor,
      'a1',
      pathname.replace('a1', 'other'),
      oldUrl,
    ),
  ).rejects.toThrow('чужая');
  expect(w.blob.uploadBuffer).not.toHaveBeenCalled();
});
it('does not import silent, wrong-canvas or mismatched-duration files', async () => {
  const w = setup();
  (probeMp4 as jest.Mock).mockReturnValue({
    durationSeconds: 1,
    tracks: [
      {
        kind: 'video',
        samples: 25,
        width: 720,
        height: 1560,
        durationSeconds: 1,
      },
    ],
  });
  await expect(
    w.service.importAssembled(actor, 'a1', pathname, oldUrl),
  ).rejects.toThrow('проверенный MP4');
  expect(w.prisma.$transaction).not.toHaveBeenCalled();
});
it('rejects stale target before uploading a permanent file', async () => {
  const w = setup();
  await expect(
    w.service.importAssembled(actor, 'a1', pathname, 'https://blob/other.mp4'),
  ).rejects.toThrow('уже изменился');
  expect(w.blob.uploadBuffer).not.toHaveBeenCalled();
});
it('detects a concurrent change inside the activation transaction', async () => {
  const w = setup();
  w.tx.tutorialVideoAsset.findUnique.mockResolvedValue({
    ...w.asset,
    blobUrl: 'newer',
  });
  await expect(
    w.service.importAssembled(actor, 'a1', pathname, oldUrl),
  ).rejects.toThrow('уже изменился');
  expect(w.tx.tutorialVideoAsset.updateMany).not.toHaveBeenCalled();
});
it('does not grant user actors operator import', async () => {
  const w = setup();
  await expect(
    w.service.importAssembled(
      { kind: 'user', userId: 'owner' },
      'a1',
      pathname,
      oldUrl,
    ),
  ).rejects.toThrow('оператор');
});
