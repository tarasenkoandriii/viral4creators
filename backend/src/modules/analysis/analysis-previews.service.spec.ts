jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import { BadRequestException } from '@nestjs/common';
import {
  AnalysisPreviewsService,
  applyPreviewUrls,
  previewKeysOf,
  previewPathname,
} from './analysis-previews.service';
import {
  AnalysisStatus,
  VideoAnalysis,
} from '../../common/types/analysis.types';

const mockedHead = head as jest.MockedFunction<typeof head>;

const analysis: VideoAnalysis = {
  analysisId: 'a1',
  analyzedAt: new Date(),
  status: AnalysisStatus.COMPLETE,
  sceneBreakdown: '…',
  characters: [
    {
      id: 'c1',
      label: 'Аня',
      role: null,
      appearance: 'x',
      prominence: 'main',
      previewAt: 1.5,
      previewUrl: null,
    },
  ],
  scenes: [
    {
      id: 's1',
      start: 0,
      end: 2,
      title: 'Hook',
      previewAt: 1,
      previewUrl: null,
    },
    {
      id: 's2',
      start: 2,
      end: 4,
      title: 'CTA',
      previewAt: 3,
      previewUrl: null,
    },
  ],
};

function build(
  video: VideoAnalysis | null = analysis,
  librarySourceKey: string | null = 'youtube:abc',
) {
  const sessions = {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      videoAnalysis: video ?? undefined,
      librarySourceKey,
    }),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
  };
  const library = { refreshPreviews: jest.fn().mockResolvedValue(undefined) };
  const svc = new AnalysisPreviewsService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blob as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    library as any,
  );
  return { svc, sessions, blob, library };
}

describe('preview helpers', () => {
  it('pathname is deterministic per key; keys are the analysis ids', () => {
    expect(previewPathname('s1', 'character:c1')).toBe(
      'sessions/s1/previews/character-c1.jpg',
    );
    expect([...previewKeysOf(analysis)]).toEqual([
      'character:c1',
      'scene:s1',
      'scene:s2',
    ]);
    expect(previewKeysOf(undefined).size).toBe(0);
  });

  it('applyPreviewUrls writes only the confirmed keys', () => {
    const next = applyPreviewUrls(analysis, {
      'scene:s2': 'https://cdn/s2.jpg',
    });
    expect(next.characters![0].previewUrl).toBeNull();
    expect(next.scenes![0].previewUrl).toBeNull();
    expect(next.scenes![1].previewUrl).toBe('https://cdn/s2.jpg');
  });
});

describe('AnalysisPreviewsService', () => {
  beforeEach(() => mockedHead.mockReset());

  it('upload-url: one presigned PUT per unique known key, 400 for a foreign key', async () => {
    const { svc, blob } = build();
    const r = await svc.createUploadUrls('s1', [
      'character:c1',
      'scene:s1',
      'scene:s1',
    ]);
    expect(r).toEqual([
      {
        key: 'character:c1',
        uploadUrl: 'https://put',
        pathname: 'sessions/s1/previews/character-c1.jpg',
      },
      {
        key: 'scene:s1',
        uploadUrl: 'https://put',
        pathname: 'sessions/s1/previews/scene-s1.jpg',
      },
    ]);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      'sessions/s1/previews/character-c1.jpg',
      'image/jpeg',
      2 * 1024 * 1024,
    );
    await expect(
      svc.createUploadUrls('s1', ['scene:s9']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirm: stores URLs of blobs that exist, skips missing ones, rejects a wrong pathname', async () => {
    const { svc, sessions } = build();
    mockedHead
      .mockResolvedValueOnce({ url: 'https://cdn/c1.jpg' } as never)
      .mockRejectedValueOnce(new Error('missing'));
    const next = await svc.confirm('s1', [
      {
        key: 'character:c1',
        pathname: 'sessions/s1/previews/character-c1.jpg',
      },
      { key: 'scene:s1', pathname: 'sessions/s1/previews/scene-s1.jpg' },
    ]);
    expect(next.characters![0].previewUrl).toBe('https://cdn/c1.jpg');
    expect(next.scenes![0].previewUrl).toBeNull();
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      videoAnalysis: next,
    });
    await expect(
      svc.confirm('s1', [
        { key: 'scene:s2', pathname: 'sessions/OTHER/previews/scene-s2.jpg' },
      ]),
    ).rejects.toThrow(/must be the value returned/);
  });

  it('подтверждённые кадры досохраняются в библиотеку (этап 39, А-2.10)', async () => {
    // `library.save` вызывается ВНУТРИ разбора — до того, как плеер
    // показал ролик и браузер снял кадры. Без этого шага обложки у
    // записей библиотеки не было никогда.
    const { svc, library } = build();
    mockedHead.mockResolvedValue({ url: 'https://cdn/c1.jpg' } as never);
    const next = await svc.confirm('s1', [
      {
        key: 'character:c1',
        pathname: 'sessions/s1/previews/character-c1.jpg',
      },
    ]);
    expect(library.refreshPreviews).toHaveBeenCalledWith('youtube:abc', next);
  });

  it('сессия без записи в библиотеке в неё и не пишет', async () => {
    // Разбор мог не попасть в библиотеку вовсе (например, приватная
    // загрузка со сбоем сохранения) — тогда обновлять нечего.
    const { svc, library } = build(analysis, null);
    mockedHead.mockResolvedValue({ url: 'https://cdn/c1.jpg' } as never);
    await svc.confirm('s1', [
      {
        key: 'character:c1',
        pathname: 'sessions/s1/previews/character-c1.jpg',
      },
    ]);
    expect(library.refreshPreviews).not.toHaveBeenCalled();
  });

  it('confirm without an analysis → 400', async () => {
    const { svc } = build(null);
    await expect(
      svc.confirm('s1', [
        { key: 'scene:s1', pathname: 'sessions/s1/previews/scene-s1.jpg' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
