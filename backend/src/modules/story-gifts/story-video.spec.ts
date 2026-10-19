import * as mp4Probe from '../tutorial-runner/mp4-probe';
/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory transactional store */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoryVideoService } from './story-video.service';
import { STORY_VIDEO_BASE as BASE } from './story-video-base';
import {
  planStorySegments,
  planStoryVideo,
  storyDigest,
  storyVideoConfigHash,
  storyVideoReserve,
  storyVideoTtsReserve,
  STORY_PARENT_CONSENT_VERSION,
  STORY_RECORDING_CONSENT_VERSION,
} from './story-video-plan';
import {
  STORY_VIDEO_BASES,
  storyVideoBaseFor,
  storyVideoBaseRevision,
} from './story-video-base';
import {
  applyStoryPronunciations,
  buildStoryVtt,
  parseStoryPronunciations,
  parseStoryWav,
  storyChaptersSha256,
  storyCues,
  storyVideoLayout,
  STORY_VIDEO_MIX,
} from './story-video-segments';
import { STORY_VOICE } from './story-catalog';
import { STORY_EDITIONS } from './story-editions';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import {
  PublicStoryGiftController,
  StoryGiftsController,
} from './story-gifts.controller';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import {
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { StoryRecordingDto, StoryVideoDto } from './story-video.dto';
import { storyRenderWipe } from './story-gifts.service';
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
    audioHash: storyDigest(Buffer.from('main-audio')),
    durationSeconds: 55.74525,
    audio: Buffer.from('main-audio'),
    audioQaStatus: 'PASS',
    giftNote: null,
    giftNotePosition: null,
    narrationLayout: null,
    hasGiftPhoto: false,
    giftPhoto: null,
    occasionKind: null,
    chapters: STORY_EDITIONS.find((e) => e.id === BASE.catalogId)!.chapters,
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
      if (v && typeof v === 'object' && !(v instanceof Date) && 'not' in v)
        return v.not === null ? r[k] == null : r[k] === v.not;
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
      return { ...r, gift };
    }),
    findFirst: jest.fn(async ({ where, include, select }: any) => {
      const r = rows.find((r) => match(r, where));
      return r ? { ...r, ...(include || select?.gift ? { gift } : {}) } : null;
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
  const parentVoice: any = {
    id: 'pv',
    userId: 'u',
    status: 'READY',
    resembleVoiceId: 'parent-clone',
    consentAt: new Date('2026-10-01'),
    label: 'Мой голос',
  };
  const manifest: any = {
    id: 'manifest',
    userId: 'u',
    ttsProvider: 'resemble',
    ttsVoiceId: 'parent-clone',
    title: 'Рассказчик',
  };
  const matches = (row: any, where: any) =>
    row && Object.entries(where).every(([k, v]) => row[k] === v);
  Object.assign(tx, {
    userVoice: {
      findFirst: jest.fn(async ({ where }: any) =>
        matches(parentVoice, where) ? { ...parentVoice } : null,
      ),
      findMany: jest.fn(async () =>
        parentVoice.status === 'READY' ? [{ ...parentVoice }] : [],
      ),
    },
    brandManifest: {
      findFirst: jest.fn(async ({ where }: any) =>
        matches(manifest, where) ? { ...manifest } : null,
      ),
      findMany: jest.fn(async () => [{ ...manifest }]),
    },
  });
  // WP4 segment cache / recordings: generic in-memory table.
  const segs: any[] = [];
  const segMatch = (r: any, w: any = {}) =>
    Object.entries(w).every(([k, v]: [string, any]) =>
      k === 'gift'
        ? !v.status?.in || v.status.in.includes(gift.status)
        : v && typeof v === 'object' && !(v instanceof Date)
          ? 'in' in v
            ? v.in.includes(r[k])
            : 'not' in v
              ? r[k] !== v.not
              : 'lt' in v
                ? r[k] < v.lt
                : true
          : r[k] === v,
    );
  const segDb: any = {
    findFirst: jest.fn(async ({ where }: any) => {
      const r = segs.find((r) => segMatch(r, where));
      return r ? { ...r } : null;
    }),
    findMany: jest.fn(async ({ where }: any) =>
      segs.filter((r) => segMatch(r, where)).map((r) => ({ ...r })),
    ),
    count: jest.fn(
      async ({ where }: any) => segs.filter((r) => segMatch(r, where)).length,
    ),
    create: jest.fn(async ({ data }: any) => {
      if (
        segs.some(
          (r) => r.giftId === data.giftId && r.cacheKey === data.cacheKey,
        )
      )
        throw new Error('unique');
      const r = {
        id: `00000000-0000-4000-8000-${String(segs.length + 1).padStart(12, '0')}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      segs.push(r);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of segs)
        if (segMatch(r, where)) {
          Object.assign(r, data, { updatedAt: new Date() });
          count++;
        }
      return { count };
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.giftId_cacheKey;
      const r = segs.find(
        (r) => r.giftId === key.giftId && r.cacheKey === key.cacheKey,
      );
      if (r) {
        Object.assign(r, update);
        return { ...r };
      }
      return segDb.create({ data: create });
    }),
  };
  tx.storyVideoSegment = segDb;
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
    synthesize: jest.fn(async ({ text, voiceId }: any) => ({
      ok: true,
      voiceId,
      mimeType: 'audio/mpeg',
      audio: Buffer.from(text === gift.text ? 'parent-main' : `seg:${text}`),
      durationSeconds: text === gift.text ? 55 : 5,
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
  // WP5 narrator image of the owner's profile (applied look by default).
  const narratorPng = Buffer.from('narrator-look-png');
  const narrator: any = {
    kind: 'variant',
    manifestId: 'manifest',
    characterId: 'character',
    lookId: 'look-1',
    asset: 'photo',
    assetHash: storyDigest(narratorPng),
    style: 'photo',
    sketchRendering: null,
    consentVersion: 'story-parent-image-v1',
    mimeType: 'image/png',
    bytes: narratorPng,
  };
  const looks: any = {
    resolveNarratorImage: jest.fn(
      async (manifestId: string, userId: string) => {
        // Same contract as WP5: another owner's manifest is 404.
        if (manifestId !== manifest.id || userId !== manifest.userId)
          throw new NotFoundException('Брендбук не найден');
        return { ...narrator, bytes: Buffer.from(narrator.bytes) };
      },
    ),
  };
  (fetchPubliclyRoutable as jest.Mock).mockResolvedValue({ ok: true });
  (readBodyWithLimit as jest.Mock).mockResolvedValue(baseBytes);
  const plan = { assertCanSpendUser: jest.fn() };
  return {
    plan,
    service: new StoryVideoService(
      prisma,
      ffmpeg,
      tts,
      plan as never,
      { record: jest.fn() } as never,
      stt,
      looks,
    ),
    looks,
    narrator,
    gift,
    parentVoice,
    manifest,
    prisma,
    rows,
    db,
    tts,
    ffmpeg,
    stt,
    segs,
    segDb,
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
  it('requires the already checked exact story; a Nova gift note stays inside the approved main track', async () => {
    const s = setup();
    s.gift.audioQaStatus = 'WARN';
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toThrow(
      'проверенная',
    );
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    // Legacy/WP3 glued note: reused as part of the checked Nova MP3, never re-bought.
    s.gift.audioQaStatus = 'PASS';
    s.gift.giftNote = 'Под подушкой тебя ждёт книжка.';
    s.gift.giftNotePosition = 'end';
    s.gift.text = `${s.gift.text}\n\n${s.gift.giftNote}`;
    const r: any = await s.service.create('u', 'g', 'Привет');
    expect(r.status).toBe('PENDING');
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      'Привет',
    ]);
    const main = r.segments.segments.find((x: any) => x.kind === 'main');
    expect(main.includes).toEqual(['gift_note']);
    expect(main.text).toBe(s.gift.text);
    expect(r.segments.segments.map((x: any) => x.kind)).toEqual([
      'intro',
      'main',
    ]);
  });
  it('does not buy a second intro or job after an uncertain submit', async () => {
    const s = setup();
    s.ffmpeg.submit.mockRejectedValue(new Error('network'));
    expect((await s.service.create('u', 'g', 'Привет')).status).toBe('UNKNOWN');
    await s.service.create('u', 'g', 'Привет');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
    // A-S3-9: the token hash stays as the job's input fingerprint, expired:
    // the provider inputs are no longer served.
    const token = new URL(s.ffmpeg.submit.mock.calls[0][0].inputs.main).pathname
      .split('/')
      .at(-2)!;
    expect(s.rows[0].assetTokenHash).toBe(storyDigest(token));
    expect(s.rows[0].assetExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(s.service.input(token, 'main')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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

const parentChoice = {
  narratorManifestId: 'manifest',
  voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
  voiceConsentAccepted: true,
};
describe('Parent narration from owned narrator profiles', () => {
  it('requires explicit current consent before any paid work', async () => {
    const s = setup();
    await expect(
      s.service.create('u', 'g', 'Привет', { narratorManifestId: 'manifest' }),
    ).rejects.toThrow('согласие');
    await expect(
      s.service.create('u', 'g', 'Привет', {
        ...parentChoice,
        voiceConsentVersion: 'old',
      }),
    ).rejects.toThrow('согласие');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it.each(['other-owner', 'training', 'library', 'no-consent'])(
    'rejects %s profiles before spending',
    async (kind) => {
      const s = setup();
      if (kind === 'other-owner') s.manifest.userId = 'other';
      if (kind === 'training') s.parentVoice.status = 'TRAINING';
      if (kind === 'library') s.manifest.ttsVoiceId = STORY_VOICE;
      if (kind === 'no-consent') s.parentVoice.consentAt = null;
      await expect(
        s.service.create('u', 'g', 'Привет', parentChoice),
      ).rejects.toThrow();
      expect(s.tts.synthesize).not.toHaveBeenCalled();
    },
  );
  it('synthesizes separate main and intro, then reuses the main for a changed intro without changing the master or Nova', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет', parentChoice);
    await s.service.create('u', 'g', 'Добрый вечер', parentChoice);
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      s.gift.text,
      'Привет',
      'Добрый вечер',
    ]);
    expect(
      s.tts.synthesize.mock.calls.every(
        (c: any) => c[0].voiceId === 'parent-clone',
      ),
    ).toBe(true);
    expect(s.rows[0].mainAudioHash).toBe(s.rows[1].mainAudioHash);
    expect(s.rows.every((r) => r.baseHash === BASE.baseSha256)).toBe(true);
    expect(s.rows[0].mainAudioHash).toBe(
      storyDigest(Buffer.from('parent-main')),
    );
    expect(s.rows[0].voiceConsentVersion).toBe(STORY_PARENT_CONSENT_VERSION);
    expect(s.rows[0].voiceConsentAt).toBeInstanceOf(Date);
    expect(s.rows[1].reservedMicroUsd).toBeLessThan(s.rows[0].reservedMicroUsd);
    const view = await s.service.list('u', 'g');
    expect(view.narratorProfiles).toEqual([
      { id: 'manifest', title: 'Рассказчик', voiceLabel: 'Мой голос' },
    ]);
    expect(s.gift.voiceId).toBe(STORY_VOICE);
    expect(s.gift.audioHash).toBe(storyDigest(Buffer.from('main-audio')));
    expect(Buffer.from(s.rows[1].mainAudio).toString()).toBe('parent-main');
    const main = await s.service.file('u', 'g', 'r2', 'main');
    expect(Buffer.from(main.base64, 'base64').toString()).toBe('parent-main');
    await expect(s.service.file('other', 'g', 'r2', 'main')).rejects.toThrow();
  });
  it('does not duplicate main synthesis for concurrent different preambles', async () => {
    const s = setup();
    await Promise.allSettled([
      s.service.create('u', 'g', 'Привет', parentChoice),
      s.service.create('u', 'g', 'Другой', parentChoice),
    ]);
    expect(
      s.tts.synthesize.mock.calls.filter((c: any) => c[0].text === s.gift.text),
    ).toHaveLength(1);
  });
  it('reserves full narration before paying and rejects insufficient remaining budget', async () => {
    const s = setup();
    s.gift.text = 'Репка '.repeat(1000);
    s.gift.budgetCents = 100;
    await expect(
      s.service.create('u', 'g', 'Привет', parentChoice),
    ).rejects.toThrow('бюджета');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('blocks revoked voice downloads, provider input and publication without silently falling back', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет', parentChoice);
    Object.assign(s.rows[0], {
      status: 'READY',
      qaStatus: 'PASS',
      videoHash: 'b'.repeat(64),
      approvedAt: new Date(),
      video: Buffer.from('mp4'),
    });
    s.parentVoice.status = 'FAILED';
    await expect(s.service.file('u', 'g', 'r1', 'main')).rejects.toThrow(
      'отозван',
    );
    await expect(s.service.published('s'.repeat(43))).rejects.toThrow(
      'отозван',
    );
    await expect(
      s.service.approve('u', 'g', 'r1', 'b'.repeat(64)),
    ).rejects.toThrow('отозван');
    s.rows[0].status = 'PENDING';
    const token = new URL(s.ffmpeg.submit.mock.calls[0][0].inputs.main).pathname
      .split('/')
      .at(-2)!;
    await expect(s.service.input(token, 'main')).rejects.toThrow('отозван');
  });
  it('does not silently retry an uncertain main synthesis', async () => {
    const s = setup();
    s.tts.synthesize.mockRejectedValue(new Error('timeout'));
    expect(
      (await s.service.create('u', 'g', 'Привет', parentChoice)).status,
    ).toBe('UNKNOWN');
    await s.service.create('u', 'g', 'Привет', parentChoice);
    await expect(
      s.service.create('u', 'g', 'Другой', parentChoice),
    ).rejects.toThrow('повторная оплата');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    await expect(s.service.file('u', 'g', 'r1', 'main')).rejects.toThrow(
      'Файл ещё не готов',
    );
  });
});

describe('Story read-only background recovery', () => {
  function completed(s: ReturnType<typeof setup>) {
    s.ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'story.mp4': 'https://result.test/story.mp4' },
    });
    (readBodyWithLimit as jest.Mock).mockResolvedValue(Buffer.alloc(2048, 1));
    return jest.spyOn(mp4Probe, 'probeMp4').mockReturnValue({
      durationSeconds: s.rows[0].durationSeconds,
      tracks: [
        { kind: 'video', width: 1280, height: 720 },
        { kind: 'audio', durationSeconds: s.rows[0].durationSeconds },
      ],
    } as any);
  }
  it('recovers an old UNKNOWN job without new synthesis, submit, QA or publication', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    Object.assign(s.rows[0], {
      status: 'UNKNOWN',
      createdAt: new Date(Date.now() - 3600000),
      assetTokenHash: null,
    });
    const probe = completed(s);
    try {
      const result = await s.service.status('u', 'g', 'r1');
      expect(result.status).toBe('READY');
      expect(result.approvedAt).toBeUndefined();
      expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
      expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
      expect(s.stt.transcribe).not.toHaveBeenCalled();
      await expect(s.service.published('s'.repeat(43))).rejects.toThrow();
    } finally {
      probe.mockRestore();
    }
  });
  it('polls a saved job even after the thirty-minute timeout', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    s.rows[0].createdAt = new Date(Date.now() - 3600000);
    const probe = completed(s);
    try {
      expect((await s.service.status('u', 'g', 'r1')).status).toBe('READY');
    } finally {
      probe.mockRestore();
    }
  });
  it('preserves the receipt even when usage accounting fails after submit', async () => {
    const s = setup();
    (s.service as any).usage.record.mockImplementation(async (r: any) => {
      if (r.operation === 'story-video-assembly')
        throw Error('ledger unavailable');
    });
    await s.service.create('u', 'g', 'Привет');
    expect(s.rows[0].jobId).toBeTruthy();
    expect(s.rows[0].status).toBe('PENDING');
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
  });
  it('does not resubmit or guess a provider job when its receipt was lost', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    Object.assign(s.rows[0], {
      status: 'UNKNOWN',
      jobId: null,
      createdAt: new Date(Date.now() - 3600000),
    });
    expect((await s.service.status('u', 'g', 'r1')).status).toBe('UNKNOWN');
    expect(s.ffmpeg.status).not.toHaveBeenCalled();
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
  });
  it('runs bounded background reconciliation and expires stale audio without paid work', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    s.db.findMany.mockResolvedValueOnce([
      { id: 'r1', giftId: 'g', gift: { userId: 'u' } },
    ]);
    s.prisma.storyGift.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const probe = completed(s);
    try {
      expect(await s.service.finalizePending()).toEqual({
        scanned: 1,
        ready: 1,
        failed: 0,
        unknown: 0,
        blocked: 0,
        staleAudio: 1,
        staleQa: 1,
      });
      expect(s.db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, orderBy: { updatedAt: 'asc' } }),
      );
      expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
      expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
      expect(s.stt.transcribe).not.toHaveBeenCalled();
      expect(s.rows[0].approvedAt).toBeUndefined();
    } finally {
      probe.mockRestore();
    }
  });
  it('isolates revoked voices so later background rows still finish', async () => {
    const s = setup();
    s.db.findMany.mockResolvedValueOnce([
      { id: 'missing', giftId: 'g', gift: { userId: 'other' } },
    ]);
    s.prisma.storyGift.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    expect((await s.service.finalizePending()).blocked).toBe(1);
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
});

// ── WP4: registry, segments, tracks, subtitles, recordings, pronunciations ──
function wav(seconds: number, rate = 22050, amp = 0.3, channels = 1) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2 * channels);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2 * channels, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2 * channels, 40);
  for (let i = 0; i < n * channels; i++)
    b.writeInt16LE(Math.round(Math.sin(i / 7) * amp * 32767), 44 + i * 2);
  return b;
}
const recConsent = {
  consentVersion: STORY_RECORDING_CONSENT_VERSION,
  consentAccepted: true,
};
const tokenOf = (s: ReturnType<typeof setup>, call = 0) =>
  new URL(s.ffmpeg.submit.mock.calls[call][0].inputs.intro).pathname
    .split('/')
    .at(-2)!;

describe('WP4 base package registry', () => {
  it('publishes only packages whose assets exist with the pinned hashes and sizes', () => {
    expect(new Set(STORY_VIDEO_BASES.map((b) => b.revision)).size).toBe(
      STORY_VIDEO_BASES.length,
    );
    for (const b of STORY_VIDEO_BASES) {
      const dir = join(
        __dirname,
        '../../../../frontend/public/story-assets',
        b.revision,
      );
      const video = readFileSync(join(dir, b.tracks.video));
      const cover = readFileSync(join(dir, b.tracks.cover));
      expect(video.length).toBe(b.baseBytes);
      expect(storyDigest(video)).toBe(b.baseSha256);
      expect(cover.length).toBe(b.coverBytes);
      expect(storyDigest(cover)).toBe(b.coverSha256);
      const stems = [b.tracks.music, b.tracks.effects].filter(
        (stem) => stem !== null,
      );
      expect(
        stems.map((stem) => {
          const bytes = readFileSync(join(dir, stem.file));
          return [storyDigest(bytes), bytes.length];
        }),
      ).toEqual(stems.map((stem) => [stem.sha256, stem.bytes]));
      const manifest = JSON.parse(
        readFileSync(join(dir, 'manifest.json'), 'utf8'),
      );
      expect(manifest).toEqual({
        revision: b.revision,
        catalogId: b.catalogId,
        textSha256: b.textSha256,
        baseSha256: b.baseSha256,
        durationSeconds: b.durationSeconds,
        fps: b.fps,
        width: b.width,
        height: b.height,
        audioTracks: 0,
        scenes: b.scenes,
        rights: b.rights,
        coverSha256: b.coverSha256,
      });
      expect(b.scenes[0].start).toBe(0);
      expect(b.scenes.every((sc) => sc.end > sc.start)).toBe(true);
      expect(b.scenes.slice(1).map((sc) => sc.start)).toEqual(
        b.scenes.slice(0, -1).map((sc) => sc.end),
      );
      expect(b.scenes.at(-1)!.end).toBe(b.durationSeconds);
      const edition = STORY_EDITIONS.find((e) => e.id === b.catalogId)!;
      expect(edition.textSha256).toBe(b.textSha256);
      expect(storyChaptersSha256(edition.chapters)).toBe(b.textSha256);
    }
    expect(storyVideoBaseFor(BASE.catalogId)).toBe(BASE);
    expect(storyVideoBaseRevision('turnip-v1')).toBe(BASE);
    expect(storyVideoBaseFor('little-lantern-ru-v1')).toBeNull();
  });
  it('refuses an edition without a published package and a changed text hash before spending', async () => {
    const s = setup();
    s.gift.catalogId = 'little-lantern-ru-v1';
    expect((await s.service.list('u', 'g')).supported).toBe(false);
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toThrow(
      'видеопакет',
    );
    const t = setup();
    t.gift.chapters = [{ title: 'x', scene: 'x', text: 'Другой текст' }];
    await expect(t.service.create('u', 'g', 'Привет')).rejects.toThrow(
      'редакцией базового видео',
    );
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(t.tts.synthesize).not.toHaveBeenCalled();
  });
});

describe('WP4 segment manifest, config hash and FFmpeg plan', () => {
  it('keeps the version-1 export key for legacy layouts so old renders still deduplicate', async () => {
    expect(storyVideoConfigHash('a', 'Привет')).toBe(
      storyDigest(
        JSON.stringify({
          version: 1,
          base: BASE.baseSha256,
          audioHash: 'a',
          preamble: 'Привет',
        }),
      ),
    );
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    expect(s.rows[0].configHash).toBe(
      storyVideoConfigHash(s.gift.audioHash, 'Привет'),
    );
    // A pre-WP4 row (no manifest) is still found by the same request.
    s.rows[0].segments = null;
    await s.service.create('u', 'g', 'Привет');
    expect(s.rows).toHaveLength(1);
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    const p = setup();
    await p.service.create('u', 'g', 'Привет', parentChoice);
    const key = storyDigest(
      JSON.stringify({
        giftId: 'g',
        text: p.gift.text,
        userVoiceId: 'pv',
        voiceId: 'parent-clone',
        consentAt: p.parentVoice.consentAt.toISOString(),
      }),
    );
    expect(p.rows[0].parentNarrationKey).toBe(key);
    expect(p.rows[0].configHash).toBe(
      storyVideoConfigHash(
        storyDigest(`${key}:manifest:${STORY_PARENT_CONSENT_VERSION}`),
        'Привет',
      ),
    );
    const q = await s.service.quote('u', 'g', 'Привет', {
      outroText: 'Спокойной ночи.',
    });
    expect(q.configHash).not.toBe(s.rows[0].configHash);
  });
  it('submits exactly the live-verified command for the legacy layout', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    const job = s.ffmpeg.submit.mock.calls[0][0];
    expect(job.commands[0]).toBe(
      planStoryVideo(55.74525, s.rows[0].preambleDuration).commands[0],
    );
    expect(Object.keys(job.inputs).sort()).toEqual([
      'base',
      'cover',
      'intro',
      'main',
    ]);
    expect(s.rows[0].segments.layout.durationSeconds).toBeCloseTo(
      55.74525 + s.rows[0].preambleDuration,
      3,
    );
  });
  it('builds separate speech/music/effects tracks with gains and ducking (plan only, nothing sent)', () => {
    const legacy = planStorySegments({
      segments: [
        { kind: 'intro', seconds: 5, visual: 'cover' },
        { kind: 'main', seconds: 55, visual: 'base' },
      ],
      baseSeconds: BASE.durationSeconds,
    });
    expect(legacy.legacy).toBe(true);
    expect(legacy.commands).toEqual(planStoryVideo(55, 5).commands);
    const p = planStorySegments({
      segments: [
        { kind: 'intro', seconds: 4, visual: 'cover', normalize: true },
        {
          kind: 'gift_note',
          position: 'beginning',
          seconds: 3,
          visual: 'photo',
        },
        { kind: 'main', seconds: 50, visual: 'base' },
        { kind: 'outro', seconds: 2, visual: 'cover' },
      ],
      baseSeconds: BASE.durationSeconds,
      music: { volume: 0.25 },
      effects: { volume: 0.5 },
      ducking: STORY_VIDEO_MIX.ducking,
    });
    const cmd = p.commands[0];
    expect(p.legacy).toBe(false);
    expect(p.durationSeconds).toBe(59);
    expect(p.inputs).toEqual({
      base: 'base',
      main: 'main',
      cover: 'cover',
      intro: 'intro',
      note_visual: 'photo',
      note: 'note',
      outro_visual: 'cover',
      outro: 'outro',
      music: 'music',
      effects: 'effects',
    });
    expect(cmd).toContain('[3:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000');
    expect(cmd).toContain(
      '[iv][ia][gv][ga][v][a][ov][oa]concat=n=4:v=1:a=1[outv][speech]',
    );
    expect(cmd).toContain('-stream_loop -1 -i {{music}}');
    expect(cmd).toContain('[speech]asplit=2[sp][sc]');
    expect(cmd).toContain('volume=0.250');
    expect(cmd).toContain(
      '[mus][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[musd]',
    );
    expect(cmd).toContain('volume=0.500');
    expect(cmd).toContain(
      '[sp][musd][sfx]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[outa]',
    );
    expect(cmd).toContain('force_original_aspect_ratio=decrease,pad=1280:720');
    expect(cmd).toMatch(/-t 59\.000000 \{\{story\.mp4\}\}$/);
    // No user text or URL can reach the command: only placeholders and numbers.
    expect(cmd.match(/\{\{[^}]+\}\}/g)!.sort()).toEqual(
      [
        '{{base}}',
        '{{cover}}',
        '{{effects}}',
        '{{intro}}',
        '{{main}}',
        '{{music}}',
        '{{note_visual}}',
        '{{note}}',
        '{{outro_visual}}',
        '{{outro}}',
        '{{story.mp4}}',
      ].sort(),
    );
    const bad =
      (segments: any[], extra = {}) =>
      () =>
        planStorySegments({ segments, baseSeconds: 55.76, ...extra });
    expect(
      bad([
        { kind: 'main', seconds: 50, visual: 'base' },
        { kind: 'intro', seconds: 4, visual: 'cover' },
      ]),
    ).toThrow();
    expect(
      bad([
        { kind: 'intro', seconds: 20, visual: 'cover' },
        { kind: 'main', seconds: 90, visual: 'base' },
        { kind: 'outro', seconds: 5, visual: 'cover' },
      ]),
    ).toThrow('too long');
    expect(
      bad([
        { kind: 'intro', seconds: 4, visual: 'photo' },
        { kind: 'main', seconds: 50, visual: 'base' },
      ]),
    ).toThrow();
    expect(
      bad(
        [
          { kind: 'intro', seconds: 4, visual: 'cover' },
          { kind: 'main', seconds: 50, visual: 'base' },
        ],
        { music: { volume: 2 } },
      ),
    ).toThrow();
  });
  it('maps base scene timecodes onto the export timeline', () => {
    const l = storyVideoLayout(
      [
        { kind: 'intro', seconds: 5 },
        { kind: 'main', seconds: BASE.durationSeconds / 2 },
        { kind: 'outro', seconds: 2 },
      ],
      BASE,
    );
    expect(l.speedFactor).toBe(0.5);
    expect(l.segments.map((x) => [x.kind, x.start])).toEqual([
      ['intro', 0],
      ['main', 5],
      ['outro', 32.88],
    ]);
    expect(l.scenes[1]).toEqual({
      title: BASE.scenes[1].title,
      start: 8.5,
      end: 12.5,
    });
    expect(l.scenes.at(-1)!.end).toBe(32.88);
    expect(l.durationSeconds).toBe(34.88);
  });
});

describe('WP4 segment cache and repeat-order quote', () => {
  it('re-renders without re-synthesizing existing segments or re-cloning', async () => {
    const s = setup();
    const outro = { ...parentChoice, outroText: 'Спокойной ночи.' };
    await s.service.create('u', 'g', 'Привет', outro);
    await s.service.create('u', 'g', 'Добрый вечер', outro);
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      s.gift.text,
      'Привет',
      'Спокойной ночи.',
      'Добрый вечер',
    ]);
    expect(s.segs.filter((r) => r.status === 'READY')).toHaveLength(3);
    expect(s.segs.every((r) => r.giftId === 'g')).toBe(true);
    const again = await s.service.quote('u', 'g', 'Привет', outro);
    expect(again.existingRender?.id).toBe('r1');
    expect(again.reserveMicroUsd).toBe(0);
    const q = await s.service.quote('u', 'g', 'Привет', {
      ...outro,
      outroText: 'Сладких снов.',
    });
    expect(q.sideEffects).toBe('none');
    expect(q.voice).toEqual({
      label: 'Мой голос',
      profile: 'parent',
      cloning: false,
    });
    expect(q.segments.map((x) => [x.kind, x.state])).toEqual([
      ['intro', 'reuse'],
      ['main', 'reuse'],
      ['outro', 'synthesize'],
    ]);
    expect(q.reserveMicroUsd).toBe(storyVideoReserve('Сладких снов.'));
    expect(q.layoutEstimated).toBe(true);
    expect(q.layout.segments.map((x) => x.kind)).toEqual([
      'intro',
      'main',
      'outro',
    ]);
    expect(q.warnings).toEqual([]);
    expect(q.fits).toBe(true);
    // The third render then buys only the new outro.
    await s.service.create('u', 'g', 'Привет', {
      ...outro,
      outroText: 'Сладких снов.',
    });
    expect(s.tts.synthesize.mock.calls.at(-1)[0].text).toBe('Сладких снов.');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(5);
    expect(s.rows[2].segments.segments.map((x: any) => x.kind)).toEqual([
      'intro',
      'main',
      'outro',
    ]);
    expect(s.rows[2].segments.tracks).toEqual({
      speech: s.rows[2].segments.segments.map((x: any) => x.cacheKey),
      music: [],
      effects: [],
    });
    const token = new URL(
      s.ffmpeg.submit.mock.calls[2][0].inputs.outro,
    ).pathname
      .split('/')
      .at(-2)!;
    expect((await s.service.input(token, 'outro')).bytes.toString()).toBe(
      'seg:Сладких снов.',
    );
  });
  it('quotes with no side effects, including missing consent and budget', async () => {
    const s = setup();
    (fetchPubliclyRoutable as jest.Mock).mockClear();
    s.gift.budgetCents = 15;
    const before = JSON.stringify({ rows: s.rows, segs: s.segs });
    const q = await s.service.quote('u', 'g', 'Привет', {
      narratorManifestId: 'manifest',
      outroText: 'Пока.',
    });
    expect(JSON.stringify({ rows: s.rows, segs: s.segs })).toBe(before);
    for (const fn of [
      s.db.create,
      s.db.updateMany,
      s.segDb.create,
      s.segDb.updateMany,
      s.segDb.upsert,
      s.tts.synthesize,
      s.ffmpeg.submit,
      s.ffmpeg.status,
      s.stt.transcribe,
      (s.service as any).usage.record,
      (s.service as any).plan.assertCanSpendUser,
    ])
      expect(fn).not.toHaveBeenCalled();
    expect(fetchPubliclyRoutable).not.toHaveBeenCalled();
    expect(q.fits).toBe(false);
    expect(q.blockers.join(' ')).toContain('согласия');
    expect(q.blockers.join(' ')).toContain('бюджета');
    expect(q.segments.map((x) => x.state)).toEqual([
      'synthesize',
      'synthesize',
      'synthesize',
    ]);
    expect(q.segments[1].characters).toBe(s.gift.text.length);
  });
  it('marks an uncertain segment UNKNOWN, releases unattempted claims and never re-buys it', async () => {
    const s = setup();
    const ok = s.tts.synthesize.getMockImplementation();
    s.tts.synthesize.mockImplementation(async (a: any) => {
      if (a.text === 'Привет') throw new Error('timeout');
      return ok(a);
    });
    const r: any = await s.service.create('u', 'g', 'Привет', {
      outroText: 'Пока.',
    });
    expect(r.status).toBe('UNKNOWN');
    expect(r.error).toContain('озвучка преамбулы');
    const byText = (t: string) =>
      s.segs.find((x) => x.text === t || x.cacheKey === t);
    expect(byText('Привет').status).toBe('UNKNOWN');
    expect(s.segs.find((x) => x.status === 'DELETED')).toBeTruthy();
    await expect(
      s.service.create('u', 'g', 'Привет', { outroText: 'Спокойной ночи.' }),
    ).rejects.toThrow('повторная оплата');
    const q = await s.service.quote('u', 'g', 'Привет', {
      outroText: 'Пока.',
    });
    expect(q.existingRender?.status).toBe('UNKNOWN');
    await s.service.create('u', 'g', 'Другое', { outroText: 'Пока.' });
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      'Привет',
      'Другое',
      'Пока.',
    ]);
  });
  it('expires stale segment syntheses from the cron without paid work', async () => {
    const s = setup();
    s.segs.push({
      id: 'stale',
      giftId: 'g',
      cacheKey: 'k'.repeat(64),
      source: 'synth',
      status: 'PENDING',
      updatedAt: new Date(Date.now() - 3600000),
    });
    s.db.findMany.mockResolvedValueOnce([]);
    s.prisma.storyGift.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const res = await s.service.finalizePending();
    expect(res).toEqual({
      scanned: 0,
      ready: 0,
      failed: 0,
      unknown: 0,
      blocked: 0,
      staleAudio: 1,
      staleQa: 0,
    });
    expect(s.segs[0].status).toBe('UNKNOWN');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
  });
});

describe('WP4 isolation: two family profiles on one video hash', () => {
  it('shares only the base master; speech tracks and segments differ and stay private', async () => {
    const s = setup();
    const voices: any[] = [
      s.parentVoice,
      {
        id: 'pv2',
        userId: 'u',
        status: 'READY',
        resembleVoiceId: 'clone-b',
        consentAt: new Date('2026-10-02'),
        label: 'Голос папы',
      },
    ];
    const manifests: any[] = [
      s.manifest,
      {
        id: 'manifest2',
        userId: 'u',
        ttsProvider: 'resemble',
        ttsVoiceId: 'clone-b',
        title: 'Папа',
      },
    ];
    const has = (row: any, where: any) =>
      Object.entries(where).every(([k, v]) => row[k] === v);
    s.prisma.userVoice.findFirst.mockImplementation(async ({ where }: any) => {
      const v = voices.find((v) => has(v, where));
      return v ? { ...v } : null;
    });
    s.prisma.brandManifest.findFirst.mockImplementation(
      async ({ where }: any) => {
        const m = manifests.find((m) => has(m, where));
        return m ? { ...m } : null;
      },
    );
    s.tts.synthesize.mockImplementation(async ({ text, voiceId }: any) => ({
      ok: true,
      voiceId,
      mimeType: 'audio/mpeg',
      audio: Buffer.from(`${voiceId}:${text}`),
      durationSeconds: text === s.gift.text ? 55 : 5,
      characters: text.length,
    }));
    await s.service.create('u', 'g', 'Привет', parentChoice);
    await s.service.create('u', 'g', 'Привет', {
      ...parentChoice,
      narratorManifestId: 'manifest2',
    });
    const [a, b] = s.rows;
    expect(a.baseHash).toBe(BASE.baseSha256);
    expect(b.baseHash).toBe(a.baseHash);
    expect(a.mainAudioHash).not.toBe(b.mainAudioHash);
    expect(a.parentNarrationKey).not.toBe(b.parentNarrationKey);
    expect(a.segments.segments[0].cacheKey).not.toBe(
      b.segments.segments[0].cacheKey,
    );
    expect(Buffer.from(a.preambleAudio).toString()).toBe('parent-clone:Привет');
    expect(Buffer.from(b.preambleAudio).toString()).toBe('clone-b:Привет');
    const mainA = await s.service.file('u', 'g', 'r1', 'main');
    const mainB = await s.service.file('u', 'g', 'r2', 'main');
    expect(mainA.base64).not.toBe(mainB.base64);
    await expect(s.service.file('other', 'g', 'r2', 'main')).rejects.toThrow();
    await expect(
      s.service.quote('other', 'g', 'Привет', parentChoice),
    ).rejects.toThrow();
    for (const fn of [s.segDb.findMany, s.segDb.findFirst, s.segDb.create])
      for (const [arg] of fn.mock.calls)
        expect((arg.where ?? arg.data).giftId).toBe('g');
  });
  it('refuses a revoked voice before any new speech, also for cached segments', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет', parentChoice);
    s.parentVoice.status = 'FAILED';
    await expect(
      s.service.create('u', 'g', 'Добрый вечер', parentChoice),
    ).rejects.toThrow('клон');
    await expect(
      s.service.quote('u', 'g', 'Привет', parentChoice),
    ).rejects.toThrow('клон');
    await expect(s.service.subtitles('u', 'g', 'r1')).rejects.toThrow(
      'отозван',
    );
    expect(s.tts.synthesize).toHaveBeenCalledTimes(2);
  });
});

describe('WP4 gift note segment and photo', () => {
  it('speaks the note as a separate profile-voice segment without breaking main reuse', async () => {
    const plain = setup();
    await plain.service.create('u', 'g', 'Привет', parentChoice);
    const s = setup();
    const story = s.gift.text;
    const note = 'Под подушкой тебя ждёт книжка.';
    Object.assign(s.gift, {
      giftNote: note,
      giftNotePosition: 'beginning',
      text: `${note}\n\n${story}`,
      hasGiftPhoto: true,
      giftPhoto: Buffer.from('gift-photo-png'),
    });
    s.tts.synthesize.mockImplementation(async ({ text, voiceId }: any) => ({
      ok: true,
      voiceId,
      mimeType: 'audio/mpeg',
      audio: Buffer.from(text === story ? 'parent-main' : `seg:${text}`),
      durationSeconds: text === story ? 55 : 4,
      characters: text.length,
    }));
    const r: any = await s.service.create('u', 'g', 'Привет', parentChoice);
    expect(r.status).toBe('PENDING');
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      story,
      'Привет',
      note,
    ]);
    expect(s.rows[0].parentNarrationKey).toBe(plain.rows[0].parentNarrationKey);
    expect(
      r.segments.segments.map((x: any) => [
        x.kind,
        x.position ?? null,
        x.visual,
      ]),
    ).toEqual([
      ['intro', null, 'cover'],
      ['gift_note', 'beginning', 'photo'],
      ['main', null, 'base'],
    ]);
    const job = s.ffmpeg.submit.mock.calls[0][0];
    expect(job.inputs.note_visual).toMatch(/\/photo$/);
    const token = tokenOf(s);
    expect((await s.service.input(token, 'photo')).bytes.toString()).toBe(
      'gift-photo-png',
    );
    expect((await s.service.input(token, 'note')).bytes.toString()).toBe(
      `seg:${note}`,
    );
    const vtt = await s.service.subtitles('u', 'g', 'r1');
    expect(vtt.indexOf('Привет')).toBeLessThan(vtt.indexOf('Под подушкой'));
    expect(vtt.indexOf('Под подушкой')).toBeLessThan(vtt.indexOf('Репка'));
    // QA reference covers every spoken segment in order.
    Object.assign(s.rows[0], {
      status: 'READY',
      video: Buffer.from('mp4'),
      videoHash: 'b'.repeat(64),
    });
    s.stt.transcribe.mockResolvedValue({
      text: `Привет. ${note} ${story}`,
      language: 'ru',
      billable: true,
      seconds: 64,
    });
    expect((await s.service.quality('u', 'g', 'r1')).qaStatus).toBe('PASS');
  });
});

describe('WP4 subtitles', () => {
  it('builds WebVTT by sentences with proportional timing and escaping', () => {
    const vtt = buildStoryVtt([
      { text: 'Привет. Как дела?', start: 0, end: 4 },
      { text: 'Кот <b> & пёс.', start: 4, end: 6 },
    ]);
    expect(vtt.startsWith('WEBVTT\n\n1\n00:00:00.000 --> ')).toBe(true);
    expect(vtt).toContain('Привет.');
    expect(vtt).toContain('Как дела?');
    expect(vtt).toContain('Кот &lt;b&gt; &amp; пёс.');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000');
    const cues = storyCues([
      { text: 'слово '.repeat(40).trim() + '.', start: 0, end: 10 },
    ]);
    expect(cues.every((c) => c.lines.length <= 2)).toBe(true);
    expect(cues.flatMap((c) => c.lines).every((l) => l.length <= 42)).toBe(
      true,
    );
    expect(cues.at(-1)!.end).toBe(10);
  });
  it('serves subtitles for new and pre-WP4 renders behind owner checks', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет.');
    const vtt = await s.service.subtitles('u', 'g', 'r1');
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000\nПривет.');
    expect(vtt).toContain('Репка.');
    await expect(s.service.subtitles('other', 'g', 'r1')).rejects.toThrow();
    s.rows[0].segments = null;
    expect(await s.service.subtitles('u', 'g', 'r1')).toContain(
      '00:00:00.000 --> 00:00:05.000\nПривет.',
    );
    s.rows[0].preambleDuration = null;
    await expect(s.service.subtitles('u', 'g', 'r1')).rejects.toThrow(
      'Субтитры',
    );
    expect(
      Reflect.getMetadata(
        'path',
        StoryGiftsController.prototype.videoSubtitles,
      ),
    ).toBe(':id/video/:renderId/subtitles.vtt');
    const res: any = { set: jest.fn(() => res), send: jest.fn() };
    s.rows[0].preambleDuration = 5;
    const ctl: StoryGiftsController = Object.assign(
      Object.create(StoryGiftsController.prototype),
      { videos: s.service },
    );
    await ctl.videoSubtitles({ telegramUserId: 'u' } as never, 'g', 'r1', res);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/vtt; charset=utf-8',
      }),
    );
    expect(res.send.mock.calls[0][0]).toMatch(/^WEBVTT\n/);
  });
});

describe('WP4 own recorded preamble (ST-P1)', () => {
  it('accepts only a consented, canonical, audible WAV of 1–20 s', async () => {
    const s = setup();
    const up = (bytes: Buffer, c: any = recConsent) =>
      s.service.uploadRecording('u', 'g', {
        base64: bytes.toString('base64'),
        ...c,
      });
    await expect(
      up(wav(3), { consentVersion: 'old', consentAccepted: true }),
    ).rejects.toThrow('согласие');
    await expect(up(wav(3, 22050, 0))).rejects.toThrow('беззвучна');
    await expect(up(wav(25, 16000))).rejects.toThrow('Длительность');
    await expect(up(wav(0.5))).rejects.toThrow('Длительность');
    await expect(up(wav(2, 22050, 0.3, 2))).rejects.toThrow('WAV');
    await expect(up(Buffer.from('ID3 not a wav at all'))).rejects.toThrow(
      'WAV',
    );
    await expect(
      s.service.uploadRecording('other', 'g', {
        base64: wav(3).toString('base64'),
        ...recConsent,
      }),
    ).rejects.toThrow();
    const a = await up(wav(3));
    expect(a.seconds).toBe(3);
    expect((await up(wav(3))).id).toBe(a.id);
    expect(parseStoryWav(wav(2, 16000))).toMatchObject({
      sampleRate: 16000,
      seconds: 2,
    });
    expect(parseStoryWav(wav(2).subarray(0, 100))).toBeNull();
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('assembles a recorded intro without TTS, with loudness normalisation and the same QA', async () => {
    const s = setup();
    const bytes = wav(4);
    const rec = await s.service.uploadRecording('u', 'g', {
      base64: bytes.toString('base64'),
      ...recConsent,
    });
    await expect(
      s.service.create('u', 'g', 'Привет, это мама.', {
        preambleSource: 'recorded',
      }),
    ).rejects.toThrow('Запись вступления');
    const q = await s.service.quote('u', 'g', 'Привет, это мама.', {
      preambleSource: 'recorded',
      recordingId: rec.id,
    });
    expect(q.segments[0]).toMatchObject({
      kind: 'intro',
      source: 'recorded',
      state: 'reuse',
      seconds: 4,
    });
    expect(q.reserveMicroUsd).toBe(storyVideoReserve(''));
    const r: any = await s.service.create('u', 'g', 'Привет, это мама.', {
      preambleSource: 'recorded',
      recordingId: rec.id,
    });
    expect(r.status).toBe('PENDING');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    const job = s.ffmpeg.submit.mock.calls[0][0];
    expect(job.commands[0]).toContain('[3:a]loudnorm=');
    const token = tokenOf(s);
    const intro = await s.service.input(token, 'intro');
    expect(intro.mime).toBe('audio/wav');
    expect(Buffer.compare(intro.bytes, bytes)).toBe(0);
    expect((await s.service.file('u', 'g', 'r1', 'intro')).mime).toBe(
      'audio/wav',
    );
    expect(r.segments.segments[0]).toMatchObject({
      source: 'recorded',
      text: 'Привет, это мама.',
      voiceId: null,
    });
    // Deleting the recording keeps the render's own copy; a new render needs it again.
    await s.service.deleteRecording('u', 'g', rec.id);
    expect(s.segs.find((x) => x.id === rec.id).audio).toBeNull();
    expect(s.rows[0].preambleAudio).toBeTruthy();
    await expect(
      s.service.create('u', 'g', 'Другое вступление.', {
        preambleSource: 'recorded',
        recordingId: rec.id,
      }),
    ).rejects.toThrow('Запись вступления');
    await expect(
      s.service.deleteRecording('other', 'g', rec.id),
    ).rejects.toThrow();
  });
  it('blocks promises in preamble and outro before any paid call', async () => {
    const s = setup();
    await expect(
      s.service.create('u', 'g', 'Папа вернётся завтра, обещаю.'),
    ).rejects.toThrow();
    await expect(
      s.service.quote('u', 'g', 'Привет', {
        outroText: 'Подарок уже едет к тебе.',
      }),
    ).rejects.toThrow();
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
});

describe('WP4 pronunciations (ST-P2)', () => {
  it('validates pairs and respells whole words only', () => {
    expect(() =>
      parseStoryPronunciations(
        Array.from({ length: 6 }, (_, i) => ({
          written: `А${i}`,
          spoken: 'а',
        })),
      ),
    ).toThrow();
    expect(() =>
      parseStoryPronunciations([{ written: 'Жучка', spoken: 'Ж1учка' }]),
    ).toThrow();
    expect(() =>
      parseStoryPronunciations([{ written: 'Жучка', spoken: 'Жучка. Привет' }]),
    ).toThrow();
    expect(() =>
      parseStoryPronunciations([
        { written: 'Жучка', spoken: 'Жу+чка' },
        { written: 'жучка', spoken: 'Жучка' },
      ]),
    ).toThrow();
    const list = parseStoryPronunciations([
      { written: 'Жучка', spoken: 'Жу+чка' },
    ]);
    expect(
      applyStoryPronunciations('Жучка и жучка, но не Жучкам.', list),
    ).toEqual({ text: 'Жу+чка и Жу+чка, но не Жучкам.', applied: ['Жучка'] });
    expect(applyStoryPronunciations('Без имён.', list).applied).toEqual([]);
  });
  it('applies respellings to TTS input only; subtitles and QA keep the written text', async () => {
    const s = setup();
    const story = s.gift.text;
    const pr = [{ written: 'Маша', spoken: 'Ма+ша' }];
    const q = await s.service.quote('u', 'g', 'Привет, Маша!', {
      ...parentChoice,
      pronunciations: pr,
    });
    expect(q.segments[0]).toMatchObject({
      text: 'Привет, Маша!',
      ttsText: 'Привет, Ма+ша!',
      pronunciations: ['Маша'],
    });
    await s.service.create('u', 'g', 'Привет, Маша!', {
      ...parentChoice,
      pronunciations: pr,
    });
    expect(s.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      story,
      'Привет, Ма+ша!',
    ]);
    const m = s.rows[0].segments.segments;
    expect(m[0].text).toBe('Привет, Маша!');
    expect(m[1].text).toBe(story);
    const vtt = await s.service.subtitles('u', 'g', 'r1');
    expect(vtt).toContain('Маша');
    expect(vtt).not.toContain('Ма+ша');
    // Nova main is pinned: pronunciations reach only new segments.
    const nova = await s.service.quote('u', 'g', 'Привет, Репка!', {
      pronunciations: [{ written: 'Репка', spoken: 'Рэпка' }],
    });
    expect(nova.segments[1]).toMatchObject({
      source: 'gift',
      pronunciations: [],
    });
  });
  it('Nova: a pair matching only the pinned story text keeps the legacy config hash', async () => {
    const s = setup();
    const hashOf = () =>
      s.db.findUnique.mock.calls
        .map((c: any) => c[0].where.giftId_configHash?.configHash)
        .filter(Boolean)
        .pop();
    await s.service.quote('u', 'g', 'Привет, солнышко!', {});
    const plain = hashOf();
    await s.service.quote('u', 'g', 'Привет, солнышко!', {
      pronunciations: [{ written: 'Репка', spoken: 'Ре+пка' }],
    });
    expect(plain).toBeTruthy();
    expect(hashOf()).toBe(plain);
  });
  it('B-S2-1: one close word only; never on the classic text; the spoken TTS input is validated', async () => {
    // Audit example: a pair cannot smuggle a promise as a "pronunciation".
    expect(() =>
      parseStoryPronunciations([
        { written: 'солнышко', spoken: 'вернусь завтра' },
      ]),
    ).toThrow('одно слово');
    expect(() =>
      parseStoryPronunciations([
        { written: 'солнышко', spoken: 'вернусьзавтра' },
      ]),
    ).toThrow('не похоже');
    expect(() =>
      parseStoryPronunciations([
        { written: 'вернусь', spoken: 'вернусь-завтра' },
      ]),
    ).toThrow('не похоже');
    for (const ok of [
      { written: 'Жучка', spoken: 'Жу+чка' },
      { written: 'Репка', spoken: 'Рэпка' },
      { written: 'Ёжик', spoken: 'йо+жик' },
      { written: 'Маша', spoken: 'Ма́ша' },
    ])
      expect(parseStoryPronunciations([ok])).toEqual([ok]);
    const s = setup();
    for (const bad of [
      [{ written: 'солнышко', spoken: 'вернусь завтра' }],
      [{ written: 'солнышко', spoken: 'вернусьзавтра' }],
    ]) {
      await expect(
        s.service.quote('u', 'g', 'Привет, солнышко', { pronunciations: bad }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        s.service.create('u', 'g', 'Привет, солнышко', {
          pronunciations: bad,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    // The classic edition is spoken exactly: a pair that touches it is refused.
    await expect(
      s.service.create('u', 'g', 'Привет!', {
        ...parentChoice,
        pronunciations: [{ written: 'Репка', spoken: 'Рэпка' }],
      }),
    ).rejects.toThrow('классической редакции');
    await expect(
      s.service.quote('u', 'g', 'Привет!', {
        ...parentChoice,
        pronunciations: [{ written: 'Репка', spoken: 'Рэпка' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Close respelling that turns the TTS input into a dated promise.
    await expect(
      s.service.create('u', 'g', 'Вернусь, и будет завтрак', {
        pronunciations: [{ written: 'завтрак', spoken: 'за+втра' }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'STORY_PROMISE_RETURN_DATE' },
    });
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(0);
  });
  it('B-S3-6/B-S3-7: legacy gift notes are validated; lone surrogates never reach TTS', async () => {
    const s = setup();
    s.gift.giftNote = 'Вернусь завтра';
    s.gift.giftNotePosition = 'end';
    s.gift.text = `${s.gift.text}\n\nВернусь завтра`;
    await expect(s.service.quote('u', 'g', 'Привет')).rejects.toMatchObject({
      status: 400,
    });
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toMatchObject({
      status: 400,
    });
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    const t = setup();
    await t.service.create('u', 'g', 'Привет \ud83d', {
      outroText: 'Пока\udc00!',
    });
    expect(t.tts.synthesize.mock.calls.map((c: any) => c[0].text)).toEqual([
      'Привет',
      'Пока!',
    ]);
    expect(t.rows[0].preambleText).toBe('Привет');
  });
});

describe('WP4 request validation', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const body = (metatype: any, value: unknown) =>
    pipe.transform(value, { type: 'body', metatype });
  it('accepts the segment options and rejects unknown or excessive fields', async () => {
    await expect(
      body(StoryVideoDto, {
        preambleText: 'Привет',
        preambleSource: 'recorded',
        recordingId: '00000000-0000-4000-8000-000000000001',
        outroText: 'Пока',
        pronunciations: [{ written: 'Жучка', spoken: 'Жу+чка' }],
      }),
    ).resolves.toBeInstanceOf(StoryVideoDto);
    for (const bad of [
      {
        preambleText: 'x',
        pronunciations: [{ written: 'a', spoken: 'b', x: 1 }],
      },
      {
        preambleText: 'x',
        pronunciations: Array.from({ length: 6 }, () => ({
          written: 'a',
          spoken: 'b',
        })),
      },
      { preambleText: 'x', preambleSource: 'clone' },
      { preambleText: 'x', recordingId: 'not-a-uuid' },
      { preambleText: 'x', music: 'https://example.com/a.mp3' },
    ])
      await expect(body(StoryVideoDto, bad)).rejects.toThrow();
    await expect(
      body(StoryRecordingDto, {
        base64: 'UklGRg==',
        consentVersion: STORY_RECORDING_CONSENT_VERSION,
        consentAccepted: false,
      }),
    ).rejects.toThrow();
  });
});

describe('WP5↔WP4 narrator image in the video intro', () => {
  const withImage = { ...parentChoice, useNarratorImage: true };
  const looksConflict = () =>
    new ConflictException({
      code: 'NARRATOR_LOOK_CONSENT',
      message: 'Согласие на образ рассказчика отозвано',
    });
  it('plans the narrator still only for the intro, letterboxed, instead of the cover', () => {
    const p = planStorySegments({
      segments: [
        { kind: 'intro', seconds: 5, visual: 'narrator' },
        { kind: 'main', seconds: 55, visual: 'base' },
      ],
      baseSeconds: BASE.durationSeconds,
    });
    expect(p.legacy).toBe(false);
    expect(p.inputs).toEqual({
      base: 'base',
      main: 'main',
      intro: 'intro',
      narrator: 'narrator',
    });
    expect(p.commands[0]).toContain('-loop 1 -framerate 25 -i {{narrator}}');
    expect(p.commands[0]).not.toContain('{{cover}}');
    expect(p.commands[0]).toContain(
      '[2:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720',
    );
    expect(() =>
      planStorySegments({
        segments: [
          { kind: 'intro', seconds: 5, visual: 'cover' },
          { kind: 'main', seconds: 55, visual: 'base' },
          { kind: 'outro', seconds: 3, visual: 'narrator' },
        ],
        baseSeconds: BASE.durationSeconds,
      }),
    ).toThrow('Invalid story segments');
  });
  it('puts the applied look into the plan, the provider inputs and the render snapshot', async () => {
    const s = setup();
    const r: any = await s.service.create('u', 'g', 'Привет', withImage);
    expect(r.status).toBe('PENDING');
    expect(s.looks.resolveNarratorImage).toHaveBeenCalledWith('manifest', 'u');
    // Checked at create and again right before the paid submit.
    expect(s.looks.resolveNarratorImage).toHaveBeenCalledTimes(2);
    const job = s.ffmpeg.submit.mock.calls[0][0];
    expect(job.inputs.narrator).toMatch(/\/narrator$/);
    expect(job.inputs.cover).toBeUndefined();
    expect(job.commands[0]).toContain('{{narrator}}');
    const m = s.rows[0].segments;
    expect(m.segments[0]).toMatchObject({ kind: 'intro', visual: 'narrator' });
    expect(m.narrator).toEqual({
      manifestId: 'manifest',
      characterId: 'character',
      kind: 'variant',
      lookId: 'look-1',
      asset: 'photo',
      assetHash: s.narrator.assetHash,
      style: 'photo',
      sketchRendering: null,
      consentVersion: 'story-parent-image-v1',
      mimeType: 'image/png',
      bytes: s.narrator.bytes.length,
    });
    // No image bytes in the stored JSON.
    expect(JSON.stringify(m)).not.toContain('narrator-look-png');
    const file = await s.service.input(tokenOf(s), 'narrator');
    expect(file).toEqual({
      bytes: Buffer.from('narrator-look-png'),
      mime: 'image/png',
    });
    // The quote shows the same image without side effects.
    const q = await s.service.quote('u', 'g', 'Привет', withImage);
    expect(q.narrator).toMatchObject({ kind: 'variant', lookId: 'look-1' });
    expect(q.segments[0].visual).toBe('narrator');
    expect(q.configHash).toBe(s.rows[0].configHash);
  });
  it('uses the original narrator photo when no look is applied', async () => {
    const s = setup();
    const photo = Buffer.from('original-photo-jpeg');
    Object.assign(s.narrator, {
      kind: 'original',
      lookId: null,
      asset: 'original',
      consentVersion: null,
      mimeType: 'image/jpeg',
      bytes: photo,
      assetHash: storyDigest(photo),
    });
    await s.service.create('u', 'g', 'Привет', withImage);
    expect(s.rows[0].segments.narrator).toMatchObject({
      kind: 'original',
      lookId: null,
      consentVersion: null,
    });
    const file = await s.service.input(tokenOf(s), 'narrator');
    expect(file.mime).toBe('image/jpeg');
  });
  it('keeps every earlier export key; the image enters the key only for the new layout', async () => {
    const off = setup();
    await off.service.create('u', 'g', 'Привет', {
      ...parentChoice,
      useNarratorImage: false,
    });
    const legacy = setup();
    await legacy.service.create('u', 'g', 'Привет', parentChoice);
    // Explicit false, absent flag and the pre-WP5 version-1 key are identical.
    expect(off.rows[0].configHash).toBe(legacy.rows[0].configHash);
    expect(legacy.rows[0].configHash).toBe(
      storyVideoConfigHash(
        storyDigest(
          `${legacy.rows[0].parentNarrationKey}:manifest:${STORY_PARENT_CONSENT_VERSION}`,
        ),
        'Привет',
      ),
    );
    expect(off.looks.resolveNarratorImage).not.toHaveBeenCalled();
    expect(off.rows[0].segments.narrator).toBeUndefined();
    expect(off.ffmpeg.submit.mock.calls[0][0].inputs.cover).toMatch(/\/cover$/);
    const a = setup();
    await a.service.create('u', 'g', 'Привет', withImage);
    expect(a.rows[0].configHash).not.toBe(legacy.rows[0].configHash);
    // Another look (asset hash) or consent snapshot is another export.
    const b = setup();
    const other = Buffer.from('another-look');
    Object.assign(b.narrator, {
      lookId: 'look-2',
      bytes: other,
      assetHash: storyDigest(other),
    });
    await b.service.create('u', 'g', 'Привет', withImage);
    expect(b.rows[0].configHash).not.toBe(a.rows[0].configHash);
    const c = setup();
    c.narrator.consentVersion = 'story-parent-image-v2';
    expect(
      (await c.service.quote('u', 'g', 'Привет', withImage)).configHash,
    ).not.toBe(a.rows[0].configHash);
  });
  it('returns the WP5 409 as is when image consent is revoked: no cover/original fallback, nothing paid', async () => {
    const s = setup();
    s.looks.resolveNarratorImage.mockRejectedValue(looksConflict());
    await expect(
      s.service.create('u', 'g', 'Привет', withImage),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'NARRATOR_LOOK_CONSENT' },
    });
    await expect(
      s.service.quote('u', 'g', 'Привет', withImage),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(0);
  });
  it('re-checks the image before submit: a revocation during synthesis stops the render as FAILED, no submit', async () => {
    const s = setup();
    s.looks.resolveNarratorImage
      .mockImplementationOnce(async () => ({
        ...s.narrator,
        bytes: Buffer.from(s.narrator.bytes),
      }))
      .mockRejectedValueOnce(looksConflict());
    const r: any = await s.service.create('u', 'g', 'Привет', withImage);
    expect(r.status).toBe('FAILED');
    expect(r.error).toContain('образ рассказчика недоступен');
    expect(r.error).toContain('отозвано');
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    expect(s.rows[0].assetTokenHash).toBeNull();
    // Speech already bought is kept for reuse, not marked UNKNOWN.
    expect(s.segs.every((x: any) => x.status === 'READY')).toBe(true);
  });
  it('a look changed after create is not served to the provider', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет', withImage);
    const token = tokenOf(s);
    const changed = Buffer.from('changed-look');
    Object.assign(s.narrator, {
      lookId: 'look-9',
      bytes: changed,
      assetHash: storyDigest(changed),
    });
    await expect(s.service.input(token, 'narrator')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    s.looks.resolveNarratorImage.mockRejectedValue(looksConflict());
    await expect(s.service.input(token, 'narrator')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('isolates the image by owner and requires a profile voice', async () => {
    const s = setup();
    await expect(
      s.service.create('u', 'g', 'Привет', { useNarratorImage: true }),
    ).rejects.toMatchObject({ status: 400 });
    // Another owner's gift and manifest: nothing resolved, nothing paid.
    await expect(
      s.service.create('other', 'g', 'Привет', withImage),
    ).rejects.toThrow();
    s.manifest.userId = 'someone-else';
    await expect(
      s.service.create('u', 'g', 'Привет', withImage),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.looks.resolveNarratorImage).not.toHaveBeenCalled();
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    // The provider input of a Nova/cover render never serves a narrator image.
    const n = setup();
    await n.service.create('u', 'g', 'Привет');
    await expect(
      n.service.input(tokenOf(n), 'narrator'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(n.looks.resolveNarratorImage).not.toHaveBeenCalled();
  });
  it('rejects an unusable image format or size before any paid call', async () => {
    const s = setup();
    s.narrator.mimeType = 'image/gif';
    await expect(
      s.service.create('u', 'g', 'Привет', withImage),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('accepts the explicit flag in the DTO and rejects a non-boolean', async () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const meta = { type: 'body' as const, metatype: StoryVideoDto };
    await expect(
      pipe.transform({ preambleText: 'Привет', useNarratorImage: true }, meta),
    ).resolves.toMatchObject({ useNarratorImage: true });
    await expect(
      pipe.transform({ preambleText: 'Привет', useNarratorImage: 'yes' }, meta),
    ).rejects.toThrow();
  });
});

describe('F1 audit: render lifecycle, budget and races', () => {
  const longParent = (s: ReturnType<typeof setup>) =>
    s.tts.synthesize.mockImplementation(async ({ text, voiceId }: any) => ({
      ok: true,
      voiceId,
      mimeType: 'audio/mpeg',
      audio: Buffer.from(`tts:${text}`),
      durationSeconds: text === s.gift.text ? 90 : text === 'Привет' ? 18 : 5,
      characters: text.length,
    }));
  it('A-S2-2/A-S3-4: FAILED before submit keeps only the speech reserve; the same configuration starts a new attempt without re-buying speech', async () => {
    const s = setup();
    longParent(s);
    const choice = { ...parentChoice, outroText: 'Спокойной ночи' };
    const r1: any = await s.service.create('u', 'g', 'Привет', choice);
    expect(r1.status).toBe('FAILED');
    expect(r1.error).toContain('резерв сборки освобождён');
    const chars =
      s.gift.text.length + 'Привет'.length + 'Спокойной ночи'.length;
    expect(s.rows[0].reservedMicroUsd).toBe(storyVideoTtsReserve(chars));
    expect(s.rows[0].reservedMicroUsd).toBeLessThan(
      storyVideoReserve('ПриветСпокойной ночи', s.gift.text),
    );
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    const q = await s.service.quote('u', 'g', 'Привет', choice);
    expect(q.existingRender).toBeNull();
    expect(q.segments.every((l: any) => l.state === 'reuse')).toBe(true);
    const r2: any = await s.service.create('u', 'g', 'Привет', choice);
    expect(r2.id).toBe('r2');
    expect(s.rows[0].configHash).toBe(`${s.rows[1].configHash}:retired:r1`);
    // Speech is reused (READY cache + stored main): no second TTS purchase.
    expect(s.tts.synthesize).toHaveBeenCalledTimes(3);
    expect(s.rows[1].reservedMicroUsd).toBe(0);
  });
  it('A-S2-2: a render deleted with its old configuration key does not block the same order forever', async () => {
    const s = setup();
    await s.service.create('u', 'g', 'Привет');
    Object.assign(s.rows[0], { status: 'DELETED', video: null });
    const again: any = await s.service.create('u', 'g', 'Привет');
    expect(again.status).not.toBe('DELETED');
    expect(s.rows).toHaveLength(2);
    // UNKNOWN still occupies the slot: no paid repeat without an operator.
    s.rows[1].status = 'UNKNOWN';
    expect((await s.service.create('u', 'g', 'Привет')).id).toBe('r2');
    expect(s.rows).toHaveLength(2);
  });
  it('A-S2-1: an unconfirmed main narration stays blocked after retention and FAILED, until an operator releases the key', async () => {
    const s = setup();
    s.tts.synthesize.mockRejectedValueOnce(new Error('timeout'));
    expect(
      ((await s.service.create('u', 'g', 'Привет', parentChoice)) as any)
        .status,
    ).toBe('UNKNOWN');
    const key = s.rows[0].parentNarrationKey;
    // Retention wipe of that render keeps the key (main never saved).
    Object.assign(
      s.rows[0],
      storyRenderWipe({
        release: { id: 'r1', configHash: s.rows[0].configHash },
        keepNarrationKey: true,
      }),
    );
    expect(s.rows[0]).toMatchObject({
      status: 'DELETED',
      parentNarrationKey: key,
    });
    await expect(
      s.service.create('u', 'g', 'Другой', parentChoice),
    ).rejects.toThrow('повторная оплата');
    const q = await s.service.quote('u', 'g', 'Другой', parentChoice);
    expect(q.segments.find((l: any) => l.kind === 'main')!.state).toBe(
      'blocked',
    );
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    // A saved narration on a FAILED render is reused, never bought again.
    s.rows[0].parentNarrationKey = null; // operator: no charge confirmed
    await s.service.create('u', 'g', 'Другой', parentChoice);
    expect(s.tts.synthesize).toHaveBeenCalledTimes(3);
    s.rows[1].status = 'FAILED';
    await s.service.create('u', 'g', 'Третий', parentChoice);
    expect(
      s.tts.synthesize.mock.calls.filter((c: any) => c[0].text === s.gift.text),
    ).toHaveLength(2);
  });
  it('A-S3-3: the spend gate after speech is its own stage — FAILED with the plan message, nothing submitted', async () => {
    const s = setup();
    s.plan.assertCanSpendUser
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Лимит расходов тарифа исчерпан'));
    const r: any = await s.service.create('u', 'g', 'Привет');
    expect(r.status).toBe('FAILED');
    expect(r.error).toContain('тариф сейчас не разрешает новые расходы');
    expect(r.error).toContain('Лимит расходов тарифа исчерпан');
    expect(r.error).not.toContain('длительност');
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
    expect(s.rows[0].reservedMicroUsd).toBe(
      storyVideoTtsReserve('Привет'.length),
    );
    expect(s.segs[0].status).toBe('READY');
  });
  it('A-S3-6: speech is not stored for a gift deleted during synthesis', async () => {
    const s = setup();
    s.tts.synthesize.mockImplementation(async ({ text, voiceId }: any) => {
      // The owner deletes the gift while TTS runs (remove() wipes everything).
      s.gift.status = 'DELETED';
      for (const x of s.segs) Object.assign(x, { status: 'DELETED' });
      for (const x of s.rows) Object.assign(x, { status: 'DELETED' });
      return {
        ok: true,
        voiceId,
        mimeType: 'audio/mpeg',
        audio: Buffer.from(`tts:${text}`),
        durationSeconds: 5,
        characters: text.length,
      };
    });
    await expect(s.service.create('u', 'g', 'Привет')).rejects.toThrow();
    expect(s.segs.every((x: any) => !x.audio && x.status === 'DELETED')).toBe(
      true,
    );
    expect(s.rows[0].status).toBe('DELETED');
    expect(s.ffmpeg.submit).not.toHaveBeenCalled();
  });
  it('A-S3-11: the five-recordings limit is checked and written under the gift lock', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++)
      await s.service.uploadRecording('u', 'g', {
        base64: wav(2 + i).toString('base64'),
        ...recConsent,
      });
    await expect(
      s.service.uploadRecording('u', 'g', {
        base64: wav(9).toString('base64'),
        ...recConsent,
      }),
    ).rejects.toThrow('пяти');
    expect(s.prisma.$queryRaw).toHaveBeenCalled();
    expect(String(s.prisma.$queryRaw.mock.calls.at(-1)[1])).toBe(
      'story-video:g',
    );
  });
  it('A-S2-4: a narrator image over 4 000 000 bytes is refused before any paid call (quote and create)', async () => {
    const s = setup();
    const big = Buffer.alloc(4_000_001, 1);
    Object.assign(s.narrator, { bytes: big, assetHash: storyDigest(big) });
    const choice = { ...parentChoice, useNarratorImage: true };
    await expect(s.service.quote('u', 'g', 'Привет', choice)).rejects.toThrow(
      '4 МБ',
    );
    await expect(
      s.service.create('u', 'g', 'Привет', choice),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(0);
    const ok = Buffer.alloc(4_000_000, 1);
    Object.assign(s.narrator, { bytes: ok, assetHash: storyDigest(ok) });
    await expect(
      s.service.quote('u', 'g', 'Привет', choice),
    ).resolves.toMatchObject({ narrator: { assetHash: storyDigest(ok) } });
  });
});
