/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { WizardGuideService } from './wizard-guide.service';

function build(
  project: Record<string, unknown> | null = {
    type: 'CLIENT_SITE',
    aiGuideEnabled: false,
  },
  over: { frames?: number[]; sessions?: number; globalOn?: boolean } = {},
) {
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue(project),
      update: jest.fn().mockResolvedValue({}),
    },
    clientSiteTutorialDraft: {
      findUnique: jest
        .fn()
        .mockResolvedValue(over.frames ? { stepsPerRound: over.frames } : null),
    },
    session: { count: jest.fn().mockResolvedValue(over.sessions ?? 0) },
  };
  const settings = {
    get: jest.fn().mockResolvedValue(over.globalOn ? 'true' : null),
  };
  return {
    svc: new WizardGuideService(prisma as any, settings as any),
    prisma,
    settings,
  };
}

describe('WizardGuideService — чекбокс ИИ (§3)', () => {
  it('чужой проект — 404, а не тихий отказ', async () => {
    const { svc } = build(null);
    await expect(svc.stateOf('u1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('глобально выключено по умолчанию', async () => {
    // Фича, тратящая деньги на каждом шаге у каждого пользователя,
    // включается сознательно — как лендинговый ассистент.
    const { svc } = build();
    expect((await svc.stateOf('u1', 'p1')).available).toBe(false);
  });

  it('включение в начале сценария проходит', async () => {
    const { svc, prisma } = build();
    const state = await svc.setEnabled('u1', 'p1', true);
    expect(prisma.project.update).toHaveBeenCalled();
    expect(state.enabled).toBe(false); // стейт перечитан у двойника
  });

  it('включение после первого записанного раунда — 409', async () => {
    // Линия либо проведена с начала, либо её нет: советник,
    // подключённый на пятом шаге, не видел первых четырёх.
    const { svc, prisma } = build(undefined, { frames: [1, 2] });
    await expect(svc.setEnabled('u1', 'p1', true)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('включение после создания сессии — 409 (greeting, товарка)', async () => {
    const { svc } = build(
      { type: 'GREETING_VIDEO', aiGuideEnabled: false },
      { sessions: 1 },
    );
    await expect(svc.setEnabled('u1', 'p1', true)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('ВЫКЛЮЧЕНИЕ проходит и посреди сценария', async () => {
    // Асимметрия и есть решение владельца: включить — только в начале,
    // выключить — когда угодно.
    const { svc, prisma } = build(
      { type: 'CLIENT_SITE', aiGuideEnabled: true },
      { frames: [1, 2, 3] },
    );
    await svc.setEnabled('u1', 'p1', false);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { aiGuideEnabled: false },
    });
  });

  it('повторное включение уже включённого не проверяет поздноту', async () => {
    // Иначе включённый в начале проект переставал бы сохраняться
    // посреди сценария на любом повторном PATCH от интерфейса.
    const { svc, prisma } = build(
      { type: 'CLIENT_SITE', aiGuideEnabled: true },
      { frames: [1, 2, 3] },
    );
    await expect(svc.setEnabled('u1', 'p1', true)).resolves.toBeDefined();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('у обучалки прогресс читается из колонки раундов, а не из сессий', async () => {
    const { svc, prisma } = build(undefined, { frames: [] });
    await svc.stateOf('u1', 'p1');
    expect(prisma.clientSiteTutorialDraft.findUnique).toHaveBeenCalled();
    expect(prisma.session.count).not.toHaveBeenCalled();
  });

  // ── Найдено аудитом ТЗ перед волной D ────────────────────────────

  it('в товарке чекбокс доступен на первом шаге, хотя сессия уже есть', async () => {
    // Сессию товарки создаёт та же кнопка, которая ОТКРЫВАЕТ мастер.
    // С общим признаком «есть сессия» чекбокс был бы недоступен уже на
    // первом кадре — то есть советы в товарке нельзя было бы включить
    // никогда. ТЗ §3.2 всё это время говорило «пока не начат разбор».
    const { svc, prisma } = build({
      type: 'SINGLE',
      aiGuideEnabled: false,
    });
    // Двойник считает сессии с ещё не начатым разбором: их ноль.
    prisma.session.count.mockResolvedValue(0);
    expect((await svc.stateOf('u1', 'p1')).canEnable).toBe(true);
    const where = prisma.session.count.mock.calls[0][0].where;
    expect(where.status).toBeDefined();
    expect(where.status.notIn).toContain('created');
  });

  it('в товарке начатый разбор закрывает чекбокс', async () => {
    const { svc, prisma } = build({ type: 'LINE', aiGuideEnabled: false });
    prisma.session.count.mockResolvedValue(1);
    expect((await svc.stateOf('u1', 'p1')).canEnable).toBe(false);
  });

  it('в greeting признак прежний — сессии ещё нет', async () => {
    // Там сессия создаётся кнопкой ПОСЛЕ брифа, то есть весь первый шаг
    // её не существует, и статусы спрашивать незачем.
    const { svc, prisma } = build({
      type: 'GREETING_VIDEO',
      aiGuideEnabled: false,
    });
    await svc.stateOf('u1', 'p1');
    expect(prisma.session.count.mock.calls[0][0].where.status).toBeUndefined();
  });
});
