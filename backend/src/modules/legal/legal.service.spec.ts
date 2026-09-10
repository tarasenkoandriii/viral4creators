/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { LegalService, TERMS_VERSION, toStatus } from './legal.service';

function build(row: unknown) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
    },
  };
  return { svc: new LegalService(prisma as any), prisma };
}

describe('LegalService.assertAccepted (ТЗ §20, этап 38)', () => {
  it('принявший текущую версию проходит', async () => {
    const { svc } = build({
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    });
    await expect(svc.assertAccepted('u1')).resolves.toBeUndefined();
  });

  it('не принявший — отказ, а не тихий пропуск', async () => {
    // На согласии стоят права сервиса на Разбор (§4 условий) и вместе с
    // ними легитимность общей Библиотеки: разбор без согласия попадал бы
    // в неё и предлагался другим.
    const { svc } = build({ termsAcceptedAt: null, termsVersion: null });
    await expect(svc.assertAccepted('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('принявший СТАРУЮ версию должен принять заново', async () => {
    const { svc } = build({
      termsAcceptedAt: new Date(),
      termsVersion: '2020-01-01',
    });
    await expect(svc.assertAccepted('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('анонимный проходит, и в базу за ним не ходят', async () => {
    // Строки пользователя у него нет, писать согласие некуда; заводить
    // её ради галочки хуже для человека, чем сама галочка.
    const { svc, prisma } = build(null);
    await expect(svc.assertAccepted(null)).resolves.toBeUndefined();
    await expect(svc.assertAccepted(undefined)).resolves.toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('неизвестный пользователь считается не принявшим', async () => {
    const { svc } = build(null);
    await expect(svc.assertAccepted('u-unknown')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('toStatus', () => {
  it('версия в ответе всегда текущая — по ней клиент решает, спрашивать ли', () => {
    expect(toStatus(null)).toEqual({
      version: TERMS_VERSION,
      acceptedAt: null,
      accepted: false,
    });
  });
});
