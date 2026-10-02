/**
 * Приёмка Э6 «Видео-ответы и показать на экране» (план, Приложение А
 * «Этап 6») на реальном Postgres: публичный код — под ролью assist_public
 * (как в проде), посев и кабинет — владельцем схемы, модель — подделка.
 *
 *  п.1 — ролик сайта A никогда не предлагается на сайте B: ТРИ барьера по
 *        образцу лендинга, каждый проверен ОТДЕЛЬНО (список в промпте по
 *        siteId; действие модели — только V# из списка этого запроса;
 *        ссылка и редирект — заново по siteId посетителя/токена);
 *  п.2 — неодобренный ролик не предлагается: не пришёл от генератора
 *        (оператор не одобрил — синхронизация его не шлёт), выключен
 *        владельцем или снят за логином (закрытый отказ);
 *  п.3 — подсветка: элементы карты страницы посетителя → действие с
 *        селектором из карты; сигнал «карта устарела» — счётчик промахов
 *        (браузерная часть — e2e виджета `highlight.spec.ts`);
 *  п.4 — барьер лендинга не меняется: backend `assistant.service.spec.ts`
 *        (прогон — в отчёте этапа; код лендинга Э6 не трогает).
 * Плюс внутренний API генератора (привязка, полный набор, членство хозяина,
 * хост шагов), кабинет «Видео» и тариф.
 */
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { SitesDb } from '../../prisma/sites-db.service';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import type { ChatModelRequest } from '../../modules/assist-site-chat/chat-model';
import { SiteVideosService } from '../../modules/assist-site-media/cabinet/site-videos.service';
import { promptVideos } from '../../modules/assist-site-media/public/site-videos';
import { verifyVideoLink } from '../../modules/assist-site-media/public/video-link';
import { EventCounts } from '../../modules/assist-analytics/public/event-counts.service';
import { WidgetMediaController } from '../../modules/assist-widget/widget-media.controller';
import { WidgetRateLimit } from '../../modules/assist-widget/rate-limit';
import { InternalSiteMediaService } from '../../modules/internal-sites/site-media.service';
import { AccountService } from '../../modules/site-core/account/account.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { videoLinkKey } from '../../config/media-env';

jest.setTimeout(180_000);

/** Отметка набора `asOf` (мс часов генератора) — растёт с каждым вызовом. */
let asOfClock = Date.now();
const nextAsOf = () => ++asOfClock;

const BLOB = (n: string) =>
  `https://store1.public.blob.vercel-storage.com/tutorial-videos/${n}.mp4`;

