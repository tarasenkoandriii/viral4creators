jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
import { head } from '@vercel/blob';
import { readBodyWithLimit } from '../../common/external-url-guard';
jest.mock('../../common/external-url-guard', () => ({
  readBodyWithLimit: jest.fn(),
}));
import { NarratorPreambleService } from './narrator-preamble.service';
import { parseNarratorPreamble } from './narrator-preamble';
const recording = {
  version: 1,
  manifestId: 'brand',
  characterId: null,
  imageUrl: null,
  voiceId: null,
  voiceProvider: null,
  pathname: 'brand-manifests/brand/preambles/abc123.mp4',
  sourcePathname: 'brand-manifests/brand/preamble-uploads/123abc.mp4',
  url: 'https://store.public.blob.vercel-storage.com/brand-manifests/brand/preambles/abc123.mp4',
  seconds: 6,
  locale: 'ru',
  approvedAt: '2026-10-16T10:00:00.000Z',
};
function setup() {
  const prisma = {
    brandManifest: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'brand',
        narratorCharacterId: null,
        characters: [],
        tutorialPreamble: recording,
      }),
      update: jest.fn(),
    },
    project: {
      findFirst: jest.fn().mockResolvedValue({ brandManifestId: 'brand' }),
    },
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'signed' }),
    uploadBuffer: jest.fn(),
    copyBlob: jest
      .fn()
      .mockImplementation(
        async (_from: string, pathname: string) =>
          `https://store.public.blob.vercel-storage.com/${pathname}`,
      ),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
  };
  const service = new NarratorPreambleService(prisma as never, blob as never);
  return { service, prisma, blob };
}
describe('narrator ownership and explicit preamble selection', () => {
  beforeEach(() => jest.clearAllMocks());
  it('scopes uploads by owner before issuing a PUT token', async () => {
    const { service, prisma, blob } = setup();
    prisma.brandManifest.findFirst.mockResolvedValue(null);
    await expect(service.upload('stranger', 'brand')).rejects.toThrow(
      'Бренд-бук не найден',
    );
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
    expect(prisma.brandManifest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'brand', userId: 'stranger' } }),
    );
  });
  it('uses a random staging path which cannot overwrite the approved clip', async () => {
    const { service, blob } = setup();
    const result = await service.upload('owner', 'brand');
    expect(result.pathname).toMatch(
      /^brand-manifests\/brand\/preamble-uploads\/[-a-f0-9]+\.mp4$/,
    );
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      result.pathname,
      'video/mp4',
      20971520,
    );
  });
  it('rejects a path from another brand before reading bytes', async () => {
    const { service } = setup();
    await expect(
      service.confirm('owner', 'brand', {
        pathname: 'brand-manifests/other/preamble-uploads/123abc.mp4',
        locale: 'ru',
        approved: true,
      }),
    ).rejects.toThrow();
    expect(head).not.toHaveBeenCalled();
  });
  it('reuses a confirmed upload on retry without storage writes', async () => {
    const { service, blob, prisma } = setup();
    await expect(
      service.confirm('owner', 'brand', {
        pathname: recording.sourcePathname,
        locale: 'ru',
        approved: true,
      }),
    ).resolves.toEqual(recording);
    expect(head).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.brandManifest.update).not.toHaveBeenCalled();
  });
  it('requires a linked own brand', async () => {
    const { service, prisma } = setup();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(service.forProject('owner', 'project', 'ru')).rejects.toThrow(
      'Сначала привяжите',
    );
  });
  it('rejects mismatched language rather than replacing or omitting speech', async () => {
    const { service } = setup();
    await expect(service.forProject('owner', 'project', 'uk')).rejects.toThrow(
      'на языке обучалки',
    );
  });
  it('returns the approved snapshot without changing global voice settings', async () => {
    const { service, prisma } = setup();
    expect(await service.forProject('owner', 'project', 'ru')).toEqual(
      recording,
    );
    expect(prisma.brandManifest.update).not.toHaveBeenCalled();
  });
  it('copies validated bytes to a token-free immutable path before saving', async () => {
    const { service, prisma, blob } = setup();
    prisma.brandManifest.findFirst.mockResolvedValue({
      id: 'brand',
      narratorCharacterId: null,
      characters: [],
      tutorialPreamble: null,
    } as never);
    const atom = (type: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(data.length + 8);
      h.write(type, 4);
      return Buffer.concat([h, data]);
    };
    const mvhd = Buffer.alloc(24);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(6000, 16);
    const track = (kind: string) => {
      const b = Buffer.alloc(12);
      b.write(kind, 8);
      return atom('trak', atom('mdia', atom('hdlr', b)));
    };
    const bytes = atom(
      'moov',
      Buffer.concat([atom('mvhd', mvhd), track('vide'), track('soun')]),
    );
    (head as jest.Mock).mockResolvedValue({
      size: bytes.length,
      contentType: 'video/mp4',
      url: 'https://store.public.blob.vercel-storage.com/staging.mp4',
    });
    (readBodyWithLimit as jest.Mock).mockResolvedValue(bytes);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true } as Response);
    blob.uploadBuffer.mockImplementation(async (pathname: string) => ({
      url: `https://store.public.blob.vercel-storage.com/${pathname}`,
    }));
    try {
      const value = await service.confirm('owner', 'brand', {
        pathname: recording.sourcePathname,
        locale: 'ru',
        approved: true,
      });
      expect(value.pathname).not.toBe(recording.sourcePathname);
      expect(value.pathname).toMatch(/preambles\/[a-f0-9]{64}\.mp4$/);
      expect(value.seconds).toBe(6);
      expect(prisma.brandManifest.update).toHaveBeenCalledWith({
        where: { id: 'brand' },
        data: { tutorialPreamble: value },
      });
      expect(blob.deleteBlob).toHaveBeenCalledWith(recording.sourcePathname);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('gives a finished tutorial its own recording copy for orphan cleanup safety', async () => {
    const { service, blob } = setup();
    const value = await service.forProject('owner', 'project', 'ru', 'draft');
    expect(value.pathname).toBe(
      'tutorial-video-frames/draft/preamble-abc123.mp4',
    );
    expect(parseNarratorPreamble(value)).toEqual(value);
    expect(blob.copyBlob).toHaveBeenCalledWith(
      recording.pathname,
      value.pathname,
      'video/mp4',
    );
  });
  it('rejects a snapshot whose declared owner differs from its path', () => {
    expect(
      parseNarratorPreamble({ ...recording, manifestId: 'other' }),
    ).toBeNull();
  });
});
