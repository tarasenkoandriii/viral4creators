/**
 * Сохранение перевода — «Тонкая красная линия» §6.7, этап 11.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { TranslationService } from './translation.service';

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

function build(over: { text?: string; noKey?: boolean } = {}) {
  const prisma = {
    wizardExperienceText: {
      upsert: jest.fn(async (_args: UpsertCall) => ({})),
    },
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const svc = new TranslationService(prisma as never, aiUsage as never);
  const generateContent = jest.fn(async () => ({
    text:
      over.text ??
      '{"symptom":"Code kommt nicht","cause":"","advice":"drücken Sie {{clientSiteWizard.liveRestartButton}}"}',
  }));
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

  it('без ключа модели молчит, а не падает', async () => {
    const { svc } = build({ noKey: true });
    expect(await svc.translate('e1', 'de', SOURCE)).toBe(false);
  });
});
