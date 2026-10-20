/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory store */
import * as mp4Probe from '../tutorial-runner/mp4-probe';
import { createHash } from 'node:crypto';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import {
  StoryOperatorService,
  storyRenderStage,
} from './story-operator.service';
import { storyVideoTtsReserve } from './story-video-plan';
jest.mock('../../common/external-url-guard', () => ({
  fetchPubliclyRoutable: jest.fn(),
  readBodyWithLimit: jest.fn(),
}));

const HASH = 'a'.repeat(64);
const VIDEO = 'abcDEF123_-';
const REF = `${HASH}${VIDEO}`;
const KEY = `story-ref:v1:${HASH}:${VIDEO}`;
let seq = 0;
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const old = new Date(Date.now() - 2 * 3600_000);
const SEG_KEY = `0123456789ab${'f'.repeat(52)}`;

function matches(
  row: any,
  where: any,
  related: Record<string, any> = {},
): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]): boolean => {
    if (k === 'gift') return matches(related.gift ?? row.gift, v);
    if (k === 'OR') return v.some((w: any) => matches(row, w, related));
    const val = row[k];
    if (v === null) return val == null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(val);
      if ('not' in v) return v.not === null ? val != null : val !== v.not;
      if ('startsWith' in v) return String(val).startsWith(v.startsWith);
      if ('contains' in v) return String(val).includes(v.contains);
      return true;
    }
    return val === v;
  });
}
function table(
  rows: any[],
  related: (r: any) => Record<string, any> = () => ({}),
) {
  return {
    rows,
    findFirst: jest.fn(async ({ where, select }: any) => {
      const r = rows.find((r) => matches(r, where, related(r)));
      if (!r) return null;
      const full = { ...r, ...related(r) };
      // Like Prisma: only selected columns leave the database.
      return select
        ? Object.fromEntries(
            Object.keys(select)
              .filter((k) => select[k])
              .map((k) => [k, full[k]]),
          )
        : full;
    }),
    findMany: jest.fn(async ({ where }: any = {}) =>
      rows.filter((r) => matches(r, where, related(r))).map((r) => ({ ...r })),
    ),
    findUnique: jest.fn(async ({ where }: any) => {
      const r = rows.find((r) =>
        Object.entries(where).every(([k, v]) => r[k] === v),
      );
      return r ? { ...r } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows)
        if (matches(r, where, related(r))) {
          Object.assign(r, data, { updatedAt: new Date() });
          count++;
        }
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--)
        if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    }),
  };
}

