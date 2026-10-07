/* eslint-disable @typescript-eslint/no-explicit-any -- двойники сервисов */
/**
 * Съёмка кадров страницы поздравлений (этап I ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`, §5.3).
 *
 * Ошибки здесь молчат: кадр снимется, просто не тот — бриф вместо
 * сценария, чужой ролик, второй платный рендер. Поэтому проверяется
 * соответствие «кадр ↔ маршрут ↔ секция», подсказка к пустому кадру 4
 * и то, что кнопка ролика не платит дважды.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../greeting-prompt/greeting-prompt.service', () => ({
  GreetingPromptService: class {},
}));
jest.mock('../greeting-video/greeting-video.service', () => ({
  GreetingVideoService: class {},
}));
jest.mock('../postprod/postprod.service', () => ({
  PostProductionService: class {},
}));
jest.mock('./ui-snapshot-runner.service', () => ({
  UiSnapshotRunnerService: class {},
}));

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  PAID_FIXTURE_VIDEO_ACTIONS,
  FIXTURE_VIDEO_HINT,
  fixtureVideoAction,
  fixtureVideoStage,
  GREETING_FRAME_SHOTS,
  GreetingFramesCaptureService,
} from './greeting-frames-capture.service';
import { CAPTURE_DEVICE_SCALE_FACTOR } from '../tutorial-runner/tutorial-video-assembly';
import { FIXTURE_IDS } from '../tutorial-runner/fixture-seed';

const REPO = path.join(__dirname, '..', '..', '..', '..');

function build() {
  const runner = {
    findFixtureUser: jest.fn().mockResolvedValue({ id: 'usr_fixture' }),
    run: jest.fn(
      async (opts: any): Promise<any> => ({
        total: 1,
        changed: 0,
        failed: 0,
        outcomes: [
          {
            routeKey: opts.routeKeys[0],
            changed: false,
            blobUrl: `https://blob/${opts.locale}/${opts.routeKeys[0]}/${opts.scrollTo}.png`,
          },
        ],
      }),
    ),
  };
  const prisma = {
    session: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiUsage: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prompt = { generateGreetingPrompt: jest.fn().mockResolvedValue({}) };
  const video = {
    startVideo: jest.fn().mockResolvedValue({ status: 'processing' }),
    pollVideo: jest.fn().mockResolvedValue({ status: 'processing' }),
  };
  const postprod = {
    poll: jest.fn(async (_id: string, v: any) => ({
      ...v,
      postStatus: 'complete',
    })),
  };
  const edits = {
    forkForRerender: jest.fn().mockResolvedValue({
      sessionId: 'sess-v2',
      newVersion: true,
      promptKept: true,
    }),
  };
  const service = new GreetingFramesCaptureService(
    runner as any,
    prisma as any,
    prompt as any,
    video as any,
    postprod as any,
    edits as any,
  );
  return { service, runner, prisma, prompt, video, postprod, edits };
}

describe('GREETING_FRAME_SHOTS — что на каком кадре', () => {
  it('четыре кадра по порядку сюжетов §5.2: бриф → характер → сценарий → ролик', () => {
    expect(GREETING_FRAME_SHOTS.map((s) => [s.card, s.routeKey])).toEqual([
      [1, 'greeting-video'],
      [2, 'greeting-video-ready'],
      [3, 'greeting-video-ready'],
      [4, 'greeting-video-done'],
    ]);
  });

  it('число кадров — то же, что ждёт лендинг (GREETING_FRAME_COUNT)', () => {
    const src = readFileSync(
      path.join(REPO, 'landing/src/lib/greeting-frames.ts'),
      'utf8',
    );
    const m = /GREETING_FRAME_COUNT = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(GREETING_FRAME_SHOTS).toHaveLength(Number(m?.[1]));
  });

  it('каждая секция — настоящий data-qa мастера, а не выдуманный', () => {
    // Селектор, которого в мастере нет, прогон честно уронит — но уже
    // на проде, с браузером и фикстурой. Здесь то же ловится даром.
    const dir = path.join(REPO, 'frontend/src/features/projects/greeting');
    const sources = [
      'BriefStep.tsx',
      'CharacterBlock.tsx',
      'ScriptStep.tsx',
      'VideoStep.tsx',
    ]
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    for (const shot of GREETING_FRAME_SHOTS) {
      const qa = /^\[data-qa="([a-z-]+)"\]$/.exec(shot.scrollTo)?.[1];
      expect(qa).toBeDefined();
      expect(sources).toContain(`data-qa="${qa}"`);
    }
  });
});

describe('GreetingFramesCaptureService.capture', () => {
  it('каждый кадр — немаскированный прогон одного маршрута с прокруткой к своей секции', async () => {
    const { service, runner } = build();

    const result = await service.capture({ locales: ['ru'] });

    expect(runner.run).toHaveBeenCalledTimes(4);
    GREETING_FRAME_SHOTS.forEach((shot, i) => {
      expect(runner.run.mock.calls[i][0]).toEqual({
        routeKeys: [shot.routeKey],
        locale: 'ru',
        theme: 'dark',
        unmasked: true,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
        scrollTo: shot.scrollTo,
        alerts: false,
      });
    });
    const cards = result.locales[0].cards;
    expect(Object.keys(cards)).toEqual(['1', '2', '3', '4']);
    expect(cards[3]).toContain('greeting-script-card');
    expect(result.locales[0].problems).toEqual([]);
  });

  it('нет ролика у фикстуры — кадр 4 пуст, и сказано, какую кнопку нажать', async () => {
    const { service, runner } = build();
    runner.run.mockImplementation(async (opts: any) => ({
      total: 1,
      changed: 0,
      failed: opts.routeKeys[0] === 'greeting-video-done' ? 1 : 0,
      outcomes: [
        opts.routeKeys[0] === 'greeting-video-done'
          ? {
              routeKey: 'greeting-video-done',
              changed: false,
              error:
                'для этого маршрута нужны фикстурные данные (greetingDoneProjectId), которых нет',
            }
          : { routeKey: opts.routeKeys[0], changed: false, blobUrl: 'u' },
      ],
    }));

    const result = await service.capture({ locales: ['de'], theme: 'light' });
    const { cards, problems } = result.locales[0];

    expect(cards[4]).toBeUndefined();
    expect(cards[1]).toBe('u');
    expect(problems[0]).toContain('кадр 4');
    expect(problems[0]).toContain(FIXTURE_VIDEO_HINT);
    expect(problems[problems.length - 1]).toBe('не сняты карточки: 4');
  });

  it('прогон пропущен целиком — одна причина, а не четыре одинаковые', async () => {
    const { service, runner } = build();
    runner.run.mockResolvedValue({
      skipped: 'TMA_PUBLIC_URL не настроен',
      total: 0,
      changed: 0,
      failed: 0,
      outcomes: [],
    });

    const result = await service.capture({ locales: ['ru'] });

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(result.locales[0].problems).toEqual([
      'TMA_PUBLIC_URL не настроен',
      'не сняты карточки: 1, 2, 3, 4',
    ]);
  });

  it('фикстурный вход не настроен — съёмка не начинается', async () => {
    const { service, runner } = build();
    runner.findFixtureUser.mockResolvedValue(null);

    const result = await service.capture({ locales: ['ru'] });

    expect(result.skipped).toBeTruthy();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('fixtureVideoAction — ролик фикстуры не оплачивается дважды', () => {
  it.each([
    [{ hasPrompt: true, videoStatus: 'complete' }, 'none'],
    [{ hasPrompt: true, videoStatus: 'processing' }, 'poll'],
    [{ hasPrompt: true, videoStatus: 'pending' }, 'poll'],
    [{ hasPrompt: false, videoStatus: null }, 'script-and-render'],
    [{ hasPrompt: true, videoStatus: null }, 'render'],
    [{ hasPrompt: true, videoStatus: 'failed' }, 'render'],
    // Переснять готовый — только явным флагом.
    // Готовый на месте не перерендеривается (409 ALREADY_READY) — новая
    // версия сессии (CONTRACT6).
    [
      { hasPrompt: true, videoStatus: 'complete', rerender: true },
      'new-version-render',
    ],
    [{ hasPrompt: true, videoStatus: 'processing', rerender: true }, 'poll'],
    // Картинка готова, озвучка ещё кладётся — только опрос постобработки,
    // и `rerender` её не перебивает (оплатили бы обе работы).
    [
      { hasPrompt: true, videoStatus: 'complete', postStatus: 'pending' },
      'poll-post',
    ],
    [
      {
        hasPrompt: true,
        videoStatus: 'complete',
        postStatus: 'pending',
        rerender: true,
      },
      'poll-post',
    ],
    [
      { hasPrompt: true, videoStatus: 'complete', postStatus: 'failed' },
      'none',
    ],
    [
      { hasPrompt: true, videoStatus: 'complete', postStatus: 'skipped' },
      'none',
    ],
  ])('%j → %s', (state, action) => {
    expect(fixtureVideoAction(state)).toBe(action);
  });
});

describe('GreetingFramesCaptureService.fixtureVideo', () => {
  const row = (data: Record<string, unknown>, liveData = {}) => ({
    id: 'sess-done',
    data,
    liveData,
  });

  it('ищет сессию ровно фикстурного проекта «готовый ролик», а не «самую свежую»', async () => {
    const { service, prisma } = build();
    prisma.session.findFirst.mockResolvedValue(
      row({ generationPrompt: {} }, { generatedVideo: { status: 'complete' } }),
    );

    await service.fixtureVideo();

    expect(prisma.session.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'usr_fixture',
      projectId: FIXTURE_IDS.greetingDoneProject,
      deletedAt: null,
    });
  });

  it('ролик готов — ни одного платного вызова', async () => {
    const { service, prisma, prompt, video } = build();
    prisma.session.findFirst.mockResolvedValue(
      row({ generationPrompt: {} }, { generatedVideo: { status: 'complete' } }),
    );

    const result = await service.fixtureVideo();

    expect(result.stage).toBe('complete');
    expect(prompt.generateGreetingPrompt).not.toHaveBeenCalled();
    expect(video.startVideo).not.toHaveBeenCalled();
    expect(video.pollVideo).not.toHaveBeenCalled();
  });

  it('сценария нет — сначала настоящий конвейер сценария, потом рендер', async () => {
    const { service, prisma, prompt, video } = build();
    prisma.session.findFirst.mockResolvedValue(row({}));
    const order: string[] = [];
    prompt.generateGreetingPrompt.mockImplementation(async () => {
      order.push('prompt');
    });
    video.startVideo.mockImplementation(async () => {
      order.push('start');
      return { status: 'processing' };
    });

    const result = await service.fixtureVideo();

    expect(order).toEqual(['prompt', 'start']);
    expect(prompt.generateGreetingPrompt).toHaveBeenCalledWith('sess-done');
    expect(result.stage).toBe('started');
  });

  it('рендер идёт — только опрос', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue(
      row(
        { generationPrompt: {} },
        { generatedVideo: { status: 'processing' } },
      ),
    );
    video.pollVideo.mockResolvedValue({ status: 'complete' });

    const result = await service.fixtureVideo();

    expect(video.startVideo).not.toHaveBeenCalled();
    expect(video.pollVideo).toHaveBeenCalledWith('sess-done');
    expect(result.stage).toBe('complete');
  });

  it('сессии нет — пропуск с подсказкой завести фикстуру, без вызовов', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue(null);

    const result = await service.fixtureVideo();

    expect(result.skipped).toContain('seed-fixture-user');
    expect(video.startVideo).not.toHaveBeenCalled();
  });
});

/**
 * Аудит этапа I: `complete` отдавался сразу после рендера Grok, когда
 * постобработка (своя озвучка) ещё `pending` — оператор слушал ролик
 * без голоса и браковал годный.
 */
