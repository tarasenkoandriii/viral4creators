/**
 * Обучалка → помощник (Э6): привязка только через проверку sites-backend,
 * полный набор ОДОБРЕННЫХ и собранных роликов привязанных черновиков,
 * карта интерфейса только у привязанного черновика без входа. Сеть —
 * подделка клиента внутреннего API; база — подделка Prisma.
 */
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SitesRejectedError,
  SitesUnavailableError,
} from '../sites-internal/sites-internal.client';
import {
  ClientSiteMediaService,
  SYNC_BODY_BUDGET,
  UI_MAP_BODY_BUDGET,
  fitUiMapBody,
  mapElements,
} from './client-site-media.service';

type Row = Record<string, unknown>;

function fakePrisma(state: {
  projects: Row[];
  drafts: Row[];
  assets: Row[];
  users: Row[];
}) {
  const match = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Row;
        if ('in' in o) return (o.in as unknown[]).includes(row[k]);
        if ('not' in o) return row[k] !== o.not;
      }
      return row[k] === v;
    });
  return {
    project: {
      findFirst: async ({ where }: { where: Row }) =>
        state.projects.find((p) => match(p, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        state.projects
          .filter((p) => match(p, where))
          .map((p) => ({
            id: p.id,
            user: state.users.find((u) => u.id === p.userId) ?? null,
          })),
    },
    user: {
      findUnique: async ({ where }: { where: Row }) =>
        state.users.find((u) => u.id === where.id) ?? null,
    },
    clientSiteTutorialDraft: {
      findUnique: async ({ where }: { where: Row }) =>
        state.drafts.find((d) => match(d, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        state.drafts.filter((d) => match(d, where)),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const d = state.drafts.find((x) => x.id === where.id)!;
        Object.assign(d, data);
        return d;
      },
    },
    tutorialVideoAsset: {
      findMany: async ({ where }: { where: Row }) =>
        state.assets
          .filter((a) => match(a, where))
          .sort((a, b) => (b.createdAt as number) - (a.createdAt as number)),
    },
  };
}

function fakeSites() {
  return {
    calls: [] as Array<[string, unknown[]]>,
    configuredFlag: true,
    linkError: null as Error | null,
    syncError: null as Error | null,
    configured() {
      return this.configuredFlag;
    },
    async linkSite(...a: unknown[]) {
      this.calls.push(['linkSite', a]);
      if (this.linkError) throw this.linkError;
      return { siteId: a[1], siteName: 'Магазин', hosts: ['shop.example.com'] };
    },
    async syncSiteVideos(...a: unknown[]) {
      this.calls.push(['syncSiteVideos', a]);
      if (this.syncError) throw this.syncError;
      return { siteId: a[0], accepted: 0, removed: 0, rejected: [] };
    },
    async pushUiMap(...a: unknown[]) {
      this.calls.push(['pushUiMap', a]);
      return { siteId: a[1], path: '/', elements: 1 };
    },
  };
}

/**
 * Реалистичный публичный черновик (аудит Э6, Д1): `secretsUsedAt` ставит
 * каждый раунд, куки первой стороны пишутся каждым раундом (колонка или
 * личная запись хранилища), входа не было — `loginUsedAt` пуст.
 */
const publicDraft = (over: Row = {}): Row => ({
  id: 'd1',
  projectId: 'p1',
  baseUrl: 'https://shop.example.com/',
  lastUrl: null,
  steps: [
    { kind: 'goto', route: 'https://shop.example.com/' },
    { kind: 'click', selector: '#buy' },
  ],
  credentialsEnc: null,
  cookiesEnc: 'v1:куки-первой-стороны',
  userSiteSessionId: null,
  siteTestAccountId: null,
  storeHasCredentials: false,
  requiresLiveLoginReplay: false,
  secretsUsedAt: new Date('2027-01-20T10:00:00Z'),
  loginUsedAt: null,
  status: 'APPROVED',
  title: 'Как купить',
  clientSiteId: null,
  ...over,
});

function setup(over: Partial<Parameters<typeof fakePrisma>[0]> = {}) {
  const state = {
    projects: [
      { id: 'p1', userId: 'u1', type: 'CLIENT_SITE', deletedAt: null },
      { id: 'p2', userId: 'u2', type: 'CLIENT_SITE', deletedAt: null },
    ],
    users: [
      { id: 'u1', telegramId: '1001' },
      { id: 'u2', telegramId: '1002' },
    ],
    drafts: [publicDraft()],
    assets: [] as Row[],
    ...over,
  };
  const sites = fakeSites();
  const svc = new ClientSiteMediaService(
    fakePrisma(state) as never,
    sites as never,
  );
  return { state, sites, svc };
}

describe('привязка черновика к сайту помощника', () => {
  it('проверка в sites-backend → clientSiteId записан, набор сайта отправлен', async () => {
    const { state, sites, svc } = setup();
    await expect(svc.setLink('u1', 'p1', 'site_A')).resolves.toEqual({
      clientSiteId: 'site_A',
      siteName: 'Магазин',
    });
    expect(state.drafts[0].clientSiteId).toBe('site_A');
    expect(sites.calls.map((c) => c[0])).toEqual([
      'linkSite',
      'syncSiteVideos',
    ]);
    expect(sites.calls[0][1]).toEqual(['1001', 'site_A']);
  });

  it('sites-backend отказал (не владелец/менеджер) — 403, черновик не привязан', async () => {
    const { state, sites, svc } = setup();
    sites.linkError = new SitesRejectedError(403, 'SITE_LINK_FORBIDDEN', 'x');
    await expect(svc.setLink('u1', 'p1', 'site_B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(state.drafts[0].clientSiteId).toBeNull();
    expect(sites.calls.map((c) => c[0])).toEqual(['linkSite']);
  });

  it('sites-backend недоступен — 503, не привязан', async () => {
    const { state, sites, svc } = setup();
    sites.linkError = new SitesUnavailableError('down');
    await expect(svc.setLink('u1', 'p1', 'site_B')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(state.drafts[0].clientSiteId).toBeNull();
  });

  it('чужой проект — 404; dev-пользователь без Telegram — 403; кривой id — 400', async () => {
    const { svc, state } = setup();
    await expect(svc.setLink('u2', 'p1', 'site_A')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    state.users[0].telegramId = null;
    await expect(svc.setLink('u1', 'p1', 'site_A')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.setLink('u1', 'p1', '../x')).rejects.toThrow();
  });

  it('отвязка — без проверки, набор прежнего сайта переотправлен', async () => {
    const { state, sites, svc } = setup();
    state.drafts[0].clientSiteId = 'site_A';
    await svc.setLink('u1', 'p1', null);
    expect(state.drafts[0].clientSiteId).toBeNull();
    expect(sites.calls).toEqual([
      ['syncSiteVideos', ['site_A', [], expect.any(Number)]],
    ]);
  });
});

describe('набор роликов сайта', () => {
  const asset = (over: Row): Row => ({
    id: 'a1',
    clientSiteDraftId: 'd1',
    assemblyStatus: 'complete',
    blobUrl: 'https://s.public.blob.vercel-storage.com/a1.mp4',
    title: 'shop.example.com',
    locale: 'ru',
    durationMs: 9000,
    createdAt: 1,
    ...over,
  });

  it('только одобренные оператором и собранные; один (последний) ролик на черновик; хозяин — его Telegram', async () => {
    const { svc } = setup({
      drafts: [
        publicDraft({ clientSiteId: 'S' }),
        publicDraft({
          id: 'd2',
          projectId: 'p2',
          clientSiteId: 'S',
          status: 'PENDING_REVIEW',
        }),
        publicDraft({ id: 'd3', clientSiteId: 'OTHER' }),
        publicDraft({
          id: 'd4',
          projectId: 'p2',
          clientSiteId: 'S',
          // Креды стёр крон — липкий признак входа остался.
          loginUsedAt: new Date('2027-01-19T10:00:00Z'),
          title: 'За логином',
        }),
      ],
      assets: [
        asset({ id: 'old', createdAt: 1 }),
        asset({ id: 'new', createdAt: 5 }),
        asset({ id: 'pending', assemblyStatus: 'pending', createdAt: 9 }),
        asset({ id: 'noblob', blobUrl: null, createdAt: 9 }),
        asset({ id: 'd2a', clientSiteDraftId: 'd2' }),
        asset({ id: 'd3a', clientSiteDraftId: 'd3' }),
        asset({ id: 'd4a', clientSiteDraftId: 'd4' }),
      ],
    });
    const out = await svc.collectVideos('S');
    expect(
      out.map((v) => [v.externalId, v.ownerTelegramId, v.requiresLogin]),
    ).toEqual([
      ['new', '1001', false],
      ['d4a', '1002', true],
    ]);
    expect(out[0]).toMatchObject({
      title: 'Как купить',
      stepHosts: ['shop.example.com'],
      url: 'https://s.public.blob.vercel-storage.com/a1.mp4',
    });
  });

  it('набор держит бюджет тела ≤ 8 КБ sites-backend: длинные названия — старые ролики уходят, новые остаются', async () => {
    const n = 15;
    const longTitle = 'Як оформити замовлення з доставкою '
      .repeat(4)
      .slice(0, 120);
    const { svc } = setup({
      drafts: Array.from({ length: n }, (_, i) =>
        publicDraft({ id: `d${i}`, clientSiteId: 'S', title: longTitle }),
      ),
      assets: Array.from({ length: n }, (_, i) =>
        asset({
          id: `asset-${i}`,
          clientSiteDraftId: `d${i}`,
          createdAt: i,
          blobUrl: `https://abcdefgh12345678.public.blob.vercel-storage.com/tutorial-videos/client-site/cm1abcdefghijklmnopqrst${i}-AbCdEfGhIjKlMnOpQrStUvWxYz0123.mp4`,
        }),
      ),
    });
    const out = await svc.collectVideos('S');
    expect(
      Buffer.byteLength(
        JSON.stringify({ siteId: 'S', asOf: Date.now(), videos: out }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(SYNC_BODY_BUDGET);
    expect(SYNC_BODY_BUDGET).toBeLessThan(8 * 1024);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(n);
    // Отсечены самые старые: первым остаётся самый новый.
    expect(out[0].externalId).toBe(`asset-${n - 1}`);
  });

  it('аудит Э6 (гонка): отметка набора asOf берётся ДО чтения базы и уходит в тело', async () => {
    const { state, sites, svc } = setup();
    const order: string[] = [];
    let clock = 1_790_000_000_000;
    svc.now = () => {
      order.push('asOf');
      return ++clock;
    };
    const prisma = (svc as unknown as { prisma: Record<string, Row> }).prisma;
    const drafts = prisma.clientSiteTutorialDraft as {
      findMany: (a: unknown) => Promise<unknown>;
    };
    const findMany = drafts.findMany;
    drafts.findMany = (a: unknown) => {
      order.push('read');
      return findMany(a);
    };
    state.drafts[0].clientSiteId = 'S';
    await svc.syncSite('S');
    await svc.syncSite('S');
    expect(order).toEqual(['asOf', 'read', 'asOf', 'read']);
    expect(sites.calls.map((c) => c[1][2])).toEqual([
      1_790_000_000_001, 1_790_000_000_002,
    ]);
  });

  it('устаревший набор (stale) — не ошибка', async () => {
    const { sites, svc } = setup();
    sites.syncSiteVideos = async () => ({
      siteId: 'S',
      accepted: 0,
      removed: 0,
      rejected: [],
      stale: true,
    });
    await expect(svc.syncSite('S')).resolves.toBe(true);
  });

  it('сбой отправки не бросает (визард и сборка не падают)', async () => {
    const { sites, svc } = setup();
    sites.syncError = new SitesUnavailableError('down');
    await expect(svc.syncSite('S')).resolves.toBe(false);
  });
});

describe('карта интерфейса из раунда', () => {
  const exploration = {
    currentUrl: 'https://shop.example.com/cart',
    elements: [
      { selector: '#buy', tag: 'button', visibleText: 'Купить' },
      { selector: '#pwd', tag: 'input', type: 'password', label: 'Пароль' },
      { selector: '#q', tag: 'input', label: 'Поиск' },
    ],
  };

  it('привязанный черновик без входа — элементы уходят (без поля пароля)', async () => {
    const { state, sites, svc } = setup();
    state.drafts[0].clientSiteId = 'S';
    await svc.afterRound('u1', 'p1', exploration);
    expect(sites.calls).toEqual([
      [
        'pushUiMap',
        [
          '1001',
          'S',
          'https://shop.example.com/cart',
          [
            { selector: '#buy', tag: 'button', label: 'Купить' },
            { selector: '#q', tag: 'input', label: 'Поиск' },
          ],
        ],
      ],
    ]);
  });

  it('черновик в хранилище Ш2 (куки в личной записи, secretsUsedAt) без входа — карта уходит', async () => {
    const { sites, svc } = setup({
      drafts: [
        publicDraft({
          clientSiteId: 'S',
          cookiesEnc: null,
          userSiteSessionId: 'user-1',
        }),
      ],
    });
    await svc.afterRound('u1', 'p1', exploration);
    expect(sites.calls.map((c) => c[0])).toEqual(['pushUiMap']);
  });

  it.each([
    ['липкий признак входа', { loginUsedAt: new Date() }],
    ['поля входа в хранилище', { storeHasCredentials: true }],
    ['живой вход', { requiresLiveLoginReplay: true }],
    [
      'секретное поле /login в шагах',
      {
        steps: [
          { kind: 'goto', route: 'https://shop.example.com/' },
          { kind: 'fill', selector: '#email', value: '' },
        ],
      },
    ],
  ])('после входа (%s) — карта не уходит', async (_n, over) => {
    const { sites, svc } = setup({
      drafts: [publicDraft({ clientSiteId: 'S', ...over })],
    });
    await svc.afterRound('u1', 'p1', exploration);
    expect(sites.calls).toEqual([]);
  });

  it('не привязан, за логином или sites-backend не настроен — ничего не уходит', async () => {
    const a = setup();
    await a.svc.afterRound('u1', 'p1', exploration);
    const b = setup({
      drafts: [publicDraft({ clientSiteId: 'S', credentialsEnc: 'c' })],
    });
    await b.svc.afterRound('u1', 'p1', exploration);
    const c = setup({ drafts: [publicDraft({ clientSiteId: 'S' })] });
    c.sites.configuredFlag = false;
    await c.svc.afterRound('u1', 'p1', exploration);
    expect([...a.sites.calls, ...b.sites.calls, ...c.sites.calls]).toEqual([]);
  });

  it('аудит Э6: тело ui-map целиком (кириллица, длинный адрес) — в бюджете байт, лишние элементы с конца отсечены', async () => {
    const url = `https://shop.example.com/${'каталог/'.repeat(1)}?q=${'x'.repeat(1900)}`;
    const elements = Array.from({ length: 60 }, (_, i) => ({
      selector: `#кнопка-${i}-${'ж'.repeat(60)}`,
      tag: 'button',
      label: 'Оформить заказ с доставкой по Україні '.repeat(3),
    }));
    const mapped = mapElements(elements);
    const fitted = fitUiMapBody(
      { telegramId: '1001', siteId: 'S', url },
      mapped,
    );
    const body = { telegramId: '1001', siteId: 'S', url, elements: fitted };
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(
      UI_MAP_BODY_BUDGET,
    );
    expect(UI_MAP_BODY_BUDGET).toBeLessThan(8 * 1024);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(mapped.length);
    expect(fitted).toEqual(mapped.slice(0, fitted.length));

    // И через afterRound: то, что уходит в sites-backend, — в бюджете.
    const { sites, svc } = setup({
      drafts: [publicDraft({ clientSiteId: 'S' })],
    });
    await svc.afterRound('u1', 'p1', { currentUrl: url, elements });
    const [telegramId, siteId, sentUrl, sent] = sites.calls[0][1] as [
      string,
      string,
      string,
      unknown[],
    ];
    expect(
      Buffer.byteLength(
        JSON.stringify({ telegramId, siteId, url: sentUrl, elements: sent }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(UI_MAP_BODY_BUDGET);
  });

  it('mapElements держит бюджет тела ≤ 8 КБ', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      selector: `#button-${i}-${'x'.repeat(150)}`,
      tag: 'button',
      label: 'Подпись кнопки '.repeat(6),
    }));
    const out = mapElements(many);
    expect(out.length).toBeGreaterThan(0);
    // Байты UTF-8, а не символы: кириллица — 2 байта (аудит Э6).
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(
      UI_MAP_BODY_BUDGET,
    );
  });
});
