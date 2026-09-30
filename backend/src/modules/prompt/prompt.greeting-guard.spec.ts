/**
 * Этап C ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6 п.4
 * (Г-4): общий `PATCH /sessions/:id/prompt` не правит сессию-поздравление
 * — он развёл бы сцену и озвучку. Правильный путь назван в отказе.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import {
  GREETING_PROMPT_PATCH_REFUSAL,
  PROMPT_MISSING,
  PromptService,
} from './prompt.service';

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
    expect(GREETING_PROMPT_PATCH_REFUSAL).toContain('«Сценарий»');
    // Маршрут API человеку ничего не говорит — в тексте отказа его нет.
    expect(GREETING_PROMPT_PATCH_REFUSAL).not.toMatch(/\/sessions|PATCH/);
  });

  it('у товарной сессии отказа нет — проверка только для поздравления', async () => {
    const s = serviceWith({ sessionId: 's1' });
    // Без промпта товарная сессия получает свой прежний отказ, не наш.
    await expect(s.updatePrompt('s1', 'x')).rejects.toThrow(PROMPT_MISSING);
  });
});

/**
 * CONTRACT6 п.1: общий `approvePrompt` превращал FLAGGED в BYPASSED, а
 * рендер поздравления смотрел только на FLAGGED — помеченный текст уходил
 * в ролик. Для поздравления одобрения нет вовсе.
 */
describe('POST /sessions/:id/prompt/approve для поздравления', () => {
  it('400 с кодом, флаг не превращается в BYPASSED и ничего не пишется', async () => {
    const prompt = { finalText: 'x', moderationStatus: 'flagged' };
    const s = serviceWith({
      sessionId: 's1',
      greetingBriefSnapshot: { occasion: 'BIRTHDAY' },
      generationPrompt: prompt,
    });
    const err = await s.approvePrompt('s1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'GREETING_APPROVE_NOT_SUPPORTED' }),
    );
    expect(err.message).toMatch(/Сценарий/);
    expect(prompt.moderationStatus).toBe('flagged');
    expect(
      (s as unknown as { sessionService: { updateSession: jest.Mock } })
        .sessionService.updateSession,
    ).not.toHaveBeenCalled();
  });

  it('товарная сессия одобряется как раньше: FLAGGED → BYPASSED', async () => {
    const prompt = { finalText: 'x', moderationStatus: 'flagged' };
    const s = serviceWith({ sessionId: 's1', generationPrompt: prompt });
    const out = await s.approvePrompt('s1');
    expect(out.moderationStatus).toBe('bypassed');
  });
});
