/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Этап 89: удаление сессии оператором — софт-delete через
 * `SessionService.softDeleteSession`, «тот же механизм», что и
 * пользовательский `DELETE /sessions/:id` (прямой запрос владельца
 * продукта). Раньше (Б-5.9, этап 88.2) этот путь удалял строку и файлы
 * синхронно, своей отдельной реализацией — та история и её тесты
 * («пути собираются ДО удаления строки» и т. п.) переехали в
 * `SessionService.purgeSoftDeletedSessions` (`session.service.spec.ts`),
 * которая теперь единственная физически удаляет строку.
 */
// PrismaService и @prisma/client тянут сгенерированный клиент, которого в
// песочнице нет (`prisma generate` недоступен, doc/CI.md). `WorkflowKind`
// — то, что `admin-panel.service.ts` реально использует как значение
// (сравнения `descriptor.kind === WorkflowKind.SESSION` и т. п. в воронке,
// этап 78), не только как тип — тот же приём, что в
// `project.service.spec.ts`/`session.service.spec.ts` для `Prisma.DbNull`.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: {
    SESSION: 'SESSION',
    CATALOG_BATCH_ITEM: 'CATALOG_BATCH_ITEM',
    AB_TEST_VARIANT: 'AB_TEST_VARIANT',
  },
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminPanelService } from './admin-panel.service';

function build(
  opts: {
    session?: unknown;
    softDeleteResult?: { deleted: boolean };
  } = {},
) {
  const prisma = {
    session: {
      findFirst: jest.fn().mockResolvedValue(opts.session ?? null),
    },
  };
  const sessionService = {
    softDeleteSession: jest
      .fn()
      .mockResolvedValue(opts.softDeleteResult ?? { deleted: true }),
  };
  return {
    svc: new AdminPanelService(prisma as any, sessionService as any),
    prisma,
    sessionService,
  };
}

