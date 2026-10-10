jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { GreetingPromptService } from './greeting-prompt.service';
const SOURCE =
  'Марина, поздравляем с 30-летием! Желаем здоровья, счастья, успехов и радости каждый день.';
function build(output = 'Марина, с 30-летием! Здоровья и счастья!') {
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue({
        greetingBriefSnapshot: {
          occasion: 'BIRTHDAY',
          recipientName: 'Марина',
          tone: 'WARM',
        },
        generationPrompt: {},
      }),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn(),
    updateSession: jest.fn(),
  };
  const plans = { assertCanSpendSession: jest.fn() };
  const usage = { recordGemini: jest.fn() };
  const generate = jest.fn().mockResolvedValue({ text: output });
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const service = new GreetingPromptService(
    sessions as never,
    usage as never,
    plans as never,
    {} as never,
  );
  if (old === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = old;
  Object.assign(service, { genai: { models: { generateContent: generate } } });
  return { service, sessions, plans, usage, generate };
}
describe('shorten script proposal', () => {
  it('предлагает меньший текст, учитывает расход и не меняет сессию', async () => {
    const b = build();
    expect(
      (await b.service.shortenScript('s1', SOURCE)).text.length,
    ).toBeLessThan(SOURCE.length);
    expect(b.sessions.updateSession).not.toHaveBeenCalled();
    expect(b.usage.recordGemini).toHaveBeenCalled();
    expect(b.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });
  it.each(['', 'Марина, с 31-летием!', 'Анна, с 30-летием!', SOURCE])(
    'отклоняет некорректное сокращение: %s',
    async (text) => {
      const b = build(text);
      await expect(b.service.shortenScript('s1', SOURCE)).rejects.toThrow();
      expect(b.sessions.updateSession).not.toHaveBeenCalled();
      expect(b.sessions.releaseWork).toHaveBeenCalled();
    },
  );
  it('не зовёт модель при лимите и конфликте', async () => {
    const b = build();
    b.plans.assertCanSpendSession.mockRejectedValue(new Error('budget'));
    await expect(b.service.shortenScript('s1', SOURCE)).rejects.toThrow(
      'budget',
    );
    expect(b.generate).not.toHaveBeenCalled();
    const c = build();
    c.sessions.claimWork.mockResolvedValue(false);
    await expect(c.service.shortenScript('s1', SOURCE)).rejects.toThrow();
    expect(c.generate).not.toHaveBeenCalled();
    expect(c.sessions.releaseWork).not.toHaveBeenCalled();
  });
  it('обрыв ответа не становится готовым сокращением', async () => {
    const b = build();
    b.generate.mockResolvedValue({
      text: 'Марина, с 30-летием!',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    } as never);
    await expect(b.service.shortenScript('s1', SOURCE)).rejects.toThrow();
  });
  it('ошибка провайдера отпускает замок', async () => {
    const b = build();
    b.generate.mockRejectedValue(new Error('upstream'));
    await expect(b.service.shortenScript('s1', SOURCE)).rejects.toThrow();
    expect(b.sessions.releaseWork).toHaveBeenCalled();
  });
});
