/**
 * Заход 9, хвосты Ш4 (2) и (4) по HTTP на настоящем Postgres под ролью
 * виджета (конвейер ответа — подделка стенда W2, testing/widget-stack):
 *  - Р-З9-1: `POST /widget/v1/chat` передаёт конвейеру вид вёрстки
 *    посетителя по заголовкам iframe (`Sec-CH-UA-Mobile`, User-Agent); из
 *    тела вид не принимается (лишнее поле — 400);
 *  - Р-З9-3: `POST /widget/v1/highlight-seen` — допуск visitor-token,
 *    строгий DTO, голос «найден» только по квитанции показа.
 * Выбор элементов карты по виду и порог голосов — `ui-map.spec.ts`.
 */
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  uiElementId,
  uiMapKey,
  uiMapPageRef,
} from '../../modules/site-core/ui-map/ui-map';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import {
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

jest.setTimeout(120_000);

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';

describeDb('Ш4 (2), (4) по HTTP: вид вёрстки для чата и «найдено»', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    stack = await startWidgetStack();
  });
  afterAll(async () => {
    await stack?.close();
  });

  async function token(f: WidgetFixture): Promise<string> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', `${randomV6Prefix()}::1`)
      .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
      .expect(200);
    return r.body.data.visitorToken as string;
  }

  const chatBody = (f: WidgetFixture, extra: object = {}) => ({
    conversationId: null,
    clientRequestId: newRequestId(),
    question: 'Де кнопка «Купити»?',
    page: { url: `${f.hosts[0].origin}/cart`, title: null },
    context: null,
    uiLang: 'uk',
    ...extra,
  });

  it('Р-З9-1: вид вёрстки — по заголовкам запроса iframe (Client Hint точнее UA); из тела не принимается', async () => {
    const f = await widgetFixture(stack, [{ host: domain('sh4v') }]);
    const t = await token(f);
    const ask = (headers: Record<string, string>, body = chatBody(f)) => {
      const r = request(srv())
        .post('/widget/v1/chat')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .set('Accept', 'application/json');
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      return r.send(body);
    };
    const last = () => stack.chat.inputs[stack.chat.inputs.length - 1];
    await ask({ 'User-Agent': IPHONE }).expect(200);
    expect(last().viewport).toBe('mobile');
    await ask({ 'User-Agent': IPHONE, 'Sec-CH-UA-Mobile': '?0' }).expect(200);
    expect(last().viewport).toBe('desktop');
    await ask({ 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }).expect(200);
    expect(last().viewport).toBe('desktop');
    const n = stack.chat.inputs.length;
    await ask(
      { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      chatBody(f, { viewport: 'mobile' }),
    ).expect(400);
    expect(stack.chat.inputs.length).toBe(n);
  });

  it('Р-З9-3: highlight-seen — без visitor-token 401, мусор 400; без квитанции — не голос; с квитанцией и сомнением у вида — голос', async () => {
    const f = await widgetFixture(stack, [{ host: domain('sh4s') }]);
    const el = uiElementId('#buy');
    const key = uiMapKey(`${f.hosts[0].origin}/cart`)!;
    await ingestUiSnapshot(new SitesDb(stack.prisma).forAccount(f.accountId), {
      accountId: f.accountId,
      siteId: f.siteId,
      hostId: f.hosts[0].id,
      host: key.host,
      path: key.path,
      source: 'crawl',
      viewport: 'any',
      elements: [{ selector: '#buy', tag: 'button', label: 'Купити' }],
    });
    // Элемент под сомнением на компьютере (промахи набрали «устарел»).
    await stack.prisma.siteUiElement.updateMany({
      where: { siteId: f.siteId, elementId: el },
      data: {
        missCountDesktop: 3,
        missSinceDesktop: new Date(),
        staleDesktopAt: new Date(),
      },
    });
    const no = await request(srv())
      .post('/widget/v1/highlight-seen')
      .set('Origin', W_ORIGIN)
      .send({ elementId: el, pageUrl: `${f.hosts[0].origin}/cart` })
      .expect(401);
    expect(no.body.error.code).toBe('SESSION_REQUIRED');
    const t = await token(f);
    const seen = (body: object) =>
      request(srv())
        .post('/widget/v1/highlight-seen')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(body);
    for (const body of [
      { elementId: 'selector', pageUrl: f.hosts[0].origin },
      { elementId: el, pageUrl: f.hosts[0].origin, extra: 1 },
      { elementId: el },
    ])
      await seen(body).expect(400);
    const ok = { elementId: el, pageUrl: `${f.hosts[0].origin}/cart` };
    expect((await seen(ok).expect(200)).body.data).toEqual({
      ok: true,
      recorded: false,
    });
    const row = () =>
      stack.prisma.siteUiElement.findFirstOrThrow({
        where: { siteId: f.siteId, elementId: el },
      });
    expect((await row()).seenCountDesktop).toBe(0);
    // Квитанция показа: ассистент выдал ЭТОМУ посетителю подсветку на /cart.
    const { visitorId } = JSON.parse(
      Buffer.from(t.split('.')[0], 'base64url').toString('utf8'),
    ) as { visitorId: string };
    const conv = await stack.prisma.assistSiteConversation.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        visitorId,
        ipHash: 'ip',
        parentOrigin: f.hosts[0].origin,
      },
    });
    await stack.prisma.assistSiteMessage.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        conversationId: conv.id,
        role: 'assistant',
        text: 'Ось кнопка.',
        flags: [],
        actions: [
          {
            kind: 'highlight',
            label: 'Показати',
            elementId: el,
            selector: '#buy',
            caption: 'Купити',
            page: uiMapPageRef(key),
          },
        ],
      },
    });
    expect((await seen(ok).expect(200)).body.data).toEqual({
      ok: true,
      recorded: true,
    });
    const r = await row();
    // Один голос — ещё не порог: «устарел» остаётся (данные посетителя).
    expect([r.seenCountDesktop, r.staleDesktopAt]).toEqual([
      1,
      expect.any(Date),
    ]);
    // Повтор того же посетителя — не голос.
    expect((await seen(ok).expect(200)).body.data).toEqual({
      ok: true,
      recorded: false,
    });
  });
});
