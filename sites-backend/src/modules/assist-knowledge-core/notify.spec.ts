import { sendToMembers, tmaLink } from './notify';

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
});