describeDb('Приёмка Э6 — видео и подсветка', () => {
  const st = new ChatStack();
  let internal: InternalSiteMediaService;
  let cabinet: SiteVideosService;
  let widget: WidgetMediaController;
  let counts: EventCounts;
  let script: ((req: ChatModelRequest) => string) | null = null;

  beforeAll(async () => {
    await st.init();
    const db = new SitesDb(st.owner);
    internal = new InternalSiteMediaService(db, new AccountService(db));
    internal.env = {};
    cabinet = new SiteVideosService(db, st.owner);
    cabinet.env = { GENERATOR_TMA_URL: 'https://t.me/gen_bot/app' };
    counts = new EventCounts(st.publicDb);
    widget = new WidgetMediaController(
      { authenticate: async () => current } as never,
      new WidgetRateLimit(st.publicDb),
      st.publicDb,
      counts,
    );
    widget.env = st.env;
    const honest = st.model.compose.bind(st.model);
    st.model.compose = (req) => (script ? script(req) : honest(req));
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    script = null;
    st.model.calls.length = 0;
  });

  /** Контекст посетителя для маршрутов виджета (как дал бы visitor-token). */
  let current: {
    site: ReturnType<ChatSite['ctx']>;
    visitor: ReturnType<ChatStack['visitor']>;
  };
  const as = (s: ChatSite) => {
    current = { site: s.ctx(), visitor: st.visitor() };
    return current;
  };
  const owner = (s: ChatSite): AccountMembership => ({
    accountId: s.accountId,
    memberId: 'm',
    telegramId: s.ownerTelegramId,
    role: 'owner',
    productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
  });

  /** Сайт с тарифом и роликами от генератора (как после одобрения оператором). */
  async function videoSite(
    titles: string[],
    opts: { plan?: 'business' | 'start' | 'trial'; enable?: boolean } = {},
  ) {
    const s = await st.stand('shop');
    if (opts.plan !== 'trial')
      await setPlan(st.owner, s.accountId, opts.plan ?? 'business');
    const r = await internal.syncVideos(
      s.siteId,
      titles.map((title, i) => ({
        externalId: `asset-${randomUUID()}`,
        draftId: `draft-${i}`,
        ownerTelegramId: s.ownerTelegramId,
        title,
        locale: 'uk',
        durationMs: 30_000,
        url: BLOB(`${s.siteId}-${i}`),
        requiresLogin: false,
        stepHosts: [s.host],
      })),
      nextAsOf(),
    );
    expect(r.accepted).toBe(titles.length);
    const rows = await st.owner.assistSiteVideo.findMany({
      where: { siteId: s.siteId },
      orderBy: { title: 'asc' },
    });
    if (opts.enable !== false) {
      for (const v of rows)
        await cabinet.patch(owner(s), s.siteId, v.id, { enabled: true });
    }
    return { s, rows };
  }

  const lastPrompt = () => {
    const req = st.model.calls[st.model.calls.length - 1];
    return req.contents[req.contents.length - 1].content;
  };
  const answer = (items: unknown[]) => () =>
    `Доставка Новою поштою коштує 80 грн. [S1]<<<actions>>>${JSON.stringify({ items })}`;

  function fakeRes() {
    const r = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      ended: false,
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      setHeader(k: string, v: string) {
        r.headers[k.toLowerCase()] = v;
      },
      end() {
        r.ended = true;
      },
    };
    return r;
  }
  const origin = {
    headers: { origin: 'https://w.test' },
    method: 'POST',
  } as never;

  // ── п.1: ролик сайта A никогда не предлагается на сайте B ─────────────

  it('п.1 барьер 1: в промпт сайта B не попадает ни один ролик сайта A (и наоборот)', async () => {
    const a = await videoSite(['Як оформити замовлення A']);
    const b = await videoSite(['Як повернути товар B']);
    await st.ask(b.s, 'Скільки коштує доставка?');
    expect(lastPrompt()).toContain('Як повернути товар B');
    expect(lastPrompt()).not.toContain('Як оформити замовлення A');
    expect(lastPrompt()).not.toContain(a.rows[0].id);
    // Сам запрос списка — по siteId.
    expect(
      (await promptVideos(st.publicDb, b.s.siteId)).map((v) => v.id),
    ).toEqual([b.rows[0].id]);
  });

  it('п.1 барьер 2: модель называет id ролика сайта A на сайте B — кнопки нет; V# из списка B — ролик B', async () => {
    const a = await videoSite(['Ролик A']);
    const b = await videoSite(['Ролик B']);
    script = answer([
      { kind: 'video', label: 'Чужий', video: a.rows[0].id },
      { kind: 'video', label: 'Чужий 2', videoId: a.rows[0].id },
      { kind: 'video', label: 'Нема', video: 'V7' },
    ]);
    const bad = await st.ask(b.s, 'Скільки коштує доставка?');
    expect(bad.actions.filter((x) => x.kind === 'video')).toEqual([]);
    script = answer([{ kind: 'video', label: 'Дивитись відео', video: 'V1' }]);
    const ok = await st.ask(b.s, 'Скільки коштує доставка Новою поштою?');
    expect(ok.actions).toEqual([
      {
        kind: 'video',
        label: 'Дивитись відео',
        videoId: b.rows[0].id,
        title: 'Ролик B',
      },
    ]);
  });

  it('п.1 барьер 3: ссылку на ролик сайта A посетитель сайта B не получает; токен, переписанный на чужой сайт, не открывается', async () => {
    const a = await videoSite(['Ролик A3']);
    const b = await videoSite(['Ролик B3']);
    as(b.s);
    await expect(
      widget.videoLink(
        undefined,
        { videoId: a.rows[0].id },
        origin,
        fakeRes() as never as Response,
      ),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
    // Свой — подписанная ссылка на 10 минут; адреса хранилища в ответе нет.
    const own = await widget.videoLink(
      undefined,
      { videoId: b.rows[0].id },
      origin,
      fakeRes() as never as Response,
    );
    expect(own.url).toMatch(/^\/widget\/v1\/video\/v1\./);
    expect(JSON.stringify(own)).not.toContain('blob.vercel-storage');
    const token = own.url.split('/').pop()!;
    const res = fakeRes();
    await widget.videoRedirect(token, res as never as Response);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(b.rows[0].url);
    expect(res.headers['cache-control']).toBe('private, no-store');
    // Подмена сайта/ролика в токене — подпись не сходится.
    const [v, , , exp, sig] = token.split('.');
    for (const forged of [
      [v, a.s.siteId, b.rows[0].id, exp, sig],
      [v, b.s.siteId, a.rows[0].id, exp, sig],
    ]) {
      await expect(
        widget.videoRedirect(forged.join('.'), fakeRes() as never as Response),
      ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
    }
    // Даже ВЕРНО подписанный токен «сайт B + ролик A» (утечка ключа/ошибка
    // выдачи) не открывается: строка ищется по (id, siteId токена).
    const key = videoLinkKey(st.env)!;
    const { signVideoLink } =
      await import('../../modules/assist-site-media/public/video-link');
    const crafted = signVideoLink(key, {
      siteId: b.s.siteId,
      videoId: a.rows[0].id,
      expUnix: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      verifyVideoLink(key, crafted, Math.floor(Date.now() / 1000)).ok,
    ).toBe(true);
    await expect(
      widget.videoRedirect(crafted, fakeRes() as never as Response),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
  });

  // ── п.2: неодобренный ролик не предлагается ───────────────────────────

  it('п.2: выключенный владельцем и снятый за логином ролики — не в промпте и не по ссылке; выключение действует сразу', async () => {
    const { s, rows } = await videoSite(['Відео А', 'Відео Б', 'Відео В'], {
      enable: false,
    });
    await cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: true });
    // «За логином», но кто-то включил в базе руками — всё равно не показываем.
    await st.owner.assistSiteVideo.update({
      where: { id: rows[2].id },
      data: { requiresLogin: true, enabled: true },
    });
    await st.ask(s, 'Скільки коштує доставка?');
    expect(lastPrompt()).toContain('Відео А');
    expect(lastPrompt()).not.toContain('Відео Б');
    expect(lastPrompt()).not.toContain('Відео В');
    as(s);
    for (const id of [rows[1].id, rows[2].id]) {
      await expect(
        widget.videoLink(
          undefined,
          { videoId: id },
          origin,
          fakeRes() as never as Response,
        ),
      ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
    }
    const link = await widget.videoLink(
      undefined,
      { videoId: rows[0].id },
      origin,
      fakeRes() as never as Response,
    );
    await cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: false });
    await expect(
      widget.videoRedirect(
        link.url.split('/').pop()!,
        fakeRes() as never as Response,
      ),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
  });

  it('п.2: оператор снял одобрение — следующая синхронизация генератора убирает ролик сайта (полный набор)', async () => {
    const { s, rows } = await videoSite(['Перший', 'Другий']);
    const r = await internal.syncVideos(
      s.siteId,
      [
        {
          externalId: rows.find((x) => x.title === 'Другий')!.externalId,
          draftId: 'draft-1',
          ownerTelegramId: s.ownerTelegramId,
          title: 'Другий',
          locale: 'uk',
          durationMs: 1000,
          url: BLOB('x2'),
          requiresLogin: false,
          stepHosts: [s.host],
        },
      ],
      nextAsOf(),
    );
    expect(r).toMatchObject({ accepted: 1, removed: 1 });
    const left = await st.owner.assistSiteVideo.findMany({
      where: { siteId: s.siteId },
    });
    expect(left.map((x) => [x.title, x.enabled])).toEqual([['Другий', true]]);
  });

  it('тариф без видео: ролики не в промпте, ссылка не выдаётся, включить нельзя (402), выключить — можно', async () => {
    const { s, rows } = await videoSite(['Відео тарифу'], { enable: false });
    await st.owner.assistSiteVideo.update({
      where: { id: rows[0].id },
      data: { enabled: true },
    });
    await setPlan(st.owner, s.accountId, 'start');
    await st.ask(s, 'Скільки коштує доставка?');
    expect(lastPrompt()).not.toContain('Відео тарифу');
    as(s);
    await expect(
      widget.videoLink(
        undefined,
        { videoId: rows[0].id },
        origin,
        fakeRes() as never as Response,
      ),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
    await expect(
      cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: true }),
    ).rejects.toMatchObject({ response: { code: 'VIDEO_PLAN_REQUIRED' } });
    await expect(
      cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: false }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('ответ из кэша: кнопка ролика — только если он и сейчас доступен', async () => {
    const { s, rows } = await videoSite(['Кешоване відео']);
    script = answer([{ kind: 'video', label: 'Дивитись', video: 'V1' }]);
    const q = 'Скільки коштує доставка Новою поштою по Україні?';
    const first = await st.ask(s, q);
    expect(first.actions.map((x) => x.kind)).toEqual(['video']);
    const calls = st.model.calls.length;
    const cached = await st.ask(s, q);
    expect(st.model.calls.length).toBe(calls);
    expect(cached.actions.map((x) => x.kind)).toEqual(['video']);
    await cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: false });
    const after = await st.ask(s, q);
    expect(st.model.calls.length).toBe(calls);
    expect(after.actions.filter((x) => x.kind === 'video')).toEqual([]);
  });

  // ── Внутренний API генератора: привязка и синхронизация ───────────────

  it('привязка: только владелец/менеджер помощника кабинета сайта; чужой и несуществующий — один код', async () => {
    const s = await st.stand('shop');
    const other = await st.stand('shop');
    await expect(
      internal.link(s.ownerTelegramId, s.siteId),
    ).resolves.toMatchObject({
      siteId: s.siteId,
      hosts: [s.host],
    });
    for (const [tg, site] of [
      [other.ownerTelegramId, s.siteId],
      [s.ownerTelegramId, 'site-no-such'],
    ] as const) {
      await expect(internal.link(tg, site)).rejects.toMatchObject({
        response: { code: 'SITE_LINK_FORBIDDEN' },
      });
    }
    const withOp = await st.site({
      members: [{ role: 'operator', productRoles: { assist: 'operator' } }],
    });
    const op = await st.owner.siteAccountMember.findFirst({
      where: { accountId: withOp.accountId, role: 'operator' },
    });
    await expect(
      internal.link(op!.telegramId, withOp.siteId),
    ).rejects.toMatchObject({
      response: { code: 'SITE_LINK_FORBIDDEN' },
    });
  });

  it('синхронизация: хозяин не из кабинета и адрес не из хранилища — не приняты; шаг на чужом хосте — «за логином» и выключен', async () => {
    const { s, rows } = await videoSite(['Свій']);
    const stranger = await st.stand('shop');
    const base = {
      draftId: 'd',
      title: 'T',
      locale: 'uk',
      durationMs: null,
      requiresLogin: false,
    };
    const r = await internal.syncVideos(
      s.siteId,
      [
        {
          ...base,
          externalId: rows[0].externalId,
          ownerTelegramId: s.ownerTelegramId,
          title: 'Свій',
          url: rows[0].url,
          stepHosts: [s.host, 'admin.elsewhere.example'],
        },
        {
          ...base,
          externalId: 'e-stranger',
          ownerTelegramId: stranger.ownerTelegramId,
          url: BLOB('s'),
          stepHosts: [s.host],
        },
        {
          ...base,
          externalId: 'e-url',
          ownerTelegramId: s.ownerTelegramId,
          url: 'https://evil.example/v.mp4',
          stepHosts: [s.host],
        },
        {
          ...base,
          externalId: 'e-nohosts',
          ownerTelegramId: s.ownerTelegramId,
          url: BLOB('n'),
          stepHosts: [],
        },
      ],
      nextAsOf(),
    );
    expect(r.rejected).toEqual([
      { externalId: 'e-stranger', reason: 'owner' },
      { externalId: 'e-url', reason: 'url' },
    ]);
    const after = await st.owner.assistSiteVideo.findMany({
      where: { siteId: s.siteId },
      orderBy: { externalId: 'asc' },
    });
    expect(
      after.map((x) => [x.externalId, x.requiresLogin, x.enabled]),
    ).toEqual(
      [
        [rows[0].externalId, true, false],
        ['e-nohosts', true, false],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    await expect(
      cabinet.patch(owner(s), s.siteId, rows[0].id, { enabled: true }),
    ).rejects.toMatchObject({ response: { code: 'VIDEO_REQUIRES_LOGIN' } });
  });

  it('«за логином» — навсегда: следующая синхронизация с «чистыми» признаками не снимает его, включить нельзя, посетителю не предлагается', async () => {
    const { s, rows } = await videoSite(['Вхід']);
    const v = {
      externalId: rows[0].externalId,
      draftId: 'd',
      ownerTelegramId: s.ownerTelegramId,
      title: 'Вхід',
      locale: 'uk',
      durationMs: null,
      url: rows[0].url,
      stepHosts: [s.host],
    };
    // Генератор увидел данные входа — ролик «за логином» и выключен.
    await internal.syncVideos(
      s.siteId,
      [{ ...v, requiresLogin: true }],
      nextAsOf(),
    );
    // Данные входа стёрты (крон/«одноразово»/перенос Ш2) — признак генератора
    // снова «чистый», но кадры за логином в ролике остались.
    await internal.syncVideos(
      s.siteId,
      [{ ...v, requiresLogin: false }],
      nextAsOf(),
    );
    const row = await st.owner.assistSiteVideo.findFirstOrThrow({
      where: { siteId: s.siteId, externalId: v.externalId },
    });
    expect([row.requiresLogin, row.enabled]).toEqual([true, false]);
    await expect(
      cabinet.patch(owner(s), s.siteId, row.id, { enabled: true }),
    ).rejects.toMatchObject({ response: { code: 'VIDEO_REQUIRES_LOGIN' } });
    expect(await promptVideos(st.publicDb, s.siteId)).toEqual([]);
  });

  it('аудит Э6 (гонка): два полных набора в обратном порядке — старый не возвращает отвязанный ролик (stale, без изменений)', async () => {
    const { s, rows } = await videoSite(['Лишається', 'Відвʼязаний']);
    const keep = rows.find((x) => x.title === 'Лишається')!;
    const gone = rows.find((x) => x.title === 'Відвʼязаний')!;
    const item = (r: typeof keep) => ({
      externalId: r.externalId,
      draftId: r.draftId,
      ownerTelegramId: s.ownerTelegramId,
      title: r.title,
      locale: 'uk',
      durationMs: null,
      url: r.url,
      requiresLogin: false,
      stepHosts: [s.host],
    });
    // Генератор: набор «до отвязки» собран раньше (asOf меньше), «после» —
    // позже, а до sites-backend доехали в обратном порядке.
    const before = nextAsOf();
    const after = nextAsOf();
    await expect(
      internal.syncVideos(s.siteId, [item(keep)], after),
    ).resolves.toMatchObject({ accepted: 1, removed: 1 });
    const stale = await internal.syncVideos(
      s.siteId,
      [item(keep), item(gone)],
      before,
    );
    expect(stale).toEqual({
      siteId: s.siteId,
      accepted: 0,
      removed: 0,
      rejected: [],
      stale: true,
    });
    const left = await st.owner.assistSiteVideo.findMany({
      where: { siteId: s.siteId },
    });
    expect(left.map((x) => x.externalId)).toEqual([keep.externalId]);
    const site = await st.owner.site.findUniqueOrThrow({
      where: { id: s.siteId },
    });
    expect(site.assistVideosAsOf).toBe(BigInt(after));
    // Повтор того же набора (равная отметка) принимается.
    await expect(
      internal.syncVideos(s.siteId, [item(keep)], after),
    ).resolves.toMatchObject({ accepted: 1, removed: 0 });
    expect(
      (await internal.syncVideos(s.siteId, [item(keep)], after)).stale,
    ).toBeUndefined();
  });

  it('аудит Э6 (гонка): параллельные синхронизации — побеждает более новый набор при любом порядке', async () => {
    for (let round = 0; round < 3; round++) {
      const { s, rows } = await videoSite(['A', 'B']);
      const item = (r: (typeof rows)[number]) => ({
        externalId: r.externalId,
        draftId: r.draftId,
        ownerTelegramId: s.ownerTelegramId,
        title: r.title,
        locale: 'uk',
        durationMs: null,
        url: r.url,
        requiresLogin: false,
        stepHosts: [s.host],
      });
      const older = nextAsOf();
      const newer = nextAsOf();
      await Promise.all([
        internal.syncVideos(s.siteId, rows.map(item), older),
        internal.syncVideos(s.siteId, [item(rows[0])], newer),
      ]);
      const left = await st.owner.assistSiteVideo.findMany({
        where: { siteId: s.siteId },
      });
      expect(left.map((x) => x.externalId)).toEqual([rows[0].externalId]);
    }
  });

  it('аудит Э6: GET по ссылке перепроверяет тариф и ролик, как POST (ссылка выдана, потом тариф снят / ролик стал «за логином»)', async () => {
    const { s, rows } = await videoSite(['Тариф після посилання']);
    as(s);
    const link = await widget.videoLink(
      undefined,
      { videoId: rows[0].id },
      origin,
      fakeRes() as never as Response,
    );
    const token = link.url.split('/').pop()!;
    const ok = fakeRes();
    await widget.videoRedirect(token, ok as never as Response);
    expect(ok.statusCode).toBe(302);
    await setPlan(st.owner, s.accountId, 'start');
    await expect(
      widget.videoRedirect(token, fakeRes() as never as Response),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
    await setPlan(st.owner, s.accountId, 'business');
    await widget.videoRedirect(token, fakeRes() as never as Response);
    // Ролик стал «за логином» — ссылка больше не открывается.
    await st.owner.assistSiteVideo.update({
      where: { id: rows[0].id },
      data: { requiresLogin: true },
    });
    await expect(
      widget.videoRedirect(token, fakeRes() as never as Response),
    ).rejects.toMatchObject({ response: { error: 'VIDEO_UNAVAILABLE' } });
  });

  // ── п.3: подсветка и «карта устарела» ─────────────────────────────────

  async function mapSite() {
    const s = await st.stand('shop');
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/delivery'), [
      { selector: '#np-calc', tag: 'button', label: 'Розрахувати доставку' },
      { selector: 'a[aria-label="Кошик"]', tag: 'a', label: 'Кошик' },
    ]);
    return s;
  }

  it('п.3: элементы карты страницы посетителя → highlight с селектором из карты; другая страница и чужой хост — без карты', async () => {
    const s = await mapSite();
    script = answer([
      { kind: 'highlight', label: 'Показати на сторінці', element: 'E1' },
    ]);
    const r = await st.ask(s, 'Скільки коштує доставка?', {
      page: { url: s.url('/delivery?utm=1'), title: null },
    });
    expect(lastPrompt()).toContain(
      '<element id="E1" tag="button">Розрахувати доставку</element>',
    );
    expect(lastPrompt()).not.toContain('#np-calc');
    const hl = r.actions.find((x) => x.kind === 'highlight');
    expect(hl).toMatchObject({
      selector: '#np-calc',
      caption: 'Розрахувати доставку',
    });
    // Другая страница — карты нет, модель про подсветку не знает, кнопки нет.
    const other = await st.ask(s, 'Скільки коштує доставка Новою поштою?', {
      page: { url: s.url('/payment'), title: null },
    });
    expect(lastPrompt()).not.toContain('<element');
    expect(other.actions.filter((x) => x.kind === 'highlight')).toEqual([]);
    const foreign = await mapSite();
    await st.ask(s, 'Доставка Новою поштою — скільки?', {
      page: { url: foreign.url('/delivery'), title: null },
    });
    expect(lastPrompt()).not.toContain('<element');
  });

  it('п.3: подсветка в кэш не кладётся (она про страницу вопроса)', async () => {
    const s = await mapSite();
    script = answer([
      { kind: 'highlight', label: 'Показати', element: 'E2' },
      { kind: 'lead', label: 'Заявка' },
    ]);
    const q = 'Скільки коштує доставка товару Новою поштою?';
    const page = { url: s.url('/delivery'), title: null };
    const first = await st.ask(s, q, { page });
    expect(first.actions.map((x) => x.kind)).toEqual(['highlight', 'lead']);
    const n = st.model.calls.length;
    const cached = await st.ask(s, q, { page });
    expect(st.model.calls.length).toBe(n);
    expect(cached.actions.map((x) => x.kind)).toEqual(['lead']);
    // И в самой строке кэша подсветки нет (не только отфильтрована на чтении).
    const rows = await st.owner.assistSiteSemanticCache.findMany({
      where: { siteId: s.siteId },
      select: { answer: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('highlight');
    // Строка кэша с подсветкой (записанная до правила) — на чтении вон.
    await st.owner.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_semantic_cache"
          SET "answer" = jsonb_set("answer", '{actions}', "answer"->'actions' || $2::jsonb)
        WHERE "siteId" = $1`,
      s.siteId,
      JSON.stringify([first.actions[0]]),
    );
    const again = await st.ask(s, q, { page });
    expect(st.model.calls.length).toBe(n);
    expect(again.actions.map((x) => x.kind)).toEqual(['lead']);
  });

  it('п.3: «карта устарела» — счётчик промахов карты этой страницы этого сайта; мусорный id и чужая страница ничего не трогают', async () => {
    const s = await mapSite();
    const map = await st.owner.siteUiMap.findFirst({
      where: { siteId: s.siteId },
    });
    const el = (map!.elements as Array<{ id: string }>)[0].id;
    as(s);
    const ok = await widget.highlightMiss(
      undefined,
      { elementId: el, pageUrl: s.url('/delivery') },
      origin,
    );
    expect(ok).toEqual({ ok: true, recorded: true });
    for (const dto of [
      { elementId: 'u00000000', pageUrl: s.url('/delivery') },
      { elementId: el, pageUrl: s.url('/payment') },
      { elementId: el, pageUrl: 'https://evil.example/delivery' },
    ]) {
      expect(await widget.highlightMiss(undefined, dto, origin)).toEqual({
        ok: true,
        recorded: false,
      });
    }
    const after = await st.owner.siteUiMap.findFirst({
      where: { siteId: s.siteId },
    });
    expect(after!.staleSignals).toBe(1);
    expect(after!.lastStaleAt).not.toBeNull();
    const ev = await st.owner.assistSiteEventCount.findMany({
      where: { siteId: s.siteId, kind: 'highlight_miss' },
    });
    expect(ev.map((e) => [e.key, e.count])).toEqual([[el, 1]]);
    // Обучалка прислала новую карту (вёрстка другая) — счётчик с нуля.
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/delivery'), [
      { selector: '#np-calc-v2', tag: 'button', label: 'Розрахувати' },
    ]);
    const fresh = await st.owner.siteUiMap.findFirst({
      where: { siteId: s.siteId },
    });
    expect(fresh!.staleSignals).toBe(0);
    // Карта — только с подтверждённого хоста этого сайта и от его менеджера.
    await expect(
      internal.uiMap(s.ownerTelegramId, s.siteId, 'https://evil.example/x', []),
    ).rejects.toMatchObject({ response: { code: 'HOST_NOT_VERIFIED' } });
    const stranger = await st.stand('shop');
    await expect(
      internal.uiMap(stranger.ownerTelegramId, s.siteId, s.url('/x'), []),
    ).rejects.toMatchObject({ response: { code: 'SITE_LINK_FORBIDDEN' } });
  });

  it('кабинет «Видео»: список, deep-link, сводка карты', async () => {
    const { s } = await videoSite(['Перше відео']);
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/delivery'), [
      { selector: '#a', tag: 'button', label: 'A' },
    ]);
    await st.owner.siteUiMap.updateMany({
      where: { siteId: s.siteId },
      data: { staleSignals: 2 },
    });
    const v = await cabinet.list(owner(s), s.siteId);
    expect(v).toMatchObject({
      siteId: s.siteId,
      planAllowsVideo: true,
      tutorialLink: `https://t.me/gen_bot/app?startapp=cst_${s.siteId}`,
      uiMap: { pages: 1, stalePages: 1 },
    });
    expect(v.videos.map((x) => [x.title, x.enabled, x.requiresLogin])).toEqual([
      ['Перше відео', true, false],
    ]);
    expect(JSON.stringify(v)).not.toContain('blob.vercel-storage');
    const other = await st.stand('shop');
    await expect(cabinet.list(owner(other), s.siteId)).rejects.toMatchObject({
      response: { code: 'SITE_NOT_FOUND' },
    });
  });
});
