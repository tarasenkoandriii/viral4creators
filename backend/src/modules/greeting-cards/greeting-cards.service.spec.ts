/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { NotFoundException } from '@nestjs/common';
import { GreetingCardsService } from './greeting-cards.service';
import { MAX_CARD_TEXT_LENGTH } from '../../common/greeting-cards';
import type { SessionService } from '../../common/session.service';

function build(snapshot: Record<string, unknown> | null = {}) {
  let current: Record<string, unknown> | null =
    snapshot === null
      ? null
      : {
          occasion: 'BIRTHDAY',
          recipientName: 'Марина',
          senderName: 'Андрей',
          ...snapshot,
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
  const svc = new GreetingCardsService(sessions as unknown as SessionService);
  return { svc, updateSession };
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
});
