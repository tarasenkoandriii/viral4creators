/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory store */
import {
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
  StoryRetentionService,
} from './story-retention.service';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function setup() {
  // ST3 (ТЗ §11.4): filled by the ST3 tests only.
  const voices: any[] = [];
  const apps: any[] = [];
  const charges: any[] = [];
  const gifts: any[] = [
    {
      id: 'g-draft',
      userId: 'u',
      status: 'DRAFT',
      updatedAt: ago(STORY_RETENTION_STALE_DAYS + 1),
    },
    { id: 'g-unknown', userId: 'u', status: 'UNKNOWN', updatedAt: ago(45) },
    { id: 'g-fresh', userId: 'u', status: 'FAILED', updatedAt: ago(3) },
    {
      id: 'g-old-ready',
      userId: 'u',
      status: 'APPROVED',
      updatedAt: ago(STORY_RETENTION_READY_DAYS + 5),
    },
  ];
  const renders: any[] = [
    {
      id: 'r-old-unknown',
      giftId: 'g-live',
      status: 'UNKNOWN',
      createdAt: ago(40),
      userVoiceId: null,
      configHash: 'cfg-old',
      jobId: null,
      parentNarrationKey: null,
      mainDuration: null,
    },
    {
      id: 'r-revoked',
      giftId: 'g-live',
      status: 'READY',
      createdAt: ago(2),
      userVoiceId: 'gone',
      configHash: 'cfg-revoked',
      jobId: 'job-1',
      parentNarrationKey: 'nk-saved',
      mainDuration: 55,
    },
    {
      id: 'r-kept-voice',
      giftId: 'g-live',
      status: 'READY',
      createdAt: ago(2),
      userVoiceId: 'pv',
      configHash: 'cfg-kept',
      jobId: 'job-2',
      parentNarrationKey: 'nk-kept',
      mainDuration: 55,
    },
  ];
  const segments: any[] = [
    {
      id: 'seg-gone',
      giftId: 'g-live',
      status: 'READY',
      cacheKey: 'a'.repeat(64),
      userVoiceId: 'gone',
      text: 'речь удалённого голоса',
      audio: Buffer.from('mp3'),
    },
    {
      id: 'seg-kept',
      giftId: 'g-live',
      status: 'READY',
      cacheKey: 'b'.repeat(64),
      userVoiceId: 'pv',
      text: 'речь живого голоса',
      audio: Buffer.from('mp3'),
    },
    {
      id: 'seg-nova',
      giftId: 'g-live',
      status: 'READY',
      cacheKey: 'c'.repeat(64),
      userVoiceId: null,
      text: 'Nova',
      audio: Buffer.from('mp3'),
    },
  ];
  const settings: any[] = [
    {
      key: `story-ref:v1:${'a'.repeat(64)}:abcDEF123_-`,
      value: '{"status":"unknown","id":"abcDEF123_-"}',
      updatedAt: ago(31),
    },
    {
      key: `story-ref:v1:${'b'.repeat(64)}:abcDEF123_-`,
      value: '{"status":"complete"}',
      updatedAt: ago(200),
    },
    {
      key: `story-ref:v1:${'c'.repeat(64)}:abcDEF123_-`,
      value: '{"status":"complete"}',
      updatedAt: ago(40),
    },
    {
      key: `story-ref-quota:${'a'.repeat(64)}:2026-01-01:0`,
      value: 'x',
      updatedAt: ago(10),
    },
  ];
  const journal: any[] = [];
  const lt = (v: any, d: Date) => !v?.lt || d < v.lt;
  // Minimal Prisma-like matcher for the voice/status filters used here.
  const ok = (r: any, w: any = {}) =>
    Object.entries(w).every(([k, v]: [string, any]) => {
      if (k === 'gift' || k === 'createdAt') return true;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(r[k]);
        if ('notIn' in v) return !v.notIn.includes(r[k]);
        if ('not' in v) return v.not === null ? r[k] != null : r[k] !== v.not;
        if ('lt' in v) return r[k] < v.lt;
        return true;
      }
      return r[k] === v;
    });
  const distinct = (rows: any[], args: any) =>
    args.distinct
      ? [
          ...new Map(
            rows
              .filter((r) => ok(r, args.where))
              .map((r) => [r.userVoiceId, r]),
          ).values(),
        ].map((r) => ({ userVoiceId: r.userVoiceId }))
      : null;
  const prisma: any = {
    storyGift: {
      findMany: jest.fn(async ({ where }: any) =>
        gifts
          .filter(
            (g) =>
              where.status.in.includes(g.status) &&
              lt(where.updatedAt, g.updatedAt),
          )
          .map((g) => ({ ...g })),
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          gifts.find(
            (g) =>
              g.id === where.id &&
              g.status === where.status &&
              g.updatedAt === where.updatedAt,
          ) ?? null,
      ),
    },
    storyVideoRender: {
      findMany: jest.fn(
        async (args: any) =>
          distinct(renders, args) ??
          renders
            .filter(
              (r) =>
                ok(r, args.where) &&
                (!args.where.createdAt ||
                  r.createdAt < args.where.createdAt.lt),
            )
            .map((r) => ({ ...r })),
      ),
      findFirst: jest.fn(
        async ({ where }: any) => renders.find((r) => ok(r, where)) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = renders.find((r) => ok(r, where));
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    storyVideoSegment: {
      findMany: jest.fn(
        async (args: any) =>
          distinct(segments, args) ??
          segments.filter((r) => ok(r, args.where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = segments.find((r) => ok(r, where));
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    userVoice: {
      findMany: jest.fn(async ({ where }: any) =>
        where.id?.in
          ? where.id.in
              .filter((id: string) => id === 'pv')
              .map((id: string) => ({ id }))
          : voices
              .filter(
                (v) =>
                  (where.status === undefined || v.status === where.status) &&
                  v.personaId === where.personaId &&
                  v.sampleUrl !== where.sampleUrl.not &&
                  v.updatedAt < where.updatedAt.lt,
              )
              .map((v) => ({ ...v })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const v = voices.find(
          (x) =>
            x.id === where.id &&
            x.status === where.status &&
            x.sampleUrl === where.sampleUrl &&
            x.updatedAt === where.updatedAt,
        );
        if (!v) return { count: 0 };
        Object.assign(v, data);
        return { count: 1 };
      }),
    },
    storyPilotApplication: {
      findMany: jest.fn(async ({ where }: any) =>
        typeof where.status === 'string'
          ? apps
              .filter(
                (a) =>
                  a.status === where.status && a.createdAt < where.createdAt.lt,
              )
              .map((a) => ({ id: a.id, createdAt: a.createdAt }))
          : apps
              .filter(
                (a) =>
                  where.status.in.includes(a.status) &&
                  a.scenario !== null &&
                  a.decidedAt < where.decidedAt.lt,
              )
              .map((a) => ({ id: a.id, status: a.status })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = apps.find(
          (x) =>
            x.id === where.id &&
            x.status === where.status &&
            (where.createdAt ? x.createdAt === where.createdAt : x.scenario),
        );
        if (!a) return { count: 0 };
        Object.assign(a, data);
        return { count: 1 };
      }),
    },
    platformSetting: {
      findMany: jest.fn(async ({ where }: any) =>
        settings.filter(
          (s) =>
            s.key.startsWith(where.key.startsWith) &&
            s.updatedAt < where.updatedAt.lt,
        ),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const keys: string[] = where.key.in ?? [where.key];
        let count = 0;
        for (let i = settings.length - 1; i >= 0; i--)
          if (
            keys.includes(settings[i].key) &&
            (where.value === undefined || settings[i].value === where.value)
          ) {
            settings.splice(i, 1);
            count++;
          }
        return { count };
      }),
    },
    storyCreditCharge: {
      findMany: jest.fn(async ({ where }: any) =>
        charges.filter(
          (c) =>
            c.status === where.status &&
            where.OR.some((o: any) =>
              o.kind === 'audio'
                ? c.kind === 'audio' && o.giftId.in.includes(c.giftId)
                : c.kind === 'video' && o.renderId.in.includes(c.renderId),
            ),
        ),
      ),
    },
    storyOperatorAction: {
      create: jest.fn(async ({ data }: any) => {
        journal.push({ createdAt: new Date(), ...data });
        return data;
      }),
      count: jest.fn(
        async ({ where }: any) =>
          journal.filter((j) => j.createdAt < where.createdAt.lt).length,
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = journal.length;
        for (let i = journal.length - 1; i >= 0; i--)
          if (journal[i].createdAt < where.createdAt.lt) journal.splice(i, 1);
        return { count: before - journal.length };
      }),
    },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const giftsService: any = {
    // Same contract as StoryGiftsService.remove: conditional, journal in-tx.
    remove: jest.fn(async (_u: string, id: string, opts: any = {}) => {
      const g = gifts.find((x) => x.id === id);
      if (
        opts.expect &&
        (g.status !== opts.expect.status ||
          g.updatedAt !== opts.expect.updatedAt)
      )
        return { deleted: false, raced: true };
      g.status = 'DELETED';
      if (opts.journal) await opts.journal(prisma);
      return { deleted: true };
    }),
  };
  const blob = { deleteBlob: jest.fn(async () => true) };
  const service = new StoryRetentionService(prisma, giftsService, blob as any);
  return {
    service,
    prisma,
    giftsService,
    gifts,
    renders,
    segments,
    settings,
    journal,
    voices,
    apps,
    charges,
    blob,
  };
}

const ENV = [
  'STORY_RETENTION_PURGE_ENABLED',
  'STORY_RETENTION_READY_PURGE_ENABLED',
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('StoryRetentionService', () => {
  it('по умолчанию dry-run: только счётчики и кандидаты, ничего не удаляется и не журналируется', async () => {
    const { service, giftsService, prisma, journal, settings } = setup();
    const r = await service.run({ withCandidates: true });
    expect(r).toMatchObject({
      dryRun: true,
      readyPurgeEnabled: false,
      staleGifts: 2,
      staleRenders: 1,
      revokedVoiceRenders: 1,
      revokedVoiceSegments: 1,
      staleReferences: 1,
      quotaKeys: 1,
      readyGifts: 1,
      readyReferences: 1,
      purged: 0,
      errors: 0,
    });
    expect(r.candidates).toMatchObject({
      gifts: ['g-draft', 'g-unknown'],
      renders: ['r-old-unknown', 'r-revoked'],
      segments: ['seg-gone'],
      readyGifts: ['g-old-ready'],
    });
    expect(giftsService.remove).not.toHaveBeenCalled();
    expect(prisma.storyVideoRender.updateMany).not.toHaveBeenCalled();
    expect(prisma.platformSetting.deleteMany).not.toHaveBeenCalled();
    expect(journal).toHaveLength(0);
    expect(settings).toHaveLength(4);
  });

  it('явный dryRun сильнее включённого удаления (ручной запуск в debug)', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const { service, giftsService } = setup();
    expect((await service.run({ dryRun: true })).dryRun).toBe(true);
    expect(giftsService.remove).not.toHaveBeenCalled();
  });

  it('реальное удаление класса A: та же очистка, что remove(); готовые — не трогаются без отдельного флага', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = '1';
    const {
      service,
      giftsService,
      gifts,
      renders,
      segments,
      settings,
      journal,
    } = setup();
    const r = await service.run();
    expect(r.dryRun).toBe(false);
    expect(giftsService.remove.mock.calls.map((c: any[]) => c[1])).toEqual([
      'g-draft',
      'g-unknown',
    ]);
    // Conditional on the state the cron saw (A-S3-5).
    expect(giftsService.remove.mock.calls[0][2].expect).toMatchObject({
      status: 'DRAFT',
    });
    expect(gifts.find((g) => g.id === 'g-old-ready').status).toBe('APPROVED');
    expect(gifts.find((g) => g.id === 'g-fresh').status).toBe('FAILED');
    expect(renders.find((x) => x.id === 'r-old-unknown')).toMatchObject({
      status: 'DELETED',
      preambleAudio: null,
      mainAudio: null,
      video: null,
    });
    expect(renders.find((x) => x.id === 'r-revoked')).toMatchObject({
      status: 'DELETED',
      userVoiceId: null,
    });
    expect(renders.find((x) => x.id === 'r-kept-voice').status).toBe('READY');
    // A-S2-3: speech of the deleted clone erased at once; other voices kept.
    expect(segments.find((x) => x.id === 'seg-gone')).toMatchObject({
      status: 'DELETED',
      audio: null,
      text: '',
    });
    expect(segments.find((x) => x.id === 'seg-kept').status).toBe('READY');
    expect(segments.find((x) => x.id === 'seg-nova').status).toBe('READY');
    // unknown-разбор и старый ключ квоты удалены; завершённые разборы — нет.
    expect(settings.map((s) => s.value)).toEqual([
      '{"status":"complete"}',
      '{"status":"complete"}',
    ]);
    expect(r.purged).toBe(7);
    expect(journal).toHaveLength(6);
    expect(journal.find((j) => j.targetType === 'segment')).toMatchObject({
      targetId: 'seg-gone',
      previousState: { status: 'READY' },
    });
    expect(JSON.stringify(journal)).not.toContain('речь удалённого голоса');
    // ST2: no cache-key prefix (digest of the exact text) in new records.
    expect(JSON.stringify(journal)).not.toContain('cacheKeyPrefix');
    expect(
      journal.every(
        (j) => j.actorKind === 'cron' && j.action === 'retention.purge',
      ),
    ).toBe(true);
    expect(journal[0]).toMatchObject({
      targetType: 'gift',
      targetId: 'g-draft',
    });
  });

  it('готовые сказки и разборы старше 180 дней удаляются только с READY-флагом', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    process.env.STORY_RETENTION_READY_PURGE_ENABLED = 'true';
    const { service, gifts, settings } = setup();
    const r = await service.run();
    expect(r.readyPurgeEnabled).toBe(true);
    expect(gifts.find((g) => g.id === 'g-old-ready').status).toBe('DELETED');
    expect(settings).toHaveLength(1); // остался свежий (40 дней) завершённый разбор
  });

  it('READY-флаг без общего флага не включает удаление', async () => {
    process.env.STORY_RETENTION_READY_PURGE_ENABLED = 'true';
    const { service, giftsService } = setup();
    const r = await service.run();
    expect(r).toMatchObject({ dryRun: true, readyPurgeEnabled: false });
    expect(giftsService.remove).not.toHaveBeenCalled();
  });

  it('активность между выборкой и удалением — пропуск (raced); сбой одной записи не останавливает прогон', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const { service, prisma, giftsService } = setup();
    prisma.storyGift.findFirst.mockResolvedValueOnce(null);
    giftsService.remove.mockRejectedValueOnce(new Error('db'));
    const r = await service.run();
    expect(r.raced).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.purged).toBe(5);
  });

  it('A-S3-5: изменение сказки после выборки (условное удаление под замком) — raced, журнал пуст', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const { service, gifts, journal, prisma } = setup();
    const draft = gifts.find((g) => g.id === 'g-draft');
    // The owner edits the draft between the cron's re-check and the delete.
    prisma.storyGift.findFirst.mockImplementationOnce(async () => {
      const row = { id: draft.id };
      draft.updatedAt = new Date();
      return row;
    });
    const r = await service.run();
    expect(draft.status).toBe('DRAFT');
    expect(r.raced).toBe(1);
    expect(journal.some((j) => j.targetId === 'g-draft')).toBe(false);
  });

  it('A-S2-1/A-S2-2: стёртая сборка освобождает слот конфигурации; неподтверждённая основная речь остаётся заблокированной', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const { service, renders, prisma } = setup();
    Object.assign(renders[0], {
      userVoiceId: 'pv',
      parentNarrationKey: 'nk-unsaved',
      mainDuration: null,
    });
    await service.run();
    expect(renders[0]).toMatchObject({
      status: 'DELETED',
      configHash: 'cfg-old:purged:r-old-unknown',
      parentNarrationKey: 'nk-unsaved',
      mainAudio: null,
    });
    // Saved narration of a deleted voice: key released together with the audio.
    expect(renders[1]).toMatchObject({
      status: 'DELETED',
      configHash: 'cfg-revoked:purged:r-revoked',
      parentNarrationKey: null,
    });
    // Under the gift and render locks, conditional on the job id it saw.
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.storyVideoRender.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'r-revoked', jobId: 'job-1' }),
      }),
    );
  });

  it('A-S3-7: сборки удалённых голосов ищутся по мёртвым id в запросе, а не среди первых N', async () => {
    const { service, prisma, renders } = setup();
    for (let i = 0; i < 300; i++)
      renders.unshift({
        id: `r-alive-${i}`,
        giftId: 'g-live',
        status: 'READY',
        createdAt: ago(5),
        userVoiceId: 'pv',
        configHash: `c${i}`,
        jobId: null,
      });
    const r = await service.run({ withCandidates: true });
    expect(r.revokedVoiceRenders).toBe(1);
    expect(r.candidates!.renders).toContain('r-revoked');
    expect(prisma.storyVideoRender.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userVoiceId: { in: ['gone'] } }),
      }),
    );
  });

  it('ST2-S-03: текст UNKNOWN/PENDING-сегментов стирается через 30 дней; ключ остаётся заблокирован', async () => {
    const { service, segments, journal } = setup();
    segments.push(
      {
        id: 'seg-unknown-old',
        giftId: 'g-live',
        source: 'synth',
        status: 'UNKNOWN',
        cacheKey: 'd'.repeat(64),
        userVoiceId: null,
        text: 'Милана, это мама. Я рядом с тобой.',
        audio: null,
        updatedAt: ago(STORY_RETENTION_STALE_DAYS + 1),
      },
      {
        id: 'seg-pending-old',
        giftId: 'g-live',
        source: 'synth',
        status: 'PENDING',
        cacheKey: 'e'.repeat(64),
        userVoiceId: null,
        text: 'Зависшая попытка',
        audio: null,
        updatedAt: ago(40),
      },
      {
        id: 'seg-unknown-fresh',
        giftId: 'g-live',
        source: 'synth',
        status: 'UNKNOWN',
        cacheKey: 'f'.repeat(64),
        userVoiceId: null,
        text: 'Свежая неизвестная попытка',
        audio: null,
        updatedAt: ago(5),
      },
    );
    const dry = await service.run({ withCandidates: true });
    expect(dry.staleSegments).toBe(2);
    expect(dry.candidates!.segments).toEqual(
      expect.arrayContaining(['seg-unknown-old', 'seg-pending-old']),
    );
    expect(segments.find((x) => x.id === 'seg-unknown-old').text).not.toBe('');
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    await service.run();
    for (const id of ['seg-unknown-old', 'seg-pending-old'])
      expect(segments.find((x) => x.id === id)).toMatchObject({
        // Never DELETED: the maybe billed key is not freed for a new purchase.
        status: 'UNKNOWN',
        text: '',
        audio: null,
      });
    expect(segments.find((x) => x.id === 'seg-unknown-fresh').text).toBe(
      'Свежая неизвестная попытка',
    );
    const rows = journal.filter(
      (j) => j.targetType === 'segment' && j.targetId.startsWith('seg-'),
    );
    expect(rows.map((j) => j.targetId)).toEqual(
      expect.arrayContaining(['seg-unknown-old', 'seg-pending-old']),
    );
    expect(
      rows.find((j) => j.targetId === 'seg-unknown-old').previousState,
    ).toMatchObject({ status: 'UNKNOWN', class: 'stale', keyBlocked: true });
    expect(JSON.stringify(journal)).not.toContain('Милана');
    // A second run finds nothing more to erase.
    expect((await service.run()).staleSegments).toBe(0);
  });

  it('ST2-S-03 (p3a): UNKNOWN-сегмент сборки теряет текст вместе с её удалением, даже если ему меньше 30 дней', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const { service, segments, renders, journal } = setup();
    Object.assign(renders[0], {
      segments: {
        version: 1,
        segments: [
          { kind: 'intro', source: 'synth', cacheKey: 'd'.repeat(64) },
          { kind: 'main', source: 'gift', cacheKey: 'e'.repeat(64) },
        ],
      },
    });
    segments.push({
      id: 'seg-of-render',
      giftId: 'g-live',
      source: 'synth',
      status: 'UNKNOWN',
      cacheKey: 'd'.repeat(64),
      userVoiceId: null,
      text: 'Милана, это мама. Я рядом с тобой.',
      audio: null,
      updatedAt: ago(1),
    });
    await service.run();
    expect(renders[0].status).toBe('DELETED');
    expect(segments.find((x) => x.id === 'seg-of-render')).toMatchObject({
      status: 'UNKNOWN',
      text: '',
    });
    expect(
      journal.find((j) => j.targetId === 'seg-of-render').previousState,
    ).toMatchObject({
      class: 'with-render',
      renderId: 'r-old-unknown',
      keyBlocked: true,
    });
    expect(JSON.stringify(journal)).not.toContain('Милана');
  });
});

