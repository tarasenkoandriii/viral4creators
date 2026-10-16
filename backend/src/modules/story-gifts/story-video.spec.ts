/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory transactional store */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoryVideoService } from './story-video.service';
import { STORY_VIDEO_BASE as BASE } from './story-video-base';
import {
  planStoryVideo,
  storyDigest,
  storyVideoConfigHash,
  storyVideoReserve,
} from './story-video-plan';
import { STORY_VOICE } from './story-catalog';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import {
  PublicStoryGiftController,
  StoryGiftsController,
} from './story-gifts.controller';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
jest.mock('../../common/external-url-guard', () => ({
  fetchPubliclyRoutable: jest.fn(),
  readBodyWithLimit: jest.fn(),
}));
const baseBytes = readFileSync(
  join(
    __dirname,
    '../../../../frontend/public/story-assets/turnip-v1/base.mp4',
  ),
);
function setup() {
  const gift: any = {
    id: 'g',
    userId: 'u',
    status: 'APPROVED',
    catalogId: BASE.catalogId,
    voiceId: STORY_VOICE,
    audioHash: 'a'.repeat(64),
    durationSeconds: 55.74525,
    audio: Buffer.from('main-audio'),
    audioQaStatus: 'PASS',
    giftNote: null,
    locale: 'ru',
    text: 'Репка. Точный текст.',
    budgetCents: 500,
    reservedMicroUsd: 130000,
    shareHash: storyDigest('s'.repeat(43)),
  };
  const rows: any[] = [];
  const match = (r: any, w: any) =>
    !Object.entries(w).some(([k, v]: [string, any]) => {
      if (k === 'gift')
        return (
          (v.userId && gift.userId !== v.userId) ||
          (v.status?.in && !v.status.in.includes(gift.status)) ||
          (typeof v.status === 'string' && v.status !== gift.status) ||
          (v.shareHash && v.shareHash !== gift.shareHash)
        );
      if (k === 'status')
        return typeof v === 'string'
          ? r.status !== v
          : v.in
            ? !v.in.includes(r.status)
            : v.not === r.status;
      if (k === 'assetExpiresAt') return !(r.assetExpiresAt > v.gt);
      if (k === 'createdAt') return false;
      if (k === 'approvedAt') return v.not === null ? !r.approvedAt : false;
      return r[k] !== v;
    });
  const db: any = {
    findUnique: jest.fn(
      async ({ where }: any) =>
        rows.find((r) =>
          where.id
            ? r.id === where.id
            : r.giftId === where.giftId_configHash.giftId &&
              r.configHash === where.giftId_configHash.configHash,
        ) || null,
    ),
    findUniqueOrThrow: jest.fn(async ({ where }: any) => {
      const r = rows.find((r) => r.id === where.id);
      if (!r) throw Error('not found');
      return { ...r };
    }),
    findFirst: jest.fn(async ({ where, include }: any) => {
      const r = rows.find((r) => match(r, where));
      return r ? { ...r, ...(include ? { gift } : {}) } : null;
    }),
    findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
    aggregate: jest.fn(async () => ({
      _sum: {
        reservedMicroUsd: rows.reduce((s, r) => s + r.reservedMicroUsd, 0),
      },
    })),
    count: jest.fn(async () => rows.length),
    create: jest.fn(async ({ data }: any) => {
      const r = {
        ...data,
        id: `r${rows.length + 1}`,
        status: 'PREPARING',
        qaStatus: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(r);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows)
        if (match(r, where)) {
          Object.assign(r, data, { updatedAt: new Date() });
          count++;
        }
      return { count };
    }),
  };
  const tx: any = {
    storyVideoRender: db,
    storyGift: {
      findFirst: jest.fn(async ({ where }: any) =>
        (where.userId && where.userId !== gift.userId) ||
        gift.status === 'DELETED'
          ? null
          : { ...gift },
      ),
    },
    $queryRaw: jest.fn(),
  };
  let chain = Promise.resolve();
  const prisma: any = {
    ...tx,
    $transaction: (fn: any) => {
      const next = chain.then(() => fn(tx));
      chain = next.catch(() => {});
      return next;
    },
  };
  const tts: any = {
    configured: () => true,
    synthesize: jest.fn(async ({ text }: any) => ({
      ok: true,
      voiceId: STORY_VOICE,
      mimeType: 'audio/mpeg',
      audio: Buffer.from('intro'),
      durationSeconds: 5,
      characters: text.length,
    })),
  };
  const ffmpeg: any = {
    configured: () => true,
    submit: jest.fn(async () => ({ jobId: 'j', status: 'pending' })),
    status: jest.fn(async () => ({ status: 'pending' })),
  };
  const stt: any = {
    configured: () => true,
    transcribe: jest.fn(async () => ({
      text: 'Привет. Репка. Точный текст.',
      language: 'ru',
      billable: true,
      seconds: 60,
    })),
  };
  (fetchPubliclyRoutable as jest.Mock).mockResolvedValue({ ok: true });
  (readBodyWithLimit as jest.Mock).mockResolvedValue(baseBytes);
  return {
    service: new StoryVideoService(
      prisma,
      ffmpeg,
      tts,
      { assertCanSpendUser: jest.fn() } as never,
      { record: jest.fn() } as never,
      stt,
    ),
    gift,
    rows,
    db,
    tts,
    ffmpeg,
    stt,
  };
}
describe('Reusable story master, separate speech and preamble', () => {
  it('pins a truly silent master and builds commands from finite numeric durations only', () => {
    expect(storyDigest(baseBytes)).toBe(BASE.baseSha256);
    expect(
      storyDigest(
        readFileSync(
          join(
            __dirname,
            '../../../../frontend/public/story-assets/turnip-v1/cover.png',
          ),
        ),
      ),
    ).toBe(BASE.coverSha256);
    expect(BASE.audioTracks).toBe(0);
    const p = planStoryVideo(55.74525, 5);
    expect(p.durationSeconds).toBeCloseTo(60.74525);
    expect(p.commands[0]).toContain('{{main}}');
    expect(p.commands[0]).toContain('{{intro}}');
    expect(p.commands[0]).toContain('[iv][ia][v][a]concat');
    expect(() => planStoryVideo(NaN, 5)).toThrow();
    expect(() => planStoryVideo(55, 100)).toThrow();
  });
  it('changes the export key for a new intro without changing the base or main narration', () => {
    expect(storyVideoConfigHash('a', 'Привет')).not.toBe(
      storyVideoConfigHash('a', 'Добрый вечер'),
    );
    expect(storyVideoConfigHash('a', 'Привет')).toBe(
      storyVideoConfigHash('a', 'Привет'),
    );
    expect(storyVideoReserve('Привет')).toBeLessThan(1000000);
  });
  it('deduplicates concurrent create requests before synthesis and paid submit', async () => {
    const s = setup();
    await Promise.all([
      s.service.create('u', 'g', 'Привет'),
      s.service.create('u', 'g', 'Привет'),
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
    expect(s.ffmpeg.submit.mock.calls[0][0].retrySubmit).toBe(false);
  });
  it('replaces only intro speech across two versions and keeps both source hashes identical', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    await s.service.create('u', 'g', 'Добрый вечер');
    expect(s.rows[0].baseHash).toBe(s.rows[1].baseHash);
    expect(s.rows[0].mainAudioHash).toBe(s.rows[1].mainAudioHash);
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      'Привет',
      'Добрый вечер',
    ]);
    expect(s.rows.every((r) => r.voiceId === STORY_VOICE)).toBe(true);
  });
  it('rejects access by another owner without buying anything', async () => {
    const s = setup();
    await expect(s.service.create('other', 'g', 'Привет')).rejects.toThrow();
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    await expect(s.service.file('other', 'g', 'r1', 'video')).rejects.toThrow();
  });
  it('reserves cumulative spend before synthesis, including previous exports', async () => {
    const s = setup();
    s.gift.budgetCents = 15;
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toThrow(
      'бюджета',
    );
    expect(s.rows).toHaveLength(0);
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('requires the already checked exact story and refuses embedded extra speech', async () => {
    const s = setup();
    s.gift.giftNote = 'Ещё фраза';
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toThrow(
      'проверенная',
    );
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('does not buy a second intro or job after an uncertain submit', async () => {
    const s = setup();
    s.ffmpeg.submit.mockRejectedValue(new Error('network'));
    expect((await s.service.create('u', 'g', 'Привет')).status).toBe('UNKNOWN');
    await s.service.create('u', 'g', 'Привет');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
    expect(s.rows[0].assetTokenHash).toBeNull();
  });
  it('bounds provider asset access by hash, expiry, state and gift deletion', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    const token = new URL(
      s.ffmpeg.submit.mock.calls[0][0].inputs.intro,
    ).pathname
      .split('/')
      .at(-2)!;
    expect((await s.service.input(token, 'intro')).mime).toBe('audio/mpeg');
    s.rows[0].assetExpiresAt = new Date(0);
    await expect(s.service.input(token, 'intro')).rejects.toThrow();
    s.rows[0].assetExpiresAt = new Date(Date.now() + 60000);
    s.gift.status = 'DELETED';
    await expect(s.service.input(token, 'main')).rejects.toThrow();
  });
  it('never publishes an unapproved render, and revocation also blocks video', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    await expect(s.service.published('s'.repeat(43))).rejects.toThrow();
    Object.assign(s.rows[0], {
      status: 'READY',
      qaStatus: 'PASS',
      videoHash: 'b'.repeat(64),
      video: Buffer.from('mp4'),
    });
    await s.service.approve('u', 'g', 'r1', 'b'.repeat(64));
    expect((await s.service.published('s'.repeat(43))).id).toBe('r1');
    s.gift.shareHash = null;
    await expect(s.service.published('s'.repeat(43))).rejects.toThrow();
  });
  it('rejects broken output containers instead of marking them ready', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    s.ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'story.mp4': 'https://result.test/out.mp4' },
    });
    (readBodyWithLimit as jest.Mock).mockResolvedValue(Buffer.from('broken'));
    expect((await s.service.status('u', 'g', 'r1')).status).toBe('FAILED');
    expect(s.rows[0].assetTokenHash).toBeNull();
  });
  it('checks preamble plus main text once and only from the actual MP4', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет.');
    Object.assign(s.rows[0], {
      status: 'READY',
      video: Buffer.from('actual-mp4'),
      videoHash: 'b'.repeat(64),
    });
    expect((await s.service.quality('u', 'g', 'r1')).qaStatus).toBe('PASS');
    await s.service.quality('u', 'g', 'r1');
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(s.stt.transcribe.mock.calls[0][0].mimeType).toBe('video/mp4');
  });
  it('keeps reference analysis exclusively behind owner authentication', () => {
    expect(
      (PublicStoryGiftController.prototype as any).referenceAnalyze,
    ).toBeUndefined();
    expect(
      (PublicStoryGiftController.prototype as any).referenceList,
    ).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', StoryGiftsController)).toContain(
      TelegramIdentityGuard,
    );
  });
});
