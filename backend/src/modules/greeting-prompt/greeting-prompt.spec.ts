/**
 * Запрос к модели на текст сообщения — этап 2, фича №1.
 *
 * Смысл этих тестов ровно один: доказать, что повод влияет на то, ЧТО
 * модель напишет, а не только на подставленное слово. Мутационная
 * проверка этапа показала, что без них выброшенная инструкция повода не
 * роняла ничего — то есть «20 поводов» могли незаметно выродиться в «20
 * меток», против чего и написан весь `greeting-occasions.ts`.
 */
// Цепочка импортов сервиса задевает @prisma/client напрямую (через
// SessionService) — в песочнице клиент не сгенерирован, и модуль упал бы
// при ЗАГРУЗКЕ, не дойдя до теста. Тот же приём, что в
// shared-video.service.spec.ts: подменяем модули заглушками до импорта.
// Проверяемая функция чистая и ни одной из этих зависимостей не
// касается.
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { buildScriptPrompt } from './greeting-prompt.service';
import { GREETING_OCCASIONS } from '../../common/types/greeting.types';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import type { GreetingBriefSnapshot } from '../../common/types/greeting.types';

const brief = (over: Partial<GreetingBriefSnapshot> = {}) =>
  ({
    sourceGreetingBriefId: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-09-22T10:00:00.000Z',
    ...over,
  }) as GreetingBriefSnapshot;

describe('buildScriptPrompt', () => {
  it('инструкция повода уходит в запрос — у каждого повода без исключения', () => {
    for (const occasion of GREETING_OCCASIONS) {
      const prompt = buildScriptPrompt(brief({ occasion }), 'повод');
      expect(prompt).toContain(GREETING_OCCASION_SPECS[occasion].intent);
    }
  });

  it('соболезнование просит не поздравлять, день рождения — поздравить', () => {
    const condolence = buildScriptPrompt(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      'соболезнование',
    );
    expect(condolence).toMatch(/[Нн]е поздравляй/);

    const birthday = buildScriptPrompt(
      brief({ occasion: 'BIRTHDAY' }),
      'день рождения',
    );
    expect(birthday).toMatch(/[Пп]оздравь/);
    expect(birthday).not.toMatch(/[Нн]е поздравляй/);
  });

  /**
   * Просить «поздравление» на повод «соболезнование» — значит толкать
   * модель ровно к той ошибке, которую предотвращает инструкция ниже в
   * том же запросе. Поэтому запрос говорит «сообщение».
   */
  it('сам запрос не называет результат поздравлением', () => {
    const prompt = buildScriptPrompt(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      'соболезнование',
    );
    expect(prompt).not.toMatch(/текст поздравления/);
  });

  it('повод, получатель, отправитель и тон попадают в запрос', () => {
    const prompt = buildScriptPrompt(brief(), 'день рождения');
    expect(prompt).toContain('Повод: день рождения.');
    expect(prompt).toContain('Получатель: Марина.');
    expect(prompt).toContain('От кого: Андрей.');
    expect(prompt).toContain('Тон: тёплый, душевный.');
  });

  it('без отправителя строка «От кого» не появляется пустой', () => {
    const prompt = buildScriptPrompt(brief({ senderName: null }), 'повод');
    expect(prompt).not.toContain('От кого');
  });
});
