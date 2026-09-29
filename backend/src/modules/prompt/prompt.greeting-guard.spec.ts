/**
 * Этап C ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6 п.4
 * (Г-4): общий `PATCH /sessions/:id/prompt` не правит сессию-поздравление
 * — он развёл бы сцену и озвучку. Правильный путь назван в отказе.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { GREETING_PROMPT_PATCH_REFUSAL, PromptService } from './prompt.service';

function serviceWith(session: Record<string, unknown>) {
  const s = Object.create(PromptService.prototype) as PromptService;
  Object.assign(s, {
    logger: { log: () => undefined, warn: () => undefined },
    sessionService: {
      getSession: async () => session,
      updateSession: jest.fn(),
    },
  });
  return s;
}

describe('PATCH /sessions/:id/prompt для поздравления', () => {
  it('отвечает 400 и называет правильный путь', async () => {
    const s = serviceWith({
      sessionId: 's1',
      greetingBriefSnapshot: { occasion: 'BIRTHDAY' },
      generationPrompt: { finalText: 'x' },
    });
    await expect(s.updatePrompt('s1', 'новый промпт')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(GREETING_PROMPT_PATCH_REFUSAL).toContain('greeting-script');
  });

  it('у товарной сессии отказа нет — проверка только для поздравления', async () => {
    const s = serviceWith({ sessionId: 's1' });
    // Без промпта товарная сессия получает свой прежний отказ, не наш.
    await expect(s.updatePrompt('s1', 'x')).rejects.toThrow(
      /generate a prompt first/,
    );
  });
});
