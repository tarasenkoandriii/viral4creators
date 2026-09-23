/**
 * Сведение дублей, сторона базы — «Тонкая красная линия» §6.4, §10.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { SiblingsService } from './siblings.service';
import {
  DEFAULT_SIBLING_AUTO,
  SIBLING_AUTO_KEY,
  SIBLING_SUGGEST_KEY,
} from './guide-settings';

interface UpdateCall {
  where: { id: string };
  data: Record<string, unknown>;
}

function build(
  over: {
    candidate?: Record<string, unknown> | null;
    subjects?: Array<{
      id: string;
      texts: Array<{ symptom: string; locale: string }>;
    }>;
    text?: string;
    settings?: Record<string, string>;
    throws?: boolean;
    noKey?: boolean;
    spentToday?: number;
    globalOn?: boolean;
  } = {},
) {
  const prisma = {
    wizardExperienceCandidate: {
      findUnique: jest.fn().mockResolvedValue(
        over.candidate === undefined
          ? {
              id: 'c1',
              scenario: 'CLIENT_SITE',
              stepId: 'record',
              rawText: 'код не приходит',
              status: 'NEW',
            }
          : over.candidate,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async (_args: UpdateCall) => ({})),
    },
    wizardExperience: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          over.subjects ?? [
            { id: 'e1', texts: [{ symptom: 'код не приходит', locale: 'ru' }] },
          ],
        ),
      update: jest.fn(async (_args: UpdateCall) => ({})),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const settings = {
    get: jest.fn(async (key: string) => over.settings?.[key] ?? null),
  };
  const aiUsage = {
    recordGemini: jest.fn().mockResolvedValue(undefined),
    spentTodayForOperation: jest.fn().mockResolvedValue(over.spentToday ?? 0),
  };
  const guide = {
    available: jest.fn().mockResolvedValue(over.globalOn ?? true),
  };
  const svc = new SiblingsService(
    prisma as never,
    settings as never,
    aiUsage as never,
    guide as never,
  );
  const generateContent = jest.fn(async () => {
    if (over.throws) throw new Error('провайдер лёг');
    return {
      text: over.text ?? '{"matchedId":"e1","score":0.9,"why":"то же самое"}',
    };
  });
  if (!over.noKey)
    (svc as unknown as { genai: unknown }).genai = {
      models: { generateContent },
    };
  return { svc, prisma, settings, aiUsage, guide, generateContent };
}

describe('SiblingsService (§6.4)', () => {
  it('выше верхнего порога сводит сам и поднимает счётчик', async () => {
    const { svc, prisma } = build();
    const v = await svc.classify('c1');
    expect(v?.decision).toBe('AUTO');
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(prisma.wizardExperience.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { occurrences: { increment: 1 } },
    });
  });

  it('между порогами оставляет кандидата в очереди с процентом', async () => {
    const { svc, prisma } = build({
      text: '{"matchedId":"e1","score":0.6,"why":"похоже"}',
    });
    const v = await svc.classify('c1');
    expect(v?.decision).toBe('OPERATOR');
    const data = prisma.wizardExperienceCandidate.update.mock.calls[0][0].data;
    expect(data.matchScore).toBe(0.6);
    expect(data.matchedId).toBe('e1');
    expect(data.status).toBeUndefined();
    expect(data.why).toBe('похоже');
  });

  it('процент сохраняется даже когда совпадений нет', async () => {
    // По распределению потом двигают порог — и отвергнутое решение для
    // этого ценнее принятого.
    const { svc, prisma } = build({
      text: '{"matchedId":"e1","score":0.2,"why":"другое"}',
    });
    await svc.classify('c1');
    const data = prisma.wizardExperienceCandidate.update.mock.calls[0][0].data;
    expect(data.matchScore).toBe(0.2);
    expect(data.matchedId).toBeNull();
    expect(data.decision).toBe('NONE');
  });

  it('сравнение идёт только внутри своего шага', async () => {
    const { svc, prisma } = build();
    await svc.classify('c1');
    expect(
      prisma.wizardExperience.findMany.mock.calls[0][0].where,
    ).toMatchObject({ scenario: 'CLIENT_SITE', stepId: 'record' });
  });

  it('сравнивать не с чем — модель не зовётся', async () => {
    // Это не «нет совпадений по мнению модели», а отсутствие вопроса.
    const { svc, generateContent } = build({ subjects: [] });
    expect(await svc.classify('c1')).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('уже разобранный кандидат второй раз не сводится', async () => {
    const { svc, generateContent } = build({
      candidate: {
        id: 'c1',
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        rawText: 'x',
        status: 'MERGED',
      },
    });
    expect(await svc.classify('c1')).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('отказ модели оставляет кандидата оператору', async () => {
    // Потерянный разбор дешевле ложного сведения.
    const { svc, prisma } = build({ throws: true });
    expect(await svc.classify('c1')).toBeNull();
    expect(prisma.wizardExperienceCandidate.update).not.toHaveBeenCalled();
  });

  it('расход записывается своей операцией', async () => {
    // Прятать его в `wizard-hint` нельзя: это разные фичи с разной
    // экономикой, и в отчёте должно быть видно, сколько стоит разбор
    // входящих сигналов.
    const { svc, aiUsage } = build();
    await svc.classify('c1');
    expect(aiUsage.recordGemini.mock.calls[0][1]).toMatchObject({
      operation: 'wizard-sibling',
    });
  });

  it('пороги читаются из настроек, мусор даёт умолчание', async () => {
    const { svc } = build({
      settings: { [SIBLING_AUTO_KEY]: '7', [SIBLING_SUGGEST_KEY]: '0.3' },
    });
    expect(await svc.thresholds()).toEqual({
      auto: DEFAULT_SIBLING_AUTO,
      suggest: 0.3,
    });
  });

  it('гистограмма раскладывает решения по десяткам', async () => {
    const { svc, prisma } = build();
    prisma.wizardExperienceCandidate.findMany.mockResolvedValue([
      { matchScore: 0.92, decision: 'AUTO' },
      { matchScore: 0.9, decision: 'AUTO' },
      { matchScore: 0.55, decision: 'OPERATOR' },
      { matchScore: 0.05, decision: 'NONE' },
    ]);
    const h = await svc.histogram();
    expect(h.total).toBe(4);
    expect(h.buckets[9].count).toBe(2);
    expect(h.buckets[5].count).toBe(1);
    expect(h.buckets[0].count).toBe(1);
    expect(h.decisions).toEqual({ AUTO: 2, OPERATOR: 1, NONE: 1 });
  });

  // ── Найдено аудитом волны C ──────────────────────────────────────

  it('исчерпанный бюджет советника останавливает и сведение', async () => {
    // Жалоба приходит с формы, то есть этот вызов умеет запускать
    // посторонний человек. Без общего потолка «$2 в сутки» ограничивали
    // бы только подсказки, а счёт рос бы мимо настройки, которую
    // оператор считает ограничителем.
    const { svc, generateContent, prisma } = build({ spentToday: 9_000_000 });
    expect(await svc.classify('c1')).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
    expect(prisma.wizardExperienceCandidate.update).not.toHaveBeenCalled();
  });

  it('бюджет считается по всем операциям советника и одним запросом', async () => {
    // Проверка стоит на пути каждой подсказки: три поездки к одной
    // таблице ради одного числа стоили бы дороже самого числа.
    const { svc, aiUsage } = build();
    await svc.classify('c1');
    expect(aiUsage.spentTodayForOperation).toHaveBeenCalledTimes(1);
    expect(aiUsage.spentTodayForOperation.mock.calls[0][0]).toEqual([
      'wizard-hint',
      'wizard-sibling',
      'wizard-translate',
    ]);
  });

  it('выключенный рубильник останавливает сведение', async () => {
    const { svc, generateContent } = build({ globalOn: false });
    expect(await svc.classify('c1')).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('ожидающее решения предложение не помечается как «совпадений нет»', async () => {
    // `NONE` по §6.2 означает именно «совпадений нет»; при заполненном
    // `matchedId` это прямое противоречие, и фильтр очереди по решению
    // начал бы врать.
    const { svc, prisma } = build({
      text: '{"matchedId":"e1","score":0.6,"why":"похоже"}',
    });
    await svc.classify('c1');
    const data = prisma.wizardExperienceCandidate.update.mock.calls[0][0].data;
    expect(data.decision).toBeNull();
    expect(data.matchedId).toBe('e1');
  });
});
