/* eslint-disable @typescript-eslint/no-explicit-any -- двойник SitesDb */
/**
 * Р-З9-7 (заход 9, TODO Э6-бис «уведомление владельцу только ru», аудит):
 * уведомления «Админки: действия» — на языке КАЖДОГО получателя
 * (`assist_bot_users.languageCode`: uk/ru/en, прочее и пусто — uk); только
 * владельцу кабинета и `assistAdmin: owner`; без параметров и ПД.
 */
import { ADMIN_NOTIFY_TEXT, AdminActionsNotifier } from './action-notifier';

const ENV = ['ASSIST_BOT_TOKEN', 'ASSIST_TMA_URL'] as const;

function stack() {
  const members = [
    { telegramId: 11n, role: 'owner', productRoles: {} },
    {
      telegramId: 12n,
      role: 'manager',
      productRoles: { assistAdmin: 'owner' },
    },
    {
      telegramId: 13n,
      role: 'manager',
      productRoles: { assistAdmin: 'owner' },
    },
    {
      telegramId: 14n,
      role: 'manager',
      productRoles: { assistAdmin: 'owner' },
    },
    // Менеджер «Сайта» и сотрудник «Админки» — не получают (К-9).
    { telegramId: 15n, role: 'manager', productRoles: { assist: 'manager' } },
    {
      telegramId: 16n,
      role: 'operator',
      productRoles: { assistAdmin: 'employee' },
    },
  ];
  const langs: Record<string, string | null> = {
    '11': 'ru-RU',
    '12': 'en',
    '13': 'uk',
    // 14 — строки нет → uk
    '15': 'ru',
    '16': 'en',
  };
  const db = {
    forAccount: () => ({
      siteAccountMember: { findMany: jest.fn(async () => members) },
    }),
    system: () => ({
      assistBotUser: {
        findMany: jest.fn(async (q: any) =>
          (q.where.telegramId.in as bigint[])
            .filter((id) => langs[id.toString()] !== undefined)
            .map((id) => ({
              telegramId: id,
              languageCode: langs[id.toString()],
            })),
        ),
      },
    }),
  };
  const n = new AdminActionsNotifier(db as any);
  const out: Array<{ chat: string; text: string; button: string }> = [];
  n.fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    out.push({
      chat: b.chat_id,
      text: b.text,
      button: b.reply_markup.inline_keyboard[0][0].text,
    });
    return { ok: true, status: 200 };
  };
  return { n, out };
}

describe('уведомления «Админки: действия» — язык получателя (Р-З9-7)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = 'test-token';
    process.env.ASSIST_TMA_URL = 'https://tma.example.com/app';
  });
  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('мемо «требует проверки»: ru, en, uk и uk по умолчанию — каждому свой; менеджеру «Сайта» и сотруднику — нет', async () => {
    const { n, out } = stack();
    await n.memoReview({
      accountId: 'a1',
      siteId: 's1',
      number: 7,
      code: 'pin_mismatch',
      step: 2,
    });
    const by = Object.fromEntries(out.map((o) => [o.chat, o]));
    expect(Object.keys(by).sort()).toEqual(['11', '12', '13', '14']);
    expect(by['11'].text).toMatch(/^Мемо АМ-7 требует проверки: шаг 2/);
    expect(by['11'].button).toBe('Мемо «Админки»');
    expect(by['12'].text).toMatch(/^Memo AM-7 needs review: step 2/);
    expect(by['12'].button).toBe('Admin memos');
    expect(by['13'].text).toMatch(/^Мемо АМ-7 потребує перевірки: крок 2/);
    expect(by['14'].text).toBe(by['13'].text);
    expect(n.sent.at(-1)!.text).toBe('memo:7:pin_mismatch');
  });

  it('danger и 401: язык получателя, без параметров действия', async () => {
    const { n, out } = stack();
    await n.dangerExecuted({
      accountId: 'a1',
      siteId: 's1',
      operation: 'shop.bulkCancel',
      title: 'Массово отменить',
      actor: 'jwt:emp-1',
      status: 'unknown',
      items: 3,
    });
    const by = Object.fromEntries(out.map((o) => [o.chat, o.text]));
    expect(by['11']).toMatch(
      /^Опасное действие в админке: .*строк: 3\) — исход неизвестен/,
    );
    expect(by['12']).toMatch(
      /^Dangerous action in the admin panel: .*rows: 3\) — outcome unknown/,
    );
    expect(by['13']).toMatch(
      /^Небезпечна дія в адмінці: .*рядків: 3\) — результат невідомий/,
    );
    out.length = 0;
    await n.authFailed({ accountId: 'a1', siteId: 's1', connector: 'shop' });
    const a = Object.fromEntries(out.map((o) => [o.chat, o]));
    expect(a['11'].text).toMatch(/отклонило ключ помощника/);
    expect(a['12'].text).toMatch(/rejected the assistant's key/);
    expect(a['13'].text).toMatch(/відхилило ключ помічника/);
    expect(a['12'].button).toBe('Action log');
  });

  it('тексты ×3 языка: причины мемо и статусы — переведены, коды не утекают сырыми', () => {
    for (const code of ['goal_low', 'pin_mismatch', 'failures']) {
      const t = ['uk', 'ru', 'en'].map((l) =>
        ADMIN_NOTIFY_TEXT.memoReview(l as 'uk', {
          number: 3,
          code,
          step: 1,
        }),
      );
      expect(new Set(t).size).toBe(3);
      for (const x of t) expect(x).not.toMatch(/goal_low|pin_mismatch/);
    }
    for (const status of ['done', 'failed', 'unknown']) {
      for (const l of ['uk', 'ru'] as const) {
        expect(
          ADMIN_NOTIFY_TEXT.danger(l, {
            title: 't',
            operation: 'c.op',
            items: 1,
            status,
            actor: 'tg:1',
          }),
        ).not.toContain(` ${status}.`);
      }
    }
  });
});