describe('fixtureVideoStage — готов только вместе с постобработкой', () => {
  it.each([
    [{ status: 'complete', postStatus: 'pending' }, false, 'post-processing'],
    [{ status: 'complete', postStatus: 'complete' }, false, 'complete'],
    [{ status: 'complete', postStatus: 'failed' }, false, 'complete'],
    [{ status: 'complete', postStatus: 'skipped' }, false, 'complete'],
    [{ status: 'complete' }, false, 'complete'],
    [{ status: 'failed' }, true, 'failed'],
    [{ status: 'processing' }, true, 'started'],
    [{ status: 'processing' }, false, 'rendering'],
  ])('%j (started=%s) → %s', (video, started, stage) => {
    expect(fixtureVideoStage(video as any, started)).toBe(stage);
  });
});

describe('GreetingFramesCaptureService.fixtureVideo — постобработка', () => {
  const pending = {
    id: 'sess-done',
    data: { generationPrompt: {} },
    liveData: { generatedVideo: { status: 'complete', postStatus: 'pending' } },
  };

  it('постобработка идёт — опрос её, без рендера, стадия post-processing', async () => {
    const { service, prisma, video, postprod } = build();
    prisma.session.findFirst.mockResolvedValue(pending);
    postprod.poll.mockImplementation(async (_id: string, v: any) => v);

    const result = await service.fixtureVideo({ rerender: true });

    expect(postprod.poll).toHaveBeenCalledWith(
      'sess-done',
      expect.objectContaining({ postStatus: 'pending' }),
    );
    expect(video.startVideo).not.toHaveBeenCalled();
    expect(result.stage).toBe('post-processing');
  });

  it('постобработка закончилась на этом опросе — complete', async () => {
    const { service, prisma } = build();
    prisma.session.findFirst.mockResolvedValue(pending);

    const result = await service.fixtureVideo();

    expect(result.stage).toBe('complete');
    expect(result.postError).toBeUndefined();
  });

  it('постобработка упала — complete, но причина наружу', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue({
      ...pending,
      liveData: {
        generatedVideo: {
          status: 'complete',
          postStatus: 'failed',
          postError: 'ffmpeg: нет звука',
        },
      },
    });

    const result = await service.fixtureVideo();

    expect(result.stage).toBe('complete');
    expect(result.postError).toBe('ffmpeg: нет звука');
    expect(video.startVideo).not.toHaveBeenCalled();
  });
});

