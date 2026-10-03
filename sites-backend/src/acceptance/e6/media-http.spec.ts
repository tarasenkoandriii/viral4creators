/**
 * Э6 по HTTP на настоящем Postgres под ролью виджета: маршруты
 * `/widget/v1/video` (подписанная ссылка), `/widget/v1/video/:token`
 * (редирект), `/widget/v1/highlight-miss` (сигнал «карта устарела»),
 * допуск visitor-token, конверт ошибок, CSP iframe (media-src).
 * Конвейер ответа — подделка стенда W2 (testing/widget-stack).
 */
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
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
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

jest.setTimeout(120_000);

describeDb('Э6: видео и подсветка по HTTP', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    stack = await startWidgetStack();
  });
  afterAll(async () => {
    await stack?.close();
  });

  async function site(): Promise<
    WidgetFixture & { videoId: string; url: string }
  > {
    const f = await widgetFixture(stack, [{ host: domain('e6') }]);
    await setPlan(stack.prisma, f.accountId, 'business');
    const url = `https://s1.public.blob.vercel-storage.com/v/${f.siteId}.mp4`;
    const v = await stack.prisma.assistSiteVideo.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        externalId: `a-${f.siteId}`,
        draftId: 'd',
        ownerTelegramId: BigInt(1),
        title: 'Як оформити замовлення',
        locale: 'uk',
        url,
        requiresLogin: false,
        enabled: true,
        syncedAt: new Date(),
      },
    });
    return { ...f, videoId: v.id, url };
  }

  async function token(f: WidgetFixture): Promise<string> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', `${randomV6Prefix()}::1`)
      .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
      .expect(200);
    return r.body.data.visitorToken as string;
  }

  it('ссылка на свой ролик → 302 на хранилище, no-store, без Referer; чужой — 404 VIDEO_UNAVAILABLE в конверте', async () => {
    const a = await site();
    const b = await site();
    const t = await token(a);
    const r = await request(srv())
      .post('/widget/v1/video')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, t)
      .send({ videoId: a.videoId })
      .expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data).toMatchObject({ title: 'Як оформити замовлення' });
    expect(r.body.data.url).toMatch(/^\/widget\/v1\/video\/v1\./);
    expect(JSON.stringify(r.body)).not.toContain('blob.vercel-storage');
    const go = await request(srv()).get(r.body.data.url).expect(302);
    expect(go.headers.location).toBe(a.url);
    expect(go.headers['cache-control']).toBe('private, no-store');
    expect(go.headers['referrer-policy']).toBe('no-referrer');

    const foreign = await request(srv())
      .post('/widget/v1/video')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, t)
      .send({ videoId: b.videoId })
      .expect(404);
    expect(foreign.body.error.code).toBe('VIDEO_UNAVAILABLE');
    const junk = await request(srv())
      .get('/widget/v1/video/v1.x.y.1.z')
      .expect(404);
    expect(junk.body.error.code).toBe('VIDEO_UNAVAILABLE');
  });

  it('без visitor-token — SESSION_REQUIRED; лишнее поле и мусорный id — 400', async () => {
    const a = await site();
    const no = await request(srv())
      .post('/widget/v1/video')
      .set('Origin', W_ORIGIN)
      .send({ videoId: a.videoId })
      .expect(401);
    expect(no.body.error.code).toBe('SESSION_REQUIRED');
    const t = await token(a);
    for (const body of [
      { videoId: a.videoId, url: 'https://evil.example/v.mp4' },
      { videoId: '../x' },
    ]) {
      await request(srv())
        .post('/widget/v1/video')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(body)
        .expect(400);
    }
    for (const body of [
      { elementId: 'selector', pageUrl: a.hosts[0].origin },
      { elementId: uiElementId('#x'), pageUrl: a.hosts[0].origin, extra: 1 },
    ]) {
      await request(srv())
        .post('/widget/v1/highlight-miss')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(body)
        .expect(400);
    }
  });

  it('сигнал «карта устарела» по HTTP (Э-С Ш4): прямой вызов без квитанции показа — не засчитан; с квитанцией — промах элемента и справочный счётчик страницы; повтор посетителя — нет; лимит посетителя — RATE_LIMITED', async () => {
    const a = await site();
    const el = uiElementId('#buy');
    const key = uiMapKey(`${a.hosts[0].origin}/cart`)!;
    await ingestUiSnapshot(new SitesDb(stack.prisma).forAccount(a.accountId), {
      accountId: a.accountId,
      siteId: a.siteId,
      hostId: a.hosts[0].id,
      host: key.host,
      path: key.path,
      source: 'crawl',
      viewport: 'any',
      elements: [{ selector: '#buy', tag: 'button', label: 'Купити' }],
    });
    const t = await token(a);
    const miss = () =>
      request(srv())
        .post('/widget/v1/highlight-miss')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send({ elementId: el, pageUrl: `${a.hosts[0].origin}/cart/` });
    const map = () =>
      stack.prisma.siteUiMap.findFirst({ where: { siteId: a.siteId } });
    // Накрутка прямым вызовом (хвост Э6) — ничего не трогает.
    expect((await miss().expect(200)).body.data).toEqual({
      ok: true,
      recorded: false,
    });
    expect((await map())!.staleSignals).toBe(0);
    // Квитанция показа: ассистент выдал ЭТОМУ посетителю подсветку `#buy`.
    const { visitorId } = JSON.parse(
      Buffer.from(t.split('.')[0], 'base64url').toString('utf8'),
    ) as { visitorId: string };
    const conv = await stack.prisma.assistSiteConversation.create({
      data: {
        accountId: a.accountId,
        siteId: a.siteId,
        visitorId,
        ipHash: 'ip',
        parentOrigin: a.hosts[0].origin,
      },
    });
    await stack.prisma.assistSiteMessage.create({
      data: {
        accountId: a.accountId,
        siteId: a.siteId,
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
            // Квитанция — на странице карты (аудит Ш4).
            page: uiMapPageRef(key),
          },
        ],
      },
    });
    const r = await miss().expect(200);
    expect(r.body.data).toEqual({ ok: true, recorded: true });
    expect((await map())!.staleSignals).toBe(1);
    const row = await stack.prisma.siteUiElement.findFirst({
      where: { siteId: a.siteId, elementId: el },
    });
    // Вид — по заголовкам (без мобильного UA — компьютер); один промах —
    // ещё не «устарел» (порог).
    expect([row!.missCountDesktop, row!.missCountMobile]).toEqual([1, 0]);
    expect(row!.staleDesktopAt).toBeNull();
    expect(stack.events.batches.filter((x) => x.siteId === a.siteId)).toEqual([
      { siteId: a.siteId, events: [{ kind: 'highlight_miss', key: el }] },
    ]);
    // Тот же посетитель ещё раз — не засчитывается.
    expect((await miss().expect(200)).body.data).toEqual({
      ok: true,
      recorded: false,
    });
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      limited = (await miss()).status === 429;
    }
    expect(limited).toBe(true);
  });

  it('пакет загрузчика не принимает серверные виды событий (video_play, highlight_miss)', async () => {
    const a = await site();
    // Контроль: обычный вид с той же страницы принимается.
    await request(srv())
      .post('/widget/v1/event')
      .set('Origin', a.hosts[0].origin)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ pk: a.pk, events: [{ kind: 'open', key: null }] }))
      .expect(204);
    for (const kind of ['video_play', 'highlight_miss']) {
      await request(srv())
        .post('/widget/v1/event')
        .set('Origin', a.hosts[0].origin)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ pk: a.pk, events: [{ kind, key: null }] }))
        .expect(400);
    }
  });

  it('CSP iframe: media-src — blob:, свой origin и хранилище роликов; остальное без изменений', async () => {
    const a = await site();
    const r = await request(srv()).get(`/w/v1/frame?pk=${a.pk}`).expect(200);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain(
      "media-src blob: 'self' https://*.public.blob.vercel-storage.com",
    );
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("trusted-types 'none'");
  });
});
