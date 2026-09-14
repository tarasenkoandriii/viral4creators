import { BadRequestException, NotFoundException } from '@nestjs/common';

// Этап 53 (В-6.15): клиент Gemini создаётся с явным ключом, и без него
// конструктор честно бросает — как уже делал AnalysisService. Ключ ставим
// и убираем за собой: process.env общий на весь воркер jest.
const keyBefore = process.env.GEMINI_API_KEY;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
});
import { VideoAuditService } from './video-audit.service';
import type { Session } from '../../common/types/session.types';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

const plansMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertNotBlocked: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertUser: jest.fn().mockResolvedValue(undefined),
  assertSession: jest.fn().mockResolvedValue(undefined),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ videoAudit: { autoIterationsLimit: 3 } }),
}));
const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest
    .fn()
    .mockImplementation(() => ({ models: { generateContent } })),
}));

const baseSession = {
  generationPrompt: {
    promptId: 'p1',
    generatedText: 'orig',
    finalText: 'current prompt',
    characterCount: 14,
    generatedAt: new Date(),
    approvedAt: new Date(),
    moderationStatus: 'approved',
  },
  generatedVideo: {
    generatedVideoId: 'v1',
    pathname: 'sessions/s1/generated.mp4',
    status: 'complete',
  },
} as unknown as Session;

function build(session: Partial<Session> | undefined) {
  let stored: Partial<Session> | undefined = session
    ? { ...session }
    : undefined;
  const sessions = {
    getSession: jest.fn(async () => stored),
    updateSession: jest.fn(async (_id: string, u: Partial<Session>) => {
      stored = { ...stored, ...u };
      return stored;
    }),
    // М-2.5 седьмого аудита: замок на платный вызов — по умолчанию свободен.
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('mp4')),
  };
  const files = {
    uploadAndWaitActive: jest.fn().mockResolvedValue({
      name: 'files/f1',
      uri: 'gs://f1',
      mimeType: 'video/mp4',
    }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VideoAuditService(
    plansMock() as never,
    sessions as never,
    blob as never,
    files as never,
    usageMock() as never,
  );
  return { service, sessions, blob, files, stored: () => stored };
}

beforeEach(() => generateContent.mockReset());

describe('VideoAuditService.run — какой файл смотрит (этап 39, А-2.9)', () => {
  const withPost = {
    ...baseSession,
    generatedVideo: {
      ...baseSession.generatedVideo!,
      postStatus: 'complete',
      postPathname: 'sessions/s1/generated-4x5.mp4',
    },
  } as never;

  it('после постобработки смотрит ГОТОВЫЙ файл, а не исходник Veo', async () => {
    // У исходника другой кадр и, в режимах со своей озвучкой, другая
    // звуковая дорожка — а у аудита есть категория `audio`.
    generateContent.mockResolvedValue({
      text: JSON.stringify({ verdict: 'clean', summary: 'чисто', issues: [] }),
    });
    const { service, blob } = build(withPost);
    await service.run('s1', {});
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'sessions/s1/generated-4x5.mp4',
    );
  });

  it('без постобработки смотрит исходник — он и есть готовый ролик', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({ verdict: 'clean', summary: 'чисто', issues: [] }),
    });
    const { service, blob } = build(baseSession);
    await service.run('s1', {});
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'sessions/s1/generated.mp4',
    );
  });

  it('пока постобработка идёт — просит подождать, а не тратит вызов', async () => {
    const pending = {
      ...baseSession,
      generatedVideo: {
        ...baseSession.generatedVideo!,
        postStatus: 'pending',
      },
    } as never;
    await expect(build(pending).service.run('s1', {})).rejects.toThrow(
      /обрабатывается/,
    );
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('VideoAuditService.run — automatic audit', () => {
  it('refuses without a completed video or a prompt', async () => {
    await expect(build(undefined).service.run('s0', {})).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      build({
        ...baseSession,
        generatedVideo: {
          ...baseSession.generatedVideo!,
          status: 'processing',
        },
      } as never).service.run('s1', {}),
    ).rejects.toThrow(/generate the video first/);
    await expect(
      build({ ...baseSession, generationPrompt: undefined }).service.run(
        's1',
        {},
      ),
    ).rejects.toThrow(/no prompt/);
  });

  it('uploads the generated video to Gemini, parses the brief, stores it newest-first, cleans the file', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'issues',
        summary: 'Есть лишняя рука',
        issues: [
          {
            severity: 'high',
            category: 'anatomy',
            description: 'третья рука',
            timecode: '0:03',
          },
        ],
        promptFix: {
          suggestedText: 'current prompt; exactly two hands',
          rationale: 'ограничил руки',
        },
      }),
    });
    const { service, blob, files } = build(baseSession);
    const state = await service.run('s1', {});

    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'sessions/s1/generated.mp4',
    );
    expect(files.uploadAndWaitActive).toHaveBeenCalledWith(
      expect.any(Buffer),
      'video/mp4',
    );
    const call = generateContent.mock.calls[0][0];
    expect(call.contents[0]).toEqual({
      fileData: { fileUri: 'gs://f1', mimeType: 'video/mp4' },
    });
    expect(call.contents[1].text).toContain('current prompt');
    expect(call.config).toEqual({ responseMimeType: 'application/json' });
    expect(files.deleteFile).toHaveBeenCalledWith('files/f1');

    expect(state.limit).toBe(3);
    expect(state.appliedFixes).toBe(0);
    expect(state.overLimit).toBe(false);
    expect(state.history).toHaveLength(1);
    const a = state.history[0];
    expect(a).toMatchObject({
      generatedVideoId: 'v1',
      source: 'gemini',
      status: 'complete',
      verdict: 'issues',
      summary: 'Есть лишняя рука',
      promptText: 'current prompt',
      promptFix: {
        suggestedText: 'current prompt; exactly two hands',
        rationale: 'ограничил руки',
      },
    });
    expect(a.issues[0]).toMatchObject({
      severity: 'high',
      description: 'третья рука',
      timecode: '0:03',
    });
    expect(a.completedAt).toBeInstanceOf(Date);
  });

  it('a Gemini failure is recorded as a failed audit, not thrown', async () => {
    generateContent.mockRejectedValue(new Error('quota'));
    const { service, files } = build(baseSession);
    const state = await service.run('s1', {});
    expect(state.history[0]).toMatchObject({
      status: 'failed',
      error: 'quota',
      verdict: 'unknown',
    });
    expect(files.deleteFile).toHaveBeenCalled();
  });
});

