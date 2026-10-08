/**
 * Приёмка Э3 (A) — утренняя сводка и отчёт недели (ТЗ §4.15, §5-тер.7,
 * §5-тер.16 п.9): получатели — владелец и assist: manager (оператор — нет,
 * отписавшийся — нет); раздел «Админка» — только assistAdmin: owner (У-27);
 * по понедельникам (пояс сайта) — отчёт недели вместо сводки; текст ≤ 4 096;
 * кнопка — экран статистики сайта; тревоги №29; пустые сутки — без
 * сообщения; scope своих сайтов. Telegram — подменённый fetch. Логи — без
 * текста сообщения.
 */
import { AdminDigestSource } from '../../modules/assist-admin-knowledge/admin-digest';
import { addDays, dayRangeUtc } from '../../modules/assist-analytics/site-time';
import {
  AnalyticsStack,
  LogCapture,
} from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { AssistDigestService } from '../../modules/assist-digest/digest.service';
import { TELEGRAM_TEXT_LIMIT } from '../../modules/assist-digest/report-text';
import type { LearningReadApi } from '../../modules/assist-site-learning/learning-read.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';

jest.setTimeout(90_000);

const HOUR = 60 * 60 * 1000;
const TZ = 'Europe/Kyiv';

/** Прошлый понедельник (не сегодня) и вторник после него, 06:30 UTC. */
function pastMonday(): Date {
  const d = new Date();
  d.setUTCHours(6, 30, 0, 0);
  const back = ((d.getUTCDay() + 6) % 7) + 7; // ≥ 7 дней назад — точно в прошлом
  return new Date(d.getTime() - back * 24 * HOUR);
}

