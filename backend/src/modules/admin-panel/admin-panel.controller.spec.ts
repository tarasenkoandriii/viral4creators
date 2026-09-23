/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники: подставляем заглушки на месте зависимостей, форму которых тест не проверяет */
/**
 * Пятый аудит (doc/AUDIT-2026-09-09-round5.md, Д-... тест-план в
 * `doc/WORKFLOW-FUNNEL-SPEC.md` §9 и `doc/WORKFLOW-FUNNEL-COHORT-
 * CONVERSION-SPEC.md` §9) явно требовал этот файл — маршрут требует
 * `assertOperator`, как и остальные семнадцать в `AdminPanelController`.
 * У контроллера в целом нет отдельного файла тестов (все 19 маршрутов
 * — тонкая обвязка над сервисами, которые тестируются сами по себе), но
 * два новых маршрута воронки (этап 78) были явно названы в тест-плане
 * обоих ТЗ — этот файл закрывает именно их, не весь контроллер целиком
 * (это отдельная, более крупная задача сама по себе, см. TODO).
 *
 * Проверяем ровно то, что нельзя проверить в `admin-panel.service.spec.ts`
 * (там `assertOperator` тестируется в изоляции, без маршрута вокруг):
 * что оба HTTP-хендлера реально ЗОВУТ `assertOperator` ПЕРЕД обращением
 * к данным, и что отказ `assertOperator` (не-оператор) останавливает
 * запрос до вызова `getWorkflowFunnel`/`getWorkflowCohortConversion` —
 * то есть данные воронки не могут утечь мимо проверки роли даже если
 * кто-то по ошибке поменяет порядок строк в контроллере.
 */

// `AdminPanelController` импортирует `AdminSessionGuard` (для типа
// `AdminAuthenticatedRequest`), а тот — `PrismaService`, которая в
// песочнице не может собрать `@prisma/client` (нет сети до
// binaries.prisma.sh). Тот же обход, что уже применяет
// `cron.controller.spec.ts` — подменяем модуль до импорта контроллера,
// сервис в этом файле никак не используется по существу.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `AdminPanelController` импортирует ЗНАЧЕНИЕ `AdminPanelService`
// (не только тип) — реальный файл сервиса тоже тянет `@prisma/client`
// напрямую (enum `WorkflowKind`). Мокаем и его — в этом файле нужен
// только конструктор-заглушка, реальную логику сервиса тестирует
// `admin-panel.service.spec.ts`.
jest.mock('./admin-panel.service', () => ({ AdminPanelService: class {} }));
// Тот же класс проблемы дальше по цепочке импортов контроллера (через
// `AdminUsersService`/`AiUsageService`/др.) — мокаем корневые модули,
// которые реально тянут `@prisma/client`, той же техникой, что уже
// применяет `cron.controller.spec.ts` для похожей цепочки.
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { AdminPanelController } from './admin-panel.controller';
import type { AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';

function build() {
  const adminPanel = {
    assertOperator: jest.fn().mockResolvedValue(undefined),
    getWorkflowFunnel: jest.fn().mockResolvedValue({ funnel: 'stub' }),
    getWorkflowCohortConversion: jest
      .fn()
      .mockResolvedValue({ cohort: 'stub' }),
    listSessions: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
  };
  // Остальные семь зависимостей контроллера не участвуют ни в одном из
  // двух проверяемых маршрутов — им намеренно ничего не подставляем
  // (реальный вызов через них бросил бы TypeError, что и подтверждает,
  // что тест не задевает чужую логику).
  const voiceoverSettings = {
    get: jest.fn(),
    setDefault: jest.fn(),
  };
  const musicCatalog = {
    get: jest.fn(),
    save: jest.fn(),
  };
  const balances = { list: jest.fn().mockResolvedValue([]) };
  const controller = new AdminPanelController(
    adminPanel as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    voiceoverSettings as any,
    musicCatalog as any,
    balances as any,
    // aiGuide, analysisSettings, videoProviderSettings,
    // grokTransportSettings — этих маршрутов тест не трогает. Число
    // заглушек обязано совпадать с числом параметров конструктора:
    // арность проверяет шаг «типы» в CI (корневой tsconfig видит
    // спеки), а `jest` с `diagnostics: false` — нет.
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );
  const req = { userId: 'op-1' } as AdminAuthenticatedRequest;
  return {
    controller,
    adminPanel,
    voiceoverSettings,
    musicCatalog,
    balances,
    req,
  };
}

describe('AdminPanelController — /admin/workflow-funnel*', () => {
  it('GET /admin/workflow-funnel: требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.getWorkflowFunnel.mockImplementation(async () => {
      callOrder.push('getWorkflowFunnel');
      return { funnel: 'stub' };
    });

    const result = await controller.workflowFunnel(req, 'day');

    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(callOrder).toEqual(['assertOperator', 'getWorkflowFunnel']);
    expect(result).toEqual({ funnel: 'stub' });
  });

  it('GET /admin/workflow-funnel: отказ assertOperator останавливает запрос — сервис данных не зовётся', async () => {
    const { controller, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());

    await expect(controller.workflowFunnel(req, 'day')).rejects.toThrow(
      ForbiddenException,
    );
    expect(adminPanel.getWorkflowFunnel).not.toHaveBeenCalled();
  });

  it('GET /admin/workflow-funnel: валидный `window` передаётся как есть', async () => {
    const { controller, adminPanel, req } = build();
    await controller.workflowFunnel(req, 'week');
    expect(adminPanel.getWorkflowFunnel).toHaveBeenCalledWith('week');
  });

  it.each([
    ['не передан', undefined],
    ['мусорное значение', 'fortnight'],
  ])(
    'GET /admin/workflow-funnel: %s → дефолт "day", а не падение/undefined',
    async (_label, value) => {
      const { controller, adminPanel, req } = build();
      await controller.workflowFunnel(req, value);
      expect(adminPanel.getWorkflowFunnel).toHaveBeenCalledWith('day');
    },
  );

  it('GET /admin/workflow-funnel/cohort-conversion: требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.getWorkflowCohortConversion.mockImplementation(async () => {
      callOrder.push('getWorkflowCohortConversion');
      return { cohort: 'stub' };
    });

    const result = await controller.workflowFunnelCohortConversion(
      req,
      'month',
    );

    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(callOrder).toEqual([
      'assertOperator',
      'getWorkflowCohortConversion',
    ]);
    expect(adminPanel.getWorkflowCohortConversion).toHaveBeenCalledWith(
      'month',
    );
    expect(result).toEqual({ cohort: 'stub' });
  });

  it('GET /admin/workflow-funnel/cohort-conversion: отказ assertOperator останавливает запрос — сервис данных не зовётся', async () => {
    const { controller, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.workflowFunnelCohortConversion(req, 'month'),
    ).rejects.toThrow(ForbiddenException);
    expect(adminPanel.getWorkflowCohortConversion).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — GET /admin/sessions (доп. запрос владельца продукта: сортировки и фильтры по колонкам)', () => {
  it('требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.listSessions.mockImplementation(async () => {
      callOrder.push('listSessions');
      return { items: [], total: 0, page: 1, pageSize: 20 };
    });

    await controller.listSessions(req);

    expect(callOrder).toEqual(['assertOperator', 'listSessions']);
  });

  it('валидные фильтры и сортировка передаются как есть', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      'error',
      'standard',
      'dub',
      'PREMIUM',
      '2026-09-01',
      '2026-09-10',
      ' anna ',
      'plan',
      'asc',
      '2',
      '50',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        quality: 'standard',
        voiceMode: 'dub',
        plan: 'PREMIUM',
        search: 'anna',
        sortBy: 'plan',
        sortDir: 'asc',
        page: 2,
        pageSize: 50,
      }),
    );
    const call = adminPanel.listSessions.mock.calls[0][0];
    expect(call.createdFrom).toBeInstanceOf(Date);
    expect(call.createdTo).toBeInstanceOf(Date);
  });

  it('мусорные voiceMode/plan/sortBy/sortDir тихо отбрасываются — не 400', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      'not-a-mode',
      'GOLD',
      undefined,
      undefined,
      undefined,
      'unknown-column',
      'sideways',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceMode: undefined,
        plan: undefined,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
    );
  });

  it('невалидная дата отбрасывается, а не падает', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      undefined,
      undefined,
      'не дата',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ createdFrom: undefined }),
    );
  });

  it('page/pageSize сохраняют прежние границы (минимум 1, максимум 100)', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '0',
      '9999',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );
  });
});

