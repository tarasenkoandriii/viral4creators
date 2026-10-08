/**
 * Приёмка Э-С Ш4 — общие карты интерфейса сайтов (план «Э-С: слияние»,
 * Ш4; аудит слияния §3.2) на РЕАЛЬНОМ Postgres: публичный код — под
 * логин-ролью `assist_public` (ChatStack.publicDb), запись — основной ролью
 * через клиента тенанта.
 *
 * Что проверяем (по составу Ш4):
 *  - тенант: карта и сводка — только своего кабинета; QA — владелец или
 *    `qa: admin` (запись) / `viewer` (чтение), чужой — один код 403;
 *  - только подтверждённые хосты своего сайта (обучалка и QA);
 *  - слияние источников по стабильному ключу (обход + QA + обучалка),
 *    вид вёрстки (снятое на телефоне компьютеру не предлагается), история
 *    версий вместо перезаписи;
 *  - приоритет кандидатов (`data-assist-id` > id > роль+имя > текст > путь)
 *    и узнавание строки при смене ключа (промахи не теряются);
 *  - устаревание ПО ЭЛЕМЕНТУ и виду — порог и окно, а не «после первого
 *    промаха»; анти-накрутка: квитанция показа, один промах на посетителя
 *    и на IP, сутки на IP+сайт; сброс при новом подтверждении браузером;
 *  - ретенция (крон), лимиты (страниц на сайт);
 *  - заход 9 (хвосты Ш4 (2)–(4)): чат берёт элементы карты своего вида
 *    вёрстки (Р-З9-1); снимок узнаёт `div role=button` по ключам, не
 *    зависящим от тега (Р-З9-2); «найдено» подсветкой — голос с порогом по
 *    квитанции показа (Р-З9-3, `highlight-seen`).
 */
import { randomUUID } from 'crypto';
import { SitesDb } from '../../prisma/sites-db.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { EventCounts } from '../../modules/assist-analytics/public/event-counts.service';
import { SiteVideosService } from '../../modules/assist-site-media/cabinet/site-videos.service';
import type { ChatModelRequest } from '../../modules/assist-site-chat/chat-model';
import {
  confirmSeenUiElements,
  pageUiElements,
  recordUiMiss,
  recordUiSeen,
} from '../../modules/assist-site-media/public/ui-map';
import { WidgetMediaController } from '../../modules/assist-widget/widget-media.controller';
import { WidgetRateLimit } from '../../modules/assist-widget/rate-limit';
import { InternalSiteMediaService } from '../../modules/internal-sites/site-media.service';
import { InternalUiMapService } from '../../modules/internal-sites/internal-ui-map.service';
import { AccountService } from '../../modules/site-core/account/account.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import {
  uiElementId,
  uiMapKey,
  uiMapPageRef,
} from '../../modules/site-core/ui-map/ui-map';
import { windowIpHash } from '../../modules/assist-widget/vote-ip-hash';
import {
  UI_MAP_SHARED,
  UI_MAP_STALE,
  type UiVisitorViewport,
} from '../../modules/site-core/ui-map/ui-map-model';
import {
  UiMapLimitError,
  ingestUiSnapshot,
  runUiMapMaintenance,
} from '../../modules/site-core/ui-map/ui-map-store';
import { extractUiElements } from '../../modules/site-crawl/extract/ui-map';
import { awaitUtcDayHeadroom } from '../window-headroom';

jest.setTimeout(180_000);

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';

