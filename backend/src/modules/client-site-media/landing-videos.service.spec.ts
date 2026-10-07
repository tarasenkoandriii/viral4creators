/**
 * Э-С Ш5: ролики штатной обучалки → сайт тенанта лендинга. Барьер
 * лендинга (тот же, что у консультанта): только `reviewed`, собранные и
 * НЕ ролики обучалки по сайту заказчика (`clientSiteDraftId: null`) — в
 * запросе и повторно в коде. Порядок по языкам лендинга, последний ролик
 * на (тема, язык), потолки платформы (15 и 8 КБ), сбой не бросает.
 */
import { landingAssistConfig } from './landing-assist-config';
import {
  LANDING_SYNC_BODY_BUDGET,
  LANDING_SYNC_VIDEOS_MAX,
  LandingVideosService,
} from './landing-videos.service';

type Row = Record<string, unknown>;

const ENV = {
  ASSIST_LANDING_SITE_ID: 'site_landing',
  ASSIST_LANDING_OWNER_TELEGRAM_ID: '1001',
  LANDING_PUBLIC_URL: 'https://viral4creators.example/ru',
};

function asset(over: Row): Row {
  return {
    id: 'a',
    subjectKey: '1',
    locale: 'ru',
    title: 'Шаг',
    durationMs: 30_000,
    blobUrl: 'https://blob.example/a.mp4',
    clientSiteDraftId: null,
    reviewed: true,
    createdAt: 1,
    ...over,
  };
}

