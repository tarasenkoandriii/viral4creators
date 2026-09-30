/**
 * Этап G (ТЗ Greeting 2.0 §4.8, Г-6, Г-8): сборка сценария отказывает
 * ДО платного вызова и до замка, если в референсах фото чужого лица без
 * согласия, выбран образ при выключенном режиме или стиль бренд-бука
 * просит чужой образ.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { GreetingPromptService } from './greeting-prompt.service';

const BRIEF = {
  sourceGreetingBriefId: 'gb1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Марина',
  senderName: null,
  tone: 'WARM',
  personalMessage: 'Марина, с днём рождения!',
  requestedPresenterProvider: 'grok',
  resolvedPresenterProvider: 'grok',
  requestedResolution: '720p',
  resolvedResolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  addedAt: '2026-09-30T00:00:00.000Z',
};

function build(sessionOver: Record<string, unknown> = {}) {
  const sessions = {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      greetingBriefSnapshot: BRIEF,
      greetingReferenceImages: [],
      ...sessionOver,
    }),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
    updateSession: jest
      .fn()
      .mockImplementation((_id: string, patch: unknown) =>
        Promise.resolve(patch),
      ),
  };
  const plans = { assertCanSpendSession: jest.fn() };
  const promptService = {
    moderateText: jest.fn(() => ({ status: 'APPROVED', flags: [] })),
  };
  const OLD_KEY = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const service = new GreetingPromptService(
    sessions as never,
    { recordGemini: jest.fn() } as never,
    plans as never,
    promptService as never,
  );
  process.env.GEMINI_API_KEY = OLD_KEY;
  return { service, sessions, promptService };
}

const face = {
  id: 'r1',
  label: 'соседка',
  description: null,
  photoUrl: 'https://blob/r1.jpg',
  photoPathname: 'sessions/s1/greeting-refs/r1/photo.jpg',
  createdAt: '2026-09-30T00:00:00.000Z',
  hasFace: true,
};

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterEach(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

describe('GreetingPromptService — проверки этапа G до замка и денег', () => {
  it('фото с лицом без согласия — 400 с именем фото, замок не берётся', async () => {
    const { service, sessions } = build({ greetingReferenceImages: [face] });
    await expect(service.generateGreetingPrompt('s1')).rejects.toThrow(
      /«соседка»/,
    );
    expect(sessions.claimWork).not.toHaveBeenCalled();
  });

  it('образ-ведущий при выключенном режиме — 400', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, sessions } = build({
      greetingBriefSnapshot: {
        ...BRIEF,
        presenter: {
          lookId: 'l1',
          label: 'Я',
          url: 'https://blob/l1.png',
          pathname: 'x',
          variant: 'photo',
        },
      },
    });
    await expect(service.generateGreetingPrompt('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sessions.claimWork).not.toHaveBeenCalled();
  });

  it('стиль бренд-бука «в образе знаменитости» — отказ, как у текста', async () => {
    const { service, sessions } = build({
      brandManifestSnapshot: { styleNotes: 'в образе Мэрилин Монро' },
    });
    await expect(service.generateGreetingPrompt('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sessions.claimWork).not.toHaveBeenCalled();
  });

  it('с согласием — сценарий собирается, фото в сцене', async () => {
    const { service } = build({
      greetingReferenceImages: [
        { ...face, faceConsentAt: '2026-09-30T00:00:00.000Z' },
      ],
    });
    const prompt = await service.generateGreetingPrompt('s1');
    expect(prompt.finalText).toContain('<IMAGE_1> — соседка');
  });

  it('стиль и сцены бренд-бука сессии доходят до сцены (Г-6)', async () => {
    const { service } = build({
      brandManifestSnapshot: {
        styleNotes: 'пастельные тона',
        scenes: [
          {
            sourceSceneId: 's1',
            label: 'Офис',
            // Фото сцены, прошедшее проверку лица (CONTRACT5 п.10).
            photoUrl:
              'https://blob/brand-manifests/m/scenes/s1/checked-ab12.jpg',
            description: null,
          },
        ],
      },
    });
    const prompt = await service.generateGreetingPrompt('s1');
    expect(prompt.finalText).toContain(
      'Visual style of the brand: пастельные тона.',
    );
    expect(prompt.finalText).toContain('<IMAGE_1> — Офис');
  });
});