/**
 * CONTRACT6: готовый ролик на месте не перерендеривается — сервер отвечает
 * 409 GREETING_VIDEO_ALREADY_READY. Двойник `startVideo` ведёт себя так
 * же, иначе прежний путь «рендер поверх готового» прошёл бы зелёным.
 */
describe('GreetingFramesCaptureService.fixtureVideo — перерендер готового', () => {
  const done = {
    id: 'sess-done',
    data: { generationPrompt: {} },
    liveData: {
      generatedVideo: { status: 'complete', postStatus: 'complete' },
    },
  };
  const likeServer = (video: any) =>
    video.startVideo.mockImplementation(async (id: string) => {
      if (id === 'sess-done') {
        throw Object.assign(new Error('Ролик уже готов'), {
          code: 'GREETING_VIDEO_ALREADY_READY',
        });
      }
      return { status: 'processing' };
    });

  it('rerender — новая версия с тем же сценарием, рендер её, sessionId новой', async () => {
    const { service, prisma, video, edits, prompt } = build();
    prisma.session.findFirst.mockResolvedValue(done);
    likeServer(video);

    const result = await service.fixtureVideo({ rerender: true });

    expect(edits.forkForRerender).toHaveBeenCalledWith('sess-done');
    expect(video.startVideo).toHaveBeenCalledWith('sess-v2');
    expect(prompt.generateGreetingPrompt).not.toHaveBeenCalled();
    expect(result.sessionId).toBe('sess-v2');
    expect(result.stage).toBe('started');
  });

  it('сценарий не перенёсся (фото не скопировалось) — сначала сборка в новой версии', async () => {
    const { service, prisma, video, edits, prompt } = build();
    prisma.session.findFirst.mockResolvedValue(done);
    likeServer(video);
    edits.forkForRerender.mockResolvedValue({
      sessionId: 'sess-v2',
      newVersion: true,
      promptKept: false,
    });

    await service.fixtureVideo({ rerender: true });

    expect(prompt.generateGreetingPrompt).toHaveBeenCalledWith('sess-v2');
    expect(video.startVideo).toHaveBeenCalledWith('sess-v2');
  });

  it('без rerender готовый не трогается и версия не заводится', async () => {
    const { service, prisma, edits, video } = build();
    prisma.session.findFirst.mockResolvedValue(done);

    await service.fixtureVideo();

    expect(edits.forkForRerender).not.toHaveBeenCalled();
    expect(video.startVideo).not.toHaveBeenCalled();
  });
});

