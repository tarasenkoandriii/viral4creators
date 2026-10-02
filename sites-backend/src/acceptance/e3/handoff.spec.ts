/**
 * Э3 H — передача человеку в Telegram на НАСТОЯЩЕМ Postgres (контракт Э3
 * §7: Э3-1, Э3-3, таймаут → missed → форма заявки, напоминание, повтор
 * рассылки кроном, /start и 403, права, логи без текста).
 * Публичная часть (приём, конвейер, `GET state`) — под ролью assist_public,
 * системная — основной ролью; Telegram — подменённый fetch (тела запросов
 * сверяются: кнопки, callback_data ≤ 64 байт, маскированный текст).
 */
import { Logger } from '@nestjs/common';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { ForgetJobs } from '../../modules/assist-site-learning/public/forget-jobs';
import { HandoffStack } from '../../modules/assist-site-handoff/testing/handoff-stack.testing';
import { WidgetStateService } from '../../modules/assist-widget/widget-state.service';

jest.setTimeout(60_000);

describeDb('Э3 H — передача человеку (handoff)', () => {
  const st = new HandoffStack();
  let state: WidgetStateService;
  const logs: string[] = [];

  beforeAll(async () => {
    await st.init();
    state = new WidgetStateService(
      st.publicDb,
      st.cache,
      st.intake,
      st.signals,
      new ForgetJobs(st.publicDb),
    );
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(capture);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await st.close();
  });
  beforeEach(() => {
    st.tg.clear();
    st.tg.status = 200;
    st.htext.fail = false;
    st.model.mode = 'honest';
    st.model.calls.length = 0;
  });

  it('Э3-1: карточки с Start → «Взять» → реплай → посетитель видит ответ в GET state (≤ 5 с)', async () => {
    const s = await st.handoffSite({ operators: 2 });
    // Участник без Start карточку не получает (писать можно только нажавшим Start).
    const noStart = await st.owner.siteAccountMember.create({
      data: {
        accountId: s.accountId,
        telegramId: s.members[0].telegramId + BigInt(900_000),
        role: 'operator',
        productRoles: { assist: 'operator' },
      },
    });
    // Строка бота без Start (например, после my_chat_member) — тоже не получатель.
    await st.owner.assistBotUser.create({
      data: { telegramId: noStart.telegramId, startedAt: null },
    });
    st.dispatcher.forgetRecipients();
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    expect(r).toMatchObject({ mode: 'human', existing: false });
    if (r.mode !== 'human') throw new Error('ожидалась передача');
    expect(r.handoff.state).toBe('waiting');

    // Карточка: владелец + 2 оператора, без query страницы, кнопки ≤ 64 байт.
    expect(st.tg.cards()).toHaveLength(3);
    expect(st.tg.cards(noStart.telegramId)).toHaveLength(0);
    const card = st.tg.cards(s.operators[0].telegramId)[0];
    expect(String(card.body.text)).toContain(`Страница: ${s.url('/delivery')}`);
    expect(String(card.body.text)).not.toContain('utm=secret');
    // Сводка модели с «телефоном» — в Telegram только маскированная (§3.7).
    expect(String(card.body.text)).not.toMatch(/123\s?45\s?67/);
    for (const cb of st.tg.callbacks()) {
      expect(Buffer.byteLength(cb, 'utf8')).toBeLessThanOrEqual(64);
    }
    expect(st.tg.callbacks()).toContain(`h:take:${r.handoff.id}`);
    const h0 = await st.handoffRow(r.handoff.id);
    expect(h0.deliveredAt).not.toBeNull();
    expect(h0.operatorLang).toBe('uk');
    expect(h0.pageUrl).toBe(s.url('/delivery'));

    // «Взять» вторым оператором; остальным карточкам — правка «взял другой».
    const op = s.operators[1];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    const taken = await st.handoffRow(r.handoff.id);
    expect(taken).toMatchObject({
      state: 'active',
      assignedMemberId: op.memberId,
    });
    expect(
      String(st.tg.edits(s.operators[0].telegramId)[0]?.body.text),
    ).toContain('взял другой оператор');
    expect(String(st.tg.edits(op.telegramId)[0]?.body.text)).toContain(
      'Диалог ваш',
    );

    // Реплай на карточку → сообщение в базе → GET state под ролью виджета.
    const myCard = st.tg.cards(op.telegramId)[0];
    const before = await state.state(
      { site: s.ctx(), visitor: v.visitor },
      null,
    );
    const t0 = Date.now();
    await st.replyTo(
      op.telegramId,
      myCard.messageId as number,
      'Доставка завтра, звоните 044 123 45 67',
    );
    const after = await state.state(
      { site: s.ctx(), visitor: v.visitor },
      before.conversation?.stateVersion ?? null,
    );
    const writeMs = Date.now() - t0;
    const op1 = after.conversation?.messages.find((m) => m.role === 'operator');
    // Голос бизнеса — как написан (телефон магазина не маскируется, О-5).
    expect(op1?.text).toBe('Доставка завтра, звоните 044 123 45 67');
    expect(after.conversation?.handoff).toMatchObject({
      id: r.handoff.id,
      state: 'active',
    });
    // Запись < 1 с + опрос iframe раз в 3 с = ≤ 5 с (решение 3).
    expect(writeMs).toBeLessThan(2_000);
    // Кнопка «Предложить как проверенный» — под эхом оператору.
    const echo = st.tg
      .sent(op.telegramId)
      .find((x) => String(x.body.text).startsWith('✓'));
    expect(JSON.stringify(echo?.body.reply_markup)).toContain(
      `l:prop:${op1?.id}`,
    );
    const hRow = await st.handoffRow(r.handoff.id);
    expect(hRow.firstReplyAt).not.toBeNull();
  });

  it('вопрос посетителя во время передачи — оператору (маскированный, с переводом), не модели', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('ожидалась передача');
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    st.tg.clear();
    st.model.calls.length = 0;
    const q = await st.ask(s, 'Hello, my phone is +380 50 765 43 21, when?', {
      visitor: v.visitor,
      conversationId: v.conversationId,
    });
    expect(st.model.calls).toHaveLength(0);
    expect(q.events.map((e) => e.type)).toEqual(['meta', 'handoff', 'done']);
    expect(q.events[1]).toEqual({
      type: 'handoff',
      state: 'active',
      relayed: true,
    });
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: q.meta!.messageId },
    });
    expect(msg.text).not.toContain('765');
    expect(msg.relayedAt).not.toBeNull();
    expect(msg.translation).toMatchObject({ lang: 'uk' });
    // Пересылка — только взявшему, текст маскированный, рядом перевод.
    const relayed = st.tg.sent(op.telegramId);
    expect(relayed).toHaveLength(1);
    expect(String(relayed[0].body.text)).not.toContain('765');
    expect(String(relayed[0].body.text)).toContain('Перевод (uk)');
    expect(st.tg.sent(s.members[0].telegramId)).toHaveLength(0);

    // Ответ оператора переводится на язык посетителя, оригинал — в translation.
    await st.replyTo(op.telegramId, relayed[0].messageId as number, 'Завтра');
    const reply = await st.owner.assistSiteMessage.findFirstOrThrow({
      where: { conversationId: v.conversationId, role: 'operator' },
    });
    expect(reply.text).toBe('[en] Завтра');
    expect(reply.translation).toEqual({ lang: 'uk', text: 'Завтра' });
    expect(reply.authorMemberId).toBe(op.memberId);
  });

  it('оператора удалили из кабинета (или сняли права) — сообщения посетителя и напоминания ему больше не пересылаются', async () => {
    const s = await st.handoffSite({ operators: 2 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('ожидалась передача');
    const [gone, demoted] = s.operators;
    // Пока ждём — пересылка всем, у кого карточка; один удалён, другому сняли права.
    await st.owner.siteAccountMember.delete({ where: { id: gone.memberId } });
    await st.owner.siteAccountMember.update({
      where: { id: demoted.memberId },
      data: { productRoles: { assist: 'none' } },
    });
    st.tg.clear();
    await st.ask(s, 'Ви тут?', {
      visitor: v.visitor,
      conversationId: v.conversationId,
    });
    expect(st.tg.sent(gone.telegramId)).toHaveLength(0);
    expect(st.tg.sent(demoted.telegramId)).toHaveLength(0);
    // Напоминание «посетитель ждёт» — тоже никому из них.
    await st.dispatcher.tick(new Date(Date.now() + 4 * 60_000), {
      siteIds: [s.siteId],
    });
    expect(st.tg.sent(gone.telegramId)).toHaveLength(0);
    expect(st.tg.sent(demoted.telegramId)).toHaveLength(0);
  });

  it('identify (К-3): только шифром в передаче; userHash сверяет A — «проверен»/«заявлено» в карточке без значений', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const op = s.operators[0].telegramId;
    const identity = {
      name: 'Іван Покупець',
      email: 'ivan.buyer@example.com',
      externalId: 'cust-42',
      userHash: 'good',
    };
    const v1 = await st.visitorWithDialog(s);
    const r1 = await st.requestHandoff(s, v1, { identity });
    if (r1.mode !== 'human') throw new Error('передача');
    const row = await st.handoffRow(r1.handoff.id);
    expect(row.identityEnc).toMatch(/^v1\./);
    expect(row.identityEnc).not.toContain('cust-42');
    expect(row.identityVerified).toBe(true);
    expect(st.integrations.calls).toContainEqual([s.siteId, 'cust-42', 'good']);
    const card = String(st.tg.cards(op)[0].body.text);
    expect(card).toContain('проверен');
    expect(card).not.toMatch(/Іван|ivan\.buyer|cust-42/);

    st.tg.clear();
    const v2 = await st.visitorWithDialog(s);
    const r2 = await st.requestHandoff(s, v2, {
      identity: { ...identity, userHash: 'forged' },
    });
    if (r2.mode !== 'human') throw new Error('передача');
    expect((await st.handoffRow(r2.handoff.id)).identityVerified).toBe(false);
    expect(String(st.tg.cards(op)[0].body.text)).toContain('заявлено');
    // Без identify — строки «покупатель» нет вовсе.
    st.tg.clear();
    const v3 = await st.visitorWithDialog(s);
    await st.requestHandoff(s, v3);
    expect(String(st.tg.cards(op)[0].body.text)).not.toContain('Покупатель');
  });

  it('повтор нажатия — та же передача; отмена посетителем только пока ждём', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const a = await st.requestHandoff(s, v);
    const b = await st.requestHandoff(s, v);
    if (a.mode !== 'human' || b.mode !== 'human') throw new Error('передача');
    expect(b.existing).toBe(true);
    expect(b.handoff.id).toBe(a.handoff.id);
    expect(st.tg.cards()).toHaveLength(2);
    expect(await st.intake.cancel(s.ctx(), v.visitor, v.conversationId)).toBe(
      true,
    );
    expect((await st.handoffRow(a.handoff.id)).state).toBe('cancelled');
    expect(await st.intake.cancel(s.ctx(), v.visitor, v.conversationId)).toBe(
      false,
    );
    // Чужой посетитель не видит и не отменяет.
    expect(
      await st.intake.visitorView(s.ctx(), st.visitor(), v.conversationId),
    ).toBeNull();
  });

  it('недоступна: выключена / нерабочее время / нет операторов с Start / нет диалога → форма заявки', async () => {
    const s = await st.handoffSite({ operators: 1, start: false });
    const v = await st.visitorWithDialog(s);
    expect(await st.requestHandoff(s, v)).toEqual({
      mode: 'lead',
      reason: 'no_operators',
    });
    await st.setConfig(s.siteId, { enabled: false });
    expect(await st.requestHandoff(s, v)).toEqual({
      mode: 'lead',
      reason: 'disabled',
    });
    // Рабочие часы — только воскресенье 00:00–00:01 по Киеву: сейчас почти наверняка нет.
    await st.setConfig(s.siteId, {
      enabled: true,
      hours: { sun: [{ from: '00:00', to: '00:01' }] },
    });
    await st.startBot(s.members[0].telegramId);
    st.dispatcher.forgetRecipients();
    const off = await st.intake.availability(
      s.ctx(),
      new Date('2026-10-07T10:00:00Z'),
    );
    expect(off).toMatchObject({ available: false, reason: 'off_hours' });
    expect(
      await st.requestHandoff(s, { ...v, conversationId: 'чужой' as string }),
    ).toEqual({ mode: 'lead', reason: 'no_conversation' });
    // Предпросмотр конфигуратора — к живым операторам не уходит.
    await st.setConfig(s.siteId, { enabled: true });
    expect(
      await st.intake.request({
        site: s.ctx({ preview: true }),
        visitor: v.visitor,
        conversationId: v.conversationId,
        reason: 'visitor',
        uiLang: null,
        pageUrl: null,
        identity: null,
      }),
    ).toEqual({ mode: 'lead', reason: 'disabled' });
    expect(st.tg.cards()).toHaveLength(0);
  });

  it('Э3-3: посетитель ушёл — ответ через 23 ч виден при возвращении; через 24 ч простоя передача закрывается', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    const taken = await st.handoffRow(r.handoff.id);
    const t23 = new Date((taken.takenAt as Date).getTime() + 23 * 3600_000);
    // Крон «через 23 ч» — только по своему сайту (гигиена §9 п.6).
    const tick23 = await st.dispatcher.tick(t23, { siteIds: [s.siteId] });
    expect(tick23.closed).toBe(0);
    st.actions.now = () => t23;
    try {
      await st.replyTo(
        op.telegramId,
        st.tg.cards(op.telegramId)[0].messageId as number,
        'Вибачте за затримку: доставка завтра',
      );
    } finally {
      st.actions.now = () => new Date();
    }
    // Возвращение (resume) — тот же посетитель, state под ролью виджета.
    const back = await state.state({ site: s.ctx(), visitor: v.visitor }, null);
    expect(back.conversation?.messages.map((m) => m.role)).toContain(
      'operator',
    );
    expect(back.conversation?.messages.at(-1)?.text).toBe(
      'Вибачте за затримку: доставка завтра',
    );
    // Простой 24 ч после ответа — закрыто кроном, карточка правится.
    const t48 = new Date(t23.getTime() + 25 * 3600_000);
    const tick48 = await st.dispatcher.tick(t48, { siteIds: [s.siteId] });
    expect(tick48.closed).toBe(1);
    expect(await st.handoffRow(r.handoff.id)).toMatchObject({
      state: 'closed',
      closedBy: 'timeout',
    });
  });

  it('таймаут: никто не взял → missed (посетителю — форма заявки), напоминание до maxReminders; взять можно и позже', async () => {
    const s = await st.handoffSite({
      operators: 1,
      config: { waitMinutes: 10, remindAfterMinutes: 3, maxReminders: 1 },
    });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const req = (await st.handoffRow(r.handoff.id)).requestedAt.getTime();
    const tick = (min: number) =>
      st.dispatcher.tick(new Date(req + min * 60_000), { siteIds: [s.siteId] });
    st.tg.clear();
    expect((await tick(2)).reminded).toBe(0);
    expect((await tick(3.1)).reminded).toBe(1);
    // Напоминание — всем получателям карточки, ответом на неё.
    const reminders = st.tg
      .sent()
      .filter((x) => String(x.body.text).startsWith('⏰'));
    expect(reminders).toHaveLength(2);
    expect(reminders[0].body.reply_parameters).toMatchObject({
      message_id: expect.any(Number),
    });
    // maxReminders = 1: через 3 мин после первого — уже нет.
    expect((await tick(6.5)).reminded).toBe(0);
    const t11 = await tick(11);
    expect(t11.missed).toBe(1);
    const view = await st.intake.visitorView(
      s.ctx(),
      v.visitor,
      v.conversationId,
    );
    expect(view?.state).toBe('missed');
    const conv = await st.owner.assistSiteConversation.findUniqueOrThrow({
      where: { id: v.conversationId },
    });
    expect(conv.handoffState).toBe('missed');
    expect(
      st.tg.edits().some((e) => String(e.body.text).includes('Никто не взял')),
    ).toBe(true);
    // Оператор увидел карточку позже — берёт и отвечает (§3.7 п.5).
    await st.callback(s.operators[0].telegramId, `h:take:${r.handoff.id}`);
    expect((await st.handoffRow(r.handoff.id)).state).toBe('active');
  });

  it('пропущенную не взять, если посетитель уже позвал снова: «не ждёт», а не сбой; новая передача не тронута', async () => {
    const s = await st.handoffSite({
      operators: 1,
      config: { waitMinutes: 1 },
    });
    const v = await st.visitorWithDialog(s);
    const a = await st.requestHandoff(s, v);
    if (a.mode !== 'human') throw new Error('передача');
    const req = (await st.handoffRow(a.handoff.id)).requestedAt.getTime();
    await st.dispatcher.tick(new Date(req + 2 * 60_000), {
      siteIds: [s.siteId],
    });
    expect((await st.handoffRow(a.handoff.id)).state).toBe('missed');
    const b = await st.requestHandoff(s, v);
    if (b.mode !== 'human') throw new Error('передача');
    expect(b.handoff.id).not.toBe(a.handoff.id);
    const op = s.operators[0];
    const r = await st.actions.take(
      { via: 'bot', telegramId: op.telegramId },
      a.handoff.id,
    );
    expect(r.result).toBe('not_waiting');
    expect((await st.handoffRow(a.handoff.id)).state).toBe('missed');
    expect((await st.handoffRow(b.handoff.id)).state).toBe('waiting');
  });

  it('повтор рассылки кроном: Telegram недоступен → карточки не дошли → крон дослал', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    st.tg.status = 502;
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const h1 = await st.handoffRow(r.handoff.id);
    expect(h1.deliveredAt).toBeNull();
    expect(h1.attempts).toBe(1);
    st.tg.status = 200;
    // Пауза повтора (lockedUntil) — крон «через 2 минуты».
    const t = await st.dispatcher.tick(
      new Date(Date.now() + 2 * 60_000 + 5_000),
      {
        siteIds: [s.siteId],
      },
    );
    expect(t.redelivered).toBe(1);
    expect(st.tg.cards()).toHaveLength(2);
    // Идемпотентно: следующий тик никому не шлёт второй раз.
    await st.dispatcher.dispatch(r.handoff.id);
    expect(st.tg.cards()).toHaveLength(2);
  });

  it('вопрос посетителя, пока карточки не дошли (Telegram недоступен), оператор получает после досылки', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    st.tg.status = 502;
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const q = await st.ask(s, 'Де моє замовлення номер сорок два?', {
      visitor: v.visitor,
      conversationId: v.conversationId,
    });
    expect(q.events.map((e) => e.type)).toEqual(['meta', 'handoff', 'done']);
    st.tg.status = 200;
    st.tg.clear();
    await st.dispatcher.tick(new Date(Date.now() + 2 * 60_000 + 5_000), {
      siteIds: [s.siteId],
    });
    const op = s.operators[0];
    expect(st.tg.cards(op.telegramId)).toHaveLength(1);
    expect(
      st.tg
        .sent(op.telegramId)
        .some((m) => String(m.body.text).includes('сорок два')),
    ).toBe(true);
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: q.meta!.messageId },
    });
    expect(msg.relayedAt).not.toBeNull();
  });

  it('/start → получатель; блокировка (my_chat_member и 403) → не получатель', async () => {
    const s = await st.handoffSite({ operators: 1, start: false });
    const op = s.operators[0];
    await st.botStart(op.telegramId);
    const u = await st.owner.assistBotUser.findUniqueOrThrow({
      where: { telegramId: op.telegramId },
    });
    expect(u.startedAt).not.toBeNull();
    expect(u.languageCode).toBe('ru');
    expect(String(st.tg.sent(op.telegramId)[0]?.body.text)).toContain('Готово');
    expect(await st.intake.availability(s.ctx())).toMatchObject({
      available: true,
    });

    await st.bot.handle({
      update_id: 1,
      my_chat_member: {
        chat: { id: Number(op.telegramId), type: 'private' },
        from: { id: Number(op.telegramId) },
        new_chat_member: { status: 'kicked' },
      },
    });
    expect(await st.intake.availability(s.ctx())).toMatchObject({
      available: false,
      reason: 'no_operators',
    });
    // Снова Start — и 403 при рассылке ставит blockedAt.
    await st.botStart(op.telegramId);
    const v = await st.visitorWithDialog(s);
    st.tg.status = ({ chatId }) =>
      chatId === op.telegramId.toString() ? 403 : 200;
    await st.requestHandoff(s, v);
    const blocked = await st.owner.assistBotUser.findUniqueOrThrow({
      where: { telegramId: op.telegramId },
    });
    expect(blocked.blockedAt).not.toBeNull();
  });

  it('права: участник другого кабинета не берёт и не отвечает; реплай не на наше сообщение — подсказка', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const other = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const stranger = other.operators[0];
    await st.callback(stranger.telegramId, `h:take:${r.handoff.id}`);
    expect((await st.handoffRow(r.handoff.id)).state).toBe('waiting');
    const answered = st.tg.requests.find(
      (x) => x.method === 'answerCallbackQuery',
    );
    expect(String(answered?.body.text)).toContain('не найдена');
    // TMA чужого кабинета — 404 (не оракул чужих id).
    await expect(
      st.actions.take(
        {
          via: 'tma',
          membership: {
            accountId: other.accountId,
            memberId: stranger.memberId,
            telegramId: stranger.telegramId,
            role: 'operator',
            productRoles: {
              qa: 'none',
              assist: 'operator',
              assistAdmin: 'none',
            },
          },
        },
        r.handoff.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // Участник без assist — 403.
    const noAssist = await st.owner.siteAccountMember.create({
      data: {
        accountId: s.accountId,
        telegramId: stranger.telegramId + BigInt(77),
        role: 'operator',
        productRoles: { qa: 'viewer' },
      },
    });
    await expect(
      st.actions.take(
        { via: 'bot', telegramId: noAssist.telegramId },
        r.handoff.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
    // Реплай на сообщение, которого нет в assist_bot_messages.
    st.tg.clear();
    await st.replyTo(s.operators[0].telegramId, 999_999, 'текст');
    expect(String(st.tg.sent()[0]?.body.text)).toContain('реплаем');
    expect(
      await st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      }),
    ).toBe(0);
  });

  it('ответ оператора: только взявший (оператор), перехват — manager/owner; закрыто — HANDOFF_CLOSED; только текст', async () => {
    const s = await st.handoffSite({ operators: 2 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const [a, b] = s.operators;
    await st.callback(a.telegramId, `h:take:${r.handoff.id}`);
    await expect(
      st.actions.reply({ via: 'bot', telegramId: b.telegramId }, r.handoff.id, {
        text: 'я тоже',
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Фото вместо текста — «пока только текст», посетителю ничего не уходит.
    const cardA = st.tg.cards(a.telegramId)[0].messageId as number;
    st.tg.clear();
    await st.replyTo(a.telegramId, cardA, null);
    expect(String(st.tg.sent(a.telegramId)[0]?.body.text)).toContain(
      'только текст',
    );
    expect(
      await st.owner.assistSiteMessage.count({
        where: { conversationId: v.conversationId, role: 'operator' },
      }),
    ).toBe(0);
    // Владелец перехватывает.
    const owner = s.members[0];
    const res = await st.actions.reply(
      { via: 'bot', telegramId: owner.telegramId },
      r.handoff.id,
      { text: 'Відповідає власник', noTranslate: true },
    );
    expect(res.translated).toBe(false);
    expect((await st.handoffRow(r.handoff.id)).assignedMemberId).toBe(
      owner.memberId,
    );
    await expect(
      st.actions.reply(
        { via: 'bot', telegramId: owner.telegramId },
        r.handoff.id,
        {
          text: '   ',
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await st.callback(owner.telegramId, `h:close:${r.handoff.id}`);
    await expect(
      st.actions.reply(
        { via: 'bot', telegramId: owner.telegramId },
        r.handoff.id,
        {
          text: 'ещё',
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('закрытие после ответа модели и оператора — operator_fix (L) по первому ответу оператора', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    const out = await st.actions.reply(
      { via: 'bot', telegramId: op.telegramId },
      r.handoff.id,
      { text: 'Насправді доставка безкоштовна від 1000 грн' },
    );
    st.candidates.fixes.length = 0;
    await st.callback(op.telegramId, `h:close:${r.handoff.id}`);
    expect(st.candidates.fixes).toEqual([
      {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: v.conversationId,
        operatorMessageId: out.messageId,
      },
    ]);
    // «Предложить как проверенный» — в L по кнопке.
    await st.callback(op.telegramId, `l:prop:${out.messageId}`);
    expect(st.candidates.proposals).toContainEqual({
      telegramId: op.telegramId,
      messageId: out.messageId,
    });
  });

  it('медиана «~N минут» за 7 дней: ≥ 5 передач с ответом — минуты; меньше — null', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const base = Date.now() - 3600_000;
    for (let i = 0; i < 5; i++) {
      const conv = await st.owner.assistSiteConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          visitorId: v.visitor.visitorId,
          ipHash: 'x',
          parentOrigin: s.origin,
        },
      });
      await st.owner.assistSiteHandoff.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: conv.id,
          state: 'closed',
          reason: 'visitor',
          requestedAt: new Date(base),
          firstReplyAt: new Date(base + (i + 1) * 60_000),
          timeoutAt: new Date(base + 300_000),
        },
      });
    }
    // Пока ответов меньше etaMinSamples — медианы нет (текст владельца).
    expect((await st.intake.availability(s.ctx())).etaMinutes).toBeNull();
    const t = await st.dispatcher.tick(new Date(), { siteIds: [s.siteId] });
    expect(t.etaUpdated).toBe(1);
    const row = await st.owner.assistSite.findUniqueOrThrow({
      where: { siteId: s.siteId },
    });
    expect(row.handoffEtaMinutes).toBe(3);
    expect((await st.intake.availability(s.ctx())).etaMinutes).toBe(3);
  });

  it('логи передачи: ни текста сообщений, ни сводки, ни telegramId, ни токена бота', async () => {
    logs.length = 0;
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(
      s,
      'Скільки коштує доставка? мій email ivan@example.com',
    );
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const op = s.operators[0];
    await st.callback(op.telegramId, `h:take:${r.handoff.id}`);
    await st.replyTo(
      op.telegramId,
      st.tg.cards(op.telegramId)[0].messageId as number,
      'СЕКРЕТНИЙ-ТЕКСТ-ОПЕРАТОРА',
    );
    await st.ask(s, 'ТАЄМНЕ-ПИТАННЯ відвідувача', {
      visitor: v.visitor,
      conversationId: v.conversationId,
    });
    st.tg.status = 403;
    await st.dispatcher.relayVisitorMessage('нет-такого');
    await st.dispatcher.tick(new Date(), { siteIds: [s.siteId] });
    const all = logs.join('\n');
    expect(all).toContain(r.handoff.id);
    for (const bad of [
      'СЕКРЕТНИЙ-ТЕКСТ-ОПЕРАТОРА',
      'ТАЄМНЕ-ПИТАННЯ',
      'ivan@example.com',
      'доставка',
      op.telegramId.toString(),
      s.members[0].telegramId.toString(),
      String(st.env.ASSIST_BOT_TOKEN),
      st.htext.summary.slice(0, 20),
    ]) {
      expect(all).not.toContain(bad);
    }
  });
});
