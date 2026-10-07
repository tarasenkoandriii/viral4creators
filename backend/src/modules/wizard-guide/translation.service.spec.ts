/**
 * Сохранение перевода — «Тонкая красная линия» §6.7, этап 11.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { TranslationService } from './translation.service';
import { GEMINI_THINKING_HEADROOM } from '../../common/gemini-output';

const SOURCE = {
  symptom: 'Код не приходит',
  cause: null,
  advice: 'нажмите {{clientSiteWizard.liveRestartButton}}',
};

interface UpsertCall {
  where: { experienceId_locale: { experienceId: string; locale: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

const GOOD =
  '{"symptom":"Code kommt nicht","cause":"","advice":"drücken Sie {{clientSiteWizard.liveRestartButton}}"}';

function build(
  over: { text?: string; noKey?: boolean; response?: unknown } = {},
) {
  const prisma = {
    wizardExperienceText: {
      upsert: jest.fn(async (_args: UpsertCall) => ({})),
    },
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const svc = new TranslationService(prisma as never, aiUsage as never);
  const generateContent = jest.fn(
    async (_req: { config: { maxOutputTokens: number } }) =>
      over.response ?? { text: over.text ?? GOOD },
  );
  if (!over.noKey)
    (svc as unknown as { genai: unknown }).genai = {
      models: { generateContent },
    };
  return { svc, prisma, aiUsage, generateContent };
}

describe('TranslationService (§6.7)', () => {
  it('перевод сохраняется как MODEL и непрочитанный', async () => {
    // `reviewed: false` — это очередь оператора, а не запрет показа:
    // текст переведён с проверенного источника и отдаётся сразу.
    const { svc, prisma } = build();
    expect(await svc.translate('e1', 'de', SOURCE)).toBe(true);
    const args = prisma.wizardExperienceText.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ source: 'MODEL', reviewed: false });
    expect(args.where.experienceId_locale).toEqual({
      experienceId: 'e1',
      locale: 'de',
    });
  });

  it('существующий текст не перезаписывается', async () => {
    // Он либо уже переведён, либо написан оператором — затирать его
    // свежим переводом значит потерять ревью.
    const { svc, prisma } = build();
    await svc.translate('e1', 'de', SOURCE);
    expect(prisma.wizardExperienceText.upsert.mock.calls[0][0].update).toEqual(
      {},
    );
  });

  it('перевод, потерявший ключ словаря, не сохраняется', async () => {
    const { svc, prisma } = build({
      text: '{"symptom":"Code kommt nicht","cause":"","advice":"drücken Sie den Knopf"}',
    });
    expect(await svc.translate('e1', 'de', SOURCE)).toBe(false);
    expect(prisma.wizardExperienceText.upsert).not.toHaveBeenCalled();
  });

  it('расход идёт своей операцией, а не подсказочной', async () => {
    // Иначе перевод, случающийся раз за жизнь записи, смешивается с
    // подсказкой, которая случается на каждом шаге у каждого.
    const { svc, aiUsage } = build();
    await svc.translate('e1', 'de', SOURCE);
    expect(aiUsage.recordGemini.mock.calls[0][1]).toMatchObject({
      operation: 'wizard-translate',
      userId: null,
    });
  });

  it('потолок уходит провайдеру с запасом на размышления (600 + 1024)', async () => {
    const { svc, generateContent } = build();
    await svc.translate('e1', 'de', SOURCE);
    expect(generateContent.mock.calls[0][0].config.maxOutputTokens).toBe(
      600 + GEMINI_THINKING_HEADROOM,
    );
  });

  it('перевод оборван по MAX_TOKENS — false, ничего не сохраняется, расход учтён', async () => {
    // Текст сам по себе разбирается и ключ словаря на месте: без проверки
    // обрыва он лёг бы в базу как готовый перевод.
    const { svc, prisma, aiUsage } = build({
      response: {
        text: GOOD,
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { thoughtsTokenCount: 900 },
      },
    });
    expect(await svc.translate('e1', 'de', SOURCE)).toBe(false);
    expect(prisma.wizardExperienceText.upsert).not.toHaveBeenCalled();
    expect(aiUsage.recordGemini).toHaveBeenCalledTimes(1);
  });

  it('без ключа модели молчит, а не падает', async () => {
    const { svc } = build({ noKey: true });
    expect(await svc.translate('e1', 'de', SOURCE)).toBe(false);
  });
});
