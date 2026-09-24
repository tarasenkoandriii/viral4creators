/**
 * Подписка на Telegram-канал — «Условно бесплатный Lite» Р2/§6.4,
 * этап 133.
 *
 * ## Почему это самый дешёвый способ заплатить
 *
 * Ни OAuth, ни экрана согласия, ни хранения чужого токена: один вызов
 * к боту, который у продукта уже есть (тот же `TELEGRAM_BOT_TOKEN`,
 * которым валидируется initData). Для мини-аппа трение почти нулевое —
 * человек не выходит из Telegram вовсе.
 *
 * ## Что проверяем и чем это НЕ является
 *
 * Спрашиваем у Telegram один вопрос: состоит ли человек в канале
 * (`getChatMember`). Проверка ОДНОРАЗОВАЯ — в момент сделки. Ходить
 * сюда на каждой генерации значило бы превратить подписку в абонемент
 * и завести разговор «почему у меня пропал доступ» вместо роста.
 *
 * Подписка на публичный канал — не согласие на рассылку (§42 SPEC) и не
 * заменяет его: мы ничего не шлём подписчику лично и ни в какой список
 * его не добавляем. Это принципиально: согласие, без которого услуга не
 * работает, считается несвободным, — а выйти из канала человек может в
 * ту же минуту, не потеряв доступ.
 */

import { Injectable, Logger } from '@nestjs/common';

const REQUEST_TIMEOUT_MS = 5000;

/** Статусы `getChatMember`, означающие «состоит». */
const MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);

@Injectable()
export class TelegramMembershipService {
  private readonly logger = new Logger(TelegramMembershipService.name);

  /** Канал, подписка на который засчитывается. Пусто — способ выключен. */
  channel(): string | undefined {
    return process.env.TELEGRAM_UNLOCK_CHANNEL?.trim() || undefined;
  }

  private botToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  }

  /** Настроен ли способ на этом стенде. */
  configured(): boolean {
    return !!this.channel() && !!this.botToken();
  }

  /**
   * Состоит ли человек в канале.
   *
   * `null` — «спросить не удалось» (сеть, таймаут, бот не админ
   * канала), и это НЕ то же самое, что «не состоит»: отказать
   * подписчику из-за нашей же неполадки — худший исход, поэтому
   * вызывающий отвечает на `null` внятной ошибкой, а не отказом.
   */
  async isMember(telegramId: string): Promise<boolean | null> {
    const channel = this.channel();
    const token = this.botToken();
    if (!channel || !token) return null;
    try {
      const url =
        `https://api.telegram.org/bot${token}/getChatMember` +
        `?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(telegramId)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        result?: { status?: string };
        description?: string;
      };
      if (!res.ok || !body?.ok) {
        // 400 «user not found» Telegram отдаёт и тому, кто просто не
        // подписан, — но так же он отвечает, если бот не администратор
        // канала. Различить их по ответу нельзя, а цена ошибки разная,
        // поэтому наверх уходит «не знаю», и разбираться идёт человек
        // по логу, а не пользователь по отказу.
        this.logger.warn(
          `getChatMember(${channel}) ответил ${res.status}: ${body?.description ?? 'без описания'}`,
        );
        return null;
      }
      return MEMBER_STATUSES.has(body.result?.status ?? '');
    } catch (error) {
      this.logger.warn(
        `не удалось спросить Telegram о подписке: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
