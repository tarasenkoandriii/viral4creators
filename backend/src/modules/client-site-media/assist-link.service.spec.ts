/**
 * W7 (L6445): привязка существующего черновика к сайту помощника из
 * визарда — контракт `GET/POST assist-link`: только свои сайты (кандидаты
 * sites-backend по хосту черновика), сайт лендинга — никогда, отказ — 409
 * `ASSIST_LINK_UNAVAILABLE`, чужой проект — 404, после привязки — набор.
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SitesRejectedError,
  SitesUnavailableError,
} from '../sites-internal/sites-internal.client';
import {
  ASSIST_LINK_UNAVAILABLE,
  AssistLinkService,
  draftHost,
} from './assist-link.service';

type Row = Record<string, unknown>;

const SHOP = { siteId: 'site_A', name: 'Магазин', hosts: ['shop.example.com'] };
const OTHER = {
  siteId: 'site_B',
  name: 'Витрина',
  hosts: ['shop.example.com'],
};

function setup(
  over: {
    draft?: Row | null;
    telegramId?: string | null;
    configured?: boolean;
    candidates?: Array<typeof SHOP>;
    candidatesError?: Error;
    landing?: string;
  } = {},
) {
  const draft =
    over.draft === undefined
      ? {
          id: 'd1',
          projectId: 'p1',
          clientSiteId: null as string | null,
          baseUrl: 'https://Shop.Example.com/catalog',
        }
      : over.draft;
  const projects = [
    { id: 'p1', userId: 'u1', type: 'CLIENT_SITE', deletedAt: null },
    { id: 'p9', userId: 'u1', type: 'PRODUCT', deletedAt: null },
  ];
  const prisma = {
    project: {
      findFirst: jest.fn(
        async ({ where }: { where: Row }) =>
          projects.find(
            (p) =>
              p.id === where.id &&
              p.userId === where.userId &&
              p.deletedAt === null,
          ) ?? null,
      ),
    },
    user: {
      findUnique: jest.fn(async () => ({
        telegramId: over.telegramId === undefined ? '1001' : over.telegramId,
      })),
    },
    clientSiteTutorialDraft: {
      findUnique: jest.fn(async () => (draft ? { ...draft } : null)),
      update: jest.fn(async ({ data }: { data: Row }) => {
        Object.assign(draft as Row, data);
        return draft;
      }),
    },
  };
  const sites = {
    configured: jest.fn(() => over.configured ?? true),
    siteCandidates: jest.fn(async () => {
      if (over.candidatesError) throw over.candidatesError;
      return { sites: over.candidates ?? [SHOP, OTHER] };
    }),
    linkSite: jest.fn(async (_tg: string, siteId: string) => ({
      siteId,
      siteName: 'Сайт по deep-link',
      hosts: ['other.example.com'],
    })),
  };
  const media = { syncSite: jest.fn(async () => true) };
  const svc = new AssistLinkService(
    prisma as never,
    sites as never,
    media as never,
  );
  svc.env = over.landing ? { ASSIST_LANDING_SITE_ID: over.landing } : {};
  return { svc, prisma, sites, media, draft };
}

const code = (e: unknown) =>
  (e as ConflictException).getResponse() as { code?: string };

describe('GET assist-link (W7)', () => {
  it('не привязан — кандидаты по хосту черновика (нижним регистром), можно привязать', async () => {
    const { svc, sites } = setup();
    await expect(svc.get('u1', 'p1')).resolves.toEqual({
      linked: false,
      siteId: null,
      siteName: null,
      canLink: true,
      candidates: [
        { siteId: 'site_A', name: 'Магазин' },
        { siteId: 'site_B', name: 'Витрина' },
      ],
    });
    expect(sites.siteCandidates).toHaveBeenCalledWith(
      '1001',
      'shop.example.com',
    );
  });

  it('привязан — имя из кандидатов; привязан мимо хоста (deep-link) — имя из site-link', async () => {
    const a = setup({
      draft: {
        id: 'd1',
        clientSiteId: 'site_B',
        baseUrl: 'https://shop.example.com',
      },
    });
    await expect(a.svc.get('u1', 'p1')).resolves.toMatchObject({
      linked: true,
      siteId: 'site_B',
      siteName: 'Витрина',
    });
    expect(a.sites.linkSite).not.toHaveBeenCalled();

    const b = setup({
      draft: {
        id: 'd1',
        clientSiteId: 'site_Z',
        baseUrl: 'https://shop.example.com',
      },
    });
    await expect(b.svc.get('u1', 'p1')).resolves.toMatchObject({
      linked: true,
      siteId: 'site_Z',
      siteName: 'Сайт по deep-link',
    });
  });

  it('сайт лендинга в кандидаты не попадает', async () => {
    const { svc } = setup({ landing: 'site_A' });
    const view = await svc.get('u1', 'p1');
    expect(view.candidates.map((c) => c.siteId)).toEqual(['site_B']);
  });

  it('кабинет не подключён / не ответил / нет Telegram / нет черновика — без кандидатов, без ошибки', async () => {
    for (const s of [
      setup({ configured: false }),
      setup({ candidatesError: new SitesUnavailableError('down') }),
      setup({ telegramId: null }),
      setup({ draft: null }),
    ]) {
      await expect(s.svc.get('u1', 'p1')).resolves.toMatchObject({
        canLink: false,
        candidates: [],
      });
    }
  });

  it('чужой проект и проект не того типа — 404', async () => {
    const { svc } = setup();
    await expect(svc.get('u2', 'p1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get('u1', 'p9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('POST assist-link (W7)', () => {
  it('сайт из кандидатов — привязан, набор сайта отправлен', async () => {
    const { svc, media, draft } = setup();
    await expect(svc.set('u1', 'p1', 'site_A')).resolves.toEqual({
      linked: true,
      siteId: 'site_A',
      siteName: 'Магазин',
      canLink: true,
      candidates: [
        { siteId: 'site_A', name: 'Магазин' },
        { siteId: 'site_B', name: 'Витрина' },
      ],
    });
    expect(draft!.clientSiteId).toBe('site_A');
    expect(media.syncSite).toHaveBeenCalledWith('site_A');
  });

  it('перепривязка — набор и старого, и нового сайта', async () => {
    const { svc, media } = setup({
      draft: {
        id: 'd1',
        clientSiteId: 'site_B',
        baseUrl: 'https://shop.example.com',
      },
    });
    await svc.set('u1', 'p1', 'site_A');
    expect(media.syncSite.mock.calls).toEqual([['site_B'], ['site_A']]);
  });

  it('сайта нет среди кандидатов (чужой, хост не подтверждён) — 409, черновик не тронут', async () => {
    const { svc, prisma, media } = setup({ candidates: [OTHER] });
    const e = await svc.set('u1', 'p1', 'site_A').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(code(e).code).toBe(ASSIST_LINK_UNAVAILABLE);
    expect(prisma.clientSiteTutorialDraft.update).not.toHaveBeenCalled();
    expect(media.syncSite).not.toHaveBeenCalled();
  });

  it.each([
    ['кабинет не подключён', { configured: false }],
    ['нет Telegram', { telegramId: null }],
    [
      'у черновика нет адреса',
      { draft: { id: 'd1', clientSiteId: null, baseUrl: '' } },
    ],
    ['черновик не начат', { draft: null }],
    [
      'старый sites-backend без маршрута (404)',
      {
        candidatesError: new SitesRejectedError(404, 'NOT_FOUND', 'нет'),
      },
    ],
    ['сайт лендинга', { landing: 'site_A' }],
  ])('%s — 409 ASSIST_LINK_UNAVAILABLE', async (_n, over) => {
    const { svc, prisma } = setup(over as never);
    const e = await svc.set('u1', 'p1', 'site_A').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(code(e).code).toBe(ASSIST_LINK_UNAVAILABLE);
    expect(prisma.clientSiteTutorialDraft.update).not.toHaveBeenCalled();
  });

  it('сайт лендинга — отказ без вопроса sites-backend', async () => {
    const { svc, sites } = setup({ landing: 'site_A' });
    await svc.set('u1', 'p1', 'site_A').catch(() => undefined);
    expect(sites.siteCandidates).not.toHaveBeenCalled();
  });

  it('кабинет не ответил — 503 (временное), черновик не тронут', async () => {
    const { svc, prisma } = setup({
      candidatesError: new SitesUnavailableError('down'),
    });
    await expect(svc.set('u1', 'p1', 'site_A')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.clientSiteTutorialDraft.update).not.toHaveBeenCalled();
  });

  it('null — отвязать: набор прежнего сайта уходит', async () => {
    const { svc, media, draft } = setup({
      draft: {
        id: 'd1',
        clientSiteId: 'site_A',
        baseUrl: 'https://shop.example.com',
      },
    });
    await expect(svc.set('u1', 'p1', null)).resolves.toMatchObject({
      linked: false,
      siteId: null,
      canLink: true,
    });
    expect(draft!.clientSiteId).toBeNull();
    expect(media.syncSite).toHaveBeenCalledWith('site_A');
  });

  it('чужой проект — 404', async () => {
    const { svc } = setup();
    await expect(svc.set('u2', 'p1', 'site_A')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('draftHost', () => {
  it('только http(s) с точкой в имени, нижним регистром', () => {
    expect(draftHost('https://Shop.Example.com./x')).toBe('shop.example.com');
    expect(draftHost('http://localhost:3000/')).toBeNull();
    expect(draftHost('ftp://shop.example.com/')).toBeNull();
    expect(draftHost('не адрес')).toBeNull();
    expect(draftHost(null)).toBeNull();
  });
});
