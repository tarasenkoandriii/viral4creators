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
  };
  // Остальные семь зависимостей контроллера не участвуют ни в одном из
  // двух проверяемых маршрутов — им намеренно ничего не подставляем
  // (реальный вызов через них бросил бы TypeError, что и подтверждает,
  // что тест не задевает чужую логику).
  const controller = new AdminPanelController(
    adminPanel as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );
  const req = { userId: 'op-1' } as AdminAuthenticatedRequest;
  return { controller, adminPanel, req };
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
