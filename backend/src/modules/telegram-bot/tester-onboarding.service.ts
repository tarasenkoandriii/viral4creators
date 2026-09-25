/**
 * Активация приглашения тестировщика по `/start` (этап 155,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §2.2).
 *
 * Единственное место, где тестовый доступ выдаётся не руками оператора.
 * Права выдаются ровно те, что записаны в приглашении: чтобы выдать
 * больше, оператор заводит другое приглашение или правит доступ в
 * карточке пользователя, как и раньше.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { inviteVerdict } from '../../common/tester-invite';
import {
  FREE_SCENARIO_LABELS,
  normalizeFreeScenarios,
} from '../../common/test-user-scenarios';

export interface StartInput {
  token: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  languageCode: string | null;
}

/**
 * Ответы бота. Русский по умолчанию: приглашение язык тестировщика не
 * хранит, а `language_code` приходит от клиента и может быть любым из
 * сотни (второй аудит ТЗ, Б-7). Пять наших локалей появятся здесь
 * вместе с экраном `#/testing`, где тексты и так придётся переводить.
 */
const TEXT = {
  unknown: 'Ссылка недействительна.',
  taken: 'Эта ссылка уже использована.',
  blocked: 'Доступ к сервису ограничен. Напишите оператору.',
  paid: 'У вас действует платная подписка — тестовый доступ поверх неё не выдаётся. Напишите оператору.',
};

@Injectable()
export class TesterOnboardingService {
  private readonly logger = new Logger(TesterOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
  ) {}

  async activate(input: StartInput): Promise<void> {
    const invite = await this.prisma.testerInvite.findUnique({
      where: { token: input.token },
    });
    if (!invite) {
      await this.notify.dm(input.telegramId, TEXT.unknown);
      return;
    }

    // Пользователь создаётся ДО вердикта: `botChatOpenedAt` — это факт
    // «диалог существует», и он верен независимо от того, дадим мы
    // доступ или откажем. Потерять его из-за отказа значило бы не уметь
    // написать человеку ровно тогда, когда объяснить надо больше всего.
    const user = await this.prisma.user.upsert({
      where: { telegramId: input.telegramId },
      create: {
        telegramId: input.telegramId,
        username: input.username ?? undefined,
        firstName: input.firstName ?? undefined,
        botChatOpenedAt: new Date(),
      },
      update: { botChatOpenedAt: new Date() },
      select: { id: true, isBlocked: true },
    });

    const verdict = inviteVerdict(
      {
        token: invite.token,
        freeScenarios: invite.freeScenarios,
        expiresAt: invite.expiresAt,
        revokedAt: invite.revokedAt,
        userId: invite.userId,
      },
      user.id,
      new Date(),
    );

    if (verdict.kind === 'repeat') {
      await this.notify.dm(input.telegramId, this.greeting(invite));
      return;
    }
    if (verdict.kind !== 'activate') {
      // Отозванное, просроченное и занятое отвечают ОДИНАКОВО: человеку
      // это одинаково означает «не работает», а разные ответы
      // рассказали бы постороннему, что стало с чужой ссылкой.
      await this.notify.dm(
        input.telegramId,
        verdict.kind === 'taken' ? TEXT.taken : TEXT.unknown,
      );
      return;
    }

    // Блокировка сильнее тестового доступа — тот же порядок, что в
    // `PlanService.assertSpend` (второй аудит ТЗ, Б-4). Иначе
    // заблокированный обходил бы блокировку по пересланной ссылке.
    if (user.isBlocked) {
      await this.notify.dm(input.telegramId, TEXT.blocked);
      return;
    }

    // Платящий клиент — отказ (Б-3). Выдать тестовый доступ поверх
    // оплаченного значит молча изменить человеку правила списания;
    // решение об этом принимает оператор, а не пересланная ссылка.
    //
    // `RENEWING` тоже считается действующей: деньги за период уже
    // взяты, и разница между ней и `ACTIVE` — про следующее списание,
    // а не про то, платит ли человек сейчас.
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { status: true },
    });
    if (
      subscription?.status === 'ACTIVE' ||
      subscription?.status === 'RENEWING'
    ) {
      await this.notify.dm(input.telegramId, TEXT.paid);
      return;
    }

    const scenarios = normalizeFreeScenarios(invite.freeScenarios);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          isTestUser: true,
          freeScenarios: scenarios,
          testAccessUntil: invite.expiresAt,
        },
      }),
      this.prisma.testerInvite.update({
        where: { id: invite.id },
        data: { userId: user.id, activatedAt: new Date() },
      }),
    ]);

    this.logger.warn(
      `приглашение ${invite.id} активировано пользователем ${input.telegramId}: [${scenarios.join(', ')}]`,
    );
    await this.notify.dm(input.telegramId, this.greeting(invite));
  }

  /**
   * Приветствие. Говорит ровно то, что уже действует: сценарии и срок.
   * Про суточный потолок и операции вне проекта здесь молчим — они
   * появятся вместе с их проверками (этап 5 ТЗ), а обещать в первом же
   * сообщении то, чего ещё нет, — худший способ начать работу с
   * человеком, который пришёл искать наши ошибки.
   */
  private greeting(invite: {
    freeScenarios: string[];
    expiresAt: Date | null;
  }): string {
    const scenarios = normalizeFreeScenarios(invite.freeScenarios)
      .map((code) => FREE_SCENARIO_LABELS[code] ?? code)
      .join(', ');
    const lines = [
      'Тестовый доступ открыт.',
      scenarios ? `Бесплатно: ${scenarios}.` : 'Сценарии пока не открыты.',
    ];
    if (invite.expiresAt) {
      lines.push(
        `Действует до ${invite.expiresAt.toISOString().slice(0, 10)}.`,
      );
    }
    lines.push('О находках пишите прямо сюда, в этот чат.');
    return lines.join('\n');
  }
}
