/**
 * Приёмка Э2 п.7 — «лид приходит в Telegram-бот с текстом согласия»
 * (подменённый fetch бота): приём формы под ролью assist_public
 * (createMany, поля зашифрованы), согласие обязательно и берётся из
 * настройки сайта (не из запроса), доставка системным кодом получателям
 * кабинета (owner, assist: manager|operator), повтор кроном, failed после
 * leadDeliveryMaxAttempts. Модель лид «записать» не может (К-3): лиды
 * создаёт только SiteLeadsService.submit.
 */
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { chatErrorCode } from '../../modules/assist-site-chat/chat-errors';
import {
  decryptLeadFields,
  leadKey,
} from '../../modules/assist-site-chat/lead-crypto';
import type { LeadSubmitInput } from '../../modules/assist-site-chat/leads.service';
import { leadMessageText } from '../../modules/assist-site-chat/system/lead-delivery.service';
import {
  ChatStack,
  TEST_SECRETS_KEY,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';

jest.setTimeout(60_000);

const CONSENT = {
  uk: 'Я погоджуюсь на обробку контактів магазином «Тепло» (редакція 3).',
  ru: 'Я согласен на обработку контактов магазином «Тепло» (редакция 3).',
};

describeDb('Приёмка Э2 п.7 — лиды (leads)', () => {
  const st = new ChatStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.sent.length = 0;
    st.sendStatus = 200;
    st.delivery.now = () => new Date();
  });

  async function siteWithForm(): Promise<ChatSite> {
    const s = await st.site({
      name: 'Магазин «Тепло»',
      members: [
        { role: 'manager', productRoles: { assist: 'manager' } },
        { role: 'operator', productRoles: { assist: 'operator' } },
        { role: 'manager', productRoles: { qa: 'admin', assist: 'none' } },
      ],
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        leadsConfig: {
          schema: 1,
          fields: [
            { field: 'name', required: true },
            { field: 'phone', required: true },
            { field: 'comment', required: false },
          ],
          consentText: CONSENT,
          channels: ['telegram'],
        },
      },
    });
    return s;
  }

  function lead(
    s: ChatSite,
    over: Partial<LeadSubmitInput> = {},
  ): LeadSubmitInput {
    return {
      site: s.ctx(),
      visitor: st.visitor(),
      conversationId: null,
      fields: {
        name: 'Олена',
        phone: '+380 67 765 43 21',
        comment: 'Передзвоніть після 18:00',
      },
      consent: true,
      uiLang: 'uk',
      pageUrl: `${s.origin}/catalog/kettle-k200?utm_source=x&phone=1#top`,
      ...over,
    };
  }

  it('лид → бот: сайт, страница без query, поля, ТЕКСТ СОГЛАСИЯ из настройки и время; трём получателям кабинета', async () => {
    const s = await siteWithForm();
    const { leadId } = await st.leads.submit(lead(s));
    const row = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: leadId },
    });
    expect(row.deliveryState).toBe('delivered');
    expect(row.consentText).toBe(CONSENT.uk);
    expect(row.pageUrl).toBe(`${s.origin}/catalog/kettle-k200`);
    expect(row.fieldNames.sort()).toEqual(['comment', 'name', 'phone']);
    // Полный номер, а не «765»: три цифры изредка встречаются в случайном
    // шифротексте сами по себе (ложное падение CI).
    expect(row.fieldsEnc).not.toContain('765 43 21');
    expect(row.fieldsEnc).not.toContain('380677654321');
    expect(row.fieldsEnc).not.toContain('Олена');
    expect(
      decryptLeadFields(
        row.fieldsEnc,
        leadId,
        leadKey({ ASSIST_SECRETS_KEY: TEST_SECRETS_KEY })!,
      ),
    ).toEqual({
      name: 'Олена',
      phone: '+380 67 765 43 21',
      comment: 'Передзвоніть після 18:00',
    });
    // Чужой лид этим шифром не расшифровать (AAD = id).
    expect(
      decryptLeadFields(
        row.fieldsEnc,
        'other-id',
        leadKey({ ASSIST_SECRETS_KEY: TEST_SECRETS_KEY })!,
      ),
    ).toBeNull();
    expect(st.sent).toHaveLength(3);
    const body = st.sent[0].body;
    expect(st.sent[0].url).toBe(
      'https://api.telegram.org/botw3-bot-token/sendMessage',
    );
    expect(body.text).toContain('Магазин «Тепло»');
    expect(body.text).toContain(CONSENT.uk);
    expect(body.text).toContain('+380 67 765 43 21');
    expect(body.text).toContain(`${s.origin}/catalog/kettle-k200`);
    expect(body.text).not.toContain('utm_source');
    expect(
      JSON.stringify(st.sent.map((x) => x.body.chat_id).sort()),
    ).not.toContain('undefined');
    const delivered = row.deliveredTo as Array<{
      channel: string;
      chatId: string;
    }>;
    expect(delivered).toHaveLength(3);
    expect(delivered.every((d) => d.channel === 'telegram')).toBe(true);
    expect(delivered.map((d) => d.chatId)).toContain(
      s.ownerTelegramId.toString(),
    );
  });

  it('текст согласия — по языку интерфейса; из запроса его подменить нельзя (поля запроса его не содержат)', async () => {
    const s = await siteWithForm();
    const { leadId } = await st.leads.submit(lead(s, { uiLang: 'ru' }));
    const row = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: leadId },
    });
    expect(row.consentText).toBe(CONSENT.ru);
    // en в настройке нет — первый из заданных (uk).
    const en = await st.leads.submit(lead(s, { uiLang: 'en' }));
    const r2 = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: en.leadId },
    });
    expect(r2.consentText).toBe(CONSENT.uk);
  });

  it('без настройки формы — умолчание W4 (defaultLeadsConfig) с его текстом согласия', async () => {
    const s = await st.site();
    const { leadId } = await st.leads.submit(
      lead(s, { fields: { email: 'olena@example.com' } }),
    );
    const row = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: leadId },
    });
    expect(row.consentText).toMatch(/погоджуюся/);
  });

  it('отказы: без согласия — CONSENT_REQUIRED; плохой телефон, нет обязательного, лишнее поле, нет контакта — LEAD_INVALID; лид не записан', async () => {
    const s = await siteWithForm();
    const codeOf = async (inp: LeadSubmitInput) =>
      st.leads.submit(inp).then(
        () => 'OK',
        (e: unknown) => chatErrorCode(e),
      );
    expect(await codeOf(lead(s, { consent: false }))).toBe('CONSENT_REQUIRED');
    expect(
      await codeOf(lead(s, { fields: { name: 'О', phone: 'позвоните мне' } })),
    ).toBe('LEAD_INVALID');
    expect(await codeOf(lead(s, { fields: { phone: '+380671234567' } }))).toBe(
      'LEAD_INVALID',
    );
    expect(
      await codeOf(
        lead(s, {
          fields: { name: 'О', phone: '+380671234567', email: 'a@b.co' },
        }),
      ),
    ).toBe('LEAD_INVALID');
    expect(
      await codeOf(
        lead(s, {
          fields: {
            name: 'О',
            phone: '+380671234567',
            comment: 'x'.repeat(WIDGET_DEFAULTS.leadCommentMaxChars + 1),
          },
        }),
      ),
    ).toBe('LEAD_INVALID');
    const open = await st.site();
    expect(
      await codeOf(
        lead(open, { fields: { name: 'Олена', comment: 'без контакту' } }),
      ),
    ).toBe('LEAD_INVALID');
    expect(
      await st.owner.assistSiteLead.count({ where: { siteId: s.siteId } }),
    ).toBe(0);
  });

  it('свой диалог — лид со ссылкой и outcome=lead; чужой conversationId — лид без ссылки', async () => {
    const s = await siteWithForm();
    await st.pages(s, [
      {
        path: '/delivery',
        title: 'Доставка',
        lang: 'uk',
        text: 'Доставка коштує 80 грн.',
      },
    ]);
    const visitor = st.visitor();
    const chat = await st.ask(s, 'Доставка коштує скільки?', { visitor });
    const conv = chat.meta!.conversationId;
    const mine = await st.leads.submit(
      lead(s, { visitor, conversationId: conv }),
    );
    const r1 = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: mine.leadId },
    });
    expect(r1.conversationId).toBe(conv);
    expect(
      (
        await st.owner.assistSiteConversation.findUniqueOrThrow({
          where: { id: conv },
        })
      ).outcome,
    ).toBe('lead');
    const foreign = await st.leads.submit(lead(s, { conversationId: conv }));
    const r2 = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: foreign.leadId },
    });
    expect(r2.conversationId).toBeNull();
  });

  it('бот недоступен → pending с паузой; крон доставляет позже; после 5 попыток — failed (в lastError — только код)', async () => {
    const s = await siteWithForm();
    st.sendStatus = 500;
    const { leadId } = await st.leads.submit(lead(s));
    let row = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: leadId },
    });
    expect(row).toMatchObject({
      deliveryState: 'pending',
      attempts: 1,
      lastError: 'not_delivered',
    });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Пауза ещё не прошла — крон его не трогает.
    expect(await st.delivery.deliver(leadId)).toBe('retry');
    expect(
      (
        await st.owner.assistSiteLead.findUniqueOrThrow({
          where: { id: leadId },
        })
      ).attempts,
    ).toBe(1);
    st.sendStatus = 200;
    st.delivery.now = () => new Date(Date.now() + 10 * 60_000);
    const before = st.sent.length;
    expect(await st.delivery.deliver(leadId)).toBe('delivered');
    expect(st.sent.length - before).toBe(3);
    row = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: leadId },
    });
    expect(row.deliveryState).toBe('delivered');

    st.delivery.now = () => new Date();
    st.sendStatus = 403;
    const second = await st.leads.submit(lead(s));
    for (let i = 1; i < WIDGET_DEFAULTS.leadDeliveryMaxAttempts; i++) {
      st.delivery.now = () => new Date(Date.now() + i * 3_600_000);
      await st.delivery.deliver(second.leadId);
    }
    const failed = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: second.leadId },
    });
    expect(failed).toMatchObject({
      deliveryState: 'failed',
      attempts: WIDGET_DEFAULTS.leadDeliveryMaxAttempts,
    });
    expect(failed.lastError).toBe('not_delivered');
  });

  it('redeliverPending: берёт недоставленные с истёкшей паузой', async () => {
    const s = await siteWithForm();
    st.sendStatus = 500;
    const { leadId } = await st.leads.submit(lead(s));
    st.sendStatus = 200;
    st.delivery.now = () => new Date(Date.now() + 30 * 60_000);
    const n = await st.delivery.redeliverPending(500);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(
      (
        await st.owner.assistSiteLead.findUniqueOrThrow({
          where: { id: leadId },
        })
      ).deliveryState,
    ).toBe('delivered');
  });

  it('без токена бота — лид записан, доставка отложена (bot_not_configured), текст лида не уходит никуда', async () => {
    const s = await siteWithForm();
    const env = st.delivery.env;
    st.delivery.env = { ...env, ASSIST_BOT_TOKEN: '' };
    try {
      const { leadId } = await st.leads.submit(lead(s));
      const row = await st.owner.assistSiteLead.findUniqueOrThrow({
        where: { id: leadId },
      });
      expect(row).toMatchObject({
        deliveryState: 'pending',
        lastError: 'bot_not_configured',
      });
      expect(st.sent).toHaveLength(0);
    } finally {
      st.delivery.env = env;
    }
  });

  it('текст сообщения: только заполненные поля, согласие с временем UTC', () => {
    const t = leadMessageText({
      siteName: 'S',
      pageUrl: null,
      fields: { phone: '+380' },
      consentText: 'Згода',
      consentAt: new Date('2026-10-01T10:20:30Z'),
    });
    expect(t).toBe(
      'Новая заявка с сайта «S»\nТелефон: +380\n\nСогласие посетителя (2026-10-01 10:20 UTC):\n«Згода»',
    );
  });
});