/**
 * Состояние ролика фикстуры для страницы админки (заход 8): только
 * чтение базы. Ошибка здесь стоит денег — страница по `next.paid`
 * решает, спрашивать ли «платно, ~$X», а нажатие без вопроса на
 * платном шаге и есть второй рендер, от которого берегут.
 */
describe('GreetingFramesCaptureService.fixtureVideoState', () => {
  const T0 = new Date('2026-10-01T10:00:00Z');
  function withSessions(
    rows: Array<{ id: string; data: Record<string, unknown> }>,
  ) {
    const h = build();
    h.prisma.session.findMany.mockResolvedValue(
      rows.map((r) => ({ ...r, createdAt: T0, liveData: null })),
    );
    return h;
  }
  const noProviderCalls = (h: ReturnType<typeof build>) => {
    expect(h.video.startVideo).not.toHaveBeenCalled();
    expect(h.video.pollVideo).not.toHaveBeenCalled();
    expect(h.prompt.generateGreetingPrompt).not.toHaveBeenCalled();
    expect(h.postprod.poll).not.toHaveBeenCalled();
    expect(h.edits.forkForRerender).not.toHaveBeenCalled();
  };

  it('платные шаги — ровно сценарий+рендер, рендер и новая версия', () => {
    expect([...PAID_FIXTURE_VIDEO_ACTIONS].sort()).toEqual(
      ['new-version-render', 'render', 'script-and-render'].sort(),
    );
  });

  it('фикстурный вход не настроен — пропуск, в базу не ходит', async () => {
    const h = build();
    h.runner.findFixtureUser.mockResolvedValue(null);
    expect(await h.service.fixtureVideoState()).toEqual({
      skipped: 'фикстурный вход не настроен',
    });
    expect(h.prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('сессии нет — пропуск с подсказкой про пересев', async () => {
    const h = build();
    const r = await h.service.fixtureVideoState();
    expect(r.skipped).toMatch(/seed-fixture-user/);
    noProviderCalls(h);
  });

  it('ролика нет — missing; следующий POST платный (сценарий+рендер); читает ровно проект фикстуры', async () => {
    const h = withSessions([{ id: 's1', data: {} }]);
    const r = await h.service.fixtureVideoState();
    expect(r).toMatchObject({
      sessionId: 's1',
      sessionCreatedAt: T0.toISOString(),
      versions: 1,
      hasPrompt: false,
      stage: 'missing',
      next: { action: 'script-and-render', paid: true },
      rerender: null,
      lastRun: null,
    });
    expect(r.video).toBeUndefined();
    expect(h.prisma.session.findMany.mock.calls[0][0].where).toEqual({
      userId: 'usr_fixture',
      projectId: FIXTURE_IDS.greetingDoneProject,
      deletedAt: null,
    });
    noProviderCalls(h);
  });

  it('рендер идёт — rendering, следующий POST — бесплатный опрос', async () => {
    const h = withSessions([
      {
        id: 's1',
        data: {
          generationPrompt: 'p',
          generatedVideo: { status: 'processing', initiatedAt: T0 },
        },
      },
    ]);
    const r = await h.service.fixtureVideoState();
    expect(r.stage).toBe('rendering');
    expect(r.next).toEqual({ action: 'poll', paid: false });
    expect(r.rerender).toBeNull();
    noProviderCalls(h);
  });

  it('готов — complete, POST ничего не делает, «переснять» платно новой версией; поля ролика наружу', async () => {
    const h = withSessions([
      {
        id: 's2',
        data: {
          generationPrompt: 'p',
          generatedVideo: {
            status: 'complete',
            postStatus: 'complete',
            downloadUrl: 'https://blob/v.mp4',
            initiatedAt: '2026-10-01T10:00:00.000Z',
            completedAt: new Date('2026-10-01T10:03:00Z'),
            resolution: '720p',
          },
        },
      },
      { id: 's1', data: {} },
    ]);
    const r = await h.service.fixtureVideoState();
    expect(r.stage).toBe('complete');
    expect(r.versions).toBe(2);
    expect(r.next).toEqual({ action: 'none', paid: false });
    expect(r.rerender).toEqual({ action: 'new-version-render', paid: true });
    expect(r.video).toEqual({
      status: 'complete',
      postStatus: 'complete',
      postError: null,
      error: null,
      downloadUrl: 'https://blob/v.mp4',
      initiatedAt: '2026-10-01T10:00:00.000Z',
      completedAt: '2026-10-01T10:03:00.000Z',
      resolution: '720p',
    });
    noProviderCalls(h);
  });

  it('постобработка идёт — post-processing, опрос бесплатный, «переснять» недоступно', async () => {
    const h = withSessions([
      {
        id: 's1',
        data: {
          generationPrompt: 'p',
          generatedVideo: { status: 'complete', postStatus: 'pending' },
        },
      },
    ]);
    const r = await h.service.fixtureVideoState();
    expect(r.stage).toBe('post-processing');
    expect(r.next).toEqual({ action: 'poll-post', paid: false });
    expect(r.rerender).toBeNull();
  });

  it('упал — failed, следующий POST — платный повтор рендера, причина наружу', async () => {
    const h = withSessions([
      {
        id: 's1',
        data: {
          generationPrompt: 'p',
          generatedVideo: {
            status: 'failed',
            error: { code: 'X', message: 'провайдер отказал' },
          },
        },
      },
    ]);
    const r = await h.service.fixtureVideoState();
    expect(r.stage).toBe('failed');
    expect(r.next).toEqual({ action: 'render', paid: true });
    expect(r.video?.error).toBe('провайдер отказал');
  });

  it('прошлый прогон: сумма всех операций той версии, где был рендер; без ставки — помечено', async () => {
    const h = withSessions([
      { id: 's2', data: {} },
      { id: 's1', data: {} },
    ]);
    const at = new Date('2026-10-02T00:00:00Z');
    h.prisma.aiUsage.findMany.mockResolvedValue([
      // Новые сверху (orderBy createdAt desc): у s2 рендера не было.
      {
        sessionId: 's2',
        operation: 'prompt',
        costMicroUsd: 5,
        unpriced: false,
        createdAt: at,
      },
      {
        sessionId: 's1',
        operation: 'voiceover',
        costMicroUsd: 300,
        unpriced: true,
        createdAt: at,
      },
      {
        sessionId: 's1',
        operation: 'generation',
        costMicroUsd: 2_100_000,
        unpriced: false,
        createdAt: at,
      },
      {
        sessionId: 's1',
        operation: 'prompt',
        costMicroUsd: 40_000,
        unpriced: false,
        createdAt: at,
      },
    ]);
    const r = await h.service.fixtureVideoState();
    expect(r.lastRun).toEqual({
      sessionId: 's1',
      costMicroUsd: 2_140_300,
      unpriced: true,
      at: at.toISOString(),
    });
    expect(h.prisma.aiUsage.findMany.mock.calls[0][0].where).toEqual({
      sessionId: { in: ['s2', 's1'] },
    });
  });

  it('прошлого рендера в журнале нет — lastRun: null (оценка без числа)', async () => {
    const h = withSessions([{ id: 's1', data: {} }]);
    h.prisma.aiUsage.findMany.mockResolvedValue([
      {
        sessionId: 's1',
        operation: 'prompt',
        costMicroUsd: 5,
        unpriced: false,
        createdAt: T0,
      },
    ]);
    expect((await h.service.fixtureVideoState()).lastRun).toBeNull();
  });
});

/**
 * TOCTOU (аудит захода 8): страница прочла «опросить» (бесплатно), а к
 * моменту POST рендер упал — без `expect` тот же вызов запустил бы
 * платный повтор без вопроса.
 */
describe('GreetingFramesCaptureService.fixtureVideo — ожидаемый шаг (expect)', () => {
  const failed = {
    id: 'sess-done',
    data: { generationPrompt: {} },
    liveData: { generatedVideo: { status: 'failed' } },
  };

  it('ждали опрос, а шаг стал платным — 409, ничего не запущено', async () => {
    const { service, prisma, prompt, video, edits } = build();
    prisma.session.findFirst.mockResolvedValue(failed);

    await expect(
      service.fixtureVideo({ expect: 'poll' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'GREETING_FIXTURE_ACTION_CHANGED' },
    });
    expect(video.startVideo).not.toHaveBeenCalled();
    expect(video.pollVideo).not.toHaveBeenCalled();
    expect(prompt.generateGreetingPrompt).not.toHaveBeenCalled();
    expect(edits.forkForRerender).not.toHaveBeenCalled();
  });

  it('ждали «render», а нужен «сценарий+рендер» (дороже) — тоже 409', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue({
      id: 'sess-done',
      data: {},
      liveData: {},
    });
    await expect(
      service.fixtureVideo({ expect: 'render' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(video.startVideo).not.toHaveBeenCalled();
  });

  it('ожидаемый платный шаг совпал (подтверждён) — выполняется', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue(failed);
    const r = await service.fixtureVideo({ expect: 'render' });
    expect(r.stage).toBe('started');
    expect(video.startVideo).toHaveBeenCalledTimes(1);
  });

  it('ждали опрос, а ролик уже готов — бесплатное расхождение не мешает', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue({
      id: 'sess-done',
      data: { generationPrompt: {} },
      liveData: { generatedVideo: { status: 'complete' } },
    });
    const r = await service.fixtureVideo({ expect: 'poll' });
    expect(r.stage).toBe('complete');
    expect(video.startVideo).not.toHaveBeenCalled();
  });

  it('без expect — как раньше: упавший рендер перезапускается (ручной вызов по документу)', async () => {
    const { service, prisma, video } = build();
    prisma.session.findFirst.mockResolvedValue(failed);
    await service.fixtureVideo();
    expect(video.startVideo).toHaveBeenCalledTimes(1);
  });
});
