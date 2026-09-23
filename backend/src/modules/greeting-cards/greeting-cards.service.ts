/**
 * GreetingCardsService — текст титульной карточки и закрывающей
 * подписи (фичи №38/№39).
 *
 * Сервис намеренно тонкий: вся вёрстка в `common/greeting-cards.ts`,
 * здесь только «сохранить то, что написал человек» плюс заготовки,
 * которые экран подставит в пустые поля.
 *
 * Заготовки — ПОДСКАЗКА, а не значение. Подставлять их молча нельзя:
 * титульная карточка называет получателя в первую же секунду ролика, а
 * для сюрприза это ровно то, чего делать нельзя. Включает её
 * отправитель, глядя на предупреждение.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GreetingCards,
  GreetingCardsView,
} from '../../common/types/greeting.types';
import { MAX_CARD_TEXT_LENGTH } from '../../common/greeting-cards';

@Injectable()
export class GreetingCardsService {
  constructor(private readonly sessions: SessionService) {}

  async get(sessionId: string): Promise<GreetingCardsView> {
    const snapshot = (await this.load(sessionId)).greetingBriefSnapshot!;
    return {
      cards: {
        title: snapshot.cards?.title ?? null,
        closing: snapshot.cards?.closing ?? null,
      },
      suggested: {
        // «Марине», а не «Для Марины»: имя в брифе уже в именительном,
        // а склонять его мы не умеем и не будем — чужое имя, угаданное
        // неверно, хуже отсутствия подписи.
        title: snapshot.recipientName?.trim() || null,
        closing: snapshot.senderName?.trim() || null,
      },
    };
  }

  async update(
    sessionId: string,
    cards: GreetingCards,
  ): Promise<GreetingCardsView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    const next: GreetingCards = {
      title: clean(cards.title),
      closing: clean(cards.closing),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, cards: next },
    });
    return { ...(await this.get(sessionId)), cards: next };
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException(
        `Session ${sessionId} is not a greeting session`,
      );
    }
    return session;
  }
}

/** Пусто и «только пробелы» — одно и то же: карточки нет. */
function clean(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, ' ') ?? '';
  return text ? text.slice(0, MAX_CARD_TEXT_LENGTH) : null;
}
