/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserVoicesService } from './user-voices.service';

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const NOW = new Date('2026-09-09T12:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  userId: USER,
  label: 'Мой голос',
  status: 'TRAINING',
  resembleVoiceId: 'resemble-uuid-1',
  sampleUrl: 'https://blob.test/users/u1/voices/v1/sample.mp3',
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function build() {
  const prisma: {
    userVoice: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  } = {
    userVoice: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    // Е-4.2 шестого аудита: `confirmClone` резервирует слот транзакцией
    // с advisory-lock — мок просто вызывает переданный колбэк с тем же
    // `prisma`, чтобы существующие моки `userVoice.count`/`.create` в
    // тестах работали без отдельного tx-прокси.
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) =>
    fn(prisma),
  );
  const blob = {
    createUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://blob.test/put' }),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
  };
  const plans = {
    assertUser: jest.fn().mockResolvedValue(undefined),
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  const resemble = {
    cloneVoice: jest
      .fn()
      .mockResolvedValue({ ok: true, resembleVoiceId: 'resemble-uuid-1' }),
    getVoiceStatus: jest.fn().mockResolvedValue(undefined),
    deleteVoice: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new UserVoicesService(
    prisma as never,
    blob as never,
    plans as never,
    aiUsage as never,
    resemble as never,
  );
  return { svc, prisma, blob, plans, aiUsage, resemble };
}

describe('UserVoicesService.createUploadUrl', () => {
  it('проверяет тариф и лимит ДО минтинга pathname', async () => {
    const { svc, plans, blob } = build();
    const r = await svc.createUploadUrl(USER, {
      fileName: 'x.mp3',
      fileSize: 1000,
      mimeType: 'audio/mpeg',
    } as never);
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'voiceCloning');
    expect(r.pathname).toMatch(
      new RegExp(`^users/${USER}/voices/[^/]+/sample\\.mp3$`),
    );
    expect(r.voiceId).toBe(r.pathname.split('/')[3]);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/mpeg',
      15 * 1024 * 1024,
    );
  });

  it('лимит достигнут (не считая FAILED) — отказ до вызова Blob', async () => {
    const { svc, prisma, blob } = build();
    prisma.userVoice.count.mockResolvedValue(3);
    await expect(
      svc.createUploadUrl(USER, {
        fileName: 'x.mp3',
        fileSize: 1000,
        mimeType: 'audio/mpeg',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.userVoice.count).toHaveBeenCalledWith({
      where: { userId: USER, status: { not: 'FAILED' } },
    });
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
  });
});

describe('UserVoicesService.confirmClone', () => {
  const dto = () => ({
    pathname: `users/${USER}/voices/v1/sample.mp3`,
    label: 'Мой голос',
    consent: true,
  });

  it('pathname чужого пользователя — отказ, ничего не вызывается', async () => {
    const { svc, resemble } = build();
    await expect(
      svc.confirmClone(USER, {
        pathname: 'users/other/voices/v1/sample.mp3',
        label: 'x',
        consent: true,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resemble.cloneVoice).not.toHaveBeenCalled();
  });

  it('без согласия — отказ до обращения к Resemble', async () => {
    const { svc, resemble } = build();
    await expect(
      svc.confirmClone(USER, { ...dto(), consent: false } as never),
    ).rejects.toThrow('согласие');
    expect(resemble.cloneVoice).not.toHaveBeenCalled();
  });

  it('запись не найдена в Blob — понятная ошибка, не падение', async () => {
    const { svc, resemble } = build();
    mockedHead.mockRejectedValue(new Error('not found'));
    await expect(svc.confirmClone(USER, dto() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(resemble.cloneVoice).not.toHaveBeenCalled();
  });

  it('успех: резервирует TRAINING-строку ДО вызова Resemble, потом пишет resembleVoiceId и ai-usage', async () => {
    const { svc, prisma, aiUsage, resemble } = build();
    mockedHead.mockResolvedValue({
      url: 'https://blob.test/confirmed.mp3',
    } as never);
    prisma.userVoice.update.mockResolvedValue(
      row({
        status: 'TRAINING',
        sampleUrl: 'https://blob.test/confirmed.mp3',
        resembleVoiceId: 'resemble-uuid-1',
      }),
    );
    const result = await svc.confirmClone(USER, dto() as never);

    // Резерв — create() ДО обращения к Resemble, без resembleVoiceId
    // (его ещё не может быть известно).
    expect(prisma.userVoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'v1',
        userId: USER,
        label: 'Мой голос',
        status: 'TRAINING',
        sampleUrl: 'https://blob.test/confirmed.mp3',
      }),
    });
    expect(
      (prisma.userVoice.create.mock.calls[0][0] as { data: object }).data,
    ).not.toHaveProperty('resembleVoiceId');
    expect(resemble.cloneVoice).toHaveBeenCalledWith(
      'Мой голос',
      'https://blob.test/confirmed.mp3',
      undefined, // RESEMBLE_WEBHOOK_SECRET/API_PUBLIC_URL не заданы в тестах
    );
    // Успешный ответ Resemble — обновляет ТУ ЖЕ строку, не создаёт вторую.
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { resembleVoiceId: 'resemble-uuid-1' },
    });
    expect(aiUsage.record).toHaveBeenCalledWith({
      operation: 'voice-clone',
      model: 'resemble-voice-clone',
      userId: USER,
    });
    expect(result.status).toBe('training');
  });

  it('Resemble отказал — обновляет зарезервированную строку в FAILED, деньги НЕ пишет, вторую строку не создаёт', async () => {
    const { svc, prisma, aiUsage, resemble } = build();
    mockedHead.mockResolvedValue({
      url: 'https://blob.test/confirmed.mp3',
    } as never);
    resemble.cloneVoice.mockResolvedValue({
      ok: false,
      reason: 'Resemble 402',
    });
    prisma.userVoice.update.mockResolvedValue(
      row({ status: 'FAILED', resembleVoiceId: null, error: 'Resemble 402' }),
    );
    const result = await svc.confirmClone(USER, dto() as never);
    expect(prisma.userVoice.create).toHaveBeenCalledTimes(1);
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'FAILED', error: 'Resemble 402' },
    });
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('лимит достигнут — отказ до вызова Resemble, слот не резервируется', async () => {
    const { svc, prisma, resemble } = build();
    mockedHead.mockResolvedValue({ url: 'https://blob.test/x.mp3' } as never);
    prisma.userVoice.count.mockResolvedValue(3);
    await expect(svc.confirmClone(USER, dto() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.userVoice.create).not.toHaveBeenCalled();
    expect(resemble.cloneVoice).not.toHaveBeenCalled();
  });

  it('Е-4.2 шестого аудита: проверка лимита и резерв строки — под advisory-lock по userId, одной транзакцией', async () => {
    const { svc, prisma } = build();
    mockedHead.mockResolvedValue({ url: 'https://blob.test/x.mp3' } as never);
    prisma.userVoice.update.mockResolvedValue(row());
    await svc.confirmClone(USER, dto() as never);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    // count() и create() оба происходят ВНУТРИ той же транзакции (через
    // мок $transaction, вызывающий колбэк с тем же prisma) — здесь
    // достаточно убедиться, что оба вызваны ровно один раз на попытку.
    expect(prisma.userVoice.count).toHaveBeenCalledTimes(1);
    expect(prisma.userVoice.create).toHaveBeenCalledTimes(1);
  });
});

describe('UserVoicesService.list', () => {
  it('строки без resembleVoiceId или не в TRAINING — не опрашиваются', async () => {
    const { svc, prisma, resemble } = build();
    prisma.userVoice.findMany.mockResolvedValue([
      row({ id: 'ready', status: 'READY' }),
      row({ id: 'no-remote', status: 'TRAINING', resembleVoiceId: null }),
    ]);
    const result = await svc.list(USER);
    expect(resemble.getVoiceStatus).not.toHaveBeenCalled();
    expect(result.map((v) => v.id)).toEqual(['ready', 'no-remote']);
  });

  it('TRAINING + finished у Resemble — переводит в READY и сохраняет', async () => {
    const { svc, prisma, resemble } = build();
    prisma.userVoice.findMany.mockResolvedValue([row({ status: 'TRAINING' })]);
    resemble.getVoiceStatus.mockResolvedValue({ status: 'finished' });
    prisma.userVoice.update.mockResolvedValue(row({ status: 'READY' }));
    const result = await svc.list(USER);
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'READY' },
    });
    expect(result[0].status).toBe('ready');
  });

  it('TRAINING + failed у Resemble — переводит в FAILED с причиной', async () => {
    const { svc, prisma, resemble } = build();
    prisma.userVoice.findMany.mockResolvedValue([row({ status: 'TRAINING' })]);
    resemble.getVoiceStatus.mockResolvedValue({ status: 'failed' });
    prisma.userVoice.update.mockResolvedValue(
      row({ status: 'FAILED', error: 'Resemble: статус "failed"' }),
    );
    const result = await svc.list(USER);
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'FAILED', error: 'Resemble: статус "failed"' },
    });
    expect(result[0].status).toBe('failed');
  });

  it('TRAINING + всё ещё pending — остаётся TRAINING, ничего не пишет', async () => {
    const { svc, prisma, resemble } = build();
    prisma.userVoice.findMany.mockResolvedValue([row({ status: 'TRAINING' })]);
    resemble.getVoiceStatus.mockResolvedValue({ status: 'pending' });
    const result = await svc.list(USER);
    expect(prisma.userVoice.update).not.toHaveBeenCalled();
    expect(result[0].status).toBe('training');
  });

  it('poll-запрос не удался (undefined) — остаётся TRAINING, не падает', async () => {
    const { svc, prisma, resemble } = build();
    prisma.userVoice.findMany.mockResolvedValue([row({ status: 'TRAINING' })]);
    resemble.getVoiceStatus.mockResolvedValue(undefined);
    const result = await svc.list(USER);
    expect(prisma.userVoice.update).not.toHaveBeenCalled();
    expect(result[0].status).toBe('training');
  });
});

