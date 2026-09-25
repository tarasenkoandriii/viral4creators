import { TelegramBotService } from './telegram-bot.service';

/**
 * Этап 155. Вебхук у бота ОДИН, и с этого этапа его делят платежи и
 * команды. Цена ошибки здесь — молча не принятый платёж.
 */
function build() {
  const billing = {
    handleTelegramUpdate: jest.fn().mockResolvedValue(undefined),
  };
  const onboarding = { activate: jest.fn().mockResolvedValue(undefined) };
  // По умолчанию — «не тестировщик»: тикеты умеют отказываться от
  // сообщения, и диспетчер обязан дойти до своего молчаливого хвоста.
  const tickets = { accept: jest.fn().mockResolvedValue(false) };
  return {
    service: new TelegramBotService(
      billing as never,
      onboarding as never,
      tickets as never,
    ),
    billing,
    onboarding,
    tickets,
  };
}

describe('диспетчер входящих', () => {
  it('pre_checkout уходит в биллинг', async () => {
    const { service, billing, onboarding } = build();
    await service.dispatch({
      pre_checkout_query: { id: 'q1', invoice_payload: 'p' },
    });
    expect(billing.handleTelegramUpdate).toHaveBeenCalled();
    expect(onboarding.activate).not.toHaveBeenCalled();
  });

  it('успешный платёж уходит в биллинг', async () => {
    const { service, billing } = build();
    await service.dispatch({
      message: {
        successful_payment: {
          telegram_payment_charge_id: 'c1',
          invoice_payload: 'p',
          total_amount: 100,
        },
      },
    });
    expect(billing.handleTelegramUpdate).toHaveBeenCalled();
  });

  it('платёж С ТЕКСТОМ всё равно платёж', async () => {
    // Подпись к платежу не должна увести апдейт в ветку команд: это
    // деньги, и они разбираются первыми.
    const { service, billing, onboarding } = build();
    await service.dispatch({
      message: {
        text: '/start t_TOKEN',
        from: { id: 777 },
        successful_payment: {
          telegram_payment_charge_id: 'c1',
          invoice_payload: 'p',
          total_amount: 100,
        },
      },
    });
    expect(billing.handleTelegramUpdate).toHaveBeenCalled();
    expect(onboarding.activate).not.toHaveBeenCalled();
  });

  it('/start с нашим токеном уходит в активацию', async () => {
    const { service, billing, onboarding } = build();
    await service.dispatch({
      message: {
        text: '/start t_TOKEN',
        from: { id: 777, username: 'tester', language_code: 'uk' },
      },
    });
    expect(billing.handleTelegramUpdate).not.toHaveBeenCalled();
    expect(onboarding.activate).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'TOKEN', telegramId: '777' }),
    );
  });

  it('/start без отправителя активацию не запускает', async () => {
    // Без `from.id` некого впускать, а падать на вебхуке нельзя:
    // Telegram будет повторять апдейт.
    const { service, onboarding } = build();
    await service.dispatch({ message: { text: '/start t_TOKEN' } });
    expect(onboarding.activate).not.toHaveBeenCalled();
  });

  it('чужое и постороннее — молча, без ответа', async () => {
    // Бота находят и в поиске; отвечать «не понял» случайному человеку
    // значит начать разговор, которого он не начинал.
    const { service, billing, onboarding } = build();
    for (const update of [
      {},
      { message: { text: 'привет', from: { id: 1 } } },
      { message: { text: '/start', from: { id: 1 } } },
      { message: { text: '/start r_CODE', from: { id: 1 } } },
    ]) {
      await service.dispatch(update);
    }
    expect(billing.handleTelegramUpdate).not.toHaveBeenCalled();
    expect(onboarding.activate).not.toHaveBeenCalled();
  });

  // ── Находки тестировщика (этап 157) ───────────────────────────────

  it('обычное сообщение уходит в тикеты', async () => {
    const { service, tickets } = build();
    tickets.accept.mockResolvedValue(true);
    const message = { text: 'кнопка не нажимается', from: { id: 7 } };
    await service.dispatch({ message });
    expect(tickets.accept).toHaveBeenCalledWith('7', message);
  });

  it('команда тикетом не становится', async () => {
    // `/help`, `/start` без токена — обращение к боту, а не сообщение о
    // проблеме; в очереди разбора им делать нечего.
    const { service, tickets } = build();
    for (const text of ['/help', '/start', '  /stop']) {
      await service.dispatch({ message: { text, from: { id: 7 } } });
    }
    expect(tickets.accept).not.toHaveBeenCalled();
  });

  it('файл без подписи — тоже находка', async () => {
    // У сообщения со скриншотом текста нет вовсе, и `isCommand` не
    // должен принять отсутствие текста за что-то особенное.
    const { service, tickets } = build();
    await service.dispatch({
      message: { photo: [{ file_id: 'p' }], from: { id: 7 } },
    });
    expect(tickets.accept).toHaveBeenCalled();
  });

  it('сообщение из группы находкой не становится', async () => {
    // Аудит этапа 157: бота можно добавить в группу, и каждая реплика
    // тестировщика там заводила бы тикет — а подтверждение уходило бы в
    // личку, куда он в этот момент не смотрит.
    const { service, tickets } = build();
    for (const type of ['group', 'supergroup', 'channel']) {
      await service.dispatch({
        message: { text: 'сломалось', from: { id: 7 }, chat: { type } },
      });
    }
    expect(tickets.accept).not.toHaveBeenCalled();
  });

  it('личка — становится, и без поля тоже', async () => {
    // Тип Telegram присылает всегда; ошибиться лучше в сторону
    // сохранённой находки.
    const { service, tickets } = build();
    await service.dispatch({
      message: {
        text: 'сломалось',
        from: { id: 7 },
        chat: { type: 'private' },
      },
    });
    await service.dispatch({ message: { text: 'и ещё', from: { id: 7 } } });
    expect(tickets.accept).toHaveBeenCalledTimes(2);
  });

  it('платёж до тикетов: деньги важнее очереди разбора', async () => {
    const { service, billing, tickets } = build();
    await service.dispatch({
      message: {
        text: 'спасибо',
        from: { id: 7 },
        successful_payment: {
          telegram_payment_charge_id: 'c1',
          invoice_payload: 'p',
          total_amount: 100,
        },
      },
    });
    expect(billing.handleTelegramUpdate).toHaveBeenCalled();
    expect(tickets.accept).not.toHaveBeenCalled();
  });

  it('/start с токеном до тикетов: активация, а не находка', async () => {
    const { service, onboarding, tickets } = build();
    await service.dispatch({
      message: { text: '/start t_abc', from: { id: 7 } },
    });
    expect(onboarding.activate).toHaveBeenCalled();
    expect(tickets.accept).not.toHaveBeenCalled();
  });
});
