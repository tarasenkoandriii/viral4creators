/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory store */
import {
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
  StoryRetentionService,
} from './story-retention.service';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function setup() {
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
        where.id.in
          .filter((id: string) => id === 'pv')
          .map((id: string) => ({ id })),
      ),
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
    storyOperatorAction: {
      create: jest.fn(async ({ data }: any) => {
        journal.push(data);
        return data;
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
  const service = new StoryRetentionService(prisma, giftsService);
  return {
    service,
    prisma,
    giftsService,
    gifts,
    renders,
    segments,
    settings,
    journal,
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
      previousState: { status: 'READY', cacheKeyPrefix: 'a'.repeat(12) },
    });
    expect(JSON.stringify(journal)).not.toContain('речь удалённого голоса');
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
});
