/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory database mock */
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { StoryGiftsService, storyRenderWipe } from './story-gifts.service';
import { STORY_VOICE, storyText } from './story-catalog';
import { STORY_TERMS_VERSION } from './story-access';
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
  const renderDb = {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    groupBy: jest.fn(async () => []),
    findFirst: jest.fn(async (): Promise<any> => null),
    findMany: jest.fn(async (): Promise<any[]> => []),
  };
  const charges = {
    facts: jest.fn(async () => ({ mode: 'owner', isOwner: true })),
    quote: jest.fn(async () => ({ credits: 0, usdEquivalent: 0, free: false })),
    reserve: jest.fn(async () => ({
      credits: 0,
      usdEquivalent: 0,
      free: false,
    })),
    audioCharges: jest.fn(async () => new Map()),
    refund: jest.fn(async () => ({ refunded: false, credits: 0 })),
    refundQuietly: jest.fn(async () => undefined),
    refundAudio: jest.fn(async () => ({ refunded: false, credits: 0 })),
    autoRefundStale: jest.fn(async () => 0),
    capture: jest.fn(async () => 1),
    captureAudio: jest.fn(async () => 1),
    captureQuietly: jest.fn(async () => undefined),
    captureDelivered: jest.fn(async () => 0),
  };
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
      charges as any,
    ),
    charges,
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
    // ST3-S-14: a delivered audio step is captured.
    expect(s.charges.captureQuietly).toHaveBeenCalledWith({
      audioGiftId: 'g1',
    });
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
    expect(done).toEqual({ deleted: true, creditsRefunded: 0 });
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