describeDb('Приёмка Э3 (A): сводка и отчёт недели — §5-тер.16 п.9', () => {
  const st = new AnalyticsStack();
  const logs = new LogCapture();
  let digest: AssistDigestService;
  const sent: Array<{ chat_id: string; text: string; reply_markup: unknown }> =
    [];
  beforeAll(async () => {
    logs.install();
    await st.init();
    digest = new AssistDigestService(
      st.owner,
      st.sitesDb,
      st.rollup,
      new AdminDigestSource(st.sitesDb),
      st.learning as unknown as LearningReadApi,
    );
    digest.env = st.chat.env;
    digest.fetchImpl = async (_u, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    };
  });
  afterAll(async () => {
    await st.close();
    jest.restoreAllMocks();
  });

  const monday = pastMonday();
  const tuesday = new Date(monday.getTime() + 24 * HOUR);
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

  async function shop(): Promise<{
    s: ChatSite;
    tg: Record<
      'owner' | 'manager' | 'managerAdmin' | 'operator' | 'off',
      bigint
    >;
  }> {
    const s = await st.site({ name: 'Магазин «Тепло»' });
    const manager = await st.member(s, 'manager');
    const managerAdmin = await st.member(s, 'manager', {
      assistAdmin: 'owner',
    });
    const operator = await st.member(s, 'operator');
    const off = await st.member(s, 'manager');
    await st.settings.patchSubscription(off, s.siteId, {
      digest: false,
      weekly: false,
    });
    await st.owner.assistAdminKnowledgeVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 1,
        trigger: 'test',
        status: 'held',
      },
    });
    // Тексты проверок ниже — русские: получатели с русским Telegram.
    for (const t of [
      s.ownerTelegramId,
      manager.telegramId,
      managerAdmin.telegramId,
      operator.telegramId,
      off.telegramId,
    ]) {
      await lang(t, 'ru-RU');
    }
    return {
      s,
      tg: {
        owner: s.ownerTelegramId,
        manager: manager.telegramId,
        managerAdmin: managerAdmin.telegramId,
        operator: operator.telegramId,
        off: off.telegramId,
      },
    };
  }

  /** Язык получателя в боте (`language_code` Telegram, Р-З9-7). */
  async function lang(tg: bigint, code: string | null): Promise<void> {
    await st.owner.assistBotUser.upsert({
      where: { telegramId: tg },
      create: { telegramId: tg, languageCode: code },
      update: { languageCode: code },
    });
  }

  const forChat = (tg: bigint) =>
    sent.filter((x) => x.chat_id === tg.toString());

  it('сводка (вторник): владельцу и менеджерам; «Админка» — только assistAdmin: owner; оператору и отписавшемуся — нет', async () => {
    const { s, tg } = await shop();
    const yday = dayOf(monday);
    const start = dayRangeUtc(yday, TZ).start;
    for (let i = 0; i < 3; i++) {
      await st.conversation(s, {
        createdAt: new Date(start.getTime() + (2 + i) * HOUR),
        lastMessageAt: new Date(start.getTime() + (2 + i) * HOUR + 60_000),
      });
    }
    sent.length = 0;
    const r = await digest.run(tuesday, { siteIds: [s.siteId] });
    expect(r).toEqual({ sites: 1, sent: 3, weekly: false });
    expect(forChat(tg.operator)).toEqual([]);
    expect(forChat(tg.off)).toEqual([]);
    const ownerText = forChat(tg.owner)[0].text;
    const mgrText = forChat(tg.manager)[0].text;
    const admText = forChat(tg.managerAdmin)[0].text;
    expect(ownerText).toContain('Утренняя сводка — «Магазин «Тепло»»');
    expect(ownerText).toContain('Диалоги: 3');
    expect(ownerText).toContain('Раздел «Админка»');
    expect(ownerText).toContain('Удержанных версий базы «Админки»: 1');
    expect(admText).toContain('Раздел «Админка»');
    expect(mgrText).not.toContain('Админк');
    for (const x of sent) {
      expect(x.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(JSON.stringify(x.reply_markup)).toContain(
        `#/sites/${s.siteId}/stats`,
      );
    }
    expect(logs.text()).not.toContain('Утренняя сводка');
  });

  it('понедельник по поясу сайта — отчёт недели (Δ к прошлой неделе, находки); пустая неделя — без сообщений', async () => {
    const { s, tg } = await shop();
    const weekStart = dayRangeUtc(addDays(dayOf(monday), -7), TZ).start;
    for (let i = 0; i < 4; i++) {
      await st.conversation(s, {
        createdAt: new Date(weekStart.getTime() + (24 * i + 10) * HOUR),
        lastMessageAt: new Date(
          weekStart.getTime() + (24 * i + 10) * HOUR + 60_000,
        ),
      });
    }
    // Свёртки дней недели (как суточный крон).
    for (let i = 0; i < 7; i++) {
      await st.rollup.rollupDay(s.siteId, addDays(dayOf(monday), -7 + i));
    }
    st.learning.topicsOut = [
      {
        clusterId: 'c1',
        label: 'доставка в Польшу',
        kind: 'unknown',
        distinctVisitors: 5,
        size: 7,
        status: 'open',
        conversationIds: [],
      },
    ];
    st.learning.facts = { ...st.learning.facts, newClusters: 2 };
    sent.length = 0;
    const r = await digest.run(monday, { siteIds: [s.siteId] });
    st.learning.topicsOut = [];
    st.learning.facts = { ...st.learning.facts, newClusters: 0 };
    expect(r.weekly).toBe(true);
    const t = forChat(tg.manager)[0].text;
    expect(t).toContain('Отчёт недели');
    expect(t).toContain('Диалоги: 4\n');
    expect(t).toContain('новых непокрытых тем: 2');
    expect(t).toContain(
      '• Без ответа: «доставка в Польшу» — спросили 5 разных посетителей',
    );
    expect(t).not.toContain('Админк');

    const empty = await st.site();
    sent.length = 0;
    const r2 = await digest.run(monday, { siteIds: [empty.siteId] });
    expect(r2.sent).toBe(0);
    expect(sent).toEqual([]);
  });

  it('заход 10 (Р-З10-14): отчёт недели целиком на языке получателя — рамка, выводы модели (перевод) или сухая строка на его языке, кнопка', async () => {
    const s = await st.site({ name: 'Teplo Shop' });
    const en = await st.member(s, 'manager');
    const ru = await st.member(s, 'manager');
    // Без строки в assist_bot_users (бот не запускал) — uk (аудит P3-11).
    const none = await st.member(s, 'manager');
    await st.owner.assistBotUser.deleteMany({
      where: { telegramId: none.telegramId },
    });
    await lang(s.ownerTelegramId, 'uk');
    await lang(en.telegramId, 'en-GB');
    await lang(ru.telegramId, 'ru');
    const week = addDays(dayOf(monday), -7);
    const weekStart = dayRangeUtc(week, TZ).start;
    for (let i = 0; i < 3; i++) {
      await st.conversation(s, {
        createdAt: new Date(weekStart.getTime() + (24 * i + 10) * HOUR),
        lastMessageAt: new Date(
          weekStart.getTime() + (24 * i + 10) * HOUR + 60_000,
        ),
      });
    }
    for (let i = 0; i < 7; i++) {
      await st.rollup.rollupDay(s.siteId, addDays(week, i));
    }
    const finding = (f: Record<string, unknown>) => ({
      n: 40,
      x: 10,
      share: 0.25,
      ciLow: 0.14,
      ciHigh: 0.4,
      base: null,
      page: '/cart',
      topic: null,
      reason: 'price_too_high',
      field: null,
      metric: null,
      value: null,
      trigger: null,
      campaign: null,
      changedAt: null,
      ...f,
    });
    // Вывод модели: основной — украинский, перевод — английский (русского нет).
    await st.owner.assistSiteInsight.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        weekStart: week,
        code: 'N3',
        findingKey: 'N3:/cart:price_too_high',
        finding: finding({ code: 'N3' }),
        impact: 'high',
        text: {
          title: 'Дорого на /cart',
          what: '10 з 40 діалогів (25%).',
          action: 'Покажіть розстрочку',
          lang: 'uk',
          i18n: {
            en: {
              title: 'Too expensive on /cart',
              what: '10 of 40 (25%).',
              action: 'Show installments',
            },
          },
        },
      },
    });
    // Находка без текста модели — сухая строка кодом на языке читателя.
    await st.owner.assistSiteInsight.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        weekStart: week,
        code: 'N11',
        findingKey: 'N11:/oplata:v7',
        finding: finding({
          code: 'N11',
          page: '/oplata',
          reason: null,
          n: 300,
          x: 45,
          share: 0.15,
          base: 0.05,
          changedAt: '2026-09-30',
        }),
        impact: 'medium',
        textSkipped: 'plan',
      },
    });
    sent.length = 0;
    const r = await digest.run(monday, { siteIds: [s.siteId] });
    expect(r.weekly).toBe(true);
    const uk = forChat(s.ownerTelegramId)[0];
    const enMsg = forChat(en.telegramId)[0];
    const ruMsg = forChat(ru.telegramId)[0];
    const noneMsg = forChat(none.telegramId)[0];
    expect(noneMsg.text).toContain('Звіт тижня — «Teplo Shop»');
    expect(noneMsg.text).not.toMatch(/[ыэёъ]|Отчёт|Диалоги/);
    expect(JSON.stringify(noneMsg.reply_markup)).toContain(
      'Відкрити статистику',
    );
    expect(uk.text).toContain('Звіт тижня — «Teplo Shop»');
    expect(uk.text).toContain('Діалоги: 3');
    expect(uk.text).toContain('• Дорого на /cart — Покажіть розстрочку');
    expect(uk.text).toContain(
      '• Після зміни сторінки /oplata 30.09.2026: чат відкривають у 15% переглядів, було 5% — збіг у часі, не доказ',
    );
    expect(uk.text).toContain('Розділ «Адмінка»');
    // Ни слова русской рамки в украинском и английском.
    expect(uk.text).not.toMatch(/[ыэёъ]|Отчёт|Диалоги|Раздел|Находки/);
    expect(enMsg.text).toContain('Weekly report — «Teplo Shop»');
    expect(enMsg.text).toContain('Conversations: 3');
    expect(enMsg.text).toContain(
      '• Too expensive on /cart — Show installments',
    );
    expect(enMsg.text).toContain('coincidence in time, not proof');
    expect(enMsg.text).not.toMatch(/[А-Яа-яЁёІіЇїЄєҐґ]/);
    // Русского перевода вывода нет — сухая строка кодом по-русски.
    expect(ruMsg.text).toContain('Отчёт недели — «Teplo Shop»');
    expect(ruMsg.text).toContain(
      '• Причина отказа «дорого» на /cart: 10 из 40 диалогов без конверсии (25%)',
    );
    expect(ruMsg.text).not.toContain('Покажіть');
    const button = (m: { reply_markup: unknown }) =>
      JSON.stringify(m.reply_markup);
    expect(button(uk)).toContain('Відкрити статистику');
    expect(button(enMsg)).toContain('Open statistics');
    expect(button(ruMsg)).toContain('Открыть статистику');
  });

  it('тревога №29: всплеск 👎 вчера относительно 7 дней — строка в сводке', async () => {
    const { s, tg } = await shop();
    const yday = dayOf(monday);
    // 7 дней базы: по 10 диалогов, 1 👎 из 10 оценок.
    for (let d = 1; d <= 7; d++) {
      const start = dayRangeUtc(addDays(yday, -d), TZ).start;
      for (let i = 0; i < 10; i++) {
        await st.conversation(s, {
          createdAt: new Date(start.getTime() + (1 + i) * HOUR),
          lastMessageAt: new Date(start.getTime() + (1 + i) * HOUR + 60_000),
          rating: i === 0 ? -1 : 1,
        });
      }
      await st.rollup.rollupDay(s.siteId, addDays(yday, -d));
    }
    // Вчера: 20 диалогов, половина 👎.
    const start = dayRangeUtc(yday, TZ).start;
    for (let i = 0; i < 20; i++) {
      await st.conversation(s, {
        createdAt: new Date(start.getTime() + (1 + i * 0.5) * HOUR),
        lastMessageAt: new Date(
          start.getTime() + (1 + i * 0.5) * HOUR + 60_000,
        ),
        rating: i % 2 ? -1 : 1,
      });
    }
    sent.length = 0;
    await digest.run(tuesday, { siteIds: [s.siteId] });
    expect(forChat(tg.owner)[0].text).toContain('Всплеск 👎');
    expect(forChat(tg.owner)[0].text).not.toContain('Всплеск передач');
  });

  it('без ASSIST_BOT_TOKEN — ничего не шлём и текст не пишем в лог', async () => {
    const { s } = await shop();
    const env = digest.env;
    digest.env = { ...env, ASSIST_BOT_TOKEN: '' };
    sent.length = 0;
    expect(await digest.run(tuesday, { siteIds: [s.siteId] })).toEqual({
      sites: 0,
      sent: 0,
      weekly: false,
    });
    digest.env = env;
    expect(sent).toEqual([]);
  });
});
