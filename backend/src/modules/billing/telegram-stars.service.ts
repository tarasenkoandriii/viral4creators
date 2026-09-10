/**
 * TelegramStarsService — тонкий клиент Bot API для оплаты Telegram Stars
 * (этап 62, ТЗ §41.2). Сырой `axios`, без SDK — та же конвенция, что
 * `google-oauth.service.ts`/`tiktok-oauth.service.ts` (этап 61).
 *
 * `TELEGRAM_BOT_TOKEN` — тот же бот, что уже валидирует initData и шлёт
 * алерты/статистику (`telegram-notify.service.ts`), читается напрямую из
 * `process.env` тем же приёмом (а не через `configuration.ts` — токен уже
 * есть отдельной переменной, заводить вторую копию в billing-секции
 * конфига было бы дублированием источника истины).
 *
 * ## Почему `createInvoiceLink`, а не `sendInvoice`
 *
 * `sendInvoice` шлёт инвойс прямо в чат с ботом — годится для обычного
 * бота, но внутри Mini App правильный вызов именно `createInvoiceLink`:
 * он отдаёт URL, который открывается `Telegram.WebApp.openInvoice()` в
 * нативном UI Telegram, без выхода из приложения.
 *
 * ## Почему у Stars нет автопродления через наш сервер
 *
 * В отличие от WayForPay (`wayforpay.service.ts`, `recToken`), Bot API не
 * даёт серверу инициировать повторное списание Stars — родной механизм
 * подписки (`subscription_period` в `createInvoiceLink`) продлевается
 * САМИМ Telegram, который сам шлёт новый `successful_payment`. Роль
 * нашего крона для Stars — не списание, а сверка (см.
 * `billing-renewal/stars-subscription-reconcile.service.ts`).
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const XTR_CURRENCY = 'XTR';
/** 30 дней в секундах — родной шаг подписки Bot API. Точное имя поля
 * (`subscription_period`) сверено по документации Bot API на момент
 * реализации; при её изменении меняется только это значение. */
const SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;

export interface CreateStarsInvoiceInput {
  title: string;
  description: string;
  /** Подписанный `stars-invoice-payload.util.ts`. */
  payload: string;
  /** Целые Stars — у XTR нет копеек. */
  amount: number;
  /** Есть только у SUBSCRIPTION — разовый пакет кредитов её не задаёт. */
  subscription?: boolean;
}

@Injectable()
export class TelegramStarsService {
  private readonly logger = new Logger(TelegramStarsService.name);

  private get botToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  }

  configured(): boolean {
    return !!this.botToken;
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  /** Возвращает ссылку, которую TMA открывает через
   * `Telegram.WebApp.openInvoice()`. */
  async createInvoiceLink(input: CreateStarsInvoiceInput): Promise<string> {
    if (!this.botToken) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN не задан — оплата через Stars недоступна',
      );
    }
    const res = await axios.post<{ ok: boolean; result?: string }>(
      this.api('createInvoiceLink'),
      {
        title: input.title,
        description: input.description,
        payload: input.payload,
        // Пусто — у Stars нет платёжного провайдера (сам Telegram и есть
        // провайдер), непустое значение Bot API отклонит.
        provider_token: '',
        currency: XTR_CURRENCY,
        prices: [{ label: input.title, amount: input.amount }],
        ...(input.subscription
          ? { subscription_period: SUBSCRIPTION_PERIOD_SECONDS }
          : {}),
      },
    );
    if (!res.data.ok || !res.data.result) {
      throw new Error('Telegram не выдал ссылку на инвойс Stars');
    }
    return res.data.result;
  }

  /** Ответ на `pre_checkout_query` обязателен в течение 10 секунд Bot API
   * — иначе платёж считается отклонённым. */
  async answerPreCheckoutQuery(
    preCheckoutQueryId: string,
    ok: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (!this.botToken) return;
    await axios.post(this.api('answerPreCheckoutQuery'), {
      pre_checkout_query_id: preCheckoutQueryId,
      ok,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  }

  /** Возврат Stars — для админского действия «Возврат» (§41, admin
   * /payments). Best-effort: если провайдер откажет, оператор видит
   * ошибку в логе и решает вручную. */
  async refundStarPayment(
    telegramUserId: string,
    telegramPaymentChargeId: string,
  ): Promise<boolean> {
    if (!this.botToken) return false;
    try {
      const res = await axios.post<{ ok: boolean }>(
        this.api('refundStarPayment'),
        {
          user_id: telegramUserId,
          telegram_payment_charge_id: telegramPaymentChargeId,
        },
      );
      return res.data.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Не удалось вернуть Stars: ${message}`);
      return false;
    }
  }

  /**
   * Отмена подписки Stars НА СТОРОНЕ TELEGRAM (аудит round4, Г-2.2, этап
   * 64). Без этого вызова наша сторона ставит только
   * `Subscription.cancelAtPeriodEnd`, а Telegram, ничего не зная об
   * отмене, продолжает автопродление и присылает `successful_payment`
   * каждые 30 дней — деньги списываются у человека, который уже отменил
   * подписку у нас. Зовётся сразу при отмене (`PlanService.setPlan`,
   * `AdminUsersService.cancelSubscription`), а не в кроне продления: крон
   * добирается до строки только когда период УЖЕ истёк, а Telegram к
   * этому моменту мог списать уже следующий.
   *
   * Best-effort — как и `refundStarPayment`: если Telegram откажет
   * (устаревший `charge_id`, сеть), локальная отмена уже применена
   * (`cancelAtPeriodEnd`/`CANCELED`), а `applySuccessfulPayment`
   * дополнительно не даёт такой подписке реанимироваться повторным
   * платежом (см. `billing.service.ts`).
   */
  async cancelSubscription(
    telegramUserId: string,
    telegramPaymentChargeId: string,
  ): Promise<boolean> {
    if (!this.botToken) return false;
    try {
      const res = await axios.post<{ ok: boolean }>(
        this.api('editUserStarSubscription'),
        {
          user_id: telegramUserId,
          telegram_payment_charge_id: telegramPaymentChargeId,
          is_canceled: true,
        },
      );
      return res.data.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Не удалось отменить подписку Stars на стороне Telegram: ${message}`,
      );
      return false;
    }
  }
}