describe('ST3 audio credits, public links and retention', () => {
  const original = process.env.STORY_TALES_ACCESS;
  afterEach(() => {
    if (original === undefined) delete process.env.STORY_TALES_ACCESS;
    else process.env.STORY_TALES_ACCESS = original;
  });
  const approved = async () => {
    const s = setup();
    await s.service.render('u1', 'g1');
    await s.service.approve('u1', 'g1', s.row.audioHash!);
    return s;
  };
  it('reserves credits for the audio render in the claim transaction, once', async () => {
    const s = setup();
    await s.service.render('u1', 'g1');
    await s.service.render('u1', 'g1');
    expect(s.charges.reserve).toHaveBeenCalledTimes(1);
    expect(s.charges.reserve).toHaveBeenCalledWith(
      s.tx,
      expect.anything(),
      'u1',
      { kind: 'audio', giftId: 'g1', reserveMicroUsd: 100000 },
      undefined,
    );
  });
  it('402 from the reserve stops before synthesis', async () => {
    const s = setup();
    s.charges.reserve.mockRejectedValueOnce(
      Object.assign(new Error('credits'), { status: 402 }),
    );
    await expect(s.service.render('u1', 'g1')).rejects.toThrow('credits');
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('owner mode: share is 404 and no token is stored', async () => {
    delete process.env.STORY_TALES_ACCESS;
    const s = await approved();
    await expect(s.service.share('u1', 'g1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.row.shareHash).toBeNull();
  });
  it('pilot: issues a 90-day link, stores only its hash; withdraw clears the window', async () => {
    process.env.STORY_TALES_ACCESS = 'pilot';
    const s = await approved();
    const before = Date.now();
    const out = await s.service.share('u1', 'g1');
    const token = /story-gift\/([A-Za-z0-9_-]{43})$/.exec(out.url!)![1];
    expect(s.row.shareHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(out.url).not.toContain(s.row.shareHash!);
    const days = (Date.parse(out.expiresAt!) - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.99);
    expect(days).toBeLessThanOrEqual(90.01);
    await expect(s.service.publicGift(token)).resolves.toBeTruthy();
    expect(s.db.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shareExpiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
    await s.service.withdraw('u1', 'g1');
    expect(s.row).toMatchObject({
      shareHash: null,
      sharedAt: null,
      shareExpiresAt: null,
    });
    await expect(s.service.publicGift(token)).rejects.toThrow();
  });
  it('pilot: an unapproved gift is never shared; another owner gets 404', async () => {
    process.env.STORY_TALES_ACCESS = 'pilot';
    const s = setup();
    await expect(s.service.share('u1', 'g1')).rejects.toThrow('одобрите');
    await expect(s.service.share('other', 'g1')).rejects.toThrow('не найдена');
  });
  it('deletion clears the public link window together with the hash', async () => {
    const s = setup();
    await s.service.remove('u1', 'g1');
    expect(s.row).toMatchObject({
      shareHash: null,
      sharedAt: null,
      shareExpiresAt: null,
    });
  });
  it('the card carries retention and the audio charge', async () => {
    const s = setup();
    (s.row as any).updatedAt = new Date(Date.now() - 20 * 86_400_000);
    s.charges.quote.mockResolvedValueOnce({
      credits: 5,
      usdEquivalent: 3.38,
      free: false,
    });
    const card: any = await s.service.view('u1', 'g1');
    expect(card.retention).toMatchObject({
      basis: 'unfinished',
      warning: true,
    });
    expect(card.charge).toEqual({
      credits: 5,
      usdEquivalent: 3.38,
      free: false,
    });
  });
});

describe('ST3 §11.1: narrator consent to distribution by link', () => {
  const original = process.env.STORY_TALES_ACCESS;
  afterEach(() => {
    if (original === undefined) delete process.env.STORY_TALES_ACCESS;
    else process.env.STORY_TALES_ACCESS = original;
  });
  const approvedWith = async (render: any) => {
    process.env.STORY_TALES_ACCESS = 'pilot';
    const s = setup();
    await s.service.render('u1', 'g1');
    await s.service.approve('u1', 'g1', s.row.audioHash!);
    (s.row as any).updatedAt = new Date();
    const prisma = (s.service as any).prisma;
    prisma.storyVideoRender.findFirst.mockResolvedValue(render);
    return s;
  };
  it.each([
    ['voice clone', { userVoiceId: 'v1', segments: null }],
    [
      'own recorded intro',
      {
        userVoiceId: null,
        segments: { version: 1, segments: [{ source: 'recorded' }] },
      },
    ],
    [
      'narrator image',
      {
        userVoiceId: null,
        segments: { version: 1, segments: [], narrator: { kind: 'look' } },
      },
    ],
  ])(
    '%s: share needs narratorPublicConsent, then records it with the rules version',
    async (_n, render) => {
      const s = await approvedWith(render);
      expect(
        (await s.service.view('u1', 'g1')).narratorPublicConsentRequired,
      ).toBe(true);
      await expect(s.service.share('u1', 'g1')).rejects.toMatchObject({
        response: { code: 'STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED' },
      });
      expect(s.row.shareHash).toBeNull();
      await s.service.share('u1', 'g1', { narratorPublicConsent: true });
      expect(s.row).toMatchObject({
        narratorPublicConsentAt: expect.any(Date),
        narratorPublicConsentVersion: STORY_TERMS_VERSION,
      });
      await s.service.withdraw('u1', 'g1');
      expect(s.row).toMatchObject({
        narratorPublicConsentAt: null,
        narratorPublicConsentVersion: null,
      });
    },
  );
  it('Nova-only release (or audio only): no consent needed', async () => {
    for (const render of [
      null,
      {
        userVoiceId: null,
        segments: { version: 1, segments: [{ source: 'synth' }] },
      },
    ]) {
      const s = await approvedWith(render);
      expect(
        (await s.service.view('u1', 'g1')).narratorPublicConsentRequired,
      ).toBe(false);
      await expect(s.service.share('u1', 'g1')).resolves.toMatchObject({
        url: expect.stringContaining('/story-gift/'),
      });
      expect(s.row).toMatchObject({ narratorPublicConsentAt: null });
    }
  });
});

describe('ST3 audit: audio classification, deletion refunds, confirmed price', () => {
  it('ST3-S-09: a final Resemble 4xx or a skipped call → FAILED + refund, not UNKNOWN', async () => {
    for (const outcome of [
      { ok: false, skipped: false, reason: 'Resemble 400' },
      { ok: false, skipped: false, reason: 'Resemble 422' },
      { ok: false, skipped: true, reason: 'пустой текст озвучки' },
    ]) {
      const s = setup();
      s.tts.synthesize.mockResolvedValueOnce(outcome as any);
      await s.service.render('u1', 'g1');
      expect(s.row.status).toBe('FAILED');
      expect((s.row as any).error).toMatch(/Кредиты возвращены/);
      expect(s.charges.refundAudio).toHaveBeenCalledWith('g1');
    }
  });
  it('ST3-S-09: 5xx, a timeout or a result failing our checks stay UNKNOWN (no refund yet)', async () => {
    for (const fail of [
      (s: ReturnType<typeof setup>) =>
        s.tts.synthesize.mockResolvedValueOnce({
          ok: false,
          skipped: false,
          reason: 'Resemble 503',
        } as any),
      (s: ReturnType<typeof setup>) =>
        s.tts.synthesize.mockRejectedValueOnce(new Error('timeout')),
      (s: ReturnType<typeof setup>) =>
        s.tts.synthesize.mockResolvedValueOnce({
          ok: true,
          audio: Buffer.from('x'),
          voiceId: STORY_VOICE,
          durationSeconds: 3,
          mimeType: 'audio/mpeg',
          characters: 10,
        } as any),
    ]) {
      const s = setup();
      fail(s);
      await s.service.render('u1', 'g1');
      expect(s.row.status).toBe('UNKNOWN');
      expect(s.charges.refundAudio).not.toHaveBeenCalled();
    }
  });
  it('ST3-S-12: the confirmed price goes to the reserve; a mismatch stops before synthesis', async () => {
    const s = setup();
    s.charges.reserve.mockRejectedValueOnce(
      Object.assign(new Error('Цена изменилась'), {
        status: 409,
        response: { code: 'STORY_PRICE_CHANGED' },
      }),
    );
    await expect(
      s.service.render('u1', 'g1', { expectedCredits: 3 }),
    ).rejects.toThrow('Цена изменилась');
    expect(s.charges.reserve).toHaveBeenCalledWith(
      s.tx,
      expect.anything(),
      'u1',
      expect.objectContaining({ kind: 'audio', giftId: 'g1' }),
      3,
    );
    expect(s.tts.synthesize).not.toHaveBeenCalled();
  });
  it('ST3-S-02: deleting a gift in UNKNOWN refunds the audio and unfinished renders, journaled as owner', async () => {
    const s = setup();
    s.row.status = 'UNKNOWN';
    (s.tx as any).storyVideoRender.findMany = jest.fn(async () => [
      { id: 'r-u', status: 'UNKNOWN' },
    ]);
    (s.tx as any).storyOperatorAction = {
      create: jest.fn(async ({ data }: any) => data),
    };
    s.charges.refundAudio.mockResolvedValueOnce({ refunded: true, credits: 5 });
    s.charges.refund.mockResolvedValueOnce({ refunded: true, credits: 7 });
    const out = await s.service.remove('u1', 'g1');
    expect(out).toMatchObject({ deleted: true, creditsRefunded: 12 });
    expect(s.charges.refundAudio).toHaveBeenCalledWith('g1', s.tx);
    expect(s.charges.refund).toHaveBeenCalledWith('video:r-u', s.tx);
    expect(
      (s.tx as any).storyOperatorAction.create.mock.calls.map(([a]: any) => [
        a.data.actorKind,
        a.data.targetType,
        a.data.action,
      ]),
    ).toEqual([
      ['owner', 'gift', 'charge.auto-refund'],
      ['owner', 'render', 'charge.auto-refund'],
    ]);
  });
  it('a delivered gift (READY/APPROVED) is not refunded on deletion — captured', async () => {
    const s = setup();
    s.row.status = 'APPROVED';
    (s.tx as any).storyVideoRender.findMany = jest.fn(async () => [
      { id: 'r-ok', status: 'READY' },
    ]);
    await s.service.remove('u1', 'g1');
    expect(s.charges.refundAudio).not.toHaveBeenCalled();
    expect(s.charges.captureAudio).toHaveBeenCalledWith('g1', s.tx);
    expect(s.charges.capture).toHaveBeenCalledWith('video:r-ok', s.tx);
    expect(s.charges.refund).not.toHaveBeenCalled();
  });
});
