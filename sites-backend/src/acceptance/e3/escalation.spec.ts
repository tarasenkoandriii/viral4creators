/**
 * Э3 H — ранняя эскалация (№13, §2.8; §3.7 п.1): словари uk/ru/en по видам
 * (раздражение, жалоба, возврат, опт, чувствительное), ложные срабатывания
 * ≤ 2% на ≥ 200 обычных вопросах (eval/platform-cases.ts + набор ниже), и
 * поведение конвейера на НАСТОЯЩЕМ Postgres: `sensitive` — без модели,
 * шаблон + «позвать человека»; остальные — обычный ответ + кнопка человека
 * (или формы заявки, если передача недоступна); выключенное правило — нет.
 */
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { PLATFORM_EVAL_CASES } from '../../modules/assist-site-chat/eval/platform-cases';
import type { EscalationKind } from '../../modules/assist-site-handoff/api-types';
import { detectEscalation } from '../../modules/assist-site-handoff/escalation';
import { defaultHandoffConfig } from '../../modules/assist-site-handoff/public/handoff-config';
import { HandoffStack } from '../../modules/assist-site-handoff/testing/handoff-stack.testing';

jest.setTimeout(60_000);

const ALL: Record<EscalationKind, boolean> = {
  irritation: true,
  complaint: true,
  refund: true,
  wholesale: true,
  sensitive: true,
};

const POSITIVE: Record<EscalationKind, string[]> = {
  irritation: [
    'Вы издеваетесь? Третий раз спрашиваю',
    'Это бесполезный бот',
    'Ты не понимаешь, что я пишу',
    'Скільки можна чекати?',
    'Ти не розумієш питання',
    'Марний бот, дайте людину',
    'This is useless',
    "You don't understand my question",
    'Почему так долго!!!',
    'WHY NO ONE ANSWERS ME',
  ],
  complaint: [
    'Хочу оставить жалобу на курьера',
    'Меня обманули с заказом',
    'Заказ не пришёл уже неделю',
    'Прислали не тот товар',
    'Хочу поскаржитися на менеджера',
    'Замовлення не прийшло досі',
    'Надіслали не те, що я замовляв',
    'I want to file a complaint',
    'My order never arrived',
    'The kettle arrived broken',
  ],
  refund: [
    'Верните деньги за заказ',
    'Хочу оформить возврат',
    'Требую возврат средств',
    'Поверніть гроші, будь ласка',
    'Хочу повернути чайник',
    'Вимагаю повернення коштів',
    'I want a refund',
    'Please refund my order',
    'I want my money back',
    'Сделаю chargeback через банк',
  ],
  wholesale: [
    'Можно купить оптом?',
    'Какие оптовые цены?',
    'Чи продаєте гуртом?',
    'Гуртові ціни є?',
    'Do you sell wholesale?',
    'I need a bulk order of 500 units',
    'Хочу замовити великою партією',
    'Нужен крупный заказ для магазина',
  ],
  sensitive: [
    'Я подам в суд на вас',
    'Мой адвокат с вами свяжется',
    'Подам до суду, якщо не повернете',
    'I will take legal action',
    'Удалите мои данные из вашей базы',
    'Видаліть мої дані',
    'Delete my personal data under GDPR',
    'Ребёнок отравился вашим товаром',
    'Пишу жалобу в защиту прав потребителей',
  ],
};