describe('VideoAuditService.run — user-reported issue (§11.3)', () => {
  it('skips the video call, keeps the user as the detector, takes the fix from the model', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Учёл лишнюю руку',
        promptFix: { suggestedText: 'fixed', rationale: 'r' },
      }),
    });
    const { service, blob, files } = build(baseSession);
    const state = await service.run('s1', { issue: '  третья рука на 0:03 ' });
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
    expect(files.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(generateContent.mock.calls[0][0].contents[0].text).toContain(
      'третья рука на 0:03',
    );
    expect(state.history[0]).toMatchObject({
      source: 'user',
      verdict: 'issues',
      summary: 'Учёл лишнюю руку',
      issues: [
        {
          id: 'a1',
          category: 'user',
          description: 'третья рука на 0:03',
          severity: 'medium',
          timecode: null,
        },
      ],
      promptFix: { suggestedText: 'fixed', rationale: 'r' },
    });
  });
});

describe('VideoAuditService.applyFix', () => {
  const withAudit = {
    ...baseSession,
    videoAudit: {
      appliedFixes: 2,
      history: [
        {
          auditId: 'au1',
          promptFix: { suggestedText: 'suggested text here', rationale: '' },
        },
        { auditId: 'au0', promptFix: null },
      ],
    },
  } as unknown as Session;

  it('404 for an unknown audit, 400 when it has no fix', async () => {
    const { service } = build(withAudit);
    await expect(service.applyFix('s1', { auditId: 'nope' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.applyFix('s1', { auditId: 'au0' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('puts the fix into the prompt draft, resets approval, counts the iteration, flags the soft limit', async () => {
    const { service, sessions } = build(withAudit);
    const r = await service.applyFix('s1', { auditId: 'au1' });
    expect(r.prompt).toMatchObject({
      promptId: 'p1',
      finalText: 'suggested text here',
      userEditedText: 'suggested text here',
      characterCount: 19,
    });
    expect(r.prompt.approvedAt).toBeUndefined();
    expect(r.state.appliedFixes).toBe(3);
    expect(r.state.overLimit).toBe(true);
    expect(sessions.updateSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ generationPrompt: r.prompt }),
    );
  });

  it('prefers the client’s edited text over the suggestion', async () => {
    const { service } = build(withAudit);
    const r = await service.applyFix('s1', {
      auditId: 'au1',
      text: '  my own edited version  ',
    });
    expect(r.prompt.finalText).toBe('my own edited version');
  });
});

// М-2.5 седьмого аудита: замок вокруг платного Gemini-вызова.
describe('VideoAuditService — замки audit / sound-check (М-2.5)', () => {
  it('замок занят — 409 до любого платного вызова', async () => {
    const { service, sessions } = build({
      sessionId: 's1',
      generatedVideo: {
        status: 'complete',
        downloadUrl: 'https://x/v.mp4',
      } as never,
    });
    sessions.claimWork.mockResolvedValueOnce(false);
    await expect(service.run('s1', {} as never)).rejects.toMatchObject({
      status: 409,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('замок берётся видом audit и снимается в finally даже при ошибке', async () => {
    const { service, sessions } = build(undefined);
    await expect(service.run('missing', {} as never)).rejects.toBeDefined();
    expect(sessions.claimWork).toHaveBeenCalledWith(
      'missing',
      'audit',
      expect.any(Number),
    );
    expect(sessions.releaseWork).toHaveBeenCalledWith('missing', 'audit');
  });
});
