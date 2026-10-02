/**
 * Э3 H — бот Помощника: клиент Bot API (подменённый fetch: тела запросов,
 * callback_data ≤ 64 байт, web_app только при ASSIST_TMA_URL, 403 →
 * blocked, без токена — без сети) и кнопки передачи на НАСТОЯЩЕМ Postgres
 * («Черновик» → «Отправить как есть», «Шаблон», «Закрыть», реплай на
 * просроченное/чужое сообщение, не личный чат).
 */
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { SearchHit } from '../../modules/assist-knowledge-core/types';
import {
  CALLBACK_DATA_MAX_BYTES,
  createTelegramBotClient,
  tmaHashUrl,
} from '../../modules/assist-site-handoff/bot/telegram-bot-client';
import {
  HandoffStack,
  TgFake,
} from '../../modules/assist-site-handoff/testing/handoff-stack.testing';

jest.setTimeout(60_000);

describe('TelegramBotClient (H)', () => {
  const env = {
    ASSIST_BOT_TOKEN: 'tok-123:secret',
    ASSIST_TMA_URL: 'https://tma.example.com/app/#/old',
  };

  it('без токена — bot_not_configured без сети', async () => {
    const tg = new TgFake();
    const c = createTelegramBotClient({ env: {}, fetchImpl: tg.fetchImpl });
    expect(await c.send({ chatId: BigInt(1), text: 'x' })).toEqual({
      ok: false,
      messageId: null,
      code: 'bot_not_configured',
    });
    expect(tg.requests).toHaveLength(0);
  });

  it('sendMessage: chat_id строкой, реплай, кнопки; длинный callback и web_app без TMA_URL — без кнопки', async () => {
    const tg = new TgFake();
    const c = createTelegramBotClient({ env, fetchImpl: tg.fetchImpl });
    const long = `h:take:${'x'.repeat(CALLBACK_DATA_MAX_BYTES)}`;
    const r = await c.send({
      chatId: BigInt('9007199254740993'),
      text: 'привет',
      replyToMessageId: 7,
      buttons: [
        [
          { text: 'Взять', callback: 'h:take:abc' },
          { text: 'Длинная', callback: long },
        ],
        [{ text: 'TMA', webAppHashPath: '/sites/s1/dialogs/c1' }],
      ],
    });
    expect(r).toEqual({ ok: true, messageId: 1001, code: 'sent' });
    expect(tg.requests[0].body).toEqual({
      chat_id: '9007199254740993',
      text: 'привет',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Взять', callback_data: 'h:take:abc' }],
          [
            {
              text: 'TMA',
              web_app: {
                url: 'https://tma.example.com/app/#/sites/s1/dialogs/c1',
              },
            },
          ],
        ],
      },
    });
    const noTma = createTelegramBotClient({
      env: { ASSIST_BOT_TOKEN: 't' },
      fetchImpl: tg.fetchImpl,
    });
    await noTma.send({
      chatId: BigInt(1),
      text: 'x',
      buttons: [[{ text: 'TMA', webAppHashPath: '/x' }]],
    });
    expect(tg.requests[1].body.reply_markup).toBeUndefined();
    expect(tmaHashUrl('https://a.b/', 'sites/1')).toBe('https://a.b/#/sites/1');
  });

  it('403 → blocked; 5xx → http_502; сбой сети → network; текст ≤ 4096', async () => {
    const tg = new TgFake();
    const c = createTelegramBotClient({ env, fetchImpl: tg.fetchImpl });
    tg.status = 403;
    expect((await c.send({ chatId: BigInt(1), text: 'x' })).code).toBe(
      'blocked',
    );
    tg.status = 502;
    expect(
      (await c.edit({ chatId: BigInt(1), messageId: 2, text: 'x' })).code,
    ).toBe('http_502');
    const broken = createTelegramBotClient({
      env,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect((await broken.send({ chatId: BigInt(1), text: 'x' })).code).toBe(
      'network',
    );
    tg.status = 200;
    await c.send({ chatId: BigInt(1), text: 'я'.repeat(5000) });
    expect(String(tg.requests.at(-1)?.body.text)).toHaveLength(4096);
  });
});