/** Обычные вопросы сайтов (сверх 96 вопросов платформы) — эскалации нет. */
const ORDINARY = [
  'Скільки коштує доставка до Києва?',
  'Які способи оплати у вас є?',
  'Чи можна оплатити карткою при отриманні?',
  'Скільки днів йде посилка до Львова?',
  'Чи є самовивіз у Дніпрі?',
  'Який графік роботи магазину?',
  'Чи є знижки для постійних клієнтів?',
  'Як відстежити посилку?',
  'Чи є гарантія на чайник?',
  'Скільки триває гарантія на ноутбук?',
  'Які умови повернення товару?',
  'Чи можна обміняти товар іншого розміру?',
  'Де ваш офіс?',
  'Чи працюєте ви у вихідні?',
  'Скільки коштує експрес-доставка?',
  'Чи є безкоштовна доставка?',
  'Від якої суми безкоштовна доставка?',
  'Чи можна змінити адресу доставки?',
  'Які бренди чайників у вас є?',
  'Чи є в наявності чорний колір?',
  'Коли буде поповнення товару?',
  'Як зареєструватися на сайті?',
  'Я забув пароль, як відновити?',
  'Як підписатися на розсилку?',
  'Чи можна купити подарунковий сертифікат?',
  'Скільки коштує налаштування?',
  'Чи є пробний період?',
  'Як скасувати підписку?',
  'Чи можна оплатити рахунком для ФОП?',
  'Чи видаєте ви накладні?',
  'Сколько стоит доставка в Одессу?',
  'Какие способы оплаты доступны?',
  'Можно ли оплатить частями?',
  'Есть ли рассрочка?',
  'Где посмотреть статус заказа?',
  'Как долго идёт доставка Новой почтой?',
  'Есть ли у вас пункт самовывоза?',
  'Какие часы работы поддержки?',
  'Можно ли вернуть товар в течение 14 дней?',
  'Возвращаются ли деньги при отмене подписки?',
  'Какие документы нужны для гарантийного ремонта?',
  'Сколько длится диагностика?',
  'Сколько стоит чистка ноутбука?',
  'Есть ли гарантия на ремонт?',
  'Работаете ли вы с юрлицами?',
  'Можно ли получить счёт-фактуру?',
  'Есть ли скидка студентам?',
  'Как применить промокод?',
  'Почему не проходит оплата картой?',
  'Можно ли изменить заказ после оформления?',
  'Как отменить заказ до отправки?',
  'Есть ли доставка за границу?',
  'В каких городах есть ваши магазины?',
  'Какой размер выбрать?',
  'Из какого материала сделан корпус?',
  'Подходит ли зарядка к моей модели?',
  'Есть ли инструкция на русском?',
  'Сколько весит этот чайник?',
  'Какая мощность у блендера?',
  'Можно ли забрать заказ сегодня?',
  'What are your delivery options?',
  'How much does shipping cost?',
  'Do you ship internationally?',
  'What payment methods do you accept?',
  'Can I pay with PayPal?',
  'How long does delivery take?',
  'Where is your store located?',
  'What are your opening hours?',
  'Is there a warranty on laptops?',
  'What is your return policy?',
  'How do I track my order?',
  'Can I change my delivery address?',
  'Do you have this in stock?',
  'Is there a student discount?',
  'How do I reset my password?',
  'Do you offer gift cards?',
  'Is there a free trial?',
  'How do I cancel my subscription?',
  'Can I upgrade my plan later?',
  'Do you have an API?',
  'What formats can I export to?',
  'Is my data stored in the EU?',
  'How many users can I add?',
  'Do you offer refunds for annual plans?',
  'What is the screen size of this model?',
  'Can you repair a MacBook keyboard?',
  'How much does data recovery cost?',
  'Do you pick up laptops for repair?',
  'Is there parking near the service center?',
  'Do you work with VAT invoices?',
  'Скільки коштує заміна батареї?',
  'Чи ремонтуєте ви телефони?',
  'Скільки часу займає ремонт екрана?',
  'Чи даєте ви підмінний ноутбук?',
  'Чи є кур’єр по місту?',
  'Як оплатити ремонт?',
  'Чи можна прийти без запису?',
  'Які у вас ціни на діагностику?',
  'Чи зберігаються мої файли під час ремонту?',
  'Чи є у вас мобільний додаток?',
  'Как подключить интеграцию с CRM?',
  'Сколько стоит тариф Бизнес?',
  'Есть ли ограничение на число проектов?',
  'Как пригласить коллегу в аккаунт?',
  'Где найти API-ключ?',
  'Поддерживаете ли вы единый вход (SSO)?',
  'Как выгрузить отчёт в CSV?',
  'Есть ли тёмная тема?',
  'Можно ли работать офлайн?',
  'Как удалить проект?',
];

describe('detectEscalation — словари uk/ru/en (№13)', () => {
  it.each(Object.entries(POSITIVE))(
    '%s — все примеры срабатывают своим видом',
    (kind, list) => {
      for (const q of list) {
        expect([q, detectEscalation(q, ALL)]).toEqual([q, kind]);
      }
    },
  );

  it('ложные срабатывания ≤ 2% на ≥ 200 обычных вопросах платформы', () => {
    const questions = [
      ...PLATFORM_EVAL_CASES.map((c) => c.question),
      ...ORDINARY,
    ];
    expect(questions.length).toBeGreaterThanOrEqual(200);
    const hits = questions.filter((q) => detectEscalation(q, ALL) !== null);
    expect(hits.length / questions.length).toBeLessThanOrEqual(0.02);
  });

  it('выключенное правило не срабатывает; умолчание — опт выключен; пусто/не строка — null', () => {
    const def = defaultHandoffConfig().escalation;
    expect(detectEscalation('Можно купить оптом?', def)).toBeNull();
    expect(
      detectEscalation('Верните деньги', { ...ALL, refund: false }),
    ).toBeNull();
    expect(detectEscalation('', ALL)).toBeNull();
    expect(detectEscalation(undefined as unknown as string, ALL)).toBeNull();
    // Одно сообщение с жалобой и судом — сначала чувствительное (без генерации).
    expect(detectEscalation('Это обман, подам в суд', ALL)).toBe('sensitive');
  });
});

