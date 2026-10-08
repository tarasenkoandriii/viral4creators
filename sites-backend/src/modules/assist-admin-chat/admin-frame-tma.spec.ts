/* eslint-disable @typescript-eslint/no-explicit-any -- двойники сервисов */
/**
 * Э-С Ш6: «админка» — Telegram Mini App (TMA генератора viral4creators).
 * В Telegram Web мини-апп сам в iframe, а `frame-ancestors` проверяется по
 * всем предкам — окну сотрудника нужен и origin Telegram Web. Только сайтам
 * из `ASSIST_ADMIN_TMA_SITE_IDS` и только вместе с их verified-хостами.
 */
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import {
  TELEGRAM_WEB_ORIGINS,
  adminTmaSiteIds,
  extraAdminAncestors,
} from '../../config/admin-env';
import { AdminFrameController } from './admin-frame.controller';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  ADMIN_FRAME_CACHE_SECONDS,
  adminFrameCacheControl,
  adminFrameCsp,
} from './admin-frame';

const NOW = new Date('2026-10-05T12:00:00Z');
const verified = (host: string) => ({
  id: `h-${host}`,
  host,
  status: 'verified',
  expiresAt: new Date('2027-01-01T00:00:00Z'),
  revokedAt: null,
  reverifyBlockedAt: null,
});

function controller(siteId: string, hosts: any[], adminHostIds: string[]) {
  const sessions = {
    siteByPk: jest.fn(async () => ({
      siteId,
      accountId: 'acc1',
      settings: {
        adminModeEnabled: true,
        adminAccess: 'script',
        adminHostIds,
      },
    })),
  };
  const db = {
    forAccount: () => ({ siteHost: { findMany: jest.fn(async () => hosts) } }),
  };
  return new AdminFrameController(sessions as any, db as any);
}

describe('Ш6 — frame-ancestors «Админки» для TMA в Telegram Web', () => {
  const prev = process.env.ASSIST_ADMIN_TMA_SITE_IDS;
  afterEach(() => {
    if (prev === undefined) delete process.env.ASSIST_ADMIN_TMA_SITE_IDS;
    else process.env.ASSIST_ADMIN_TMA_SITE_IDS = prev;
  });

  it('список сайтов: мусор отбрасывается', () => {
    expect([
      ...adminTmaSiteIds({ ASSIST_ADMIN_TMA_SITE_IDS: ' s1 ,bad id, s_2;x,' }),
    ]).toEqual(['s1']);
    expect(adminTmaSiteIds({}).size).toBe(0);
  });

  it('без своих хостов Telegram Web не добавляется (остаётся none)', () => {
    expect(
      extraAdminAncestors('s1', [], { ASSIST_ADMIN_TMA_SITE_IDS: 's1' }),
    ).toEqual([]);
  });

  it('сайт из списка: verified-хост TMA + Telegram Web', async () => {
    process.env.ASSIST_ADMIN_TMA_SITE_IDS = 'site_v4c';
    const c = controller('site_v4c', [verified('app.v4c.example.com')], ['h']);
    const out = await c.ancestorsFor(`${WIDGET_PK_LIVE_PREFIX}v4c`, NOW);
    expect(out).toEqual([
      'https://app.v4c.example.com',
      ...TELEGRAM_WEB_ORIGINS,
    ]);
    expect(adminFrameCsp(out)).toContain(
      'frame-ancestors https://app.v4c.example.com https://web.telegram.org;',
    );
  });

  it('сайт НЕ из списка — как раньше, только свои хосты', async () => {
    process.env.ASSIST_ADMIN_TMA_SITE_IDS = 'site_v4c';
    const c = controller('site_other', [verified('admin.shop.example')], ['h']);
    expect(await c.ancestorsFor(`${WIDGET_PK_LIVE_PREFIX}shop`, NOW)).toEqual([
      'https://admin.shop.example',
    ]);
  });

  it('хост не подтверждён — ни хоста, ни Telegram Web', async () => {
    process.env.ASSIST_ADMIN_TMA_SITE_IDS = 'site_v4c';
    const c = controller(
      'site_v4c',
      [{ ...verified('app.v4c.example.com'), status: 'pending' }],
      ['h'],
    );
    expect(await c.ancestorsFor(`${WIDGET_PK_LIVE_PREFIX}v4c`, NOW)).toEqual(
      [],
    );
  });
});

describe('аудит Э7 (б), Р-З9-16 — кэш CDN iframe «Админки» — своя минута', () => {
  it('Cache-Control `wa.` — s-maxage=60, не 300 виджета «Сайта»', async () => {
    const headers: Record<string, string> = {};
    const res = {
      status: jest.fn(),
      removeHeader: jest.fn(),
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      end: jest.fn(),
    };
    const c = controller('s1', [verified('admin.shop.example')], ['h']);
    await c.frame(`${WIDGET_PK_LIVE_PREFIX}shop`, res as any);
    expect(ADMIN_FRAME_CACHE_SECONDS).toBe(60);
    expect(headers['cache-control']).toBe('public, max-age=0, s-maxage=60');
    expect(adminFrameCacheControl()).toBe(headers['cache-control']);
    // Общая константа виджета «Сайта» не тронута.
    expect(WIDGET_DEFAULTS.frameCacheSeconds).toBe(300);
    expect(headers['content-security-policy']).toContain(
      'frame-ancestors https://admin.shop.example;',
    );
  });
});