describe('UserVoicesService.remove', () => {
  it('не найден или чужой — 404, ничего не удаляет', async () => {
    const { svc, prisma, resemble, blob } = build();
    prisma.userVoice.findUnique.mockResolvedValue(row({ userId: 'other' }));
    await expect(svc.remove(USER, 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(resemble.deleteVoice).not.toHaveBeenCalled();
    expect(blob.deleteBlob).not.toHaveBeenCalled();
    expect(prisma.userVoice.delete).not.toHaveBeenCalled();
  });

  it('успех: лучшее-старание удаление у Resemble, блоб и строка в БД', async () => {
    const { svc, prisma, resemble, blob } = build();
    prisma.userVoice.findUnique.mockResolvedValue(row());
    await svc.remove(USER, 'v1');
    expect(resemble.deleteVoice).toHaveBeenCalledWith('resemble-uuid-1');
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      'users/u1/voices/v1/sample.mp3',
    );
    expect(prisma.userVoice.delete).toHaveBeenCalledWith({
      where: { id: 'v1' },
    });
  });

  it('без resembleVoiceId — Resemble не трогаем, остальное удаляем', async () => {
    const { svc, prisma, resemble, blob } = build();
    prisma.userVoice.findUnique.mockResolvedValue(
      row({ resembleVoiceId: null }),
    );
    await svc.remove(USER, 'v1');
    expect(resemble.deleteVoice).not.toHaveBeenCalled();
    expect(blob.deleteBlob).toHaveBeenCalled();
    expect(prisma.userVoice.delete).toHaveBeenCalled();
  });
});

describe('UserVoicesService.handleWebhook', () => {
  it('нет id в теле — no-op', async () => {
    const { svc, prisma } = build();
    await svc.handleWebhook({ ok: true, status: 'finished' });
    expect(prisma.userVoice.findFirst).not.toHaveBeenCalled();
  });

  it('неизвестный resembleVoiceId — no-op, не бросает', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findFirst.mockResolvedValue(null);
    await expect(
      svc.handleWebhook({ ok: true, id: 'unknown', status: 'finished' }),
    ).resolves.toBeUndefined();
    expect(prisma.userVoice.update).not.toHaveBeenCalled();
  });

  it('уже не TRAINING (повторный вебхук) — не переигрывает статус', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findFirst.mockResolvedValue(row({ status: 'READY' }));
    await svc.handleWebhook({
      ok: true,
      id: 'resemble-uuid-1',
      status: 'finished',
    });
    expect(prisma.userVoice.update).not.toHaveBeenCalled();
  });

  it('ok+finished — переводит в READY', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findFirst.mockResolvedValue(row({ status: 'TRAINING' }));
    await svc.handleWebhook({
      ok: true,
      id: 'resemble-uuid-1',
      status: 'finished',
    });
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'READY' },
    });
  });

  it('ok: false или другой статус — переводит в FAILED с причиной', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findFirst.mockResolvedValue(row({ status: 'TRAINING' }));
    await svc.handleWebhook({
      ok: false,
      id: 'resemble-uuid-1',
      status: 'error',
    });
    expect(prisma.userVoice.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: {
        status: 'FAILED',
        error: expect.stringContaining('error'),
      },
    });
  });
});