describeDb('Э3 H — эскалация в конвейере (escalation)', () => {
  const st = new HandoffStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    st.model.calls.length = 0;
  });

  it('sensitive — без модели: шаблон + «позвать оператора», trace.rule', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const r = await st.ask(s, 'Я подам в суд, если доставка не приедет');
    expect(st.model.calls).toHaveLength(0);
    expect(r.text).toContain('лучше обсудить с человеком');
    expect(r.actions.map((a) => a.kind)).toEqual(['handoff']);
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: r.meta!.messageId },
    });
    expect(msg.answerPath).toBe('template');
    expect(msg.trace).toMatchObject({
      rule: 'escalation:sensitive',
      path: 'template',
    });
  });

  it('жалоба — обычный ответ по сайту + кнопка человека; передача недоступна — форма заявки', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const r = await st.ask(
      s,
      'Заказ не пришёл, а доставка Новою поштою коштує 80 грн?',
    );
    expect(st.model.calls).toHaveLength(1);
    expect(r.actions.some((a) => a.kind === 'handoff')).toBe(true);
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: r.meta!.messageId },
    });
    expect(msg.trace).toMatchObject({
      rule: 'escalation:complaint',
      path: 'model',
    });

    const off = await st.handoffSite({ operators: 1, start: false });
    const r2 = await st.ask(off, 'Верните деньги за доставку');
    expect(r2.actions.some((a) => a.kind === 'handoff')).toBe(false);
    expect(r2.actions.some((a) => a.kind === 'lead')).toBe(true);
  });

  it('правило выключено владельцем — без кнопки и без пометки', async () => {
    const s = await st.handoffSite({
      operators: 1,
      config: { escalation: { ...ALL, refund: false } },
    });
    const r = await st.ask(s, 'Верните деньги за доставку Новою поштою');
    expect(r.actions.some((a) => a.kind === 'handoff')).toBe(false);
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: r.meta!.messageId },
    });
    expect((msg.trace as { rule: string | null }).rule).toBeNull();
  });

  it('«позовите человека» — передача (а не форма), событие handoff; без операторов — форма заявки (Э2)', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = st.visitor();
    const first = await st.ask(s, 'Скільки коштує доставка?', { visitor: v });
    st.signals.calls.length = 0;
    const r = await st.ask(s, 'позовіть оператора', {
      visitor: v,
      conversationId: first.meta!.conversationId,
    });
    expect(st.model.calls).toHaveLength(1);
    expect(r.events.some((e) => e.type === 'handoff')).toBe(true);
    expect(r.text).toContain('Кличу оператора');
    const h = await st.owner.assistSiteHandoff.findFirstOrThrow({
      where: { conversationId: first.meta!.conversationId },
    });
    expect(h).toMatchObject({ state: 'waiting', reason: 'visitor' });
    // Просьба человека после ответа модели — сигнал unhappy (L).
    expect(st.signals.calls).toEqual([
      expect.objectContaining({
        kind: 'unhappy',
        signal: 'handoff_after_answer',
        conversationId: first.meta!.conversationId,
      }),
    ]);
    // Следующий вопрос уже идёт оператору.
    const next = await st.ask(s, 'Ви тут?', {
      visitor: v,
      conversationId: first.meta!.conversationId,
    });
    expect(next.events.find((e) => e.type === 'handoff')).toEqual({
      type: 'handoff',
      state: 'waiting',
      relayed: true,
    });

    const none = await st.handoffSite({ operators: 1, start: false });
    const r2 = await st.ask(none, 'позовите человека');
    expect(r2.events.some((e) => e.type === 'handoff')).toBe(false);
    expect(r2.actions.map((a) => a.kind)).toEqual(['lead']);
  });

  it('«не нашёл» (пустой поиск) — форма заявки и «позвать оператора»; сигнал empty_search', async () => {
    const s = await st.handoffSite({ operators: 1, noPages: true });
    st.signals.calls.length = 0;
    const r = await st.ask(s, 'Чи продаєте ви телевізори Samsung QLED?');
    expect(st.model.calls).toHaveLength(0);
    expect(r.actions.map((a) => a.kind)).toEqual(['lead', 'handoff']);
    expect(st.signals.calls).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        signal: 'empty_search',
        messageId: r.meta!.messageId,
      }),
    ]);
  });
});
