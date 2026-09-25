/**
 * Диспетчер входящих бота (этап 155,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §1.2).
 *
 * ## Почему диспетчер, а не второй вебхук
 *
 * Вебхук у бота ОДИН: его адрес задаётся `setWebhook` и заменяет
 * предыдущий. До этого этапа он целиком принадлежал платежам, и завести
 * рядом второй нельзя — можно только научить существующий различать
 * входящее.
 *
 * Путь при этом остался прежним (`POST /api/billing/webhook/telegram`)
 * и стал историческим именем. Это сознательно: смена адреса требует
 * повторного `setWebhook` руками и оставляет окно, в котором апдейты
 * теряются, — цена, которой незачем платить за красоту URL.
 *
 * ## Направление зависимостей
 *
 * `telegram-bot` знает про биллинг, биллинг про `telegram-bot` — нет.
 * Обратное направление замкнуло бы круг; это же объясняет, почему
 * маршрут переехал сюда целиком, а не остался в биллинге с вызовом
 * наружу.
 */

import { Injectable, Logger } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { TesterOnboardingService } from './tester-onboarding.service';
import { TesterTicketsService } from './tester-tickets.service';
import { TelegramUpdate } from './telegram-update';
import { tokenFromStart } from '../../common/tester-invite';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(
    private readonly billing: BillingService,
    private readonly onboarding: TesterOnboardingService,
    private readonly tickets: TesterTicketsService,
  ) {}

  async dispatch(update: TelegramUpdate): Promise<void> {
    // Платежи — первыми и без единой правки в их обработчике: это
    // деньги, и они работали до появления диспетчера.
    if (update.pre_checkout_query || update.message?.successful_payment) {
      await this.billing.handleTelegramUpdate(update);
      return;
    }

    const message = update.message;
    const token = tokenFromStart(message?.text);
    if (token && message?.from?.id) {
      await this.onboarding.activate({
        token,
        telegramId: String(message.from.id),
        username: message.from.username ?? null,
        firstName: message.from.first_name ?? null,
        languageCode: message.from.language_code ?? null,
      });
      return;
    }

    // Находка тестировщика (этап 157). После `/start` и до всего
    // остального: любое сообщение активированного тестировщика, не
    // являющееся командой, — это находка. Не «сообщение с ключевым
    // словом»: человек в поле не помнит формат, а мы теряем находку.
    //
    // Команды пропускаем мимо: `/help`, `/start` без токена и прочее —
    // это обращение к боту, а не сообщение о проблеме, и класть их в
    // очередь разбора значит засорять её тем, что никто не писал.
    if (
      message?.from?.id &&
      isPrivate(message.chat) &&
      !isCommand(message.text)
    ) {
      const accepted = await this.tickets.accept(
        String(message.from.id),
        message,
      );
      if (accepted) return;
    }

    // Всё остальное — молча. Бота находят и в поиске, и отвечать
    // случайному человеку «не понял» незачем: это разговор, которого он
    // не начинал. В лог — чтобы при разборе было видно, что апдейт
    // дошёл и был осознанно пропущен.
    this.logger.debug(
      `апдейт без обработчика: ${Object.keys(update).join(', ') || 'пусто'}`,
    );
  }
}

/** Обращение к боту, а не сообщение о проблеме. */
function isCommand(text: string | undefined): boolean {
  return (text ?? '').trimStart().startsWith('/');
}

/**
 * Личка, а не группа или канал (аудит этапа 157).
 *
 * Бота можно добавить в группу, и до этой проверки каждая реплика
 * тестировщика там становилась находкой — а подтверждение уходило в
 * личку, куда он в этот момент не смотрит. Тикет заводится там же, где
 * его подтверждают.
 *
 * Тип не пришёл — считаем личкой: Telegram его присылает всегда, а
 * ошибиться лучше в сторону сохранённой находки.
 */
function isPrivate(chat: { type?: string } | undefined): boolean {
  return (chat?.type ?? 'private') === 'private';
}