describeDb('Приёмка Э-С Ш4 — общие карты интерфейса', () => {
  const st = new ChatStack();
  let db: SitesDb;
  let internal: InternalSiteMediaService;
  let qa: InternalUiMapService;
  let cabinet: SiteVideosService;
  let widget: WidgetMediaController;

  beforeAll(async () => {
    await st.init();
    db = new SitesDb(st.owner);
    const accounts = new AccountService(db);
    internal = new InternalSiteMediaService(db, accounts);
    internal.env = {};
    qa = new InternalUiMapService(db, accounts);
    cabinet = new SiteVideosService(db, st.owner);
    cabinet.env = {};
    widget = new WidgetMediaController(
      { authenticate: async () => current } as never,
      new WidgetRateLimit(st.publicDb),
      st.publicDb,
      new EventCounts(st.publicDb),
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
  });

  /** Ответ модели с блоком действий (как в приёмке Э6). */
  let script: ((req: ChatModelRequest) => string) | null = null;
  const answer = (items: unknown[]) => () =>
    `Кнопка «Купити» — у кошику. [S1]<<<actions>>>${JSON.stringify({ items })}`;
  const lastPrompt = () => {
    const req = st.model.calls[st.model.calls.length - 1];
    return req.contents[req.contents.length - 1].content;
  };

  let current: {
    site: ReturnType<ChatSite['ctx']>;
    visitor: ReturnType<ChatStack['visitor']>;
  };

  const owner = (s: ChatSite): AccountMembership => ({
    accountId: s.accountId,
    memberId: 'm',
    telegramId: s.ownerTelegramId,
    role: 'owner',
    productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
  });

  async function hostId(s: ChatSite): Promise<string> {
    const h = await st.owner.siteHost.findFirst({
      where: { siteId: s.siteId, host: s.host },
    });
    return h!.id;
  }

  /** Снимок источника страницы `path` сайта (общая дверь ядра). */
  async function ingest(
    s: ChatSite,
    path: string,
    source: 'crawl' | 'tutorial' | 'qa' | 'manual' | 'loader',
    viewport: 'any' | 'desktop' | 'mobile',
    elements: unknown[],
    now = new Date(),
  ) {
    const key = uiMapKey(s.url(path))!;
    return ingestUiSnapshot(db.forAccount(s.accountId), {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId: await hostId(s),
      host: key.host,
      path: key.path,
      source,
      viewport,
      elements,
      now,
    });
  }

  const rows = (s: ChatSite) =>
    st.owner.siteUiElement.findMany({
      where: { siteId: s.siteId },
      orderBy: [
        { viewport: 'asc' },
        { sourceRank: 'asc' },
        { position: 'asc' },
      ],
    });

  /** Квитанция показа: ассистент выдал посетителю подсветку элемента НА странице `path`. */
  async function receipt(
    s: ChatSite,
    visitorId: string,
    elementId: string,
    createdAt = new Date(),
    path = '/cart',
  ) {
    const conv = await st.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId,
        ipHash: 'ip',
        parentOrigin: s.origin,
      },
    });
    await st.owner.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: conv.id,
        role: 'assistant',
        text: 'Ось.',
        flags: [],
        createdAt,
        actions: [
          {
            kind: 'highlight',
            label: 'Показати',
            elementId,
            selector: '#x',
            caption: 'x',
            page: uiMapPageRef(uiMapKey(s.url(path))!),
          },
        ],
      },
    });
  }

  /** Промах посетителя (новый посетитель и IP, если не заданы). */
  async function miss(
    s: ChatSite,
    elementId: string,
    viewport: UiVisitorViewport,
    o: {
      visitorId?: string;
      ipHash?: string;
      now?: Date;
      path?: string;
      withReceipt?: boolean;
    } = {},
  ) {
    const visitorId = o.visitorId ?? `v-${randomUUID()}`;
    const now = o.now ?? new Date();
    if (o.withReceipt !== false)
      await receipt(s, visitorId, elementId, now, o.path ?? '/cart');
    return recordUiMiss(st.publicDb, {
      accountId: s.accountId,
      siteId: s.siteId,
      visitorId,
      ipHash: o.ipHash ?? `ip-${randomUUID()}`,
      pageUrl: s.url(o.path ?? '/cart'),
      siteHosts: [s.host],
      elementId,
      viewport,
      now,
    });
  }

  const ids = (els: Array<{ id: string }>) => els.map((e) => e.id);

  // ── Тенант и права ─────────────────────────────────────────────────────

  it('тенант: QA — владелец или qa:admin пишет, qa:viewer только читает, чужой — один код; кабинет и публичное чтение — только своего сайта', async () => {
    const s = await st.stand('shop');
    const other = await st.stand('shop');
    const viewer = BigInt(Date.now()) * BigInt(1000) + BigInt(11);
    const admin = viewer + BigInt(1);
    await st.owner.siteAccountMember.createMany({
      data: [
        {
          accountId: s.accountId,
          telegramId: viewer,
          role: 'operator',
          productRoles: { qa: 'viewer', assist: 'none', assistAdmin: 'none' },
        },
        {
          accountId: s.accountId,
          telegramId: admin,
          role: 'operator',
          productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
        },
      ],
    });
    const els = [{ selector: '#buy', tag: 'button', label: 'Купити' }];
    await qa.write(admin, s.siteId, s.url('/cart'), 'desktop', els);
    await qa.write(s.ownerTelegramId, s.siteId, s.url('/cart'), 'mobile', els);
    await expect(
      qa.write(viewer, s.siteId, s.url('/cart'), 'desktop', els),
    ).rejects.toMatchObject({ response: { code: 'UI_MAP_FORBIDDEN' } });
    const page = (await qa.read(viewer, s.siteId, s.url('/cart'), null)) as {
      elements: Array<{ viewport: string; sources: string[] }>;
    };
    expect(page.elements.map((e) => [e.viewport, e.sources])).toEqual([
      ['desktop', ['qa']],
      ['mobile', ['qa']],
    ]);
    for (const tg of [other.ownerTelegramId, BigInt(1)]) {
      await expect(qa.read(tg, s.siteId, null, null)).rejects.toMatchObject({
        response: { code: 'UI_MAP_FORBIDDEN' },
      });
    }
    // Несуществующий сайт — тот же код (не оракул).
    await expect(
      qa.read(s.ownerTelegramId, 'nope', null, null),
    ).rejects.toMatchObject({ response: { code: 'UI_MAP_FORBIDDEN' } });
    await expect(cabinet.uiMap(owner(other), s.siteId)).rejects.toMatchObject({
      response: { code: 'SITE_NOT_FOUND' },
    });
    // Клиент кабинета A не пишет в сайт кабинета B (составной FK).
    const key = uiMapKey(other.url('/x'))!;
    await expect(
      ingestUiSnapshot(db.forAccount(s.accountId), {
        accountId: s.accountId,
        siteId: other.siteId,
        hostId: await hostId(other),
        host: key.host,
        path: key.path,
        source: 'crawl',
        viewport: 'any',
        elements: els,
      }),
    ).rejects.toBeDefined();
    // Публичное чтение: страница сайта B с картой A — пусто.
    expect(
      await pageUiElements(st.publicDb, other.siteId, s.url('/cart'), [
        other.host,
      ]),
    ).toEqual([]);
  });

  it('только подтверждённые хосты своего сайта: pending и отозванный — HOST_NOT_VERIFIED (QA и обучалка)', async () => {
    const s = await st.stand('shop');
    const pending = `pending-${randomUUID().slice(0, 8)}.example.com`;
    const revoked = `revoked-${randomUUID().slice(0, 8)}.example.com`;
    await st.owner.siteHost.createMany({
      data: [
        { accountId: s.accountId, siteId: s.siteId, host: pending },
        {
          accountId: s.accountId,
          siteId: s.siteId,
          host: revoked,
          status: 'verified',
          verifiedAt: new Date(),
          revokedAt: new Date(),
        },
      ],
    });
    const els = [{ selector: '#a', tag: 'a', label: 'A' }];
    for (const h of [pending, revoked, 'evil.example']) {
      await expect(
        qa.write(s.ownerTelegramId, s.siteId, `https://${h}/`, 'any', els),
      ).rejects.toMatchObject({ response: { code: 'HOST_NOT_VERIFIED' } });
      await expect(
        internal.uiMap(s.ownerTelegramId, s.siteId, `https://${h}/`, els),
      ).rejects.toMatchObject({ response: { code: 'HOST_NOT_VERIFIED' } });
    }
    expect(
      await st.owner.siteUiMap.count({ where: { siteId: s.siteId } }),
    ).toBe(0);
  });

  // ── Слияние источников и вид вёрстки ──────────────────────────────────

  it('слияние: обход + QA (any) — один элемент по ключу, подпись от QA, уверенность выше; обучалка — свой вид (mobile); компьютеру снятое на телефоне не предлагается', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити (HTML)' },
      { selector: 'main > a:nth-of-type(1)', tag: 'a', label: 'Доставка' },
    ]);
    await ingest(s, '/cart', 'qa', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    // Обучалка (окно 390×844): меню-гамбургер есть только на телефоне.
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/cart'), [
      { selector: '#burger', tag: 'button', label: 'Меню' },
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    const r = await rows(s);
    expect(
      r.map((e) => [e.viewport, e.elementKey, e.label, e.sources]),
    ).toEqual([
      ['any', 'i:buy', 'Купити', ['qa', 'crawl']],
      ['any', 'x:a|доставка', 'Доставка', ['crawl']],
      ['mobile', 'i:burger', 'Меню', ['tutorial']],
      ['mobile', 'i:buy', 'Купити', ['tutorial']],
    ]);
    expect(r[0].confidence).toBeGreaterThan(r[1].confidence);
    const read = (v?: UiVisitorViewport) =>
      pageUiElements(st.publicDb, s.siteId, s.url('/cart?x=1'), [s.host], {
        viewport: v,
      });
    const buy = uiElementId('#buy');
    const burger = uiElementId('#burger');
    const delivery = uiElementId('main > a:nth-of-type(1)');
    expect(ids(await read('desktop'))).toEqual([buy, delivery]);
    expect(ids(await read('mobile'))).toEqual([burger, buy, delivery]);
    expect(ids(await read())).toEqual([burger, buy, delivery]);
    // История, а не перезапись: новый набор обхода — версия 2.
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити (HTML)' },
    ]);
    const maps = await st.owner.siteUiMap.findMany({
      where: { siteId: s.siteId, source: 'crawl' },
    });
    expect(maps.map((m) => m.version)).toEqual([2]);
    expect(
      await st.owner.siteUiMapVersion.count({
        where: { siteId: s.siteId, source: 'crawl' },
      }),
    ).toBe(2);
    expect(ids(await read('desktop'))).toEqual([buy]);
    // Сводка кабинета: страница, источники, виды.
    const sum = await cabinet.uiMap(owner(s), s.siteId);
    expect(sum).toMatchObject({
      pages: 1,
      elements: 3,
      staleElements: 0,
      bySource: { crawl: 1, qa: 1, tutorial: 1 },
    });
    expect(sum.items[0]).toMatchObject({
      path: '/cart',
      viewports: ['any', 'mobile'],
      sources: ['crawl', 'qa', 'tutorial'],
      elements: 3,
      staleElements: 0,
    });
    expect(sum.byStability).toEqual({ strong: 3, medium: 0, fragile: 0 });
  });

  it('приоритет кандидатов: data-assist-id из HTML — ключ и селектор подсветки; разметили позже — та же строка (промахи не теряются)', async () => {
    const s = await st.stand('shop');
    const html = (assist: boolean) =>
      `<html><body><main><button id="buy"${assist ? ' data-assist-id="add-to-cart"' : ''}>В кошик</button></main></body></html>`;
    await ingest(
      s,
      '/p',
      'crawl',
      'any',
      extractUiElements(html(false), s.url('/p')),
    );
    let [row] = await rows(s);
    expect([row.elementKey, row.selector, row.stability]).toEqual([
      'i:buy',
      '#buy',
      'strong',
    ]);
    await st.owner.siteUiElement.update({
      where: { id: row.id },
      data: { missCountDesktop: 2, missSinceDesktop: new Date() },
    });
    await ingest(
      s,
      '/p',
      'crawl',
      'any',
      extractUiElements(html(true), s.url('/p')),
    );
    const [after] = await rows(s);
    expect(after.id).toBe(row.id);
    expect([after.elementKey, after.selector]).toEqual([
      'a:add-to-cart',
      'button[data-assist-id="add-to-cart"]',
    ]);
    expect(after.missCountDesktop).toBe(2);
    row = after;
    const cands = row.candidates as Array<{ kind: string }>;
    expect(cands.map((c) => c.kind)).toEqual([
      'assist-id',
      'id',
      'text',
      'css',
    ]);
  });

  // ── Устаревание по элементу, виду и анти-накрутка ─────────────────────

  it('устаревание: по ЭЛЕМЕНТУ и виду — порог разных посетителей и IP; первый промах страницу не «портит»; компьютер элемент видит дальше', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
      { selector: '#help', tag: 'a', label: 'Допомога' },
    ]);
    const buy = uiElementId('#buy');
    const read = (v?: UiVisitorViewport) =>
      pageUiElements(st.publicDb, s.siteId, s.url('/cart'), [s.host], {
        viewport: v,
      });
    for (let i = 1; i < UI_MAP_STALE.threshold; i++) {
      expect(await miss(s, buy, 'mobile')).toEqual({
        outcome: 'recorded',
        stale: false,
      });
    }
    expect(ids(await read('mobile'))).toContain(buy);
    expect((await cabinet.list(owner(s), s.siteId)).uiMap).toMatchObject({
      stalePages: 0,
      staleElements: 0,
    });
    expect(await miss(s, buy, 'mobile')).toEqual({
      outcome: 'recorded',
      stale: true,
    });
    expect(ids(await read('mobile'))).toEqual([uiElementId('#help')]);
    expect(ids(await read('desktop'))).toContain(buy);
    expect(ids(await read())).not.toContain(buy);
    const [row] = await rows(s);
    expect([row.missCountMobile, row.missCountDesktop]).toEqual([
      UI_MAP_STALE.threshold,
      0,
    ]);
    expect(row.staleDesktopAt).toBeNull();
    const sum = await cabinet.uiMap(owner(s), s.siteId);
    expect(sum).toMatchObject({ stalePages: 1, staleElements: 1 });
    expect(sum.items[0].stale).toEqual([
      expect.objectContaining({ label: 'Купити', viewport: 'mobile' }),
    ]);
  });

  it('окно: промахи старше окна не копятся — счёт заново', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    const buy = uiElementId('#buy');
    const t0 = new Date(Date.now() - UI_MAP_STALE.windowMs - 60_000);
    for (let i = 1; i < UI_MAP_STALE.threshold; i++) {
      await miss(s, buy, 'desktop', { now: new Date(t0.getTime() + i) });
    }
    expect(await miss(s, buy, 'desktop')).toEqual({
      outcome: 'recorded',
      stale: false,
    });
    const [row] = await rows(s);
    expect(row.missCountDesktop).toBe(1);
  });

  it('анти-накрутка: без квитанции, чужая/старая квитанция, другой элемент, повтор посетителя или IP, элемент другого вида — не засчитывается', async () => {
    const s = await st.stand('shop');
    const other = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
      { selector: '#help', tag: 'a', label: 'Допомога' },
    ]);
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/cart'), [
      { selector: '#burger', tag: 'button', label: 'Меню' },
    ]);
    const buy = uiElementId('#buy');
    const no = { outcome: 'no-receipt', stale: false };
    expect(await miss(s, buy, 'desktop', { withReceipt: false })).toEqual(no);
    // Квитанция другому посетителю.
    await receipt(s, 'v-someone', buy);
    expect(
      await miss(s, buy, 'desktop', { visitorId: 'v-me', withReceipt: false }),
    ).toEqual(no);
    // Квитанция на другой элемент.
    await receipt(s, 'v-me2', uiElementId('#help'));
    expect(
      await miss(s, buy, 'desktop', { visitorId: 'v-me2', withReceipt: false }),
    ).toEqual(no);
    // Квитанция в диалоге на ДРУГОМ сайте того же посетителя.
    await receipt(other, 'v-me3', buy);
    expect(
      await miss(s, buy, 'desktop', { visitorId: 'v-me3', withReceipt: false }),
    ).toEqual(no);
    // Старая квитанция (за окном показа).
    await receipt(
      s,
      'v-old',
      buy,
      new Date(Date.now() - UI_MAP_STALE.receiptMs - 60_000),
    );
    expect(
      await miss(s, buy, 'desktop', { visitorId: 'v-old', withReceipt: false }),
    ).toEqual(no);
    // Повтор: тот же IP с новым посетителем, тот же посетитель с новым IP.
    expect(
      await miss(s, buy, 'desktop', { ipHash: 'ip-1', visitorId: 'v-a' }),
    ).toMatchObject({ outcome: 'recorded' });
    expect(await miss(s, buy, 'desktop', { ipHash: 'ip-1' })).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await miss(s, buy, 'desktop', { visitorId: 'v-a' })).toMatchObject({
      outcome: 'duplicate',
    });
    // Снятое на телефоне (обучалка) — компьютеру не элемент.
    expect(await miss(s, uiElementId('#burger'), 'desktop')).toMatchObject({
      outcome: 'unknown-element',
    });
    expect(await miss(s, uiElementId('#burger'), 'mobile')).toMatchObject({
      outcome: 'recorded',
    });
    // Мусорный id и чужая страница.
    expect(await miss(s, 'u00000000', 'desktop')).toMatchObject({
      outcome: 'unknown-element',
    });
    expect(
      await recordUiMiss(st.publicDb, {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: 'v',
        ipHash: 'ip',
        pageUrl: 'https://evil.example/cart',
        siteHosts: [s.host],
        elementId: buy,
        viewport: 'desktop',
        now: new Date(),
      }),
    ).toEqual({ outcome: 'invalid', stale: false });
    const [row] = (await rows(s)).filter((r) => r.elementId === buy);
    expect(row.missCountDesktop).toBe(1);
  });

  it('маршрут виджета: вид — по заголовкам, сутки на IP+сайт — RATE_LIMITED', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    const buy = uiElementId('#buy');
    const ip = `ip-${randomUUID()}`;
    const req = (ua?: string) =>
      ({
        headers: {
          origin: 'https://w.test',
          ...(ua ? { 'user-agent': ua } : {}),
        },
        method: 'POST',
      }) as never;
    current = { site: s.ctx(), visitor: st.visitor({ ipHash: ip }) };
    await receipt(s, current.visitor.visitorId, buy);
    // Суточное окно IP+сайт — сутки UTC (floor(now / сутки)): 21 вызов на
    // полуночи делится между двумя окнами, и RATE_LIMITED не наступает.
    await awaitUtcDayHeadroom();
    expect(
      await widget.highlightMiss(
        undefined,
        { elementId: buy, pageUrl: s.url('/cart') },
        req(IPHONE),
      ),
    ).toEqual({ ok: true, recorded: true });
    const [row] = await rows(s);
    expect([row.missCountMobile, row.missCountDesktop]).toEqual([1, 0]);
    let limited = false;
    for (
      let i = 0;
      i < UI_MAP_STALE.missesPerIpSitePerDay + 1 && !limited;
      i++
    ) {
      current = { site: s.ctx(), visitor: st.visitor({ ipHash: ip }) };
      try {
        await widget.highlightMiss(
          undefined,
          { elementId: buy, pageUrl: s.url('/cart') },
          req(),
        );
      } catch (e) {
        limited =
          (e as { response?: { code?: string } }).response?.code ===
            'RATE_LIMITED' ||
          JSON.stringify((e as { response?: unknown }).response ?? '').includes(
            'RATE_LIMITED',
          );
      }
    }
    expect(limited).toBe(true);
  });

  it('аудит Ш4: квитанция показа привязана к странице — подсветка на /cart не засчитывает промах того же элемента на /checkout', async () => {
    const s = await st.stand('shop');
    const els = [{ selector: '#buy', tag: 'button', label: 'Купити' }];
    await ingest(s, '/cart', 'crawl', 'any', els);
    await ingest(s, '/checkout', 'crawl', 'any', els);
    const buy = uiElementId('#buy');
    // id элемента — хеш селектора: на обеих страницах один и тот же.
    await receipt(s, 'v-page', buy, new Date(), '/cart');
    expect(
      await miss(s, buy, 'desktop', {
        visitorId: 'v-page',
        path: '/checkout',
        withReceipt: false,
      }),
    ).toEqual({ outcome: 'no-receipt', stale: false });
    expect(
      await miss(s, buy, 'desktop', {
        visitorId: 'v-page',
        path: '/cart',
        withReceipt: false,
      }),
    ).toMatchObject({ outcome: 'recorded' });
    const byPath = Object.fromEntries(
      (await rows(s)).map((x) => [x.path, x.missCountDesktop]),
    );
    expect(byPath).toEqual({ '/cart': 1, '/checkout': 0 });
  });

  it('аудит Ш4: журнал промахов — хеш IP с солью на окно (неделя): тот же адрес на другой день с новым токеном — повтор; в следующем окне — новый; сырого IP нет', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    const buy = uiElementId('#buy');
    const ip = '203.0.113.77';
    const req = {
      headers: { origin: 'https://w.test', 'x-forwarded-for': ip },
      method: 'POST',
    } as never;
    const W = UI_MAP_STALE.windowMs;
    const start = (Math.floor(Date.now() / W) + 1) * W + 3600_000;
    const at = async (t: number) => {
      const day = new Date(t);
      // Новый посетитель и новый суточный ipHash токена — как на другой день.
      current = {
        site: s.ctx(),
        visitor: st.visitor({ ipHash: `daily-${randomUUID()}` }),
      };
      await receipt(s, current.visitor.visitorId, buy, day);
      widget.now = () => day;
      try {
        return await widget.highlightMiss(
          undefined,
          { elementId: buy, pageUrl: s.url('/cart') },
          req,
        );
      } finally {
        widget.now = () => new Date();
      }
    };
    expect(await at(start)).toEqual({ ok: true, recorded: true });
    expect(await at(start + 86_400_000)).toEqual({ ok: true, recorded: false });
    expect(await at(start + 3 * 86_400_000)).toEqual({
      ok: true,
      recorded: false,
    });
    // Следующее окно — соль другая: тот же адрес снова «новый IP».
    expect(await at(start + W)).toEqual({ ok: true, recorded: true });
    const [row] = await rows(s);
    const journal = await st.owner.siteUiElementMiss.findMany({
      where: { elementRowId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(journal).toHaveLength(2);
    const site = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
      select: { ipSalt: true },
    });
    const { widgetIpSecret } = await import('../../config/widget-env');
    const secret = widgetIpSecret(st.env)!;
    expect(secret).toBeTruthy();
    expect(journal.map((j) => j.ipHash)).toEqual([
      windowIpHash(ip, secret, site!.ipSalt, new Date(start)),
      windowIpHash(ip, secret, site!.ipSalt, new Date(start + W)),
    ]);
    expect(JSON.stringify(journal)).not.toContain(ip);
  });

  it('сброс при новом подтверждении: браузер сервера (QA/обучалка) снимает «устарел» своего вида сразу, загрузчик (посетитель) — голосами с порогом, обход — нет', async () => {
    const s = await st.stand('shop');
    const els = [{ selector: '#buy', tag: 'button', label: 'Купити' }];
    await ingest(s, '/cart', 'crawl', 'any', els);
    const buy = uiElementId('#buy');
    for (let i = 0; i < UI_MAP_STALE.threshold; i++) {
      await miss(s, buy, 'mobile');
      await miss(s, buy, 'desktop');
    }
    let [row] = await rows(s);
    expect(row.staleMobileAt).not.toBeNull();
    expect(row.staleDesktopAt).not.toBeNull();
    // Обход прошёл ту же вёрстку — разметка не видимость: не снимает.
    await ingest(s, '/cart', 'crawl', 'any', els);
    [row] = await rows(s);
    expect(row.staleMobileAt).not.toBeNull();
    // QA на телефоне увидел элемент — снят «устарел» телефона, журнал тоже.
    await ingest(s, '/cart', 'qa', 'mobile', els);
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect([row.staleMobileAt, row.missCountMobile]).toEqual([null, 0]);
    expect(row.staleDesktopAt).not.toBeNull();
    expect(
      await st.owner.siteUiElementMiss.count({
        where: { elementRowId: row.id, viewport: 'mobile' },
      }),
    ).toBe(0);
    // Снимок загрузчика (Э6-бис) — данные ПОСЕТИТЕЛЯ (аудит Ш4): сам по
    // себе «устарел» не снимает — только голос «найден»; порог — как у
    // промахов: разные посетители И разные IP за окно.
    const seenBy = (visitorId: string, ipHash: string, now = new Date()) =>
      confirmSeenUiElements(st.publicDb, {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId,
        ipHash,
        pageUrl: s.url('/cart'),
        siteHosts: [s.host],
        viewport: 'desktop',
        seen: [{ tag: 'button', name: 'Купити', selector: '#buy' }],
        now,
      });
    expect(await seenBy('v-s1', 'ip-s1')).toBe(1);
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect(row.staleDesktopAt).not.toBeNull();
    expect([row.seenCountDesktop, row.lastSeenAt]).toEqual([
      1,
      expect.any(Date),
    ]);
    // Снимок источника `loader` через общую дверь ядра — тоже не сброс.
    await ingest(s, '/cart', 'loader', 'desktop', els);
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect(row.staleDesktopAt).not.toBeNull();
    // Тот же посетитель с другого IP и тот же IP с другим посетителем — не голос.
    await seenBy('v-s1', 'ip-s2');
    await seenBy('v-s2', 'ip-s1');
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect([row.seenCountDesktop, row.staleDesktopAt]).toEqual([
      1,
      expect.any(Date),
    ]);
    // Голос за окном — счёт заново.
    await seenBy(
      'v-s3',
      'ip-s3',
      new Date(Date.now() + UI_MAP_STALE.windowMs + 60_000),
    );
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect(row.seenCountDesktop).toBe(1);
    await st.owner.siteUiElement.update({
      where: { id: row.id },
      data: { seenCountDesktop: 1, seenSinceDesktop: new Date() },
    });
    await seenBy('v-s4', 'ip-s4');
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect([row.seenCountDesktop, row.staleDesktopAt]).toEqual([
      2,
      expect.any(Date),
    ]);
    // Третий разный посетитель и IP — порог: промахи и «устарел» вида сняты.
    await seenBy('v-s5', 'ip-s5');
    [row] = (await rows(s)).filter((r) => r.viewport === 'any');
    expect([
      row.staleDesktopAt,
      row.missCountDesktop,
      row.seenCountDesktop,
    ]).toEqual([null, 0, 0]);
    // Элемент без промахов вида — голосов не пишет (журнал не растёт).
    const votes = () =>
      st.owner.siteUiElementMiss.count({
        where: { elementRowId: row.id, kind: 'seen' },
      });
    const before = await votes();
    // (узнаны строки `any` и `desktop` снимка loader — ни у одной промахов нет)
    expect(await seenBy('v-s6', 'ip-s6')).toBe(2);
    expect(await votes()).toBe(before);
    // Подтверждение чужой страницы и пустой снимок — ничего.
    expect(
      await confirmSeenUiElements(st.publicDb, {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: 'v-s7',
        ipHash: 'ip-s7',
        pageUrl: 'https://evil.example/cart',
        siteHosts: [s.host],
        viewport: 'desktop',
        seen: [{ tag: 'button', name: 'Купити', selector: '#buy' }],
        now: new Date(),
      }),
    ).toBe(0);
  });

  // ── Ретенция и лимиты ──────────────────────────────────────────────────

  it('аудит Ш4: снимок снят пустым набором и снят заново — номер версии продолжает историю (строка истории не теряется)', async () => {
    const s = await st.stand('shop');
    const el = (i: number) => [
      { selector: `#h${i}`, tag: 'button', label: `Кнопка ${i}` },
    ];
    expect((await ingest(s, '/h', 'qa', 'any', el(1))).version).toBe(1);
    expect((await ingest(s, '/h', 'qa', 'any', el(2))).version).toBe(2);
    expect((await ingest(s, '/h', 'qa', 'any', [])).version).toBe(0);
    expect((await ingest(s, '/h', 'qa', 'any', el(3))).version).toBe(3);
    const [map] = await st.owner.siteUiMap.findMany({
      where: { siteId: s.siteId, source: 'qa' },
    });
    const versions = await st.owner.siteUiMapVersion.findMany({
      where: { siteId: s.siteId, source: 'qa' },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2].elementsHash).toBe(map.elementsHash);
  });

  it('ретенция (крон): версии — не больше 10 и не старше 90 дней (текущая — всегда); журнал промахов — окно; «устарел» — срок; карты до Ш4 — достраиваются', async () => {
    const s = await st.stand('shop');
    const total = UI_MAP_SHARED.versionsPerMap + 2;
    for (let i = 0; i < total; i++) {
      await ingest(s, '/v', 'crawl', 'any', [
        { selector: `#b${i}`, tag: 'button', label: `Кнопка ${i}` },
      ]);
    }
    const run = () =>
      runUiMapMaintenance(st.owner, (a) => db.forAccount(a), new Date());
    await run();
    const versions = await st.owner.siteUiMapVersion.findMany({
      where: { siteId: s.siteId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual(
      Array.from({ length: UI_MAP_SHARED.versionsPerMap }, (_, i) => i + 3),
    );
    // Все старые по сроку — остаётся только текущая.
    await st.owner.siteUiMapVersion.updateMany({
      where: { siteId: s.siteId },
      data: { createdAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    // Промах старше окна и «устарел» старше срока.
    const buy = uiElementId(`#b${total - 1}`);
    await miss(s, buy, 'desktop', { path: '/v' });
    await st.owner.siteUiElementMiss.updateMany({
      where: { siteId: s.siteId },
      data: { createdAt: new Date(Date.now() - UI_MAP_STALE.windowMs - 1000) },
    });
    await st.owner.siteUiElement.updateMany({
      where: { siteId: s.siteId },
      data: {
        staleMobileAt: new Date(Date.now() - UI_MAP_STALE.staleTtlMs - 1000),
        missCountMobile: 3,
      },
    });
    // Карта до Ш4: снимок без слитых элементов.
    const key = uiMapKey(s.url('/legacy'))!;
    await st.owner.siteUiMap.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: await hostId(s),
        host: key.host,
        path: key.path,
        source: 'tutorial',
        viewport: 'mobile',
        elements: [
          {
            id: uiElementId('#old'),
            selector: '#old',
            tag: 'a',
            label: 'Старе',
          },
        ],
        elementsHash: 'legacy',
        capturedAt: new Date(),
      },
    });
    // Снимок без годных элементов — снимается (иначе вечно в очереди).
    const junkKey = uiMapKey(s.url('/junk'))!;
    await st.owner.siteUiMap.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: await hostId(s),
        host: junkKey.host,
        path: junkKey.path,
        source: 'crawl',
        elements: [{ tag: 'div', label: 'x', selector: '#x' }],
        elementsHash: 'junk',
        capturedAt: new Date(),
      },
    });
    const r = await run();
    expect(
      await st.owner.siteUiMap.count({
        where: { siteId: s.siteId, path: '/junk' },
      }),
    ).toBe(0);
    expect(r.versionsDeleted).toBeGreaterThanOrEqual(
      UI_MAP_SHARED.versionsPerMap - 1,
    );
    expect(r.pagesRebuilt).toBeGreaterThanOrEqual(1);
    expect(
      (
        await st.owner.siteUiMapVersion.findMany({
          where: { siteId: s.siteId },
        })
      ).map((v) => v.version),
    ).toEqual([total]);
    expect(
      await st.owner.siteUiElementMiss.count({ where: { siteId: s.siteId } }),
    ).toBe(0);
    const el = await rows(s);
    expect(el.find((e) => e.path === '/v')!.staleMobileAt).toBeNull();
    expect(
      el
        .filter((e) => e.path === '/legacy')
        .map((e) => [e.viewport, e.elementKey, e.sources]),
    ).toEqual([['mobile', 'i:old', ['tutorial']]]);
    expect(
      ids(
        await pageUiElements(
          st.publicDb,
          s.siteId,
          s.url('/legacy'),
          [s.host],
          {
            viewport: 'mobile',
          },
        ),
      ),
    ).toEqual([uiElementId('#old')]);
  });

  it('лимиты: страниц в карте сайта — потолок (новая страница — отказ, известная — принимается); QA — 403 UI_MAP_PAGES_LIMIT', async () => {
    const s = await st.stand('shop');
    const h = await hostId(s);
    const key = uiMapKey(s.url('/'))!;
    await st.owner.siteUiMap.createMany({
      data: Array.from({ length: UI_MAP_SHARED.pagesPerSite }, (_, i) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: h,
        host: key.host,
        path: `/p${i}`,
        source: 'crawl',
        elements: [],
        elementsHash: 'x',
        capturedAt: new Date(),
      })),
    });
    const els = [{ selector: '#a', tag: 'a', label: 'A' }];
    await expect(ingest(s, '/new', 'crawl', 'any', els)).rejects.toBeInstanceOf(
      UiMapLimitError,
    );
    await expect(
      qa.write(s.ownerTelegramId, s.siteId, s.url('/new'), 'any', els),
    ).rejects.toMatchObject({ response: { code: 'UI_MAP_PAGES_LIMIT' } });
    expect(await ingest(s, '/p1', 'qa', 'desktop', els)).toMatchObject({
      elements: 1,
      version: 1,
    });
  });
  // ── Заход 9: хвосты Ш4 (2)–(4) ─────────────────────────────────────────

  it('Ш4 (2), Р-З9-1: чат предлагает элементы карты СВОЕГО вида вёрстки и без устаревших для него (компьютеру — не снятое на телефоне, телефону — не устаревшее на телефоне)', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    // Обучалка (окно телефона): меню-гамбургер есть только на телефоне.
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/cart'), [
      { selector: '#burger', tag: 'button', label: 'Меню' },
    ]);
    const page = { url: s.url('/cart'), title: null };
    const hl = (r: { actions: Array<{ kind: string }> }) =>
      r.actions.filter((a) => a.kind === 'highlight');
    script = answer([{ kind: 'highlight', label: 'Показати', element: 'E1' }]);
    const desk = await st.ask(s, 'Де кнопка купити на компʼютері?', {
      page,
      viewport: 'desktop',
    });
    expect(lastPrompt()).toContain('Купити</element>');
    expect(lastPrompt()).not.toContain('Меню</element>');
    expect(hl(desk)).toEqual([
      expect.objectContaining({ selector: '#buy', caption: 'Купити' }),
    ]);
    const phone = await st.ask(s, 'Де меню на телефоні?', {
      page,
      viewport: 'mobile',
    });
    expect(lastPrompt()).toContain('Меню</element>');
    expect(hl(phone)).toEqual([
      expect.objectContaining({ selector: '#burger', caption: 'Меню' }),
    ]);
    // «Купити» устарела на телефоне — телефону не предлагается, компьютеру — да.
    const buy = uiElementId('#buy');
    for (let i = 0; i < UI_MAP_STALE.threshold; i++)
      await miss(s, buy, 'mobile');
    await st.ask(s, 'А кнопка оформлення на телефоні?', {
      page,
      viewport: 'mobile',
    });
    expect(lastPrompt()).not.toContain('Купити</element>');
    await st.ask(s, 'А кнопка оформлення на компʼютері?', {
      page,
      viewport: 'desktop',
    });
    expect(lastPrompt()).toContain('Купити</element>');
    // Вид неизвестен (старый клиент) — как раньше: любые, без устаревших хоть где-то.
    await st.ask(s, 'Покажіть, де оформити замовлення', { page });
    expect(lastPrompt()).toContain('Меню</element>');
    expect(lastPrompt()).not.toContain('Купити</element>');
  });

  it('Ш4 (3), Р-З9-2: снимок узнаёт `div role=button` (тег `other`) по data-assist-id — голос «найден» с порогом; по тексту и с неинтерактивной ролью — нет', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#x1', tag: 'button', label: 'Купити', assistId: 'buy' },
      {
        selector: 'main > button:nth-of-type(2)',
        tag: 'button',
        label: 'Доставка',
      },
    ]);
    const all = await rows(s);
    const buyRow = all.find((r) => r.label === 'Купити')!;
    const textRow = all.find((r) => r.label === 'Доставка')!;
    expect(buyRow.elementKey).toBe('a:buy');
    expect(textRow.elementKey.startsWith('x:button|')).toBe(true);
    for (let i = 0; i < UI_MAP_STALE.threshold; i++) {
      await miss(s, buyRow.elementId, 'desktop');
      await miss(s, textRow.elementId, 'desktop');
    }
    const seenBy = (n: number, seen: unknown[]) =>
      confirmSeenUiElements(st.publicDb, {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: `v-div-${n}`,
        ipHash: `ip-div-${n}`,
        pageUrl: s.url('/cart'),
        siteHosts: [s.host],
        viewport: 'desktop',
        seen,
        now: new Date(),
      });
    // Вёрстка сменилась: кнопка стала div с ролью, data-assist-id остался
    // (форма снимка плана Э6-бис: tag, label, assistId, role).
    const div = {
      tag: 'other',
      role: 'button',
      label: 'Купити',
      assistId: 'buy',
    };
    // «Доставка» как вкладка — тот же текст, но не та же кнопка: не узнаётся.
    const tab = { tag: 'other', role: 'tab', label: 'Доставка' };
    const heading = {
      tag: 'other',
      role: 'heading',
      label: 'Купити',
      assistId: 'buy',
    };
    expect(await seenBy(0, [tab, heading])).toBe(0);
    expect(await seenBy(1, [div, tab])).toBe(1);
    expect(await seenBy(2, [div])).toBe(1);
    let [row] = (await rows(s)).filter((r) => r.id === buyRow.id);
    expect([row.seenCountDesktop, row.staleDesktopAt]).toEqual([
      2,
      expect.any(Date),
    ]);
    expect(await seenBy(3, [div])).toBe(1);
    [row] = (await rows(s)).filter((r) => r.id === buyRow.id);
    expect([row.staleDesktopAt, row.missCountDesktop]).toEqual([null, 0]);
    const [still] = (await rows(s)).filter((r) => r.id === textRow.id);
    expect([still.seenCountDesktop, still.staleDesktopAt]).toEqual([
      0,
      expect.any(Date),
    ]);
  });

  it('Ш4 (4), Р-З9-3: «найдено» подсветкой — только по квитанции показа своей страницы и элементу карты своего вида; голос раз на посетителя и IP; порог — сброс; без сомнений — только lastSeenAt', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
      { selector: '#help', tag: 'a', label: 'Допомога' },
    ]);
    await ingest(s, '/checkout', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    await internal.uiMap(s.ownerTelegramId, s.siteId, s.url('/cart'), [
      { selector: '#burger', tag: 'button', label: 'Меню' },
    ]);
    const buy = uiElementId('#buy');
    const help = uiElementId('#help');
    const found = async (
      elementId: string,
      o: {
        visitorId?: string;
        ipHash?: string;
        path?: string;
        receiptPath?: string | null;
        viewport?: UiVisitorViewport;
        pageUrl?: string;
      } = {},
    ) => {
      const visitorId = o.visitorId ?? `v-${randomUUID()}`;
      if (o.receiptPath !== null)
        await receipt(
          s,
          visitorId,
          elementId,
          new Date(),
          o.receiptPath ?? '/cart',
        );
      return (
        await recordUiSeen(st.publicDb, {
          accountId: s.accountId,
          siteId: s.siteId,
          visitorId,
          ipHash: o.ipHash ?? `ip-${randomUUID()}`,
          pageUrl: o.pageUrl ?? s.url(o.path ?? '/cart'),
          siteHosts: [s.host],
          elementId,
          viewport: o.viewport ?? 'desktop',
          now: new Date(),
        })
      ).outcome;
    };
    const journal = () =>
      st.owner.siteUiElementMiss.count({
        where: { siteId: s.siteId, kind: 'seen' },
      });
    // Мусор и чужая страница; без квитанции; квитанция другой страницы.
    expect(await found('u00000000', { receiptPath: null })).toBe('no-receipt');
    expect(await found('x', { receiptPath: null })).toBe('invalid');
    expect(await found(buy, { pageUrl: 'https://evil.example/cart' })).toBe(
      'invalid',
    );
    expect(await found(buy, { receiptPath: null })).toBe('no-receipt');
    expect(await found(buy, { path: '/checkout', receiptPath: '/cart' })).toBe(
      'no-receipt',
    );
    // Снятое на телефоне — компьютеру не элемент.
    expect(await found(uiElementId('#burger'))).toBe('unknown-element');
    // Сомнений нет — только «видели», голосов нет.
    expect(await found(buy)).toBe('seen');
    expect(await journal()).toBe(0);
    let [row] = (await rows(s)).filter(
      (r) => r.elementId === buy && r.path === '/cart',
    );
    expect(row.lastSeenAt).toEqual(expect.any(Date));
    // Промахи набрали «устарел» на компьютере.
    for (let i = 0; i < UI_MAP_STALE.threshold; i++)
      await miss(s, buy, 'desktop');
    [row] = (await rows(s)).filter(
      (r) => r.elementId === buy && r.path === '/cart',
    );
    expect(row.staleDesktopAt).not.toBeNull();
    // Голоса: повтор посетителя и повтор IP — не голос; порог — сброс вида.
    expect(await found(buy, { visitorId: 'v-f1', ipHash: 'ip-f1' })).toBe(
      'voted',
    );
    expect(await found(buy, { visitorId: 'v-f1', ipHash: 'ip-f9' })).toBe(
      'duplicate',
    );
    expect(await found(buy, { visitorId: 'v-f9', ipHash: 'ip-f1' })).toBe(
      'duplicate',
    );
    for (let i = 2; i < UI_MAP_STALE.threshold; i++)
      expect(
        await found(buy, { visitorId: `v-f${i}`, ipHash: `ip-f${i}` }),
      ).toBe('voted');
    [row] = (await rows(s)).filter(
      (r) => r.elementId === buy && r.path === '/cart',
    );
    expect(row.staleDesktopAt).not.toBeNull();
    expect(await found(buy, { visitorId: 'v-fz', ipHash: 'ip-fz' })).toBe(
      'reset',
    );
    [row] = (await rows(s)).filter(
      (r) => r.elementId === buy && r.path === '/cart',
    );
    expect([
      row.staleDesktopAt,
      row.missCountDesktop,
      row.seenCountDesktop,
    ]).toEqual([null, 0, 0]);
    // Вид телефона и другие элементы не тронуты.
    expect(row.missCountMobile).toBe(0);
    expect(await found(help)).toBe('seen');
  });

  it('Ш4 (4): маршрут highlight-seen — вид по заголовкам, свои лимиты (сутки на IP+сайт — только на голос и не съедают лимит промахов)', async () => {
    const s = await st.stand('shop');
    await ingest(s, '/cart', 'crawl', 'any', [
      { selector: '#buy', tag: 'button', label: 'Купити' },
    ]);
    const buy = uiElementId('#buy');
    const ip = `ip-${randomUUID()}`;
    const req = (ua?: string) =>
      ({
        headers: {
          origin: 'https://w.test',
          ...(ua ? { 'user-agent': ua } : {}),
        },
        method: 'POST',
      }) as never;
    for (let i = 0; i < UI_MAP_STALE.threshold; i++)
      await miss(s, buy, 'mobile');
    current = { site: s.ctx(), visitor: st.visitor({ ipHash: ip }) };
    await receipt(s, current.visitor.visitorId, buy);
    await awaitUtcDayHeadroom();
    // Телефон: элемент устарел на телефоне — голос принят.
    expect(
      await widget.highlightSeen(
        undefined,
        { elementId: buy, pageUrl: s.url('/cart') },
        req(IPHONE),
      ),
    ).toEqual({ ok: true, recorded: true });
    let [row] = await rows(s);
    expect([row.seenCountMobile, row.seenCountDesktop]).toEqual([1, 0]);
    // Компьютер (тот же посетитель): сомнений у вида нет — голоса нет.
    expect(
      await widget.highlightSeen(
        undefined,
        { elementId: buy, pageUrl: s.url('/cart') },
        req(),
      ),
    ).toEqual({ ok: true, recorded: false });
    [row] = await rows(s);
    expect(row.seenCountDesktop).toBe(0);
    const limitedCall = async (
      visitorIp: string,
      ua: string | undefined,
    ): Promise<boolean> => {
      current = { site: s.ctx(), visitor: st.visitor({ ipHash: visitorIp }) };
      await receipt(s, current.visitor.visitorId, buy);
      try {
        await widget.highlightSeen(
          undefined,
          { elementId: buy, pageUrl: s.url('/cart') },
          req(ua),
        );
        return false;
      } catch (e) {
        return JSON.stringify(
          (e as { response?: unknown }).response ?? '',
        ).includes('RATE_LIMITED');
      }
    };
    // P3-3: «найдено» без сомнения (компьютер) суточный лимит не тратит —
    // больше суточного потолка таких вызовов с одного IP проходят.
    const calm = `ip-${randomUUID()}`;
    for (let i = 0; i < UI_MAP_STALE.missesPerIpSitePerDay + 3; i++)
      expect(await limitedCall(calm, undefined)).toBe(false);
    // Голоса (телефон, элемент под сомнением) — сутки на IP+сайт.
    let limited = false;
    for (let i = 0; i < UI_MAP_STALE.missesPerIpSitePerDay + 1 && !limited; i++)
      limited = await limitedCall(ip, IPHONE);
    expect(limited).toBe(true);
    // Промах с того же IP — свой суточный счёт, не исчерпан «найдено».
    current = { site: s.ctx(), visitor: st.visitor({ ipHash: ip }) };
    await receipt(s, current.visitor.visitorId, buy);
    expect(
      await widget.highlightMiss(
        undefined,
        { elementId: buy, pageUrl: s.url('/cart') },
        req(),
      ),
    ).toEqual({ ok: true, recorded: true });
  });
});