function setup() {
  const gifts = [
    {
      id: 'g-unknown',
      userId: 'owner',
      status: 'UNKNOWN',
      audioQaStatus: 'PENDING',
      catalogId: 'turnip-ushinsky-ru-1949-v1',
      reservedMicroUsd: 130000,
      budgetCents: 500,
      error: 'Результат озвучки не подтверждён.',
      text: 'СЕКРЕТНЫЙ ТЕКСТ',
      audio: null,
      giftNote: 'личная реплика',
      createdAt: old,
      updatedAt: old,
    },
    {
      id: 'g-live',
      userId: 'owner',
      status: 'APPROVED',
      audioQaStatus: 'UNKNOWN',
      catalogId: 'turnip-ushinsky-ru-1949-v1',
      reservedMicroUsd: 130000,
      budgetCents: 500,
      error: null,
      text: 'СЕКРЕТНЫЙ ТЕКСТ',
      createdAt: old,
      updatedAt: old,
    },
  ];
  const giftById = (id: string) => gifts.find((g) => g.id === id)!;
  const render = (over: any) => ({
    giftId: 'g-live',
    status: 'UNKNOWN',
    qaStatus: 'PENDING',
    jobId: null,
    preambleDuration: 3,
    durationSeconds: 58.7,
    reservedMicroUsd: 600000,
    userVoiceId: null,
    voiceId: 'a9fc5a41',
    configHash: 'cfg',
    parentNarrationKey: null,
    mainDuration: null,
    preambleText: 'Привет, Маша',
    segments: null,
    error:
      'Сборка не подтверждена на этапе «отправка сборщику». Платный повтор отключён; нужна проверка оператором.',
    createdAt: old,
    updatedAt: old,
    ...over,
  });
  const renders = [
    render({ id: 'r-submit' }),
    render({
      id: 'r-voice',
      configHash: 'cfg-voice',
      preambleDuration: null,
      durationSeconds: null,
      userVoiceId: 'pv',
      parentNarrationKey: 'nk',
      segments: {
        version: 1,
        segments: [
          {
            kind: 'intro',
            source: 'synth',
            cacheKey: SEG_KEY,
            text: 'Привет, Маша',
          },
        ],
      },
      error:
        'Сборка не подтверждена на этапе «озвучка преамбулы». Платный повтор отключён.',
    }),
    render({
      id: 'r-base',
      configHash: 'cfg-base',
      preambleDuration: null,
      durationSeconds: null,
      error: 'Сборка не подтверждена на этапе «проверка базового видео».',
    }),
    render({ id: 'r-job', configHash: 'cfg-job', jobId: 'job-known' }),
    render({
      id: 'r-qa',
      configHash: 'cfg-qa',
      status: 'READY',
      qaStatus: 'UNKNOWN',
    }),
  ];
  const settings = [
    {
      key: KEY,
      value: JSON.stringify({
        id: VIDEO,
        url: 'https://youtube',
        title: 'Чужое название',
        channel: 'Канал',
        status: 'unknown',
        startedAt: old.toISOString(),
        pendingAssessment: '{"broken"',
        error: 'Разбор не подтверждён',
      }),
      updatedAt: old,
    },
    {
      key: `story-ref:v1:${'b'.repeat(64)}:${VIDEO}`,
      value: JSON.stringify({
        id: VIDEO,
        status: 'running',
        startedAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
    },
    {
      key: `story-ref:v1:${'c'.repeat(64)}:${VIDEO}`,
      value: JSON.stringify({
        id: VIDEO,
        status: 'running',
        startedAt: old.toISOString(),
      }),
      updatedAt: old,
    },
    {
      key: `story-ref:v1:${'d'.repeat(64)}:${VIDEO}`,
      value: JSON.stringify({
        id: VIDEO,
        status: 'complete',
        startedAt: old.toISOString(),
      }),
      updatedAt: old,
    },
  ];
  const segment = (over: any) => ({
    giftId: 'g-live',
    source: 'synth',
    status: 'UNKNOWN',
    cacheKey: SEG_KEY,
    text: 'СЕКРЕТНАЯ РЕПЛИКА',
    voiceId: 'pv-clone',
    audio: null,
    audioHash: null,
    durationSeconds: null,
    createdAt: old,
    updatedAt: old,
    ...over,
  });
  const segments = [
    segment({ id: 'seg-unknown' }),
    segment({
      id: 'seg-ready',
      status: 'READY',
      cacheKey: 'a'.repeat(64),
      audio: Buffer.from('mp3'),
      audioHash: 'h',
      durationSeconds: 3,
    }),
    // Сказка уже не живая — сегмент оператору не показывается.
    segment({ id: 'seg-dead-gift', giftId: 'g-unknown' }),
  ];
  const journal: any[] = [];
  const voices = [
    {
      id: 'pv',
      userId: 'owner',
      resembleVoiceId: 'a9fc5a41',
      status: 'READY',
      consentAt: new Date(),
    },
  ];
  const prisma: any = {
    storyGift: table(gifts),
    storyVideoRender: table(renders, (r) => ({ gift: giftById(r.giftId) })),
    platformSetting: table(settings),
    userVoice: table(voices),
    storyVideoSegment: table(segments, (r) => ({ gift: giftById(r.giftId) })),
    storyOperatorAction: {
      rows: journal,
      findUnique: jest.fn(
        async ({ where }: any) =>
          journal.find((j) => j.requestId === where.requestId) ?? null,
      ),
      findMany: jest.fn(async () => [...journal].reverse()),
      create: jest.fn(async ({ data }: any) => {
        if (
          data.requestId &&
          journal.some((j) => j.requestId === data.requestId)
        )
          throw Object.assign(new Error('dup'), { code: 'P2002' });
        const row = {
          id: `j${journal.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        journal.push(row);
        return row;
      }),
    },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const ffmpeg: any = {
    configured: jest.fn(() => true),
    status: jest.fn(),
    submit: jest.fn(),
  };
  const service = new StoryOperatorService(prisma, ffmpeg);
  return {
    service,
    prisma,
    ffmpeg,
    gifts,
    renders,
    settings,
    journal,
    voices,
    segments,
  };
}
const input = (over: any = {}) => ({
  reason: 'Сверено с кабинетом провайдера',
  requestId: rid(),
  ...over,
});
const status = (e: any) => e?.getStatus?.();

afterEach(() => jest.restoreAllMocks());

describe('StoryOperatorService — очередь', () => {
  it('отдаёт только идентификаторы, этап, возраст и резерв — без текста, медиа и владельца', async () => {
    const { service } = setup();
    const q = await service.queue();
    expect(q.gifts.map((g) => [g.id, g.stage])).toEqual([
      ['g-unknown', 'synthesis'],
      ['g-live', 'qa'],
    ]);
    const byId = Object.fromEntries(q.renders.map((r) => [r.id, r]));
    expect(byId['r-submit']).toMatchObject({
      stage: 'submit',
      hasJobId: false,
      submitReached: true,
      voice: 'nova',
      reservedUsd: 0.6,
    });
    expect(byId['r-voice']).toMatchObject({ stage: 'voice', voice: 'parent' });
    expect(byId['r-job']).toMatchObject({ stage: 'poll', hasJobId: true });
    expect(byId['r-qa'].stage).toBe('qa');
    // Свежий running не ждёт оператора; зависший и unknown — ждут.
    expect(q.references.map((r) => r.state).sort()).toEqual([
      'running-stale',
      'unknown',
    ]);
    expect(q.references.find((r) => r.state === 'unknown')).toMatchObject({
      ref: REF,
      videoId: VIDEO,
      hasPendingAssessment: true,
    });
    const json = JSON.stringify(q);
    for (const secret of [
      'СЕКРЕТНЫЙ',
      'личная',
      'Привет, Маша',
      'Чужое название',
      'owner',
      'job-known',
      '"broken"',
      'СЕКРЕТНАЯ РЕПЛИКА',
      SEG_KEY,
    ])
      expect(json).not.toContain(secret);
  });

  it('A-S3-2: этапы реплики о подарке и завершения распознаются', () => {
    for (const [label, stage] of [
      ['озвучка реплики о подарке', 'note'],
      ['озвучка завершения', 'outro'],
    ])
      expect(
        storyRenderStage({
          status: 'UNKNOWN',
          error: `Сборка не подтверждена на этапе «${label}». Платный повтор отключён; нужна проверка оператором.`,
        }),
      ).toBe(stage);
  });

  it('этап сборки определяется по сохранённым полям и системному тексту ошибки', () => {
    expect(
      storyRenderStage({
        status: 'UNKNOWN',
        error: 'Нет сохранённого задания сборщика.',
      }),
    ).toBe('no-job');
    expect(storyRenderStage({ status: 'UNKNOWN', error: null })).toBe(
      'unknown',
    );
    expect(
      storyRenderStage({
        status: 'UNKNOWN',
        error: 'на этапе «озвучка основной сказки»',
      }),
    ).toBe('main');
  });
});

describe('StoryOperatorService — общие правила действия', () => {
  it('пустая/пробельная причина и не-UUID requestId — 400, состояние не меняется', async () => {
    const { service, gifts, journal } = setup();
    for (const bad of [
      input({ reason: '' }),
      input({ reason: '   ' }),
      input({ reason: 'ok' }),
      input({ reason: 'x'.repeat(501) }),
      input({ requestId: 'не-uuid' }),
    ])
      await expect(
        service.closeGift('admin', 'g-unknown', bad),
      ).rejects.toMatchObject({
        status: 400,
      });
    expect(gifts[0].status).toBe('UNKNOWN');
    expect(journal).toHaveLength(0);
  });

  it('повтор с тем же requestId возвращает первый результат, журнал — одна запись', async () => {
    const { service, journal } = setup();
    const req = input();
    const first = await service.closeGift('admin', 'g-unknown', req);
    const again = await service.closeGift('admin', 'g-unknown', req);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, journalId: first.journalId });
    expect(journal).toHaveLength(1);
    // Новый requestId по уже закрытой записи — 409, не второе действие.
    await expect(
      service.closeGift('admin', 'g-unknown', input()),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('requestId от другого действия — 409', async () => {
    const { service } = setup();
    const req = input();
    await service.closeGift('admin', 'g-unknown', req);
    await expect(
      service.resetGiftQa('admin', 'g-live', {
        ...req,
        providerChargeConfirmedAbsent: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('гонка: состояние изменилось между проверкой и записью — 409, журнал пуст', async () => {
    const { service, prisma, gifts, journal } = setup();
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      gifts[0].status = 'FAILED'; // другой оператор успел первым
      return fn(prisma);
    });
    await expect(
      service.closeGift('admin', 'g-unknown', input()),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(journal).toHaveLength(0);
  });

  it('параллельный дубль с тем же requestId (P2002) — отдаётся записанный результат', async () => {
    const { service, prisma, journal } = setup();
    const req = input();
    prisma.$transaction.mockImplementationOnce(async () => {
      journal.push({
        id: 'jx',
        requestId: req.requestId,
        targetType: 'gift',
        targetId: 'g-unknown',
        action: 'gift.close-failed',
        result: { status: 'FAILED' },
        createdAt: new Date(),
      });
      throw Object.assign(new Error('dup'), { code: 'P2002' });
    });
    await expect(
      service.closeGift('admin', 'g-unknown', req),
    ).resolves.toMatchObject({
      replayed: true,
      journalId: 'jx',
    });
  });
});

describe('StoryOperatorService — сказки', () => {
  it('UNKNOWN после синтеза закрывается FAILED с журналом (кто, что, прежнее состояние)', async () => {
    const { service, gifts, journal } = setup();
    await service.closeGift(
      'admin-7',
      'g-unknown',
      input({ reason: '  Таймаут TTS, квитанции нет ' }),
    );
    expect(gifts[0]).toMatchObject({ status: 'FAILED', audio: null });
    expect(journal[0]).toMatchObject({
      actorKind: 'admin',
      actorUserId: 'admin-7',
      targetType: 'gift',
      targetId: 'g-unknown',
      action: 'gift.close-failed',
      reason: 'Таймаут TTS, квитанции нет',
      previousState: expect.objectContaining({
        status: 'UNKNOWN',
        reservedMicroUsd: 130000,
      }),
    });
    expect(JSON.stringify(journal[0])).not.toContain('СЕКРЕТНЫЙ');
  });

  it('возврат в DRAFT — только с подтверждением отсутствия списания', async () => {
    const { service, gifts } = setup();
    await expect(
      service.reopenGift('admin', 'g-unknown', input()),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.reopenGift(
        'admin',
        'g-unknown',
        input({ providerChargeConfirmedAbsent: false }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(gifts[0].status).toBe('UNKNOWN');
    await service.reopenGift(
      'admin',
      'g-unknown',
      input({ providerChargeConfirmedAbsent: true }),
    );
    expect(gifts[0]).toMatchObject({
      status: 'DRAFT',
      error: null,
      audioQaStatus: 'PENDING',
    });
  });

  it('QA UNKNOWN сбрасывается в PENDING только с подтверждением; готовая озвучка не трогается', async () => {
    const { service, gifts } = setup();
    await expect(
      service.resetGiftQa('admin', 'g-live', input()),
    ).rejects.toMatchObject({ status: 400 });
    await service.resetGiftQa(
      'admin',
      'g-live',
      input({ providerChargeConfirmedAbsent: true }),
    );
    expect(gifts[1]).toMatchObject({
      status: 'APPROVED',
      audioQaStatus: 'PENDING',
    });
  });
});

describe('StoryOperatorService — привязка подтверждённого задания', () => {
  const mp4 = () => {
    (fetchPubliclyRoutable as jest.Mock).mockResolvedValue({ ok: true });
    (readBodyWithLimit as jest.Mock).mockResolvedValue(Buffer.alloc(2048, 7));
    return jest.spyOn(mp4Probe, 'probeMp4').mockReturnValue({
      durationSeconds: 58.72,
      tracks: [
        { kind: 'video', width: 1280, height: 720, durationSeconds: 58.72 },
        { kind: 'audio', durationSeconds: 58.7 },
      ],
    } as any);
  };

  it('неверный формат jobId — 400 без обращения к сборщику', async () => {
    const { service, ffmpeg } = setup();
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'x y' })),
    ).rejects.toMatchObject({ status: 400 });
    expect(ffmpeg.status).not.toHaveBeenCalled();
  });

  it('у сборки уже есть jobId или она не дошла до отправки — 409', async () => {
    const { service, ffmpeg } = setup();
    await expect(
      service.bindRenderJob('admin', 'r-job', input({ jobId: 'job-123' })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.bindRenderJob('admin', 'r-base', input({ jobId: 'job-123' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(ffmpeg.status).not.toHaveBeenCalled();
  });

  it('неверный jobId (сборщик не подтвердил) — 409, ничего не изменено', async () => {
    const { service, ffmpeg, renders, journal } = setup();
    ffmpeg.status.mockRejectedValue(new Error('404'));
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-wrong' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(renders[0]).toMatchObject({ status: 'UNKNOWN', jobId: null });
    expect(journal).toHaveLength(0);
  });

  it('задание у сборщика упало — 409 с подсказкой закрыть FAILED', async () => {
    const { service, ffmpeg, renders } = setup();
    ffmpeg.status.mockResolvedValue({ status: 'failed', error: 'boom' });
    const e = await service
      .bindRenderJob('admin', 'r-submit', input({ jobId: 'job-1' }))
      .catch((x) => x);
    expect(status(e)).toBe(409);
    expect(e.message).toContain('FAILED');
    expect(renders[0].jobId).toBeNull();
  });

  it('задание ещё идёт — jobId сохраняется, статус остаётся UNKNOWN для крона', async () => {
    const { service, ffmpeg, renders } = setup();
    ffmpeg.status.mockResolvedValue({ status: 'pending' });
    const res = await service.bindRenderJob(
      'admin',
      'r-submit',
      input({ jobId: 'job-1' }),
    );
    // Without the optional input URL: bound as before, marked unverified.
    expect(res.result).toMatchObject({
      outcome: 'bound-pending',
      inputVerified: false,
    });
    expect(renders[0]).toMatchObject({ status: 'UNKNOWN', jobId: 'job-1' });
  });

  it('успех: результат скачан и проверен той же логикой, READY с хешем; без submit/TTS', async () => {
    const { service, ffmpeg, renders, journal } = setup();
    mp4();
    ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'story.mp4': 'https://files/story.mp4' },
    });
    const res = await service.bindRenderJob(
      'admin',
      'r-submit',
      input({ jobId: 'job-1' }),
    );
    expect(ffmpeg.status).toHaveBeenCalledWith('job-1', 20000);
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    expect(renders[0]).toMatchObject({
      status: 'READY',
      jobId: 'job-1',
      durationSeconds: 58.72,
      error: null,
    });
    expect(renders[0].videoHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.result).toMatchObject({
      outcome: 'ready',
      videoHash: renders[0].videoHash,
    });
    expect(journal[0]).toMatchObject({
      action: 'render.bind-job',
      previousState: expect.objectContaining({
        status: 'UNKNOWN',
        jobId: null,
      }),
    });
  });

  it('чужое или битое видео (длительность/формат) — 409, ничего не изменено', async () => {
    const { service, ffmpeg, renders } = setup();
    mp4().mockReturnValue({
      durationSeconds: 12,
      tracks: [
        { kind: 'video', width: 1280, height: 720, durationSeconds: 12 },
        { kind: 'audio', durationSeconds: 12 },
      ],
    } as any);
    ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'story.mp4': 'https://files/other.mp4' },
    });
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-2' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(renders[0]).toMatchObject({ status: 'UNKNOWN', jobId: null });
  });

  it('задание уже привязано к другой сборке — 409', async () => {
    const { service, ffmpeg } = setup();
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-known' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(ffmpeg.status).not.toHaveBeenCalled();
  });

  it('голос рассказчика отозван — результат не привязывается', async () => {
    const { service, renders, voices, ffmpeg } = setup();
    Object.assign(renders[0], { userVoiceId: 'pv' });
    voices.length = 0;
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-1' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(ffmpeg.status).not.toHaveBeenCalled();
  });

  it('гонка: крон/другой оператор изменил сборку пока шла проверка — 409', async () => {
    const { service, ffmpeg, renders, prisma } = setup();
    mp4();
    ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'story.mp4': 'https://files/story.mp4' },
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      renders[0].status = 'FAILED';
      return fn(prisma);
    });
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-1' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(renders[0].video).toBeUndefined();
  });

  it('A-S3-8: занятость jobId перепроверяется в транзакции под замком задания', async () => {
    const { service, ffmpeg, renders, prisma, journal } = setup();
    ffmpeg.status.mockImplementation(async () => {
      // Another operator binds the same job to another render meanwhile.
      renders[2].jobId = 'job-race';
      return { status: 'pending' };
    });
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-race' })),
    ).rejects.toThrow('уже привязано');
    expect(renders[0].jobId).toBeNull();
    expect(journal).toHaveLength(0);
    expect(
      prisma.$queryRaw.mock.calls.some(
        (c: any[]) => c[1] === 'story-operator:job:job-race',
      ),
    ).toBe(true);
  });

  it('A-S3-8: нарушение уникального jobId в БД (P2002) — 409, а не 500', async () => {
    const { service, ffmpeg, prisma } = setup();
    ffmpeg.status.mockResolvedValue({ status: 'pending' });
    prisma.storyVideoRender.updateMany.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      service.bindRenderJob('admin', 'r-submit', input({ jobId: 'job-7' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('A-S3-9: отпечаток отправки — ссылка на вход задания сверяется с сохранённым хешем токена', async () => {
    const { service, ffmpeg, renders } = setup();
    const token = 'T'.repeat(43);
    renders[0].assetTokenHash = createHash('sha256')
      .update(token)
      .digest('hex');
    ffmpeg.status.mockResolvedValue({ status: 'pending' });
    await expect(
      service.bindRenderJob(
        'admin',
        'r-submit',
        input({ jobId: 'job-1', renderInputUrl: 'https://x/y' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.bindRenderJob(
        'admin',
        'r-submit',
        input({
          jobId: 'job-1',
          renderInputUrl: `https://api.test/api/story-render-input/${'U'.repeat(43)}/main`,
        }),
      ),
    ).rejects.toThrow('другой сборке');
    expect(ffmpeg.status).not.toHaveBeenCalled();
    const res = await service.bindRenderJob(
      'admin',
      'r-submit',
      input({
        jobId: 'job-1',
        renderInputUrl: `https://api.test/api/story-render-input/${token}/main`,
      }),
    );
    expect(res.result).toMatchObject({
      outcome: 'bound-pending',
      inputVerified: true,
    });
  });
});

