/**
 * UserVoicesController/UserVoicesWebhookController — тонкий слой поверх
 * UserVoicesService (этап 73, TODO п.32). Идентичность (кто есть кто) и
 * гейт (тариф/лимит) проверяются сервисом — здесь только то, что
 * контроллер честно передаёт telegramUserId и не путает маршруты.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { UnauthorizedException } from '@nestjs/common';
import {
  UserVoicesController,
  UserVoicesWebhookController,
} from './user-voices.controller';

function buildService() {
  return {
    createUploadUrl: jest.fn().mockResolvedValue({
      uploadUrl: 'https://blob/put',
      pathname: 'p',
      voiceId: 'v1',
    }),
    confirmClone: jest.fn().mockResolvedValue({ id: 'v1', status: 'training' }),
    list: jest.fn().mockResolvedValue([{ id: 'v1', status: 'ready' }]),
    remove: jest.fn().mockResolvedValue(undefined),
    handleWebhook: jest.fn().mockResolvedValue(undefined),
  };
}

const req = { telegramUserId: 'u1' } as never;

describe('UserVoicesController', () => {
  it('uploadUrl передаёт telegramUserId и dto как есть', async () => {
    const service = buildService();
    const controller = new UserVoicesController(service as never);
    const dto = {
      fileName: 'x.mp3',
      fileSize: 1,
      mimeType: 'audio/mpeg',
    } as never;
    const result = await controller.uploadUrl(req, dto);
    expect(service.createUploadUrl).toHaveBeenCalledWith('u1', dto);
    expect(result.voiceId).toBe('v1');
  });

  it('clone передаёт telegramUserId и dto как есть', async () => {
    const service = buildService();
    const controller = new UserVoicesController(service as never);
    const dto = { pathname: 'p', label: 'L', consent: true } as never;
    const result = await controller.clone(req, dto);
    expect(service.confirmClone).toHaveBeenCalledWith('u1', dto);
    expect(result.id).toBe('v1');
  });

  it('list передаёт telegramUserId', async () => {
    const service = buildService();
    const controller = new UserVoicesController(service as never);
    const result = await controller.list(req);
    expect(service.list).toHaveBeenCalledWith('u1');
    expect(result).toHaveLength(1);
  });

  it('remove передаёт telegramUserId и id, отвечает {ok: true}', async () => {
    const service = buildService();
    const controller = new UserVoicesController(service as never);
    const result = await controller.remove(req, 'v1');
    expect(service.remove).toHaveBeenCalledWith('u1', 'v1');
    expect(result).toEqual({ ok: true });
  });
});

describe('UserVoicesWebhookController', () => {
  const OLD_ENV = process.env.RESEMBLE_WEBHOOK_SECRET;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.RESEMBLE_WEBHOOK_SECRET;
    else process.env.RESEMBLE_WEBHOOK_SECRET = OLD_ENV;
  });

  it('неверный секрет — отказ, сервис не вызывается', async () => {
    process.env.RESEMBLE_WEBHOOK_SECRET = 'right';
    const service = buildService();
    const controller = new UserVoicesWebhookController(service as never);
    await expect(
      controller.resembleWebhook('wrong', {
        ok: true,
        id: 'x',
        status: 'finished',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handleWebhook).not.toHaveBeenCalled();
  });

  it('верный секрет — передаёт тело как есть в сервис', async () => {
    process.env.RESEMBLE_WEBHOOK_SECRET = 'right';
    const service = buildService();
    const controller = new UserVoicesWebhookController(service as never);
    const body = { ok: true, id: 'x', status: 'finished' };
    const result = await controller.resembleWebhook('right', body);
    expect(service.handleWebhook).toHaveBeenCalledWith(body);
    expect(result).toEqual({ ok: true });
  });
});
