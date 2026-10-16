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
  STORY_PARENT_CONSENT_VERSION,
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
    audioHash: storyDigest(Buffer.from('main-audio')),
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
      audio: Buffer.from(text === gift.text ? 'parent-main' : 'intro'),
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
    parentVoice,
    manifest,
    prisma,
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