describe('AdminPanelController — /admin/settings/music-catalog', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, musicCatalog, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    musicCatalog.get.mockImplementation(async () => {
      order.push('get');
      return { raw: '', themes: [] };
    });
    await controller.getMusicCatalog(req);
    expect(order).toEqual(['assertOperator', 'get']);
  });

  it('PATCH: оператор проверяется до записи, и записывается ОН', async () => {
    // `updatedBy` — админский аудит: кто менял каталог.
    const { controller, adminPanel, musicCatalog, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    musicCatalog.save.mockImplementation(async () => {
      order.push('save');
      return { raw: '[]', themes: [] };
    });
    await controller.setMusicCatalog(req, { raw: '[]' });
    expect(order).toEqual(['assertOperator', 'save']);
    expect(musicCatalog.save).toHaveBeenCalledWith('[]', 'op-1');
  });

  it('не оператор — до настройки дело не доходит', async () => {
    const { controller, adminPanel, musicCatalog, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(
      controller.setMusicCatalog(req, { raw: '[]' }),
    ).rejects.toThrow();
    expect(musicCatalog.save).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — GET /admin/balances', () => {
  it('оператор проверяется до обращения к остаткам', async () => {
    const { controller, adminPanel, balances, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    balances.list.mockImplementation(async () => {
      order.push('list');
      return [];
    });
    await controller.providerBalances(req);
    expect(order).toEqual(['assertOperator', 'list']);
  });

  it('refresh=1 обходит кеш, остальное — нет', async () => {
    // Кеш здесь не про нашу скорость, а про чужое ограничение частоты:
    // экран, спрашивающий на каждый рендер, сам доводит до 429.
    const { controller, balances, req } = build();
    await controller.providerBalances(req, '1');
    expect(balances.list).toHaveBeenCalledWith(true);
    await controller.providerBalances(req);
    expect(balances.list).toHaveBeenLastCalledWith(false);
    await controller.providerBalances(req, 'yes');
    expect(balances.list).toHaveBeenLastCalledWith(false);
  });
});
