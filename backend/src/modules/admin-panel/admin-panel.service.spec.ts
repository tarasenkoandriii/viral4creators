/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Б-5.9: удаление сессии оператором уносит и её файлы.
 *
 * Правило §22 одно на весь проект — удаление владельца обязано удалить
 * файл, — и этот путь был единственным, который его нарушал: строку
 * сносил, а ролик, референс и кадры оставлял. Мусор подобрала бы метла
 * через сутки, но только потому, что она есть.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { AdminPanelService } from './admin-panel.service';

const row = (data: Record<string, unknown> = {}) => ({
  id: 's1',
  status: 'video_complete',
  createdAt: new Date('2026-09-01T10:00:00Z'),
  lastActivityAt: new Date('2026-09-01T11:00:00Z'),
  userId: 'u1',
  projectId: null,
  productItemId: null,
  data: {
    generatedVideo: {
      pathname: 'sessions/s1/generated.mp4',
      postPathname: 'sessions/s1/generated-1080x1350.mp4',
      voiceoverPathname: 'sessions/s1/voiceover.mp3',
      downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
    },
    ...data,
  },
});

function build(found: unknown = row()) {
  const prisma = {
    session: {
      findUnique: jest.fn().mockResolvedValue(found),
      delete: jest.fn().mockResolvedValue(undefined),
    },
  };
  const blob = { deleteMany: jest.fn().mockResolvedValue(3) };
  return {
    svc: new AdminPanelService(prisma as any, blob as any),
    prisma,
    blob,
  };
}

describe('AdminPanelService.deleteSession (Б-5.9)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('удаляет строку и ВСЕ файлы сессии', async () => {
    const { svc, prisma, blob } = build();

    await expect(svc.deleteSession('s1')).resolves.toEqual({ ok: true });

    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    const paths = blob.deleteMany.mock.calls[0][0] as string[];
    // Самые тяжёлые файлы сервиса — ролик, обрезанная версия и дорожка.
    expect(paths).toEqual(
      expect.arrayContaining([
        'sessions/s1/generated.mp4',
        'sessions/s1/generated-1080x1350.mp4',
        'sessions/s1/voiceover.mp3',
      ]),
    );
  });

  it('пути собираются ДО удаления строки', async () => {
    // Обратный порядок означал бы, что при сбое между шагами файлы
    // становятся сиротами без единой ссылки.
    const order: string[] = [];
    const { svc, prisma, blob } = build();
    prisma.session.delete.mockImplementation(async () => {
      order.push('строка');
    });
    blob.deleteMany.mockImplementation(async () => {
      order.push('файлы');
      return 3;
    });

    await svc.deleteSession('s1');

    expect(order).toEqual(['строка', 'файлы']);
  });

  it('сбой хранилища не отменяет удаление: сессии уже нет', async () => {
    const { svc, blob } = build();
    blob.deleteMany.mockRejectedValue(new Error('Blob недоступен'));

    await expect(svc.deleteSession('s1')).resolves.toEqual({ ok: true });
  });

  it('сессия без файлов не зовёт хранилище впустую', async () => {
    const { svc, blob } = build(row({ generatedVideo: undefined }));
    await svc.deleteSession('s1');
    expect(blob.deleteMany).not.toHaveBeenCalled();
  });

  it('несуществующая сессия — 404 и ни одного удаления', async () => {
    const { svc, prisma, blob } = build(null);
    await expect(svc.deleteSession('нет')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.session.delete).not.toHaveBeenCalled();
    expect(blob.deleteMany).not.toHaveBeenCalled();
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
