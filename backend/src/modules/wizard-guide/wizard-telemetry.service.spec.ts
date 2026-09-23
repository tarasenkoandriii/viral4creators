/**
 * Телеметрия шагов — «Тонкая красная линия» §8, этап 8.
 *
 * Главное здесь не «записалось ли», а ЧТО записалось: приёмка этапа
 * требует, чтобы в таблице не было ни одного идентифицирующего поля.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { WizardTelemetryService } from './wizard-telemetry.service';
import {
  CANDIDATE_RETENTION_MS,
  pruneWizardCandidates,
  WIZARD_EVENT_DETAIL_MAX,
  WIZARD_TELEMETRY_RETENTION_MS,
  HINT_CACHE_RETENTION_MS,
  pruneWizardHintCache,
  pruneWizardHints,
  pruneWizardStepEvents,
} from './wizard-telemetry';

/** Ровно то, что читают проверки ниже из аргументов моков. */
interface CreateManyCall {
  data: Array<Record<string, unknown>>;
}
interface DeleteManyCall {
  where: { createdAt: { lt: Date } };
}

function build(over: { throws?: boolean } = {}) {
  const prisma = {
    wizardStepEvent: {
      createMany: jest.fn(async (_args: CreateManyCall) => {
        if (over.throws) throw new Error('база недоступна');
        return { count: 1 };
      }),
      groupBy: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(async (_args: DeleteManyCall) => ({ count: 3 })),
    },
    wizardHint: {
      deleteMany: jest.fn(async (_args: DeleteManyCall) => ({ count: 2 })),
    },
    wizardHintCache: {
      deleteMany: jest.fn(async (_args: DeleteManyCall) => ({ count: 1 })),
    },
    wizardExperienceCandidate: {
      deleteMany: jest.fn(
        async (_args: {
          where: { createdAt: { lt: Date }; status: { in: string[] } };
        }) => ({ count: 5 }),
      ),
    },
  };
  return { prisma, svc: new WizardTelemetryService(prisma as never) };
}

describe('WizardTelemetryService (§8)', () => {
  it('в таблицу не уезжает ничего, опознающего человека', async () => {
    // Приёмка этапа 8 дословно. Таблица без идентификаторов не может
    // утечь тем, чего в ней нет, — а частоты по шагам считаются и без
    // них.
    const { svc, prisma } = build();
    await svc.record([
      {
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        kind: 'hint_open',
        detail: 'E_TIMEOUT',
      },
    ]);
    const rows = prisma.wizardStepEvent.createMany.mock.calls[0][0].data;
    expect(Object.keys(rows[0]).sort()).toEqual([
      'detail',
      'kind',
      'scenario',
      'stepId',
    ]);
  });

  it('неизвестный вид события отбрасывается', async () => {
    const { svc, prisma } = build();
    const n = await svc.record([
      { scenario: 'CLIENT_SITE', stepId: 'url', kind: 'выдумка' as never },
    ]);
    expect(n).toBe(0);
    expect(prisma.wizardStepEvent.createMany).not.toHaveBeenCalled();
  });

  it('длинный detail обрезается, а событие остаётся', async () => {
    // Отказ потерял бы событие целиком, а длина `detail` — ошибка
    // вызывающего, не повод терять частоту шага.
    const { svc, prisma } = build();
    await svc.record([
      {
        scenario: 'CLIENT_SITE',
        stepId: 'url',
        kind: 'error',
        detail: 'x'.repeat(500),
      },
    ]);
    const rows = prisma.wizardStepEvent.createMany.mock.calls[0][0].data;
    expect(rows[0].detail).toHaveLength(WIZARD_EVENT_DETAIL_MAX);
  });

  it('упавшая запись не бросает наружу', async () => {
    // Телеметрия — наблюдение за продуктом, а не часть пути человека.
    const { svc } = build({ throws: true });
    await expect(
      svc.record([{ scenario: 'CLIENT_SITE', stepId: 'url', kind: 'enter' }]),
    ).resolves.toBe(0);
  });

  it('частоты складываются по шагу и сортируются по общему числу', async () => {
    const { svc, prisma } = build();
    prisma.wizardStepEvent.groupBy.mockResolvedValue([
      {
        scenario: 'CLIENT_SITE',
        stepId: 'url',
        kind: 'enter',
        _count: { _all: 2 },
      },
      {
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        kind: 'enter',
        _count: { _all: 5 },
      },
      {
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        kind: 'hint_useless',
        _count: { _all: 1 },
      },
    ]);
    const rows = await svc.frequencies(7);
    expect(rows.map((r) => r.stepId)).toEqual(['record', 'url']);
    expect(rows[0].counts).toEqual({ enter: 5, hint_useless: 1 });
    expect(rows[0].total).toBe(6);
  });
});

describe('ретенция (§8)', () => {
  it('телеметрия и журнал живут 30 дней', async () => {
    const { prisma } = build();
    const now = new Date('2026-09-23T00:00:00Z');
    await pruneWizardStepEvents(prisma as never, now);
    await pruneWizardHints(prisma as never, now);
    const cutoff = new Date(now.getTime() - WIZARD_TELEMETRY_RETENTION_MS);
    expect(
      prisma.wizardStepEvent.deleteMany.mock.calls[0][0].where.createdAt.lt,
    ).toEqual(cutoff);
    expect(
      prisma.wizardHint.deleteMany.mock.calls[0][0].where.createdAt.lt,
    ).toEqual(cutoff);
  });

  it('кеш подсказок убирается по своему суточному TTL', async () => {
    // Не общей ретенцией: запись старше суток не отдаётся никогда и
    // только портит долю попаданий, по которой судят о стоимости фичи.
    const { prisma } = build();
    const now = new Date('2026-09-23T00:00:00Z');
    await pruneWizardHintCache(prisma as never, now);
    expect(
      prisma.wizardHintCache.deleteMany.mock.calls[0][0].where.createdAt.lt,
    ).toEqual(new Date(now.getTime() - HINT_CACHE_RETENTION_MS));
    expect(HINT_CACHE_RETENTION_MS).toBeLessThan(WIZARD_TELEMETRY_RETENTION_MS);
  });

  it('неразобранные кандидаты не убираются никогда', async () => {
    // Это рабочая очередь оператора, а не журнал: убрать из неё
    // непрочитанный сигнал значит потерять работу, а не мусор.
    const { prisma } = build();
    await pruneWizardCandidates(prisma as never, new Date());
    const where =
      prisma.wizardExperienceCandidate.deleteMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['MERGED', 'PROMOTED', 'REJECTED']);
    expect(where.status.in).not.toContain('NEW');
  });

  it('разобранные живут дольше журналов, но не вечно', async () => {
    // Сырой текст жалобы — пользовательский ввод, и держать его после
    // принятого решения незачем (§9).
    expect(CANDIDATE_RETENTION_MS).toBeGreaterThan(
      WIZARD_TELEMETRY_RETENTION_MS,
    );
  });
});
