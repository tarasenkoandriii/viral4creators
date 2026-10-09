import {
  notifyLangOf,
  recipientsWithLang,
  sendToMembers,
  sendToMembersByLang,
  tmaLink,
} from './notify';

describe('уведомление в бот помощника', () => {
  it('ссылка TMA на хеш-маршрут', () => {
    expect(
      tmaLink('https://t.example/app/', '/sites/s1/knowledge/site/versions'),
    ).toBe('https://t.example/app/#/sites/s1/knowledge/site/versions');
    expect(tmaLink('https://t.example/app#/old', 'sites/s1')).toBe(
      'https://t.example/app/#/sites/s1',
    );
  });

  it('без токена или URL — ничего не шлёт', async () => {
    const calls: unknown[] = [];
    const n = await sendToMembers({
      chatIds: [1n],
      text: 't',
      button: { text: 'b', hashPath: '/x' },
      env: { ASSIST_TMA_URL: 'https://t' },
      fetchImpl: async (u) => {
        calls.push(u);
        return { ok: true, status: 200 };
      },
    });
    expect(n).toBe(0);
    expect(calls).toEqual([]);
  });

  it('каждому получателю — sendMessage с web_app-кнопкой; отказ одного не мешает другим', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const n = await sendToMembers({
      chatIds: [11n, 22n],
      text: 'версия удержана',
      button: { text: 'Открыть', hashPath: '/sites/s/knowledge/site/versions' },
      env: { ASSIST_BOT_TOKEN: 'TKN', ASSIST_TMA_URL: 'https://t.example/' },
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://api.telegram.org/botTKN/sendMessage');
        const b = JSON.parse(init.body);
        bodies.push(b);
        return {
          ok: b.chat_id === '11',
          status: b.chat_id === '11' ? 200 : 403,
        };
      },
    });
    expect(n).toBe(1);
    expect(bodies.map((b) => b.chat_id)).toEqual(['11', '22']);
    expect(JSON.stringify(bodies[0].reply_markup)).toContain(
      '"web_app":{"url":"https://t.example/#/sites/s/knowledge/site/versions"}',
    );
  });

  it('заход 11 (Р-З11-В3): ещё кнопки — каждая своей строкой после основной', async () => {
    const bodies: Array<{
      reply_markup: {
        inline_keyboard: Array<
          Array<{ text: string; web_app: { url: string } }>
        >;
      };
    }> = [];
    await sendToMembers({
      chatIds: [7n],
      text: 'сводка',
      button: { text: 'Статистика', hashPath: '/sites/s/stats' },
      moreButtons: [
        { text: 'Статистика «Админки»', hashPath: '/sites/s/admin-mode/stats' },
      ],
      env: { ASSIST_BOT_TOKEN: 'TKN', ASSIST_TMA_URL: 'https://t.example/' },
      fetchImpl: async (_u, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      },
    });
    expect(bodies[0].reply_markup.inline_keyboard).toEqual([
      [
        {
          text: 'Статистика',
          web_app: { url: 'https://t.example/#/sites/s/stats' },
        },
      ],
      [
        {
          text: 'Статистика «Админки»',
          web_app: { url: 'https://t.example/#/sites/s/admin-mode/stats' },
        },
      ],
    ]);
  });
});

describe('язык уведомления (Р-З9-7)', () => {
  it('notifyLangOf: uk/ru/en по первой части кода, прочее и пусто — uk', () => {
    expect(notifyLangOf('ru')).toBe('ru');
    expect(notifyLangOf('ru-RU')).toBe('ru');
    expect(notifyLangOf('EN_us')).toBe('en');
    expect(notifyLangOf('uk')).toBe('uk');
    expect(notifyLangOf('de')).toBe('uk');
    expect(notifyLangOf(null)).toBe('uk');
    expect(notifyLangOf('')).toBe('uk');
  });

  it('recipientsWithLang: фильтр режима как у recipients, язык из assist_bot_users, нет строки — uk', async () => {
    const findMembers = jest.fn().mockResolvedValue([
      { telegramId: 1n, role: 'owner', productRoles: null },
      { telegramId: 2n, role: 'owner', productRoles: null },
      { telegramId: 3n, role: 'owner', productRoles: null },
      { telegramId: 4n, role: 'nonsense', productRoles: null },
    ]);
    const findUsers = jest.fn().mockResolvedValue([
      { telegramId: 1n, languageCode: 'ru-RU' },
      { telegramId: 2n, languageCode: 'en' },
    ]);
    const sitesDb = {
      forAccount: () => ({ siteAccountMember: { findMany: findMembers } }),
      system: () => ({ assistBotUser: { findMany: findUsers } }),
    };
    const out = await recipientsWithLang(sitesDb as never, 'acc', () => true);
    expect(out).toEqual([
      { chatId: 1n, lang: 'ru' },
      { chatId: 2n, lang: 'en' },
      { chatId: 3n, lang: 'uk' },
    ]);
    expect(findUsers.mock.calls[0][0].where.telegramId.in).toEqual([
      1n,
      2n,
      3n,
    ]);
  });

  it('recipientsWithLang: никого не отобрали — без запроса языков', async () => {
    const findUsers = jest.fn();
    const sitesDb = {
      forAccount: () => ({
        siteAccountMember: { findMany: jest.fn().mockResolvedValue([]) },
      }),
      system: () => ({ assistBotUser: { findMany: findUsers } }),
    };
    expect(await recipientsWithLang(sitesDb as never, 'a', () => true)).toEqual(
      [],
    );
    expect(findUsers).not.toHaveBeenCalled();
  });

  it('sendToMembersByLang: каждому — текст и кнопка его языка', async () => {
    const got: Array<{ chat: string; text: string; button: string }> = [];
    const n = await sendToMembersByLang({
      recipients: [
        { chatId: 1n, lang: 'ru' },
        { chatId: 2n, lang: 'uk' },
        { chatId: 3n, lang: 'ru' },
      ],
      texts: {
        uk: { text: 'Привіт', button: 'Відкрити' },
        ru: { text: 'Привет', button: 'Открыть' },
        en: { text: 'Hi', button: 'Open' },
      },
      hashPath: '/x',
      env: { ASSIST_BOT_TOKEN: 'T', ASSIST_TMA_URL: 'https://t' },
      fetchImpl: async (_u, init) => {
        const b = JSON.parse(init.body);
        got.push({
          chat: b.chat_id,
          text: b.text,
          button: b.reply_markup.inline_keyboard[0][0].text,
        });
        return { ok: true, status: 200 };
      },
    });
    expect(n).toBe(3);
    expect(got).toEqual([
      { chat: '2', text: 'Привіт', button: 'Відкрити' },
      { chat: '1', text: 'Привет', button: 'Открыть' },
      { chat: '3', text: 'Привет', button: 'Открыть' },
    ]);
  });
});
