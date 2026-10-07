/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GreetingCardsService } from './greeting-cards.service';
import { MAX_CARD_TEXT_LENGTH } from '../../common/greeting-cards';
import type { SessionService } from '../../common/session.service';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';

function build(
  snapshot: Record<string, unknown> | null = {},
  opts: {
    beforeWrite?: (
      attempt: number,
      set: (patch: Record<string, unknown>) => void,
    ) => void;
  } = {},
) {
  let current: Record<string, unknown> | null =
    snapshot === null
      ? null
      : {
          occasion: 'BIRTHDAY',
          recipientName: 'Марина',
          senderName: 'Андрей',
          ...snapshot,
        };
  // «Параллельная» правка снимка из другого запроса — мимо сервиса.
  const set = (patch: Record<string, unknown>) => {
    current = { ...current, ...patch };
  };
  const updateSession = jest
    .fn()
    .mockImplementation((_id: string, patch: Record<string, any>) => {
      current = patch.greetingBriefSnapshot;
      return Promise.resolve(undefined);
    });
  const sessions = {
    getSession: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ sessionId: 's1', greetingBriefSnapshot: current }),
      ),
    updateSession,
  };
  const svc = new GreetingCardsService(
    sessions as unknown as SessionService,
    fakeSnapshotDb(sessions, {
      beforeWrite: (n) => opts.beforeWrite?.(n, set),
    }) as any,
  );
  return { svc, updateSession, snapshotNow: () => current };
}

describe('GreetingCardsService (фичи №38/№39)', () => {
  it('по умолчанию карточек нет — ни одной, включая титульную', async () => {
    // Титульная называет получателя в первую же секунду: для сюрприза
    // это ровно то, чего делать нельзя.
    const view = await build().svc.get('s1');
    expect(view.cards).toEqual({ title: null, closing: null });
  });

  it('заготовки берутся из брифа, но значениями не становятся', async () => {
    const view = await build().svc.get('s1');
    expect(view.suggested).toEqual({ title: 'Марина', closing: 'Андрей' });
    expect(view.cards.title).toBeNull();
  });

  it('заготовки пусты, если в брифе нечего подсказать', async () => {
    const view = await build({ recipientName: '  ', senderName: null }).svc.get(
      's1',
    );
    expect(view.suggested).toEqual({ title: null, closing: null });
  });

  it('текст сохраняется в снимок, остальное не трогается', async () => {
    const { svc, updateSession } = build();
    const view = await svc.update('s1', {
      title: 'Марине',
      closing: 'От Андрея',
    });
    expect(view.cards).toEqual({ title: 'Марине', closing: 'От Андрея' });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Марина',
        cards: { title: 'Марине', closing: 'От Андрея' },
      }),
    });
  });

  it('пробелы и переносы схлопываются, пустое становится null', async () => {
    const { svc } = build();
    const view = await svc.update('s1', {
      title: '  Марине \n и   Ане ',
      closing: '   ',
    });
    expect(view.cards.title).toBe('Марине и Ане');
    expect(view.cards.closing).toBeNull();
  });

  it('длинный текст обрезается на сервере, а не только на экране', async () => {
    const { svc } = build();
    const view = await svc.update('s1', {
      title: 'Я'.repeat(MAX_CARD_TEXT_LENGTH + 30),
      closing: null,
    });
    expect(view.cards.title).toHaveLength(MAX_CARD_TEXT_LENGTH);
  });

  it('одну карточку можно убрать, не трогая вторую', async () => {
    const { svc } = build({ cards: { title: 'Марине', closing: 'От Андрея' } });
    const view = await svc.update('s1', { title: null, closing: 'От Андрея' });
    expect(view.cards).toEqual({ title: null, closing: 'От Андрея' });
  });

  it('не поздравительная сессия — 404', async () => {
    const { svc } = build(null);
    await expect(svc.get('s1')).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * Этап B (Г-2 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md):
   * карточки вшиваются в файл и раньше модерацию не проходили вовсе.
   */
  it('карточка с запрещённым текстом отклоняется и не сохраняется', async () => {
    const { svc, updateSession } = build();
    await expect(
      svc.update('s1', { title: 'порнография в кадре', closing: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe('GreetingCardsService — стиль из бренд-бука (этап G, Г-6)', () => {
  it('правка текста не сбрасывает стиль, пришедший из бренд-бука', async () => {
    const { svc, updateSession } = build({
      cards: { style: { font: 'serif', color: 'gold' } },
    });
    await svc.update('s1', { title: 'Марине', closing: null });
    expect(updateSession.mock.calls[0][1].greetingBriefSnapshot.cards).toEqual({
      title: 'Марине',
      closing: null,
      style: { font: 'serif', color: 'gold' },
    });
  });

  it('стиль из запроса клиента не берётся — только из снимка', async () => {
    const { svc, updateSession } = build();
    await svc.update('s1', {
      title: 'x',
      style: { font: 'mono', color: 'pink' },
    } as never);
    expect(
      updateSession.mock.calls[0][1].greetingBriefSnapshot.cards.style,
    ).toBeUndefined();
  });
});

describe('GreetingCardsService — C2: запись снимка без потери правок', () => {
  it('пишется только cards — число сцен и музыка, выбранные параллельно, остаются', async () => {
    const musicTheme = { id: 'm1', title: 'Вальс', url: 'https://m' };
    const { svc, snapshotNow } = build(
      {},
      {
        beforeWrite: (n, set) => n === 1 && set({ sceneCount: 3, musicTheme }),
      },
    );
    await svc.update('s1', { title: 'Марине', closing: null });
    expect(snapshotNow()).toEqual(
      expect.objectContaining({
        sceneCount: 3,
        musicTheme,
        cards: { title: 'Марине', closing: null },
      }),
    );
  });

  it('стиль берётся из снимка в момент записи — не возвращается прочитанный раньше', async () => {
    const { svc, snapshotNow } = build(
      { cards: { style: { font: 'serif', color: 'gold' } } },
      {
        beforeWrite: (n, set) =>
          n === 1 && set({ cards: { style: { font: 'mono', color: 'pink' } } }),
      },
    );
    const view = await svc.update('s1', { title: 'Марине', closing: null });
    expect(snapshotNow()?.cards).toEqual({
      title: 'Марине',
      closing: null,
      style: { font: 'mono', color: 'pink' },
    });
    expect(view.cards.style).toEqual({ font: 'mono', color: 'pink' });
  });
});
