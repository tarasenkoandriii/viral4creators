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
  consentAt: NOW,
  buildRequestedAt: null,
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
      updateMany: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    brandManifest: { updateMany: jest.Mock };
    storyVideoSegment: { updateMany: jest.Mock };
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  } = {
    userVoice: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    // CONTRACT6 п.4: удалённый голос уходит из бренд-буков пользователя.
    brandManifest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    // Story-Tales (F1): video speech of a deleted clone is erased with it.
    storyVideoSegment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    buildVoice: jest.fn().mockResolvedValue({ ok: true }),
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

  it('тип с параметром кодека: путь и подпись Blob — под голый тип (иначе PUT получит 400)', async () => {
    const { svc, blob } = build();
    const r = await svc.createUploadUrl(USER, {
      fileName: 'sample',
      fileSize: 1000,
      mimeType: 'audio/webm;codecs=opus',
    } as never);
    expect(r.pathname).toMatch(/\/sample\.webm$/);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/webm',
      15 * 1024 * 1024,
    );
  });

  it('WAV из браузера — sample.wav и подпись под audio/wav', async () => {
    const { svc, blob } = build();
    const r = await svc.createUploadUrl(USER, {
      fileName: 'sample',
      fileSize: 1000,
      mimeType: 'audio/wav',
    } as never);
    expect(r.pathname).toMatch(/\/sample\.wav$/);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/wav',
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
    // Голос персоны «Я в кадре» в лимит не входит — `personaId: null`.
    expect(prisma.userVoice.count).toHaveBeenCalledWith({
      where: { userId: USER, personaId: null, status: { not: 'FAILED' } },
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
    // Story-Tales video speech synthesized by this clone is wiped, not kept.
    expect(prisma.storyVideoSegment.updateMany).toHaveBeenCalledWith({
      where: { userVoiceId: 'v1', status: { not: 'DELETED' } },
      data: {
        status: 'DELETED',
        audio: null,
        audioHash: null,
        durationSeconds: null,
        text: '',
      },
    });
    // ST2-S-08: their cache keys (sha256 of the exact text) are replaced too.
    const raw = prisma.$executeRaw.mock.calls.find(([parts]: any[]) =>
      parts.join('?').includes('"story_video_segments" SET "cacheKey"'),
    );
    expect(raw).toBeDefined();
    expect(raw![0].join('?')).toContain(
      `encode(sha256(convert_to('story-deleted:' || "id", 'UTF8')), 'hex')`,
    );
    expect(raw!.slice(1)).toEqual(['v1']);
  });

  it('CONTRACT6 п.4: голос уходит из бренд-буков ЭТОГО пользователя (голос и провайдер)', async () => {
    const { svc, prisma } = build();
    prisma.userVoice.findUnique.mockResolvedValue(row());
    await svc.remove(USER, 'v1');
    expect(prisma.brandManifest.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, ttsVoiceId: 'resemble-uuid-1' },
      data: { ttsVoiceId: null, ttsProvider: null },
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
    expect(prisma.brandManifest.updateMany).not.toHaveBeenCalled();
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

function retrySetup() {
  const s = build();
  const current: any = row({
    status: 'FAILED',
    resembleVoiceId: null,
    error: 'Resemble 400',
    consentAt: NOW,
  });
  s.prisma.userVoice.findFirst.mockImplementation(async ({ where }: any) =>
    where.userId === current.userId && where.id === current.id
      ? { ...current }
      : null,
  );
  s.prisma.userVoice.update.mockImplementation(async ({ data }: any) => {
    Object.assign(current, data);
    return { ...current };
  });
  s.prisma.userVoice.updateMany.mockImplementation(
    async ({ where, data }: any) => {
      if (where.buildRequestedAt === null && current.buildRequestedAt)
        return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    },
  );
  let chain = Promise.resolve();
  s.prisma.$transaction.mockImplementation((fn: any) => {
    const next = chain.then(() => fn(s.prisma));
    chain = next.catch(() => {});
    return next;
  });
  return { ...s, current };
}
describe('UserVoicesService explicit retry of a rejected clone', () => {
  it('reuses the owned recording and original consent without creating or deleting a row', async () => {
    const s = retrySetup();
    const result = await s.svc.retry(USER, 'v1');
    expect(result.status).toBe('training');
    expect(s.resemble.cloneVoice).toHaveBeenCalledWith(
      'Мой голос',
      s.current.sampleUrl,
      undefined,
    );
    expect(s.current.consentAt).toBe(NOW);
    expect(s.prisma.userVoice.create).not.toHaveBeenCalled();
    expect(s.prisma.userVoice.delete).not.toHaveBeenCalled();
    expect(s.aiUsage.record).toHaveBeenCalledTimes(1);
  });
  it('denies another owner before calling the provider', async () => {
    const s = retrySetup();
    await expect(s.svc.retry('other', 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
  });
  it('refuses uncertain responses, provider IDs and missing original consent', async () => {
    const s = retrySetup();
    s.current.error = 'ошибка Resemble: timeout';
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow(
      'проверки оператором',
    );
    s.current.error = 'Resemble 400';
    s.current.resembleVoiceId = 'already-created';
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow(
      'проверки оператором',
    );
    s.current.resembleVoiceId = null;
    s.current.consentAt = null;
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow(
      'проверки оператором',
    );
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
  });
  it('returns existing training or ready state without another paid start', async () => {
    const s = retrySetup();
    for (const status of ['TRAINING', 'READY']) {
      s.current.status = status;
      await s.svc.retry(USER, 'v1');
    }
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
  });
  it('holds the user slot limit before retry', async () => {
    const s = retrySetup();
    s.prisma.userVoice.count.mockResolvedValue(3);
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow('лимит');
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent retries and does not charge a definite refusal', async () => {
    const s = retrySetup();
    await Promise.all([s.svc.retry(USER, 'v1'), s.svc.retry(USER, 'v1')]);
    expect(s.resemble.cloneVoice).toHaveBeenCalledTimes(1);
    s.current.status = 'FAILED';
    s.current.resembleVoiceId = null;
    s.current.error = 'Resemble 400';
    s.current.buildRequestedAt = null;
    s.resemble.cloneVoice.mockResolvedValue({
      ok: false,
      reason: 'Resemble 400',
    });
    s.aiUsage.record.mockClear();
    expect((await s.svc.retry(USER, 'v1')).retryAllowed).toBe(true);
    expect(s.aiUsage.record).not.toHaveBeenCalled();
  });
});

describe('Explicit provider build lifecycle', () => {
  it('starts legacy pending training once under concurrent requests without creating another voice', async () => {
    const s = retrySetup();
    Object.assign(s.current, {
      status: 'TRAINING',
      resembleVoiceId: 'existing-uuid',
      error: null,
    });
    s.resemble.getVoiceStatus.mockResolvedValue({ status: 'pending' });
    await Promise.all([s.svc.retry(USER, 'v1'), s.svc.retry(USER, 'v1')]);
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
    expect(s.resemble.buildVoice).toHaveBeenCalledTimes(1);
    expect(s.current.buildRequestedAt).toBeInstanceOf(Date);
  });
  it('never retries an uncertain build submission', async () => {
    const s = retrySetup();
    s.resemble.buildVoice.mockResolvedValue({
      ok: false,
      reason: 'Результат запуска не подтверждён',
    });
    expect((await s.svc.retry(USER, 'v1')).status).toBe('failed');
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow(
      'проверки оператором',
    );
    expect(s.resemble.buildVoice).toHaveBeenCalledTimes(1);
  });
  it('recognizes a remote ready clone without rebuilding', async () => {
    const s = retrySetup();
    Object.assign(s.current, {
      status: 'TRAINING',
      resembleVoiceId: 'existing-uuid',
      error: null,
    });
    s.resemble.getVoiceStatus.mockResolvedValue({ status: 'ready' });
    expect((await s.svc.retry(USER, 'v1')).status).toBe('ready');
    expect(s.resemble.buildVoice).not.toHaveBeenCalled();
    s.current.status = 'TRAINING';
    s.resemble.getVoiceStatus.mockResolvedValue({ status: 'processing' });
    await expect(s.svc.retry(USER, 'v1')).rejects.toThrow('уже обрабатывается');
    expect(s.resemble.buildVoice).not.toHaveBeenCalled();
  });
});

describe('Provider progress callbacks are not terminal failures', () => {
  it('ignores initializing and other intermediate webhooks without changing the voice', async () => {
    const s = build();
    s.prisma.userVoice.findFirst.mockResolvedValue(row({ status: 'TRAINING' }));
    for (const status of [
      'initializing',
      'pending',
      'processing',
      'training',
      'building',
      'queued',
    ]) {
      await s.svc.handleWebhook({ id: 'resemble-uuid-1', status, ok: true });
      await s.svc.handleWebhook({ id: 'resemble-uuid-1', status, ok: false });
    }
    expect(s.prisma.userVoice.update).not.toHaveBeenCalled();
  });
  it('repairs a legacy initializing misclassification by polling, without any new training', async () => {
    const s = build();
    s.prisma.userVoice.findMany.mockResolvedValue([
      row({
        status: 'FAILED',
        error: 'Resemble сообщил об ошибке обучения (status: initializing)',
        buildRequestedAt: NOW,
      }),
    ]);
    s.resemble.getVoiceStatus.mockResolvedValue({ status: 'ready' });
    s.prisma.userVoice.update.mockResolvedValue(
      row({ status: 'READY', error: null }),
    );
    expect((await s.svc.list(USER))[0].status).toBe('ready');
    expect(s.prisma.userVoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'FAILED', userId: USER }),
        data: { status: 'TRAINING', error: null },
      }),
    );
    expect(s.resemble.buildVoice).not.toHaveBeenCalled();
    expect(s.resemble.cloneVoice).not.toHaveBeenCalled();
  });
});