describe('StoryOperatorService — закрытие сборки', () => {
  it('releaseReserve обязателен явно', async () => {
    const { service } = setup();
    await expect(
      service.closeRender('admin', 'r-submit', input() as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('без освобождения: FAILED, резерв сохранён, слот конфигурации освобождён', async () => {
    const { service, renders } = setup();
    const req = input({ releaseReserve: false });
    await service.closeRender('admin', 'r-submit', req);
    expect(renders[0]).toMatchObject({
      status: 'FAILED',
      reservedMicroUsd: 600000,
      configHash: `cfg:closed:${req.requestId}`,
      assetTokenHash: null,
    });
    expect(renders[0].error).toContain('Резерв бюджета этой попытки сохранён');
  });

  it('освобождение после платного этапа — только с подтверждением отсутствия списания', async () => {
    const { service, renders } = setup();
    await expect(
      service.closeRender('admin', 'r-voice', input({ releaseReserve: true })),
    ).rejects.toMatchObject({ status: 400 });
    expect(renders[1].status).toBe('UNKNOWN');
    const res = await service.closeRender(
      'admin',
      'r-voice',
      input({ releaseReserve: true, providerChargeConfirmedAbsent: true }),
    );
    expect(renders[1]).toMatchObject({
      status: 'FAILED',
      reservedMicroUsd: 0,
      // Без сохранённой основной речи ключ сброшен — иначе новый родительский рендер заблокирован навсегда.
      parentNarrationKey: null,
    });
    expect(res.result).toMatchObject({ releasedUsd: 0.6, stage: 'voice' });
  });

  it('ST2-S-01: releaseReserve оставляет резерв речи, синтезированной и сохранённой этой сборкой', async () => {
    const { service, renders } = setup();
    // p1: main + intro TTS confirmed and saved (745 chars), lost at submit.
    Object.assign(renders[0], { paidSpeechChars: 745 });
    const kept = storyVideoTtsReserve(745);
    expect(kept).toBeGreaterThan(0);
    const res = await service.closeRender(
      'admin',
      'r-submit',
      input({ releaseReserve: true, providerChargeConfirmedAbsent: true }),
    );
    expect(renders[0]).toMatchObject({
      status: 'FAILED',
      reservedMicroUsd: kept,
    });
    expect(res.result).toMatchObject({
      releasedUsd: (600000 - kept) / 1e6,
      keptUsd: kept / 1e6,
    });
    expect(renders[0].error).toContain('Резерв сохранённой речи');
    // Never more than the render reserved.
    Object.assign(renders[1], { paidSpeechChars: 10_000_000 });
    await service.closeRender(
      'admin',
      'r-voice',
      input({ releaseReserve: true, providerChargeConfirmedAbsent: true }),
    );
    expect(renders[1].reservedMicroUsd).toBe(600000);
  });

  it('до проверки базового видео платных вызовов не было — резерв освобождается без подтверждения', async () => {
    const { service, renders } = setup();
    await service.closeRender(
      'admin',
      'r-base',
      input({ releaseReserve: true }),
    );
    expect(renders[2]).toMatchObject({ status: 'FAILED', reservedMicroUsd: 0 });
  });

  it('A-S2-1: без подтверждения отсутствия списания ключ неподтверждённой основной речи остаётся (блок), с подтверждением — освобождается', async () => {
    const { service, renders } = setup();
    const res = await service.closeRender(
      'admin',
      'r-voice',
      input({ releaseReserve: false }),
    );
    expect(renders[1]).toMatchObject({
      status: 'FAILED',
      parentNarrationKey: 'nk',
    });
    expect(res.result).toMatchObject({ narrationKey: 'blocked' });
    expect(renders[1].error).toContain('повторно не покупается');
    // Stage base: nothing paid could have run — the key is released.
    Object.assign(renders[2], { parentNarrationKey: 'nk-base' });
    const base = await service.closeRender(
      'admin',
      'r-base',
      input({ releaseReserve: false }),
    );
    expect(renders[2].parentNarrationKey).toBeNull();
    expect(base.result).toMatchObject({ narrationKey: 'released' });
  });

  it('сохранённая основная речь родителя не теряет ключ переиспользования', async () => {
    const { service, renders } = setup();
    Object.assign(renders[1], { mainDuration: 55 });
    await service.closeRender(
      'admin',
      'r-voice',
      input({ releaseReserve: false }),
    );
    expect(renders[1].parentNarrationKey).toBe('nk');
  });

  it('QA видео UNKNOWN → PENDING только с подтверждением', async () => {
    const { service, renders } = setup();
    await expect(
      service.resetRenderQa('admin', 'r-qa', input()),
    ).rejects.toMatchObject({ status: 400 });
    await service.resetRenderQa(
      'admin',
      'r-qa',
      input({ providerChargeConfirmedAbsent: true }),
    );
    expect(renders[4]).toMatchObject({ status: 'READY', qaStatus: 'PENDING' });
  });
});

describe('StoryOperatorService — референсы', () => {
  it('неверный идентификатор — 400', async () => {
    const { service } = setup();
    await expect(
      service.closeReference('admin', 'bad', input()),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('unknown закрывается как unavailable: кандидат ответа удалён, без нового вызова', async () => {
    const { service, settings, journal } = setup();
    await service.closeReference('admin', REF, input());
    const rec = JSON.parse(settings[0].value);
    expect(rec).toMatchObject({ status: 'unavailable', id: VIDEO });
    expect(rec.pendingAssessment).toBeUndefined();
    expect(journal[0]).toMatchObject({
      targetType: 'reference',
      targetId: REF,
      previousState: expect.objectContaining({
        state: 'unknown',
        hasPendingAssessment: true,
      }),
    });
    expect(JSON.stringify(journal[0])).not.toContain('Чужое название');
  });

  it('unknown удаляется; завершённый разбор оператором не удаляется (409)', async () => {
    const { service, settings } = setup();
    await service.deleteReference('admin', REF, input());
    expect(settings.find((s) => s.key === KEY)).toBeUndefined();
    await expect(
      service.deleteReference('admin', `${'d'.repeat(64)}${VIDEO}`, input()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('гонка: запись изменена владельцем между чтением и записью — 409', async () => {
    const { service, settings, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      settings[0].value = settings[0].value.replace('"unknown"', '"running"');
      return fn(prisma);
    });
    await expect(
      service.closeReference('admin', REF, input()),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('StoryOperatorService — сегменты речи видео (WP4)', () => {
  it('очередь: UNKNOWN-сегменты живых сказок — id, вид, источник, возраст, короткий id; без ключа, текста и аудио', async () => {
    const { service } = setup();
    const q = await service.queue();
    expect(q.segments).toEqual([
      {
        id: 'seg-unknown',
        giftId: 'g-live',
        renderId: 'r-voice',
        kind: 'intro',
        source: 'synth',
        shortId: 'seg-unkn',
        ageHours: 2,
        idleHours: 2,
      },
    ]);
  });

  it('закрытие без providerChargeConfirmedAbsent: true — 400, сегмент остаётся UNKNOWN', async () => {
    const { service, segments, journal } = setup();
    for (const flag of [undefined, false])
      await expect(
        service.closeSegment(
          'admin',
          'seg-unknown',
          input({ providerChargeConfirmedAbsent: flag }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    expect(segments[0].status).toBe('UNKNOWN');
    expect(journal).toHaveLength(0);
  });

  it('UNKNOWN → DELETED освобождает ключ кэша; журнал без текста; повтор requestId идемпотентен', async () => {
    const { service, segments, journal, prisma } = setup();
    const req = input({ providerChargeConfirmedAbsent: true });
    const first = await service.closeSegment('admin-3', 'seg-unknown', req);
    expect(segments[0]).toMatchObject({
      status: 'DELETED',
      text: '',
      audio: null,
      audioHash: null,
      cacheKey: SEG_KEY,
    });
    expect(journal[0]).toMatchObject({
      actorUserId: 'admin-3',
      targetType: 'segment',
      targetId: 'seg-unknown',
      action: 'segment.close-deleted',
      previousState: expect.objectContaining({
        status: 'UNKNOWN',
        source: 'synth',
        giftId: 'g-live',
      }),
      result: expect.objectContaining({
        status: 'DELETED',
        cacheReleased: true,
      }),
    });
    const text = JSON.stringify(journal[0]);
    expect(text).not.toContain('СЕКРЕТНАЯ');
    expect(text).not.toContain(SEG_KEY);
    // ST2: no key prefix (a digest of the exact text) in the journal.
    expect(text).not.toContain('cacheKeyPrefix');
    expect(text).not.toContain(SEG_KEY.slice(0, 12));
    const again = await service.closeSegment('admin-3', 'seg-unknown', req);
    expect(again).toMatchObject({ replayed: true, journalId: first.journalId });
    expect(journal).toHaveLength(1);
    // Ни синтеза, ни сборки: оператор только освобождает ключ.
    expect(prisma.storyVideoRender.updateMany).not.toHaveBeenCalled();
  });

  it('готовый сегмент оператором не закрывается (409); гонка с владельцем — 409', async () => {
    const { service, segments, prisma, journal } = setup();
    await expect(
      service.closeSegment(
        'admin',
        'seg-ready',
        input({ providerChargeConfirmedAbsent: true }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      segments[0].status = 'DELETED';
      return fn(prisma);
    });
    await expect(
      service.closeSegment(
        'admin',
        'seg-unknown',
        input({ providerChargeConfirmedAbsent: true }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(journal).toHaveLength(0);
  });
});