function setup(assets: Row[], opts: { ignoreWhere?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const prisma = {
    tutorialVideoAsset: {
      findMany: async (args: { where: Row }) => {
        calls.push(args as unknown as Record<string, unknown>);
        const w = args.where;
        return assets
          .filter(
            (a) =>
              opts.ignoreWhere ||
              ((w.reviewed === undefined || a.reviewed === w.reviewed) &&
                (!('clientSiteDraftId' in w) ||
                  a.clientSiteDraftId === w.clientSiteDraftId) &&
                (!w.blobUrl || a.blobUrl !== null)),
          )
          .sort((x, y) => (y.createdAt as number) - (x.createdAt as number));
      },
    },
  };
  const sent: unknown[][] = [];
  const sites = {
    configuredFlag: true,
    fail: false,
    configured() {
      return this.configuredFlag;
    },
    async syncSiteVideos(...a: unknown[]) {
      sent.push(a);
      if (this.fail) throw new Error('down');
      return { siteId: a[0], accepted: 1, removed: 0, rejected: [] };
    },
  };
  const svc = new LandingVideosService(prisma as never, sites as never);
  svc.env = { ...ENV };
  svc.now = () => 1_790_000_000_000;
  return { svc, calls, sent, sites };
}

describe('landingAssistConfig', () => {
  it('нужны сайт, Telegram-id владельца и хост (по умолчанию — LANDING_PUBLIC_URL)', () => {
    expect(landingAssistConfig(ENV)).toEqual({
      siteId: 'site_landing',
      ownerTelegramId: '1001',
      hosts: ['viral4creators.example'],
    });
    expect(
      landingAssistConfig({
        ...ENV,
        ASSIST_LANDING_HOSTS: 'a.example, B.example,bad host',
      }),
    ).toMatchObject({ hosts: ['a.example', 'b.example'] });
    expect(
      landingAssistConfig({ ...ENV, ASSIST_LANDING_SITE_ID: '../x' }),
    ).toBeNull();
    expect(
      landingAssistConfig({ ...ENV, ASSIST_LANDING_OWNER_TELEGRAM_ID: 'abc' }),
    ).toBeNull();
    expect(
      landingAssistConfig({
        ...ENV,
        LANDING_PUBLIC_URL: 'http://viral4creators.example',
      }),
    ).toBeNull();
  });
});

describe('LandingVideosService — барьер лендинга', () => {
  it('запрос: reviewed, собран, clientSiteDraftId: null', async () => {
    const { svc, calls } = setup([]);
    await svc.collect('1001', ['viral4creators.example']);
    expect(calls[0].where).toEqual({
      reviewed: true,
      blobUrl: { not: null },
      clientSiteDraftId: null,
      // Лендинг светлый: тёмные ролики пары (заход 3) в набор не идут.
      OR: [{ theme: null }, { theme: 'light' }],
      // Демо обучающего лендинга (витрина-полигон) — не в набор тенанта.
      NOT: { subjectKey: { startsWith: 'site-tutorial-demo-' } },
    });
  });

  it('ролики демо обучающего лендинга не уходят в набор — даже если база их вернула', async () => {
    const { svc } = setup(
      [
        asset({ id: 'ok', subjectKey: '1' }),
        asset({ id: 'demo', subjectKey: 'site-tutorial-demo-1' }),
        asset({ id: 'demo-x', subjectKey: 'site-tutorial-demo-99' }),
      ],
      { ignoreWhere: true },
    );
    const out = await svc.collect('1001', ['viral4creators.example']);
    expect(out.map((v) => v.externalId)).toEqual(['ok']);
  });

  it('ролик по сайту заказчика, неодобренный и несобранный не уходят — даже если база их вернула', async () => {
    const { svc } = setup(
      [
        asset({ id: 'ok', subjectKey: '1' }),
        asset({
          id: 'client',
          subjectKey: '2',
          clientSiteDraftId: 'd1',
          title: 'https://shop.example',
        }),
        asset({ id: 'unreviewed', subjectKey: '3', reviewed: false }),
        asset({ id: 'nofile', subjectKey: '4', blobUrl: null }),
      ],
      { ignoreWhere: true },
    );
    const out = await svc.collect('1001', ['viral4creators.example']);
    expect(out.map((v) => v.externalId)).toEqual(['ok']);
    expect(out[0]).toEqual({
      externalId: 'ok',
      draftId: 'landing',
      ownerTelegramId: '1001',
      title: 'Шаг',
      locale: 'ru',
      durationMs: 30_000,
      url: 'https://blob.example/a.mp4',
      requiresLogin: false,
      stepHosts: ['viral4creators.example'],
    });
  });

  it('последний на (тема, язык); порядок ru, uk, en, de, es и по номеру шага; потолок 15', async () => {
    const rows: Row[] = [];
    let t = 1;
    for (const locale of ['es', 'de', 'en', 'uk', 'ru']) {
      for (let s = 10; s >= 1; s--) {
        rows.push(
          asset({
            id: `${locale}-${s}-old`,
            subjectKey: String(s),
            locale,
            createdAt: t++,
          }),
        );
        rows.push(
          asset({
            id: `${locale}-${s}`,
            subjectKey: String(s),
            locale,
            title: `${s}`,
            createdAt: t++ + 1000,
          }),
        );
      }
    }
    const { svc } = setup(rows);
    const out = await svc.collect('1001', ['viral4creators.example']);
    expect(out).toHaveLength(LANDING_SYNC_VIDEOS_MAX);
    expect(out.slice(0, 11).map((v) => v.externalId)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `ru-${i + 1}`),
      'uk-1',
    ]);
    expect(out.some((v) => v.externalId.endsWith('-old'))).toBe(false);
  });

  it('бюджет тела 8 КБ', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      asset({
        id: `v${i}`,
        subjectKey: String(i + 1),
        title: 'Очень длинное название ролика '.repeat(5),
        blobUrl: `https://blob.example/${'x'.repeat(400)}-${i}.mp4`,
      }),
    );
    const { svc } = setup(rows);
    const out = await svc.collect('1001', ['viral4creators.example']);
    expect(out.length).toBeLessThan(15);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          siteId: 'site_landing',
          asOf: 1_790_000_000_000,
          videos: out,
        }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(LANDING_SYNC_BODY_BUDGET);
  });

  it('sync: полный набор на сайт лендинга; не настроено или сбой — false без исключения', async () => {
    const { svc, sent, sites } = setup([asset({ id: 'ok' })]);
    await expect(svc.sync()).resolves.toBe(true);
    expect(sent[0][0]).toBe('site_landing');
    expect((sent[0][1] as Row[]).map((v) => v.externalId)).toEqual(['ok']);
    expect(sent[0][2]).toBe(1_790_000_000_000);
    sites.fail = true;
    await expect(svc.sync()).resolves.toBe(false);
    sites.fail = false;
    svc.env = {};
    await expect(svc.sync()).resolves.toBe(false);
    svc.env = { ...ENV };
    sites.configuredFlag = false;
    await expect(svc.sync()).resolves.toBe(false);
    expect(sent).toHaveLength(2);
  });

  describe('Ш5 (12): requestSync — пересылка после подметания (дебаунс, best-effort)', () => {
    it('серия поводов в окне — одна пересылка; набор читается заново (без удалённого)', async () => {
      const assets = [asset({ id: 'a1' }), asset({ id: 'a2', locale: 'uk' })];
      const { svc, sent } = setup(assets);
      svc.debounceMs = 20;
      const p1 = svc.requestSync();
      // Подметальщик стёр a2 уже после первого повода — в набор он не идёт.
      assets.splice(1, 1);
      const p2 = svc.requestSync();
      const p3 = svc.requestSync();
      await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
        true,
        true,
        true,
      ]);
      // p2/p3 пришли в окне дебаунса — склеены в ту же пересылку.
      expect(sent).toHaveLength(1);
      expect(
        (sent[sent.length - 1][1] as Row[]).map((v) => v.externalId),
      ).toEqual(['a1']);
    });

    it('повод посреди идущей пересылки — ещё ровно одна следом, не больше', async () => {
      const { svc, sent, sites } = setup([asset({ id: 'a1' })]);
      svc.debounceMs = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const orig = sites.syncSiteVideos.bind(sites);
      let first = true;
      sites.syncSiteVideos = async (...a: unknown[]) => {
        if (first) {
          first = false;
          await gate;
        }
        return orig(...a);
      };
      const p1 = svc.requestSync();
      await new Promise((r) => setTimeout(r, 5));
      const p2 = svc.requestSync();
      const p3 = svc.requestSync();
      release();
      await Promise.all([p1, p2, p3]);
      expect(sent).toHaveLength(2);
      // Окно закрылось — новый повод снова шлёт.
      await svc.requestSync();
      expect(sent).toHaveLength(3);
    });

    it('сбой sites-backend или базы — false, без исключения; не настроено — без сети', async () => {
      const { svc, sites, sent } = setup([asset({ id: 'a1' })]);
      svc.debounceMs = 0;
      sites.fail = true;
      await expect(svc.requestSync()).resolves.toBe(false);
      sites.fail = false;
      const broken = setup([]);
      broken.svc.debounceMs = 0;
      (
        broken.svc as unknown as {
          prisma: { tutorialVideoAsset: { findMany: () => never } };
        }
      ).prisma.tutorialVideoAsset.findMany = () => {
        throw new Error('db');
      };
      await expect(broken.svc.requestSync()).resolves.toBe(false);
      expect(broken.sent).toHaveLength(0);
      // Сбой ДО сети (проверка настройки клиента) — тоже false, не throw.
      sites.configured = () => {
        throw new Error('cfg');
      };
      await expect(svc.requestSync()).resolves.toBe(false);
      svc.env = {};
      await expect(svc.requestSync()).resolves.toBe(false);
      expect(sent).toHaveLength(1);
    });
  });
});
