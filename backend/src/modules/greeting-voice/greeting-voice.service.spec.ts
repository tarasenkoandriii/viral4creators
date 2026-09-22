/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// Тот же приём, что у соседей: `SessionService` рантаймом импортирует
// `Prisma`/`WorkflowKind` из `@prisma/client`, которого на стенде без
// `prisma generate` нет.
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: { SINGLE: 'SINGLE', LINE: 'LINE' },
}));

import { NotFoundException } from '@nestjs/common';
import { GreetingVoiceService } from './greeting-voice.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SessionService } from '../../common/session.service';

const READY = {
  id: 'uv1',
  label: 'Мой голос',
  status: 'READY',
  resembleVoiceId: 'clone-42',
};

function build(
  over: {
    session?: Record<string, unknown> | undefined;
    voice?: Record<string, unknown> | null;
  } = {},
) {
  const findFirst = jest
    .fn()
    .mockResolvedValue(over.voice === undefined ? READY : over.voice);
  const updateSession = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    getSession: jest.fn().mockResolvedValue(
      over.session === undefined
        ? {
            sessionId: 's1',
            userId: 'u1',
            greetingBriefSnapshot: { recipientName: 'Аня', senderVoice: null },
          }
        : over.session,
    ),
    updateSession,
  };
  const prisma = { userVoice: { findFirst } };
  const svc = new GreetingVoiceService(
    prisma as unknown as PrismaService,
    sessions as unknown as SessionService,
  );
  return { svc, findFirst, updateSession, sessions };
}

describe('GreetingVoiceService — голос отправителя (фича №34)', () => {
  it('готовый свой клон записывается в снимок брифа целиком, а не ссылкой', async () => {
    // Копия, а не id: клон можно удалить у себя в кабинете, и ролик,
    // который ссылался бы по id, потерял бы озвучку задним числом.
    const { svc, updateSession } = build();
    const picked = await svc.select('s1', 'clone-42');
    expect(picked).toEqual({
      userVoiceId: 'uv1',
      resembleVoiceId: 'clone-42',
      label: 'Мой голос',
    });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Аня',
        senderVoice: picked,
      }),
    });
  });

  it('чужой голос не выбирается — запрос идёт с userId сессии', async () => {
    // `resembleVoiceId` приходит от клиента, а ключ Resemble у продукта
    // один на всех пользователей: без фильтра по владельцу чужой
    // идентификатор озвучил бы поздравление чужим голосом.
    const { svc, findFirst, updateSession } = build({ voice: null });
    await expect(svc.select('s1', 'clone-чужой')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', resembleVoiceId: 'clone-чужой' },
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('голос ещё обучается — отказ сразу, а не молчаливый провал после рендера', async () => {
    // `resembleVoiceId` у TRAINING-записи УЖЕ проставлен: он приходит
    // ответом на запуск обучения, задолго до готовности
    // (`UserVoicesService.confirmClone`). Значит непустой идентификатор
    // «готовностью» не является, и проверять надо именно статус.
    const { svc, updateSession } = build({
      voice: { ...READY, status: 'TRAINING' },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('обучение провалилось — тоже отказ', async () => {
    const { svc } = build({ voice: { ...READY, status: 'FAILED' } });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('анонимная сессия своих клонов не имеет — до базы дело не доходит', async () => {
    const { svc, findFirst } = build({
      session: {
        sessionId: 's1',
        userId: null,
        greetingBriefSnapshot: { recipientName: 'Аня' },
      },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('null снимает выбор, не трогая остальной снимок', async () => {
    const { svc, findFirst, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: {
          recipientName: 'Аня',
          senderVoice: { userVoiceId: 'uv1', resembleVoiceId: 'c', label: 'L' },
        },
      },
    });
    await expect(svc.select('s1', null)).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: { recipientName: 'Аня', senderVoice: null },
    });
  });

  it('не поздравительная сессия — 404, а не запись senderVoice в товарный снимок', async () => {
    const { svc, updateSession } = build({
      session: { sessionId: 's1', userId: 'u1', productInformation: {} },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('сессии нет вовсе — 404', async () => {
    const { svc } = build({ session: null as never });
    await expect(svc.get('s1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get отдаёт уже выбранный голос', async () => {
    const senderVoice = {
      userVoiceId: 'uv1',
      resembleVoiceId: 'clone-42',
      label: 'Мой голос',
    };
    const { svc } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: { recipientName: 'Аня', senderVoice },
      },
    });
    await expect(svc.get('s1')).resolves.toEqual(senderVoice);
  });
});
