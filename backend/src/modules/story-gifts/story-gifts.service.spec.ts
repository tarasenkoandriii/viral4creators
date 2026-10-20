/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory database mock */
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { StoryGiftsService, storyRenderWipe } from './story-gifts.service';
import { STORY_VOICE, storyText } from './story-catalog';
function setup() {
  const row = {
    id: 'g1',
    userId: 'u1',
    locale: 'ru',
    budgetCents: 100,
    reservedMicroUsd: 100000,
    status: 'DRAFT',
    audioQaStatus: 'PENDING',
    voiceId: STORY_VOICE,
    text: storyText(),
    audioHash: null as string | null,
    shareHash: null as string | null,
    audio: null as Uint8Array | null,
  };
  const db = {
    findFirst: jest.fn(async ({ where }: any) => {
      if (where.userId && where.userId !== row.userId) return null;
      if (
        where.shareHash &&
        (where.shareHash !== row.shareHash || row.status !== 'APPROVED')
      )
        return null;
      return { ...row };
    }),
    findFirstOrThrow: jest.fn(async () => ({ ...row })),
    findUniqueOrThrow: jest.fn(async () => ({ ...row })),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (where.audioQaStatus && where.audioQaStatus !== row.audioQaStatus)
        return { count: 0 };
      if (typeof where.status === 'string' && where.status !== row.status)
        return { count: 0 };
      if (where.shareHash === null && row.shareHash !== null)
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    count: jest.fn(async () => 0),
    create: jest.fn(async ({ data }: any) => ({ ...data, id: 'g2' })),
  };
  const renderDb = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
  const tx = {
    storyGift: db,
    storyVideoRender: renderDb,
    // WP4: segment cache / recordings wiped with the gift.
    storyVideoSegment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const prisma = {
    storyVideoRender: renderDb,
    storyGift: db,
    $transaction: jest.fn(async (fn) => fn(tx)),
  };
  const tts = {
    configured: jest.fn(() => true),
    synthesize: jest.fn(async () => ({
      ok: true,
      audio: Buffer.from('test-mp3'),
      voiceId: STORY_VOICE,
      durationSeconds: 98,
      mimeType: 'audio/mpeg',
      characters: 1800,
    })),
  };
  const stt = {
    configured: jest.fn(() => true),
    transcribe: jest.fn(async () => ({
      text: storyText(),
      language: 'ru',
      billable: true,
      seconds: 98,
    })),
  };
  const plan = { assertCanSpendUser: jest.fn() },
    usage = { record: jest.fn() };
  return {
    service: new StoryGiftsService(
      prisma as any,
      tts as any,
      plan as any,
      usage as any,
      stt as any,
    ),
    row,
    db,
    tts,
    plan,
    usage,
    tx,
    stt,
  };
}
describe('Story‑Tales owner, cost and edition boundaries', () => {
  it('denies another owner before synthesis, audio read or sharing', async () => {
    const s = setup();
    await expect(s.service.render('other', 'g1')).rejects.toThrow('не найдена');
    await expect(s.service.audio('other', 'g1')).rejects.toThrow('не найдена');
    await expect(s.service.share('other', 'g1')).rejects.toThrow('не найдена');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('claims once across concurrent render calls and never changes Nova', async () => {
    const s = setup();
    await Promise.all([
      s.service.render('u1', 'g1'),
      s.service.render('u1', 'g1'),
    ]);
    await s.service.render('u1', 'g1');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(s.tts.synthesize).toHaveBeenCalledWith({
      text: storyText(),
      voiceId: STORY_VOICE,
      language: 'ru',
    });
    expect(s.row.status).toBe('READY');
    expect(s.usage.record).toHaveBeenCalledTimes(1);
  });
  it('keeps provider uncertainty from triggering an automatic billed retry', async () => {
    const s = setup();
    s.tts.synthesize.mockRejectedValueOnce(new Error('timeout'));
    await s.service.render('u1', 'g1');
    await s.service.render('u1', 'g1');
    expect(s.row.status).toBe('UNKNOWN');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
  });
  it('enforces budget before acquiring a paid job', async () => {
    const s = setup();
    s.plan.assertCanSpendUser.mockRejectedValueOnce(new Error('budget'));
    await expect(s.service.render('u1', 'g1')).rejects.toThrow('budget');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
    expect(s.row.status).toBe('DRAFT');
  });
  it('rejects a changed voice rather than silently producing a gift', async () => {
    const s = setup();
    s.tts.synthesize.mockResolvedValueOnce({
      ok: true,
      voiceId: 'wrong',
      audio: Buffer.from('x'),
      durationSeconds: 80,
      mimeType: 'audio/mpeg',
      characters: 1800,
    });
    await s.service.render('u1', 'g1');
    expect(s.row.status).toBe('UNKNOWN');
    expect(s.row.audio).toBeNull();
  });
  it('requires the exact reviewed hash and blocks sharing unapproved audio', async () => {
    const s = setup();
    await s.service.render('u1', 'g1');
    await expect(s.service.approve('u1', 'g1', 'old')).rejects.toThrow();
    await expect(s.service.share('u1', 'g1')).rejects.toThrow();
    await s.service.approve('u1', 'g1', s.row.audioHash!);
    expect(s.row.status).toBe('APPROVED');
    // A link made before the lockdown is still revocable.
    const token = 'a'.repeat(43);
    s.row.shareHash = createHash('sha256').update(token).digest('hex');
    await expect(s.service.publicGift(token)).resolves.toBeTruthy();
    await s.service.withdraw('u1', 'g1');
    await expect(s.service.publicGift(token)).rejects.toThrow();
  });
  it('ST2-R-02: never issues a public link token, even for an approved gift', async () => {
    const s = setup();
    await s.service.render('u1', 'g1');
    await s.service.approve('u1', 'g1', s.row.audioHash!);
    await expect(s.service.share('u1', 'g1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.row.shareHash).toBeNull();
    expect(
      s.db.updateMany.mock.calls.some(([a]: any) => 'shareHash' in a.data),
    ).toBe(false);
  });
  it('bounds creation under the owner transaction and freezes the optional gift note', async () => {
    const s = setup();
    await s.service.create('u1', {
      catalogId: 'little-lantern-ru-v1',
      occasion: 'День рождения',
      giftNoteEnabled: true,
      giftNote: 'Для тебя приготовлен подарок.',
      giftNotePosition: 'beginning',
    });
    expect(
      s.db.create.mock.calls[0][0].data.text.startsWith(
        'Для тебя приготовлен подарок.',
      ),
    ).toBe(true);
    expect(s.tx.$queryRaw).toHaveBeenCalled();
    s.db.count.mockResolvedValueOnce(3);
    await expect(
      s.service.create('u1', { catalogId: 'little-lantern-ru-v1' }),
    ).rejects.toThrow('Пилот');
  });
  it('removes bytes and revokes access when deleting a gift', async () => {
    const s = setup();
    await s.service.remove('u1', 'g1');
    expect(s.row.status).toBe('DELETED');
    expect(s.tx.storyVideoSegment.updateMany).toHaveBeenCalledWith({
      where: { giftId: 'g1' },
      data: expect.objectContaining({ status: 'DELETED', audio: null }),
    });
    expect(s.row.shareHash).toBeNull();
    expect(s.row.audio).toBeNull();
    expect(s.tx.storyVideoRender.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { giftId: 'g1' },
        data: expect.objectContaining({
          video: null,
          preambleAudio: null,
          mainAudio: null,
          voiceId: '',
          voiceLabel: null,
          parentNarrationKey: null,
          assetExpiresAt: null,
          approvedAt: null,
          assetTokenHash: null,
        }),
      }),
    );
    // A-S3-6: serialized with video create / segment claims of this gift.
    expect(String(s.tx.$queryRaw.mock.calls.at(-1)[1])).toBe('story-video:g1');
  });
  it('ST2-S-08: no digest of the personal text survives gift deletion', async () => {
    const s = setup();
    (s.row as any).textHash = 'f'.repeat(64);
    await s.service.remove('u1', 'g1');
    expect((s.row as any).textHash).toBe('');
    const sql = s.tx.$executeRaw.mock.calls.map(
      ([parts, ...values]: any[]) => ({ sql: parts.join('?'), values }),
    );
    // Render configuration hashes and segment cache keys → derived from the row id.
    expect(sql).toEqual([
      {
        sql: expect.stringMatching(
          /UPDATE "story_video_renders" SET "configHash" = 'deleted:' \|\| "id" WHERE "giftId" = \?/,
        ),
        values: ['g1'],
      },
      {
        sql: expect.stringMatching(
          /UPDATE "story_video_segments" SET "cacheKey" = encode\(sha256\(convert_to\('story-deleted:' \|\| "id"/,
        ),
        values: ['g1'],
      },
    ]);
  });
  it('A-S3-5: retention deletion is conditional on the state the cron saw, journal in the same transaction', async () => {
    const s = setup();
    const journal = jest.fn(async () => undefined);
    const raced = await s.service.remove('u1', 'g1', {
      expect: { status: 'FAILED', updatedAt: new Date(0) },
      journal,
    });
    expect(raced).toEqual({ deleted: false, raced: true });
    expect(s.row.status).toBe('DRAFT');
    expect(s.tx.storyVideoRender.updateMany).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    const done = await s.service.remove('u1', 'g1', {
      expect: { status: 'DRAFT', updatedAt: new Date(0) },
      journal,
    });
    expect(done).toEqual({ deleted: true });
    expect(journal).toHaveBeenCalledWith(s.tx);
  });
  it('storyRenderWipe: retention renames the slot and may keep an unsaved narration key', () => {
    expect(storyRenderWipe().parentNarrationKey).toBeNull();
    expect('configHash' in storyRenderWipe()).toBe(false);
    const kept = storyRenderWipe({
      release: { id: 'r1', configHash: 'cfg' },
      keepNarrationKey: true,
    });
    expect(kept).toMatchObject({
      status: 'DELETED',
      configHash: 'cfg:purged:r1',
    });
    expect('parentNarrationKey' in kept).toBe(false);
  });
});

describe('Story server speech QA', () => {
  it('checks the exact audio once without another synthesis', async () => {
    const s = setup();
    await s.service.render('u1', 'g1');
    await s.service.quality('u1', 'g1');
    await s.service.quality('u1', 'g1');
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(s.row.audioQaStatus).toBe('PASS');
    expect(s.tts.synthesize).toHaveBeenCalledTimes(1);
  });
});

describe('Story country and user budget', () => {
  it('accepts a five-dollar budget and freezes the selected classical revision and locale', async () => {
    const s = setup();
    const gift = await s.service.create('u1', {
      catalogId: 'mitten-uk-short-v1',
      giftNotePosition: 'end',
      budgetUsd: 5,
      countryCode: 'UA',
    });
    expect(gift.budgetCents).toBe(500);
    expect(gift.locale).toBe('uk');
    expect(gift.title).toBe('Рукавичка');
    expect(gift.reservedMicroUsd).toBeLessThan(5000000);
  });
});

describe('Short budget edition duration', () => {
  it('accepts a real short narration instead of requiring a long video-sized track', async () => {
    const s = setup();
    s.tts.synthesize.mockResolvedValueOnce({
      ok: true,
      voiceId: STORY_VOICE,
      audio: Buffer.from('short'),
      durationSeconds: 15,
      mimeType: 'audio/mpeg',
      characters: 300,
    });
    await s.service.render('u1', 'g1');
    expect(s.row.status).toBe('READY');
  });
});