const VOICES = () => [
  {
    id: 'v-old',
    status: 'READY',
    personaId: null,
    sampleUrl: 'https://x.public.blob.vercel-storage.com/users/u/voice/a.wav',
    updatedAt: ago(8),
  },
  {
    id: 'v-new',
    status: 'READY',
    personaId: null,
    sampleUrl: 'https://x.public.blob.vercel-storage.com/users/u/voice/b.wav',
    updatedAt: ago(6),
  },
  {
    id: 'v-failed',
    status: 'FAILED',
    personaId: null,
    sampleUrl: 'https://x.public.blob.vercel-storage.com/users/u/voice/c.wav',
    updatedAt: ago(30),
  },
  {
    id: 'v-persona',
    status: 'READY',
    personaId: 'p1',
    sampleUrl: 'https://x.public.blob.vercel-storage.com/users/u/voice/d.wav',
    updatedAt: ago(30),
  },
];
const APPS = () => [
  {
    id: 'a-old',
    status: 'rejected',
    scenario: 'Для бабушки',
    decidedAt: ago(91),
  },
  {
    id: 'a-new',
    status: 'approved',
    scenario: 'Для сына',
    decidedAt: ago(10),
  },
  { id: 'a-pending', status: 'pending', scenario: 'Ждёт', decidedAt: null },
];
describe('ST3 retention (ТЗ §11.4): voice samples, pilot scenarios, journal', () => {
  const setup3 = () => {
    const s = setup();
    s.voices.push(...VOICES());
    s.apps.push(...APPS());
    return s;
  };
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('dry-run counts only: nothing deleted', async () => {
    delete process.env.STORY_RETENTION_PURGE_ENABLED;
    const s = setup3();
    s.journal.push({ createdAt: ago(400), action: 'gift.close-failed' });
    const r = await s.service.run({ withCandidates: true });
    expect(r).toMatchObject({
      dryRun: true,
      voiceSamples: 2,
      pilotScenarios: 1,
      journalEntries: 1,
    });
    expect(r.candidates).toMatchObject({
      voiceSamples: ['v-old', 'v-failed'],
      pilotScenarios: ['a-old'],
    });
    expect(s.blob.deleteBlob).not.toHaveBeenCalled();
    expect(s.voices[0].sampleUrl).not.toBe('');
    expect(s.apps[0].scenario).toBe('Для бабушки');
    expect(s.journal).toHaveLength(1);
  });
  it('purge: READY clone sample after 7 days (blob + reference), decided scenario after 90 days, journal over a year', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const s = setup3();
    s.journal.push({ createdAt: ago(400), action: 'gift.close-failed' });
    await s.service.run();
    expect(s.blob.deleteBlob).toHaveBeenCalledWith('users/u/voice/a.wav');
    expect(s.voices.map((v) => [v.id, v.sampleUrl === ''])).toEqual([
      ['v-old', true],
      ['v-new', false],
      // Правила 9.6: an unfinished/failed cloning — 7 days after the last
      // change too (the retry after HTTP 400 is possible only before that).
      ['v-failed', true],
      ['v-persona', false],
    ]);
    expect(s.apps.map((a) => a.scenario)).toEqual([null, 'Для сына', 'Ждёт']);
    expect(s.journal.some((j) => j.action === 'gift.close-failed')).toBe(false);
    expect(s.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorKind: 'cron',
          targetType: 'voice-sample',
          targetId: 'v-old',
          action: 'retention.purge',
        }),
        expect.objectContaining({
          targetType: 'pilot-application',
          targetId: 'a-old',
          previousState: { status: 'rejected' },
        }),
      ]),
    );
    expect(JSON.stringify(s.journal)).not.toMatch(/бабушки|blob/);
  });
  it('a failed blob deletion keeps the reference for the next run', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const s = setup3();
    s.blob.deleteBlob.mockResolvedValueOnce(false);
    const r = await s.service.run();
    expect(s.voices[0].sampleUrl).not.toBe('');
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('ST3 audit: retention holds RESERVED UNKNOWN, expires pending, samples only of Story users', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('ST3-S-02: an UNKNOWN gift/render with RESERVED credits is not purged until the charge closes', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const s = setup();
    s.charges.push(
      {
        kind: 'audio',
        giftId: 'g-unknown',
        renderId: null,
        status: 'RESERVED',
      },
      ...s.renders
        .filter((r: any) => r.status === 'UNKNOWN')
        .map((r: any) => ({
          kind: 'video',
          giftId: r.giftId,
          renderId: r.id,
          status: 'RESERVED',
        })),
    );
    const r = await s.service.run({ withCandidates: true });
    expect(r.candidates!.gifts).not.toContain('g-unknown');
    for (const render of s.renders.filter((x: any) => x.status === 'UNKNOWN'))
      expect(r.candidates!.renders).not.toContain(render.id);
    expect(s.gifts.find((g: any) => g.id === 'g-unknown').status).toBe(
      'UNKNOWN',
    );
    // A refunded charge no longer holds it.
    s.charges.forEach((c: any) => (c.status = 'REFUNDED'));
    const again = await s.service.run({ withCandidates: true, dryRun: true });
    expect(again.candidates!.gifts).toContain('g-unknown');
  });
  it('ST3-S-10: pending older than 90 days → expired, text erased, journaled', async () => {
    process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
    const s = setup();
    s.apps.push(
      {
        id: 'p-old',
        status: 'pending',
        scenario: 'Для внука',
        createdAt: ago(91),
        decidedAt: null,
      },
      {
        id: 'p-new',
        status: 'pending',
        scenario: 'Для дочки',
        createdAt: ago(5),
        decidedAt: null,
      },
    );
    const r = await s.service.run();
    expect(r.pilotExpired).toBe(1);
    expect(s.apps.find((a: any) => a.id === 'p-old')).toMatchObject({
      status: 'expired',
      scenario: null,
      decidedAt: expect.any(Date),
    });
    expect(s.apps.find((a: any) => a.id === 'p-new').status).toBe('pending');
    expect(s.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: 'pilot-application',
          targetId: 'p-old',
          action: 'retention.purge',
        }),
      ]),
    );
  });
  it('ST3-S-05: voice samples only of users who accepted the Story rules, never personas', async () => {
    const s = setup();
    await s.service.run({ dryRun: true });
    const call = s.prisma.userVoice.findMany.mock.calls.find(
      ([a]: any) => a.where.personaId === null,
    );
    // Any status: READY, TRAINING, FAILED (правила 9.6).
    expect(call[0].where.status).toBeUndefined();
    expect(call[0].where).toMatchObject({
      personaId: null,
      user: { storyTermsAcceptances: { some: {} } },
    });
  });
});
