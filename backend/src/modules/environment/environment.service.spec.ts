import { Logger } from '@nestjs/common';
import { EnvironmentService } from './environment.service';
import { PrismaService } from '../../prisma/prisma.service';

function make(count = 1) {
  const updateMany = jest.fn().mockResolvedValue({ count });
  const prisma = { user: { updateMany } } as unknown as PrismaService;
  return { service: new EnvironmentService(prisma), updateMany };
}

const payload = {
  surface: 'TMA',
  deviceKind: 'PHONE',
  osFamily: 'ios',
  osVersion: '17.4',
  tgPlatform: 'ios',
  uiLocale: 'ru',
  theme: 'dark',
  maxTouchPoints: 5,
  appBuild: '2026.09.25-a1b2c3d',
};

describe('EnvironmentService.record', () => {
  it('сохраняет окружение тестировщика одним запросом', async () => {
    const { service, updateMany } = make(1);
    await expect(service.record('42', payload)).resolves.toEqual({
      stored: true,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0];
    expect(call.data.lastEnvironment).toMatchObject({
      surface: 'TMA',
      osFamily: 'ios',
      theme: 'dark',
      maxTouchPoints: 5,
      appBuild: '2026.09.25-a1b2c3d',
    });
    expect(call.data.lastEnvironmentAt).toBeInstanceOf(Date);
  });

  it('право доступа выражено в условии записи, а не отдельным чтением', async () => {
    // Атомарность: между «прочитали, что тестировщик» и «записали»
    // нельзя успеть отозвать доступ, потому что этого промежутка нет.
    const { service, updateMany } = make(1);
    await service.record('42', payload);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.telegramId).toBe('42');
    expect(where.isTestUser).toBe(true);
    expect(where.OR).toEqual([
      { testAccessUntil: null },
      { testAccessUntil: { gt: expect.any(Date) } },
    ]);
  });

  it('ни одна строка не подошла — ответ без ошибки', async () => {
    // Обычный пользователь или истёкший доступ. Отказ — не ошибка:
    // человек ничего неправильного не сделал, а красная ошибка на
    // каждом запуске потом мешает читать настоящие.
    const { service } = make(0);
    await expect(service.record('42', payload)).resolves.toEqual({
      stored: false,
    });
  });

  it('негодное тело не доходит до базы вовсе', async () => {
    const { service, updateMany } = make(1);
    await expect(service.record('42', { surface: 'TMA' })).resolves.toEqual({
      stored: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('негодное тело слышно в логах — иначе оно неотличимо от «не тестировщик»', async () => {
    // Именно этот отказ случится сам собой, когда старая сборка
    // мини-аппа встретит новый сервер.
    const { service } = make(1);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await service.record('42', { surface: 'TMA', deviceKindd: 'PHONE' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('deviceKindd');
    warn.mockRestore();
  });
});
