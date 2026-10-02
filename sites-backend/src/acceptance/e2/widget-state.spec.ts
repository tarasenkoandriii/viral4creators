/**
 * Состояние посетителя и чат по HTTP — W2 (ТЗ §4-бис.2, §4-бис.4,
 * §4-бис.10 п.3 и п.9, §6.3 forget; контракт Э2 §5 стык W2 → W3). Конвейер
 * W3 — подделка с его контрактом идемпотентности (testing/widget-stack):
 * здесь проверяется сторона W2 — токен, частота, SSE/JSON, дочитывание
 * стрима из базы, изоляция по visitor-token, 👍/👎, forget.
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import {
  WIDGET_VISITOR_TOKEN_HEADER,
  widgetResumeCookieName,
} from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { WidgetStateService } from '../../modules/assist-widget/widget-state.service';
import {
  DAY,
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

/** Свой адрес (IPv6 /64) у каждого вызова: окна лимитов в базе живут между прогонами. */
function freshIp(): string {
  return `${randomV6Prefix()}::1`;
}

interface Sse {
  type: string;
  data: Record<string, unknown>;
}
function parseSse(text: string): Sse[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.+)$/m.exec(b)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(b)?.[1] ?? '{}';
      return { type: ev, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describeDb('Состояние, чат и forget виджета по HTTP (W2: §4-бис, §6.3)', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
    stack = await startWidgetStack();
    const st = stack.app.get(WidgetStateService);
    st.pollMaxMs = 1_500;
    st.pollStepMs = 50;
  });
  afterAll(async () => stack?.close());
  beforeEach(() => {
    stack.chat.leaveStreaming = false;
    stack.chat.failWith = null;
  });

  async function visitor(f: WidgetFixture, hostIdx = 0): Promise<string> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', freshIp())
      .send({ pk: f.pk, parentOrigin: f.hosts[hostIdx].origin })
      .expect(200);
    return r.body.data.visitorToken as string;
  }
  const authed = (
    method: 'get' | 'post',
    path: string,
    token: string,
  ): request.Test =>
    request(srv())
      [method](path)
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token);

  function chatJson(token: string, body: Record<string, unknown>) {
    return authed('post', '/widget/v1/chat', token)
      .set('Accept', 'application/json')
      .send({
        conversationId: null,
        clientRequestId: newRequestId(),
        question: 'Сколько стоит доставка?',
        page: {
          url: 'https://example.com/delivery?utm=x#top',
          title: 'Доставка',
        },
        context: null,
        uiLang: 'ru',
        ...body,
      });
  }

  it('SSE: meta первым, токены, sources, done; страница — без query; visitor — из токена', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const r = await authed('post', '/widget/v1/chat', token)
      .set('Accept', 'text/event-stream')
      .send({
        conversationId: null,
        clientRequestId: newRequestId(),
        question: '  Сколько стоит доставка?  ',
        page: {
          url: 'https://example.com/delivery?email=a@b.c',
          title: 'Доставка',
        },
        context: { sku: 'ABC-1234', price: 1200, bad: { x: 1 } },
        uiLang: 'ru',
      })
      .buffer(true)
      .parse((res, cb) => {
        let t = '';
        res.on('data', (c: Buffer) => (t += c.toString()));
        res.on('end', () => cb(null, t));
      })
      .expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/event-stream/);
    const events = parseSse(r.body as string);
    expect(events[0].type).toBe('meta');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['token', 'sources', 'done']),
    );
    const input = stack.chat.inputs.at(-1)!;
    expect(input.question).toBe('Сколько стоит доставка?');
    expect(input.page).toEqual({
      url: 'https://example.com/delivery',
      title: 'Доставка',
    });
    expect(input.context).toEqual({ sku: 'ABC-1234', price: 1200 });
    expect(input.site.siteId).toBe(f.siteId);
    expect(input.site.parentOrigin).toBe(f.hosts[0].origin);
  });

  it('вопрос длиннее maxQuestionChars — QUESTION_TOO_LONG без вызова конвейера', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const before = stack.chat.inputs.length;
    const r = await chatJson(token, {
      question: 'а'.repeat(WIDGET_DEFAULTS.maxQuestionChars + 1),
    }).expect(400);
    expect(r.body.error.code).toBe('QUESTION_TOO_LONG');
    expect(stack.chat.inputs.length).toBe(before);
  });

  it('частота: 10 сообщений в минуту на посетителя, 11-е — RATE_LIMITED до конвейера', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    for (let i = 0; i < WIDGET_DEFAULTS.messagesPerVisitorPerMinute; i++) {
      await chatJson(token, {}).expect(200);
    }
    const before = stack.chat.inputs.length;
    const r = await chatJson(token, {}).expect(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
    expect(stack.chat.inputs.length).toBe(before);
  });

  it('§4-бис.10 п.3: повтор clientRequestId маршрутом — тот же messageId, replay, модель не зовётся', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const crid = newRequestId();
    const a = await chatJson(token, { clientRequestId: crid }).expect(200);
    const calls = stack.chat.modelCalls;
    const b = await chatJson(token, {
      clientRequestId: crid,
      conversationId: a.body.data.conversationId,
    }).expect(200);
    expect(b.body.data.messageId).toBe(a.body.data.messageId);
    expect(b.body.data.text).toBe(a.body.data.text);
    expect(b.body.data.streaming).toBe(false);
    expect(stack.chat.modelCalls).toBe(calls);
  });

  it('повтор при ИДУЩЕМ ответе: SSE дочитывает текст из базы до complete (другой экземпляр пишет)', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const crid = newRequestId();
    stack.chat.leaveStreaming = true;
    const first = await chatJson(token, { clientRequestId: crid }).expect(200);
    expect(first.body.data.streaming).toBe(true);
    const msgId = first.body.data.messageId as string;
    stack.chat.leaveStreaming = false;

    // «Генерирующий экземпляр» допишет ответ через 300 мс.
    const full = stack.chat.answer;
    setTimeout(() => {
      void stack.prisma.assistSiteMessage
        .update({
          where: { id: msgId },
          data: {
            text: full,
            streamOffset: full.length,
            streamState: 'complete',
            sources: [{ n: 1, url: 'https://example.com/d', title: 'Д' }],
          },
        })
        // PrismaPromise ленивый: без then запрос не уходит.
        .then(() => undefined);
    }, 300);
    const calls = stack.chat.modelCalls;
    const r = await authed('post', '/widget/v1/chat', token)
      .send({
        conversationId: first.body.data.conversationId,
        clientRequestId: crid,
        question: 'Сколько стоит доставка?',
        page: null,
        context: null,
        uiLang: null,
      })
      .buffer(true)
      .parse((res, cb) => {
        let t = '';
        res.on('data', (c: Buffer) => (t += c.toString()));
        res.on('end', () => cb(null, t));
      })
      .expect(200);
    const events = parseSse(r.body as string);
    expect(events[0]).toMatchObject({ type: 'meta', data: { replay: true } });
    const text = events
      .filter((e) => e.type === 'token')
      .map((e) => e.data.t)
      .join('');
    expect(text).toBe(full);
    expect(events.at(-1)!.type).toBe('done');
    expect(events.some((e) => e.type === 'sources')).toBe(true);
    expect(stack.chat.modelCalls).toBe(calls);
  });

  it('продолжение стрима GET /messages/:id/stream?from= — длинный опрос до нового текста', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    stack.chat.leaveStreaming = true;
    const first = await chatJson(token, {}).expect(200);
    const msgId = first.body.data.messageId as string;
    const partial = first.body.data.text as string;

    const now = await authed(
      'get',
      `/widget/v1/messages/${msgId}/stream?from=0`,
      token,
    ).expect(200);
    expect(now.body.data).toMatchObject({
      text: partial,
      offset: partial.length,
      streamState: 'streaming',
    });
    setTimeout(() => {
      void stack.prisma.assistSiteMessage
        .update({
          where: { id: msgId },
          data: { text: `${partial} и ещё`, streamState: 'complete' },
        })
        .then(() => undefined);
    }, 200);
    const later = await authed(
      'get',
      `/widget/v1/messages/${msgId}/stream?from=${partial.length}`,
      token,
    ).expect(200);
    expect(later.body.data).toMatchObject({
      text: ' и ещё',
      offset: partial.length + ' и ещё'.length,
      streamState: 'complete',
    });
  });

  it('GET state: диалог, stateVersion и since; старше 7 дней — previousConversationId', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const empty = await authed('get', '/widget/v1/state', token).expect(200);
    expect(empty.body.data).toEqual({
      conversation: null,
      previousConversationId: null,
    });
    const a = await chatJson(token, {}).expect(200);
    const s = await authed('get', '/widget/v1/state', token).expect(200);
    const conv = s.body.data.conversation;
    expect(conv.id).toBe(a.body.data.conversationId);
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual([
      'visitor',
      'assistant',
    ]);
    expect(conv.streamingMessageId).toBeNull();
    const same = await authed(
      'get',
      `/widget/v1/state?since=${conv.stateVersion as number}`,
      token,
    ).expect(200);
    expect(same.body.data.conversation.messages).toEqual([]);

    await stack.prisma.assistSiteConversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date(Date.now() - 8 * DAY) },
    });
    const old = await authed('get', '/widget/v1/state', token).expect(200);
    expect(old.body.data).toEqual({
      conversation: null,
      previousConversationId: conv.id,
    });
  });

  it('§4-бис.10 п.9: чужой conversationId/clientRequestId с другим токеном — новый вопрос; чужие сообщения — NOT_FOUND', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const x = await visitor(f);
    const y = await visitor(f);
    const crid = newRequestId();
    const ax = await chatJson(x, { clientRequestId: crid }).expect(200);
    const calls = stack.chat.modelCalls;
    const ay = await chatJson(y, {
      clientRequestId: crid,
      conversationId: ax.body.data.conversationId,
    }).expect(200);
    expect(ay.body.data.conversationId).not.toBe(ax.body.data.conversationId);
    expect(ay.body.data.messageId).not.toBe(ax.body.data.messageId);
    expect(stack.chat.modelCalls).toBe(calls + 1);

    const msgX = ax.body.data.messageId as string;
    expect(
      (await authed('get', `/widget/v1/messages/${msgX}/stream`, y).expect(404))
        .body.error.code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await authed('post', '/widget/v1/feedback', y)
          .send({ messageId: msgX, rating: -1 })
          .expect(404)
      ).body.error.code,
    ).toBe('NOT_FOUND');
    const sy = await authed('get', '/widget/v1/state', y).expect(200);
    expect(sy.body.data.conversation.id).toBe(ay.body.data.conversationId);
  });

  it('👍/👎: оценка своего ответа; 👎 на ответ из кэша — SemanticCache.evict', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const a = await chatJson(token, {}).expect(200);
    const id = a.body.data.messageId as string;
    await authed('post', '/widget/v1/feedback', token)
      .send({ messageId: id, rating: 1 })
      .expect(200);
    expect(
      (
        await stack.prisma.assistSiteMessage.findUniqueOrThrow({
          where: { id },
        })
      ).rating,
    ).toBe(1);
    expect(stack.cache.evicted).toHaveLength(0);

    await stack.prisma.assistSiteMessage.update({
      where: { id },
      data: { answerPath: 'cache', cacheKey: 'ck-123' },
    });
    await authed('post', '/widget/v1/feedback', token)
      .send({ messageId: id, rating: -1 })
      .expect(200);
    expect(stack.cache.evicted).toEqual([{ siteId: f.siteId, key: 'ck-123' }]);
    const bad = await authed('post', '/widget/v1/feedback', token)
      .send({ messageId: id, rating: 5 })
      .expect(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('forget: удалены все диалоги посетителя на сайте и его указатели; лиды остаются без ссылки; cookie стёрта', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const other = await visitor(f);
    const a1 = await chatJson(token, {}).expect(200);
    await chatJson(token, {}).expect(200);
    const b = await chatJson(other, {}).expect(200);
    const lead = await stack.prisma.assistSiteLead.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        conversationId: a1.body.data.conversationId,
        fieldsEnc: 'enc',
        fieldNames: ['phone'],
        consentText: 'Согласен',
        consentAt: new Date(),
      },
    });
    const r = await authed('post', '/widget/v1/forget', token).expect(200);
    expect(r.body.data).toEqual({ conversationsDeleted: 2 });
    expect(String(r.headers['set-cookie'])).toMatch(
      `${widgetResumeCookieName(f.pk)}=; Path=/; Max-Age=0`,
    );
    const visitorId = (
      await stack.prisma.assistSiteConversation.findUniqueOrThrow({
        where: { id: b.body.data.conversationId },
      })
    ).visitorId;
    expect(
      await stack.prisma.assistSiteConversation.count({
        where: { siteId: f.siteId },
      }),
    ).toBe(1);
    expect(
      await stack.prisma.assistSiteMessage.count({
        where: { conversationId: a1.body.data.conversationId },
      }),
    ).toBe(0);
    const resumes = await stack.prisma.assistSiteVisitorResume.findMany({
      where: { siteId: f.siteId },
    });
    expect(resumes.map((x) => x.visitorId)).toEqual([visitorId]);
    expect(
      (
        await stack.prisma.assistSiteLead.findUniqueOrThrow({
          where: { id: lead.id },
        })
      ).conversationId,
    ).toBeNull();
    // Повтор — 0, не ошибка; state — пусто.
    expect(
      (await authed('post', '/widget/v1/forget', token).expect(200)).body.data,
    ).toEqual({ conversationsDeleted: 0 });
    expect(
      (await authed('get', '/widget/v1/state', token).expect(200)).body.data
        .conversation,
    ).toBeNull();
  });

  it('лид: согласие обязательно, поля — только известные; диалог чужого посетителя не привязывается', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const x = await visitor(f);
    const y = await visitor(f);
    const ax = await chatJson(x, {}).expect(200);
    const base = {
      conversationId: ax.body.data.conversationId,
      fields: { name: 'Олег', phone: '+380501234567' },
      consent: true,
      uiLang: 'uk',
      pageUrl: 'https://example.com/contacts?ref=1',
    };
    expect(
      (
        await authed('post', '/widget/v1/lead', x)
          .send({ ...base, consent: false })
          .expect(400)
      ).body.error.code,
    ).toBe('CONSENT_REQUIRED');
    expect(
      (
        await authed('post', '/widget/v1/lead', x)
          .send({ ...base, fields: { password: 'x' } })
          .expect(400)
      ).body.error.code,
    ).toBe('LEAD_INVALID');
    await authed('post', '/widget/v1/lead', x).send(base).expect(200);
    const got = stack.leads.inputs.at(-1)!;
    expect(got.conversationId).toBe(ax.body.data.conversationId);
    expect(got.pageUrl).toBe('https://example.com/contacts');
    expect(got.visitor.visitorId).not.toBe('');
    await authed('post', '/widget/v1/lead', y).send(base).expect(200);
    expect(stack.leads.inputs.at(-1)!.conversationId).toBeNull();
    // Э3: без своего диалога передачи нет — форма заявки (причину даёт H).
    expect(
      (await authed('post', '/widget/v1/handoff', y).expect(200)).body.data,
    ).toMatchObject({ mode: 'lead' });
  });

  it('интеграция Э2: same-origin GET iframe приходит БЕЗ Origin — state/stream работают; межсайтовый GET и POST без Origin — ORIGIN_DENIED', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const get = (path: string, site?: string) => {
      const r = request(srv())
        .get(path)
        .set(WIDGET_VISITOR_TOKEN_HEADER, token);
      return site ? r.set('Sec-Fetch-Site', site) : r;
    };
    // Как шлёт Chromium из iframe: без Origin, Sec-Fetch-Site: same-origin.
    await get('/widget/v1/state', 'same-origin').expect(200);
    // Старый браузер без Sec-Fetch-* — тоже свой.
    await get('/widget/v1/state').expect(200);
    const cross = await get('/widget/v1/state', 'cross-site').expect(403);
    expect(cross.body.error.code).toBe('ORIGIN_DENIED');
    const foreign = await request(srv())
      .get('/widget/v1/state')
      .set('Origin', 'https://evil.example')
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .expect(403);
    expect(foreign.body.error.code).toBe('ORIGIN_DENIED');
    const post = await request(srv())
      .post('/widget/v1/handoff')
      .set('Sec-Fetch-Site', 'same-origin')
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .expect(403);
    expect(post.body.error.code).toBe('ORIGIN_DENIED');
  });

  it('лид: не больше leadsPerVisitorPerHour в час на посетителя — дальше RATE_LIMITED до приёма', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const v = await visitor(f);
    const body = {
      conversationId: null,
      fields: { name: 'Олег', phone: '+380501234567' },
      consent: true,
      uiLang: 'uk',
      pageUrl: null,
    };
    const before = stack.leads.inputs.length;
    for (let i = 0; i < WIDGET_DEFAULTS.leadsPerVisitorPerHour; i++) {
      await authed('post', '/widget/v1/lead', v).send(body).expect(200);
    }
    const over = await authed('post', '/widget/v1/lead', v)
      .send(body)
      .expect(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect(stack.leads.inputs.length - before).toBe(
      WIDGET_DEFAULTS.leadsPerVisitorPerHour,
    );
  });

  it('сбой конвейера: SSE — событие error upstream без текста провайдера; JSON — 502 UPSTREAM', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    stack.chat.failWith = new Error('provider said: секретный промпт');
    const r = await authed('post', '/widget/v1/chat', token)
      .send({
        conversationId: null,
        clientRequestId: newRequestId(),
        question: 'Вопрос',
        page: null,
        context: null,
        uiLang: null,
      })
      .buffer(true)
      .parse((res, cb) => {
        let t = '';
        res.on('data', (c: Buffer) => (t += c.toString()));
        res.on('end', () => cb(null, t));
      })
      .expect(200);
    const events = parseSse(r.body as string);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      data: { code: 'upstream' },
    });
    expect(r.body as string).not.toContain('секретный');
    const j = await chatJson(token, {}).expect(502);
    expect(j.body.error.code).toBe('UPSTREAM');
    expect(JSON.stringify(j.body)).not.toContain('секретный');
  });
});
