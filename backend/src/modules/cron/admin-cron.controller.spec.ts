/**
 * AdminCronController — разбор query истории/сводки: параметры
 * доходят до сервиса разобранными, мусор — 400 ДО обращения к БД, а
 * права оператора проверяются раньше разбора.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../admin-panel/admin-panel.service', () => ({
  AdminPanelService: class {},
}));
jest.mock('./admin-cron.service', () => ({ AdminCronService: class {} }));
jest.mock('../admin-auth/admin-session.guard', () => ({
  AdminSessionGuard: class {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminCronController } from './admin-cron.controller';

function build(operator = true) {
  const adminCron = {
    getHistory: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({ jobs: [] }),
  };
  const adminPanel = {
    assertOperator: jest.fn(() =>
      operator ? Promise.resolve() : Promise.reject(new ForbiddenException()),
    ),
  };
  const controller = new AdminCronController(
    adminCron as never,
    adminPanel as never,
  );
  return { controller, adminCron, adminPanel };
}

const req = { userId: 'admin-1' } as never;

describe('AdminCronController — history', () => {
  it('передаёт в сервис разобранный период, limit и курсор', async () => {
    const { controller, adminCron } = build();
    await controller.history(
      req,
      'publish',
      '2026-09-29',
      '2026-09-30',
      '200',
      'cmrow1',
    );
    expect(adminCron.getHistory).toHaveBeenCalledWith({
      jobKey: 'publish',
      since: new Date('2026-09-29T00:00:00Z'),
      until: new Date('2026-09-30T00:00:00Z'),
      limit: 200,
      before: 'cmrow1',
    });
  });

  it('без параметров — прежнее поведение (limit 50)', async () => {
    const { controller, adminCron } = build();
    await controller.history(req);
    expect(adminCron.getHistory).toHaveBeenCalledWith(
      expect.objectContaining({ jobKey: undefined, limit: 50 }),
    );
  });

  it('кривой since — 400, сервис не вызывается', async () => {
    const { controller, adminCron } = build();
    await expect(controller.history(req, undefined, 'вчера')).rejects.toThrow(
      BadRequestException,
    );
    expect(adminCron.getHistory).not.toHaveBeenCalled();
  });

  it('не-оператор — 403 раньше 400', async () => {
    const { controller } = build(false);
    await expect(controller.history(req, undefined, 'вчера')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('AdminCronController — summary', () => {
  it('передаёт в сервис период', async () => {
    const { controller, adminCron } = build();
    await controller.cronSummary(req, '2026-09-29', '2026-09-30');
    expect(adminCron.getSummary).toHaveBeenCalledWith({
      since: new Date('2026-09-29T00:00:00Z'),
      until: new Date('2026-09-30T00:00:00Z'),
    });
  });

  it('период длиннее срока хранения журнала — 400', async () => {
    const { controller, adminCron } = build();
    await expect(
      controller.cronSummary(req, '2026-01-01', '2026-09-30'),
    ).rejects.toThrow(BadRequestException);
    expect(adminCron.getSummary).not.toHaveBeenCalled();
  });
});