describe('AdminPanelService.deleteSession — софт-delete (этап 89)', () => {
  it('зовёт SessionService.softDeleteSession — тот же механизм, что у пользователя', async () => {
    const { svc, sessionService } = build();
    await expect(svc.deleteSession('s1')).resolves.toEqual({ ok: true });
    expect(sessionService.softDeleteSession).toHaveBeenCalledWith('s1');
  });

  it('несуществующая/уже удалённая сессия — 404', async () => {
    const { svc } = build({ softDeleteResult: { deleted: false } });
    await expect(svc.deleteSession('нет')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminPanelService.getSession — мягко удалённая не видна оператору (этап 89)', () => {
  it('запрашивает строку с deletedAt: null', async () => {
    const { svc, prisma } = build({
      session: {
        id: 's1',
        status: 'video_complete',
        generationStatus: null,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        lastActivityAt: new Date('2026-09-01T11:00:00Z'),
        userId: 'u1',
        data: {},
      },
    });
    await svc.getSession('s1');
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: 's1', deletedAt: null },
    });
  });

  it('мягко удалённая (не найдена с deletedAt: null) — 404', async () => {
    const { svc } = build({ session: null });
    await expect(svc.getSession('s1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminPanelService.assertOperator — вторая половина двери в админку (В-6.1)', () => {
  // Правило доступа состоит из двух половин: `AdminSessionGuard` (вход)
  // и `assertOperator` (право). Первая была покрыта, вторая — нет:
  // удаление трёх строк ниже не роняло ни одного из 946 тестов, а
  // давало любому вошедшему через Telegram удаление сессий, блокировку
  // пользователей и смену тарифов. Семнадцать обработчиков в четырёх
  // контроллерах держатся на этом одном методе.
  function withUser(user: { isOperator: boolean } | null) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    return {
      svc: new AdminPanelService(prisma as any, {} as any),
      prisma,
    };
  }

  it('оператор проходит', async () => {
    const { svc, prisma } = withUser({ isOperator: true });
    await expect(svc.assertOperator('u1')).resolves.toBeUndefined();
    // Читается ровно нужный флаг по первичному ключу — один индексный
    // поиск на каждый админский запрос, ничего лишнего.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { isOperator: true },
    });
  });

  it('вошедший без флага получает 403, а не ошибку входа', async () => {
    // Вход и право проверяются раздельно: человек с валидной
    // admin-сессией, но без флага, должен увидеть честное «нет прав», а
    // не «войдите заново».
    const { svc } = withUser({ isOperator: false });
    await expect(svc.assertOperator('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('удалённый пользователь с живой сессией — тоже 403', async () => {
    // Сессия могла пережить строку пользователя (каскад снимает
    // admin_sessions, но между удалением и следующим запросом есть окно).
    const { svc } = withUser(null);
    await expect(svc.assertOperator('u-gone')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

/**
 * Воронка движения по воркфлоу (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
 * doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md). `$queryRaw` — тегированная
 * функция: мок разбирает и текст SQL (`strings`), и подставленные значения
 * (`values`) — у событийной воронки имя воркфлоу зашито ЛИТЕРАЛОМ в текст
 * запроса, у когортной конверсии передаётся ПАРАМЕТРОМ (`::"WorkflowKind"`
 * cast), поэтому дispatch проверяет оба источника.
 */
function buildFunnelService(
  data: {
    session?: { stage?: unknown[]; failure?: unknown[] };
    catalog_batch?: { stage?: unknown[]; failure?: unknown[] };
    ab_test?: { stage?: unknown[]; failure?: unknown[] };
    cohort?: Partial<
      Record<
        'session' | 'catalog_batch' | 'ab_test',
        { size?: number; stages?: unknown[] }
      >
    >;
  } = {},
) {
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text =
        strings.join(' ') +
        ' ' +
        values.filter((v) => typeof v === 'string').join(' ');
      const workflow: 'session' | 'catalog_batch' | 'ab_test' = text.includes(
        'CATALOG_BATCH_ITEM',
      )
        ? 'catalog_batch'
        : text.includes('AB_TEST_VARIANT')
          ? 'ab_test'
          : 'session';
      if (text.includes('WITH cohort AS')) {
        return Promise.resolve(data.cohort?.[workflow]?.stages ?? []);
      }
      if (!text.includes('JOIN cohort') && text.includes('COUNT(*)::int')) {
        return Promise.resolve([{ count: data.cohort?.[workflow]?.size ?? 0 }]);
      }
      if (text.includes('GROUP BY e."fromStage"')) {
        return Promise.resolve(data[workflow]?.failure ?? []);
      }
      return Promise.resolve(data[workflow]?.stage ?? []);
    },
  );
  const prisma = { $queryRaw };
  return { svc: new AdminPanelService(prisma as any, {} as any), prisma };
}

describe('AdminPanelService.getWorkflowFunnel (этап 78)', () => {
  it('окно "hour" — from ровно на час раньше to', async () => {
    const { svc } = buildFunnelService();
    const result = await svc.getWorkflowFunnel('hour');
    expect(result.window).toBe('hour');
    expect(
      new Date(result.to).getTime() - new Date(result.from).getTime(),
    ).toBe(60 * 60 * 1000);
    expect(result.blocks.map((b) => b.workflow)).toEqual([
      'session',
      'catalog_batch',
      'ab_test',
    ]);
  });

  it('сессия: недостающие стадии дозаполняются нулями, error исключена из stages', async () => {
    const { svc } = buildFunnelService({
      session: {
        stage: [
          { stage: 'created', count: 5, uniqueUsers: 2 },
          { stage: 'video_complete', count: 1, uniqueUsers: 1 },
        ],
      },
    });
    const result = await svc.getWorkflowFunnel('day');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    expect(session.stages).toHaveLength(8);
    expect(session.stages.map((s) => s.key)).not.toContain('error');
    const created = session.stages.find((s) => s.key === 'created')!;
    expect(created).toEqual({
      key: 'created',
      label: 'Создана',
      count: 5,
      uniqueUsers: 2,
    });
    const analyzing = session.stages.find((s) => s.key === 'analyzing')!;
    expect(analyzing).toEqual({
      key: 'analyzing',
      label: 'Идёт разбор',
      count: 0,
      uniqueUsers: 0,
    });
  });

  it('разбивка ошибок — отсортирована по count desc, totalFailed — сумма', async () => {
    const { svc } = buildFunnelService({
      session: {
        failure: [
          { fromStage: 'generating_video', count: 3, uniqueUsers: 2 },
          { fromStage: 'analyzing', count: 7, uniqueUsers: 5 },
        ],
      },
    });
    const result = await svc.getWorkflowFunnel('day');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    // Порядок из БД сохраняется как есть (запрос уже сортирует ORDER BY
    // count DESC) — приложение не пересортировывает повторно.
    expect(session.failures).toEqual([
      {
        fromStage: 'generating_video',
        fromLabel: 'Генерация видео',
        count: 3,
        uniqueUsers: 2,
      },
      {
        fromStage: 'analyzing',
        fromLabel: 'Идёт разбор',
        count: 7,
        uniqueUsers: 5,
      },
    ]);
    expect(session.totalFailed).toBe(10);
  });

  it('пакетная генерация/A-B: путь трёхступенчатый (PENDING/GENERATING/DONE), без FAILED', async () => {
    const { svc } = buildFunnelService({
      catalog_batch: { stage: [{ stage: 'DONE', count: 4, uniqueUsers: 3 }] },
    });
    const result = await svc.getWorkflowFunnel('week');
    const batch = result.blocks.find((b) => b.workflow === 'catalog_batch')!;
    expect(batch.stages.map((s) => s.key)).toEqual([
      'PENDING',
      'GENERATING',
      'DONE',
    ]);
    expect(batch.stages.find((s) => s.key === 'DONE')).toEqual({
      key: 'DONE',
      label: 'Готово',
      count: 4,
      uniqueUsers: 3,
    });
  });
});

describe('AdminPanelService.getWorkflowCohortConversion (этап 78)', () => {
  it('пустая когорта — второй запрос не выполняется, все стадии нулевые', async () => {
    const { svc, prisma } = buildFunnelService({
      cohort: { session: { size: 0 } },
    });
    const result = await svc.getWorkflowCohortConversion('hour');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    expect(session.cohortSize).toBe(0);
    expect(session.stages.every((s) => s.reached === 0)).toBe(true);
    expect(session.stages.every((s) => s.pctOfCohort === 0)).toBe(true);
    expect(session.stages.every((s) => s.avgDurationFromStartMs === null)).toBe(
      true,
    );
    // Ни одного запроса с `WITH cohort AS` для пустой когорты сессии.
    const calls = (prisma.$queryRaw as jest.Mock).mock.calls;
    const cohortSessionCalls = calls.filter(([strings]: [string[]]) =>
      strings.join(' ').includes('WITH cohort AS'),
    );
    // Другие два воркфлоу тоже пусты по умолчанию — 0 запросов с WITH cohort вообще.
    expect(cohortSessionCalls.length).toBe(0);
  });

  it('стартовая и терминальная стадии не входят в stages[], недостающая стадия дозаполняется', async () => {
    const { svc } = buildFunnelService({
      cohort: {
        session: {
          size: 10,
          stages: [
            { stage: 'analysis_complete', reached: 6, avgDurationMs: 500 },
          ],
        },
      },
    });
    const result = await svc.getWorkflowCohortConversion('hour');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    expect(session.stages.map((s) => s.key)).not.toContain('created');
    expect(session.stages.map((s) => s.key)).not.toContain('error');
    const videoUploaded = session.stages.find(
      (s) => s.key === 'video_uploaded',
    )!;
    expect(videoUploaded).toEqual({
      key: 'video_uploaded',
      label: 'Видео загружено',
      reached: 0,
      pctOfCohort: 0,
      pctOfPrevious: null,
      avgDurationFromStartMs: null,
    });
  });

  it('pctOfPrevious: null у первой стадии, > 1.0 не клампится при обходе стадий (§4.1)', async () => {
    const { svc } = buildFunnelService({
      cohort: {
        session: {
          size: 10,
          stages: [
            { stage: 'video_uploaded', reached: 2, avgDurationMs: 100 },
            { stage: 'analyzing', reached: 2, avgDurationMs: 200 },
            // Обход ANALYZING через LibraryService — больше, чем предыдущая.
            { stage: 'analysis_complete', reached: 8, avgDurationMs: 300 },
          ],
        },
      },
    });
    const result = await svc.getWorkflowCohortConversion('hour');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    const first = session.stages.find((s) => s.key === 'video_uploaded')!;
    expect(first.pctOfPrevious).toBeNull();
    const skip = session.stages.find((s) => s.key === 'analysis_complete')!;
    expect(skip.pctOfPrevious).toBe(4); // 8/2 — не обрезано до 1.0
  });

  it('pctOfPrevious: null, когда предыдущая стадия ни разу не достигнута (деление на 0)', async () => {
    const { svc } = buildFunnelService({
      cohort: {
        session: {
          size: 10,
          stages: [
            { stage: 'video_uploaded', reached: 0, avgDurationMs: null },
            { stage: 'analyzing', reached: 3, avgDurationMs: 50 },
          ],
        },
      },
    });
    const result = await svc.getWorkflowCohortConversion('hour');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    const analyzing = session.stages.find((s) => s.key === 'analyzing')!;
    expect(analyzing.pctOfPrevious).toBeNull();
  });

  it('matured: false до истечения горизонта, true после (константы см. workflow-funnel-cohort.ts)', async () => {
    const { svc } = buildFunnelService({ cohort: { session: { size: 0 } } });
    const result = await svc.getWorkflowCohortConversion('hour');
    const session = result.blocks.find((b) => b.workflow === 'session')!;
    // to только что вычислен (Date.now()) — горизонт (90 минут) заведомо
    // не истёк, значит когорта ещё не завершена, а maturesAt — в будущем.
    expect(session.matured).toBe(false);
    expect(new Date(session.maturesAt).getTime()).toBeGreaterThan(Date.now());
  });
});
