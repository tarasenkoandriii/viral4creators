/**
 * Приём находки из бота (этап 157,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.2).
 *
 * ## Кто сюда попадает
 *
 * Только активированный тестировщик. Любое его сообщение, не являющееся
 * командой, становится тикетом — не «сообщение с ключевым словом»:
 * человек в поле не помнит формат, а мы теряем находку.
 *
 * ## Порядок решений
 *
 * Частота → ответ на наше сообщение → склейка → новый тикет. Порядок
 * не произволен: ограничитель стоит первым, потому что он защищает всё
 * остальное, включая скачивание вложений; ответ раньше склейки, потому
 * что «да, теперь работает» не должно ни заводить находку, ни
 * подклеиваться к последней как её продолжение.
 *
 * ## Окружение
 *
 * Из бота его нет вовсе: сообщение в Telegram не несёт ничего о том,
 * где человек был секунду назад. Берём ПОСЛЕДНЕЕ ИЗВЕСТНОЕ, снятое в
 * мини-аппе, вместе с датой снятия — и в карточке оно так и подписано.
 * Разница принципиальна: человек мог написать боту с телефона про то,
 * что видел на десктопе, и уверенное «iOS» отправило бы оператора
 * искать не там.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import {
  DownloadFailure,
  TelegramFilesService,
} from './telegram-files.service';
import { hitRateLimit } from '../../common/rate-limit';
import {
  attachmentsOf,
  IncomingMessage,
  MAX_ATTACHMENTS,
  mergesInto,
  mergeText,
  RATE_LIMIT,
  RATE_WINDOW_SEC,
  rateVerdict,
  textOf,
} from '../../common/test-ticket';
import { envKeyOf, normalizeEnvironment } from '../../common/environment';

const TEXT = {
  tooOften:
    'Слишком много сообщений подряд — подождите немного, я всё запишу позже.',
  empty:
    'Не вижу ни текста, ни файла. Опишите, что сломалось, — можно со скриншотом.',
  tooBig:
    'Файл больше 20 МБ — столько Telegram боту не отдаёт. Пришлите короткий фрагмент или скриншот.',
  failed: 'Файл не удалось сохранить — попробуйте прислать ещё раз.',
  expired:
    'Тестовый доступ закончился — находки я больше не записываю. ' +
    'Если работа продолжается, напишите оператору: он продлит.',
};

interface TicketUser {
  id: string;
  lastEnvironment: unknown;
  lastEnvironmentAt: Date | null;
}

@Injectable()
export class TesterTicketsService {
  private readonly logger = new Logger(TesterTicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
    private readonly files: TelegramFilesService,
  ) {}

  /**
   * @returns `true`, если сообщение обработано как находка. `false` —
   * человек не тестировщик, и диспетчер разбирается сам.
   */
  async accept(
    telegramId: string,
    message: IncomingMessage,
    now: Date = new Date(),
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId },
      select: {
        id: true,
        isTestUser: true,
        testAccessUntil: true,
        lastEnvironment: true,
        lastEnvironmentAt: true,
      },
    });
    if (!user?.isTestUser) return false;
    if (
      user.testAccessUntil &&
      user.testAccessUntil.getTime() <= now.getTime()
    ) {
      // Не молчим (аудит этапа 159). Человек, который вчера присылал
      // находки и получал «Принято, #14», сегодня получил бы ничего — и
      // не отличил бы кончившийся доступ от сломанного бота. Это то же
      // рассуждение, по которому подтверждение обязательно (§3.2 ТЗ):
      // без ответа он не знает, дошло ли, и пишет второй раз.
      //
      // Ответ ОДИН раз в сутки: повторять его на каждое сообщение —
      // тот же спам, от которого бережёт ограничитель частоты.
      const { count } = await hitRateLimit(
        this.prisma,
        `tester-expired|u:${user.id}`,
        24 * 60 * 60,
        now,
        this.logger,
      );
      if (count === 1) await this.notify.dm(telegramId, TEXT.expired);
      return true;
    }

    const { count } = await hitRateLimit(
      this.prisma,
      `tester-ticket|u:${user.id}`,
      RATE_WINDOW_SEC,
      now,
      this.logger,
    );
    const verdict = rateVerdict(count, RATE_LIMIT);
    if (verdict !== 'allow') {
      if (verdict === 'warn') await this.notify.dm(telegramId, TEXT.tooOften);
      return true;
    }

    const text = textOf(message);
    const claims = attachmentsOf(message);
    if (!text && !claims.length) {
      // Стикер, геометка, пересланный контакт. Заводить из этого
      // находку нечестно, а молчать — значит оставить человека гадать.
      await this.notify.dm(telegramId, TEXT.empty);
      return true;
    }

    // Вложения качаются ДО развилки «комментарий или находка» (аудит
    // этапа 157): раньше комментарий до этой строки не доходил, и
    // скриншот в ответе на наше сообщение пропадал молча — а ответ,
    // состоявший ТОЛЬКО из файла, пропадал целиком.
    const { stored, failures } = await this.files.store(
      claims,
      `${user.id}/tickets/${now.getTime()}`,
    );

    const replyTo = message.reply_to_message?.message_id;
    if (replyTo) {
      const commented = await this.comment(user.id, replyTo, text, stored, now);
      // Ответ НЕ на наше сообщение (на своё же, на чужое) тикетом
      // всё-таки становится: это обычный способ уточнить собственную
      // мысль, и терять его было бы хуже.
      if (commented) {
        if (failures.length) {
          await this.notify.dm(telegramId, failureText(failures).join('\n'));
        }
        return true;
      }
    }

    const ticket = await this.upsert(user, text, stored, now);

    // «Принято» и «добавлено» — разные слова намеренно: одинаковое
    // подтверждение с одним и тем же номером дважды читается как два
    // тикета, а подтверждение и существует затем, чтобы человек знал,
    // что произошло.
    const lines = [
      ticket.merged
        ? `Добавлено к #${ticket.number}.`
        : `Принято, #${ticket.number}.`,
      ...failureText(failures),
    ];
    // Подтверждение обязательно: без него человек не знает, дошло ли,
    // и пишет второй раз.
    const sent = await this.notify.dmWithId(telegramId, lines.join('\n'));
    if (sent.messageId !== null) {
      await this.prisma.testTicket.update({
        where: { id: ticket.id },
        data: { botMessageIds: { push: sent.messageId } },
      });
    }
    return true;
  }

  /** Ответ на наше сообщение — комментарий в тот же тикет. */
  private async comment(
    userId: string,
    replyTo: number,
    text: string,
    attachments: unknown[],
    now: Date,
  ): Promise<boolean> {
    const ticket = await this.prisma.testTicket.findFirst({
      where: { userId, botMessageIds: { has: replyTo } },
      select: { id: true, comments: true },
    });
    if (!ticket) return false;
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    await this.prisma.testTicket.update({
      where: { id: ticket.id },
      data: {
        comments: [
          ...comments,
          // Вложения кладутся в сам комментарий, а не в `attachments`
          // тикета: «вот как это выглядит после вашей правки» — часть
          // ответа, и смешивать его с доказательствами исходной находки
          // значит терять, что к чему относилось.
          { at: now.toISOString(), from: 'TESTER', text, attachments },
        ] as unknown as object,
        // Комментарий — тоже сообщение человека, и окно склейки должно
        // ехать вместе с ним: иначе следующая фраза из той же мысли
        // заведёт находку.
        lastMessageAt: now,
      },
    });
    return true;
  }

  /** Склеить с самым свежим или завести новый. */
  private async upsert(
    user: TicketUser,
    text: string,
    attachments: unknown[],
    now: Date,
  ): Promise<{ id: string; number: number; merged: boolean }> {
    const previous = await this.prisma.testTicket.findFirst({
      where: { userId: user.id, source: 'BOT' },
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true,
        number: true,
        text: true,
        attachments: true,
        lastMessageAt: true,
      },
    });

    if (mergesInto(previous, now)) {
      const had = Array.isArray(previous?.attachments)
        ? previous.attachments
        : [];
      const merged = await this.prisma.testTicket.update({
        where: { id: previous!.id },
        data: {
          text: mergeText(previous!.text, text),
          attachments: [...had, ...attachments].slice(
            0,
            MAX_ATTACHMENTS,
          ) as unknown as object,
          lastMessageAt: now,
        },
        select: { id: true, number: true },
      });
      return { ...merged, merged: true };
    }

    const environment = normalizeEnvironment(user.lastEnvironment);
    const invite = await this.prisma.testerInvite.findFirst({
      where: { userId: user.id, revokedAt: null },
      orderBy: { activatedAt: 'desc' },
      select: { id: true },
    });

    const created = await this.prisma.testTicket.create({
      data: {
        userId: user.id,
        lastMessageAt: now,
        inviteId: invite?.id ?? null,
        source: 'BOT',
        text,
        attachments: attachments as unknown as object,
        // Локаль интерфейса обязательна. Из бота её неоткуда взять,
        // кроме последнего снимка, — и `uiLocale` тогда такая же
        // «последняя известная», как и всё остальное окружение.
        uiLocale: environment?.uiLocale || 'unknown',
        env: (environment as unknown as object) ?? undefined,
        envKey: environment
          ? envKeyOf(environment, { scenario: null, stepId: null })
          : null,
        envCapturedAt: environment ? user.lastEnvironmentAt : null,
        appBuild: environment?.appBuild ?? null,
      },
      select: { id: true, number: true },
    });
    return { ...created, merged: false };
  }
}

/** Что не доехало — словами. Молча терять вложение нельзя: человек
 * будет считать, что прислал. */
function failureText(failures: DownloadFailure[]): string[] {
  const lines: string[] = [];
  if (failures.includes('too-big')) lines.push(TEXT.tooBig);
  if (failures.includes('failed')) lines.push(TEXT.failed);
  return lines;
}