const hit: SearchHit = {
  chunkId: 'c1',
  documentId: 'd1',
  sourceType: 'page',
  url: 'https://shop.example.com/delivery',
  title: 'Доставка',
  headingPath: null,
  text: 'Доставка Новою поштою коштує 80 грн. Відправляємо щодня.',
  lang: 'uk',
  ugc: false,
  score: 1,
  vectorRank: 1,
  textRank: 1,
};

describeDb('Э3 H — кнопки и реплаи бота (bot)', () => {
  const st = new HandoffStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.tg.clear();
    st.tg.status = 200;
    st.knowledge.hits = [hit];
  });

  async function taken(
    config: Parameters<HandoffStack['handoffSite']>[0] = {},
  ) {
    const s = await st.handoffSite({ operators: 1, ...config });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    return { s, v, id: r.handoff.id, op };
  }

  it('«Черновик» → сообщение с источником и «Отправить как есть» → посетителю уходит черновик (без второго перевода)', async () => {
    // Посетитель пишет по-английски: черновик — на его языке, перевод не нужен.
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(
      s,
      'How much is delivery by Nova Poshta?',
    );
    const req = await st.requestHandoff(s, v);
    if (req.mode !== 'human') throw new Error('передача');
    const id = req.handoff.id;
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${id}`);
    expect((await st.handoffRow(id)).visitorLang).toBe('en');
    st.tg.clear();
    await st.callback(op.telegramId, `h:draft:${id}`);
    const draftMsg = st.tg.sent(op.telegramId)[0];
    expect(String(draftMsg.body.text)).toContain(
      'Доставка Новою поштою коштує 80 грн.',
    );
    expect(String(draftMsg.body.text)).toContain(
      'https://shop.example.com/delivery',
    );
    expect(st.tg.callbacks()).toContain(`h:send:${id}`);
    st.htext.calls.length = 0;
    await st.callback(op.telegramId, `h:send:${id}`);
    const sent = await st.owner.assistSiteMessage.findFirstOrThrow({
      where: { conversationId: v.conversationId, role: 'operator' },
    });
    expect(sent.text).toBe('Доставка Новою поштою коштує 80 грн.');
    expect(st.htext.translations()).toHaveLength(0);
    // Реплай на сообщение черновика — тоже ответ в эту передачу.
    await st.replyTo(
      op.telegramId,
      draftMsg.messageId as number,
      'І ще: самовивіз є',
    );
    expect(
      await st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      }),
    ).toBe(2);
  });

  it('черновика нет (нет фрагментов) — честное сообщение, посетителю ничего', async () => {
    const { v, id, op } = await taken();
    st.knowledge.hits = [];
    st.tg.clear();
    await st.callback(op.telegramId, `h:draft:${id}`);
    expect(String(st.tg.sent(op.telegramId)[0]?.body.text)).toContain(
      'Черновика нет',
    );
    await st.callback(op.telegramId, `h:send:${id}`);
    expect(
      await st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      }),
    ).toBe(0);
  });

  it('«Шаблон»: список кнопками → выбор → ответ шаблоном; нет шаблонов — подсказка', async () => {
    const { v, id, op } = await taken({
      config: {
        templates: [
          {
            id: 'hi',
            title: 'Привітання',
            text: 'Добрий день! Чим допомогти?',
          },
          { id: 'bye', title: 'Прощання', text: 'Гарного дня!' },
        ],
      },
    });
    expect(st.tg.callbacks()).toContain(`h:tpl:${id}:l`);
    st.tg.clear();
    await st.callback(op.telegramId, `h:tpl:${id}:l`);
    expect(st.tg.callbacks()).toEqual([`h:tpl:${id}:0`, `h:tpl:${id}:1`]);
    await st.callback(op.telegramId, `h:tpl:${id}:1`);
    const m = await st.owner.assistSiteMessage.findFirstOrThrow({
      where: { conversationId: v.conversationId, role: 'operator' },
    });
    expect(m.text).toBe('Гарного дня!');
    await st.callback(op.telegramId, `h:tpl:${id}:9`);
    const last = st.tg.requests
      .filter((r) => r.method === 'answerCallbackQuery')
      .at(-1);
    expect(String(last?.body.text)).toContain('не найден');
  });

  it('«Закрыть» → closed, карточка правится; повторное закрытие — без ошибки; дальше снова отвечает помощник', async () => {
    const { s, v, id, op } = await taken();
    st.tg.clear();
    await st.callback(op.telegramId, `h:close:${id}`);
    expect((await st.handoffRow(id)).state).toBe('closed');
    expect(String(st.tg.edits(op.telegramId)[0]?.body.text)).toContain(
      'Передача закрыта',
    );
    await st.callback(op.telegramId, `h:close:${id}`);
    const conv = await st.owner.assistSiteConversation.findUniqueOrThrow({
      where: { id: v.conversationId },
    });
    expect(conv.handoffState).toBe('closed');
    st.model.calls.length = 0;
    const r = await st.ask(s, 'А скільки коштує доставка Новою поштою?', {
      visitor: v.visitor,
      conversationId: v.conversationId,
    });
    expect(r.events.some((e) => e.type === 'handoff')).toBe(false);
    expect(st.model.calls).toHaveLength(1);
    expect(r.text).toContain('80 грн');
  });

  it('обычное сообщение без реплая — подсказка; групповой чат — игнор; мусор и неизвестный callback — без ошибки', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const op = s.operators[0];
    await st.bot.handle({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: Number(op.telegramId) },
        chat: { id: Number(op.telegramId), type: 'private' },
        text: 'привет',
      },
    });
    expect(String(st.tg.sent(op.telegramId)[0]?.body.text)).toContain(
      'реплаем',
    );
    st.tg.clear();
    await st.bot.handle({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: Number(op.telegramId) },
        chat: { id: -100, type: 'group' },
        text: '/start',
      },
    });
    expect(st.tg.requests).toHaveLength(0);
    for (const u of [null, 5, 'x', { update_id: 3 }, { callback_query: 'x' }]) {
      await expect(st.bot.handle(u)).resolves.toBeUndefined();
    }
    await st.callback(op.telegramId, 'h:hack:../../etc');
    expect(
      st.tg.requests.filter((r) => r.method === 'answerCallbackQuery'),
    ).toHaveLength(1);
  });

  it('повтор обновления Telegram с реплаем — один ответ посетителю; двойное «Отправить как есть» — черновик уходит один раз', async () => {
    const { v, id, op } = await taken();
    const card = st.tg.cards(op.telegramId)[0];
    const update = {
      update_id: 990_001,
      message: {
        message_id: 77_001,
        from: { id: Number(op.telegramId), language_code: 'uk' },
        chat: { id: Number(op.telegramId), type: 'private' },
        text: 'Доставка — завтра',
        reply_to_message: { message_id: card.messageId as number },
      },
    };
    await st.bot.handle(update);
    await st.bot.handle(update);
    const count = () =>
      st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      });
    expect(await count()).toBe(1);
    // Реплай на своё же сообщение — та же передача (а не подсказка).
    await st.replyTo(op.telegramId, 77_001, 'І ще одне');
    expect(await count()).toBe(2);

    st.tg.clear();
    await st.callback(op.telegramId, `h:draft:${id}`);
    const draftMsg = st.tg.sent(op.telegramId)[0];
    expect(st.tg.callbacks()).toContain(`h:send:${id}`);
    await Promise.all([
      st.callback(op.telegramId, `h:send:${id}`, {
        messageId: draftMsg.messageId as number,
      }),
      st.callback(op.telegramId, `h:send:${id}`, {
        messageId: draftMsg.messageId as number,
      }),
    ]);
    expect(await count()).toBe(3);
  });

  it('реплай на просроченное сообщение бота (expiresAt) — не ответ посетителю', async () => {
    const { v, op } = await taken();
    const card = st.tg.cards(op.telegramId)[0];
    await st.owner.assistBotMessage.update({
      where: {
        chatId_messageId: {
          chatId: op.telegramId,
          messageId: card.messageId as number,
        },
      },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await st.replyTo(op.telegramId, card.messageId as number, 'поздно');
    expect(
      await st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      }),
    ).toBe(0);
  });
});
