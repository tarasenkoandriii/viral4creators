import type { IncomingMessage } from '../../common/test-ticket';

/**
 * Апдейт Telegram — ровно те поля, которые мы читаем (этап 155).
 *
 * Тип объявлен здесь, а не в биллинге, потому что вебхук перестал быть
 * платёжным: он один на весь бот, и с этого этапа его разбирает
 * диспетчер. Биллинговый `TelegramUpdateBody` — подмножество этого, и
 * передаётся туда как есть: структурная типизация позволяет отдать
 * более широкий объект в более узкий параметр.
 *
 * Поля самого сообщения (текст, подпись, вложения, `reply_to_message`)
 * живут в `common/test-ticket.ts` — там же, где код, который их читает:
 * разбор вложений под тестом, а типу тут остаётся то, что относится к
 * апдейту, а не к содержимому (кто прислал, в какой чат, оплата).
 */
export interface TelegramUpdate {
  pre_checkout_query?: {
    id: string;
    invoice_payload: string;
  };
  message?: IncomingMessage & {
    from?: {
      id?: number;
      username?: string;
      first_name?: string;
      language_code?: string;
    };
    chat?: { id?: number; type?: string };
    successful_payment?: {
      telegram_payment_charge_id: string;
      invoice_payload: string;
      total_amount: number;
      is_recurring?: boolean;
    };
  };
}
