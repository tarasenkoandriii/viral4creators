/**
 * Сессия посетителя и указатель resumeKey — W2 (ТЗ §4-бис.3, §4-бис.10
 * п.6 и п.9 серверная часть; §3-бис.4 предпросмотр), по HTTP на настоящем
 * Postgres под ролью assist_public:
 *  - «через день»: указатель (тело или CHIPS-cookie) → тот же visitorId,
 *    скользящие 30 дней; переход example.com → shop.example.com (оба хоста
 *    сайта) — тот же посетитель; хост ДРУГОГО сайта того же eTLD+1 — нет;
 *  - потеря указателя — новый посетитель и resumeLost (метрика);
 *  - при расхождении побеждает cookie; Set-Cookie — CHIPS `__Host-`;
 *  - cookie указателя не делает сессии другим маршрутам (п.9);
 *  - лимит выдачи сессий 5/мин на ipHash сайта;
 *  - предпросмотр: одноразовый обмен токена, привязка к origin, сессия
 *    предпросмотра допускает предка конфигуратора TMA.
 */
import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import {
  WIDGET_RESUME_COOKIE,
  WIDGET_VISITOR_TOKEN_HEADER,
  widgetResumeCookieName,
} from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { sha256Hex } from '../../modules/assist-widget/site-access';
import {
  DAY,
  TEST_SECRETS_KEY,
  TMA_ORIGIN,
  W_ORIGIN,
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';
import { verifyVisitorToken } from '../../modules/assist-widget/visitor-token';
import { widgetTokenKey } from '../../config/widget-env';

function setClock(at: Date): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    now: at,
  });
}

/** Свой адрес (IPv6 /64) у каждого вызова: окна лимитов в базе живут между прогонами. */
function freshIp(): string {
  return `${randomV6Prefix()}::1`;
}

describeDb(
  'Сессия посетителя и resumeKey (W2: §4-бис.3, §4-бис.10 п.6, п.9)',
  () => {
    let stack: WidgetStack;
    const srv = () => stack.app.getHttpServer();

    beforeAll(async () => {
      if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
      stack = await startWidgetStack();
    });
    afterAll(async () => {
      jest.useRealTimers();
      await stack?.close();
    });
    afterEach(() => jest.useRealTimers());

    function session(
      body: Record<string, unknown>,
      opts: { cookie?: string; ip?: string } = {},
    ) {
      const r = request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .set('X-Forwarded-For', opts.ip ?? freshIp());
      if (opts.cookie) r.set('Cookie', opts.cookie);
      return r.send(body);
    }
    function tokenOf(r: request.Response) {
      const t = verifyVisitorToken(
        r.body.data.visitorToken,
        widgetTokenKey() as Buffer,
        new Date(),
      );
      if (!t) throw new Error('токен не разобрался');
      return t;
    }
    function cookieOf(r: request.Response, pk?: string): string | null {
      const raw = r.headers['set-cookie'] as unknown as string[] | undefined;
      const c = raw?.find((s) =>
        pk
          ? s.startsWith(`${widgetResumeCookieName(pk)}=`)
          : s.startsWith(`${WIDGET_RESUME_COOKIE}_`),
      );
      return c ?? null;
    }
    /** Заголовок Cookie браузера из Set-Cookie ответа (имя=значение). */
    function jar(...rs: request.Response[]): string {
      return rs
        .map((r) => (cookieOf(r) ?? '').split(';')[0])
        .filter(Boolean)
        .join('; ');
    }

    it('новый посетитель: ключ 32 байта один раз в теле + CHIPS-cookie, в базе — только хеш', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const r = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const key: string = r.body.data.resumeKey;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
      expect(r.body.data).toMatchObject({ resumed: false, resumeLost: false });
      const cookie = cookieOf(r);
      expect(cookie).toBe(
        `${widgetResumeCookieName(f.pk)}=${key}; Path=/; Max-Age=${WIDGET_DEFAULTS.resumeTtlMs / 1000}; Secure; HttpOnly; SameSite=None; Partitioned`,
      );
      const rows = await stack.prisma.assistSiteVisitorResume.findMany({
        where: { siteId: f.siteId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].keyHash).toBe(sha256Hex(key));
      expect(JSON.stringify(rows)).not.toContain(key);
      expect(rows[0].visitorId).toBe(tokenOf(r).visitorId);
    });

    it('«через день» (подмена часов): указатель возвращает того же посетителя и продлевает 30 дней', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const first = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const key = first.body.data.resumeKey as string;
      const firstVisitor = tokenOf(first).visitorId;
      const t1 = new Date(Date.now() + 1.5 * DAY);
      setClock(t1);
      const back = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
        resumeKey: key,
      }).expect(200);
      expect(back.body.data).toMatchObject({
        resumed: true,
        resumeLost: false,
        resumeKey: null,
      });
      expect(tokenOf(back).visitorId).toBe(firstVisitor);
      // Скользящий срок: cookie переустановлена тем же ключом, строка продлена.
      expect(cookieOf(back)).toContain(
        `${widgetResumeCookieName(f.pk)}=${key};`,
      );
      const row = await stack.prisma.assistSiteVisitorResume.findUniqueOrThrow({
        where: { keyHash: sha256Hex(key) },
      });
      expect(row.expiresAt.getTime()).toBe(
        t1.getTime() + WIDGET_DEFAULTS.resumeTtlMs,
      );
    });

    it('указатель старше 30 дней — новый посетитель, resumeLost', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const first = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const firstVisitor = tokenOf(first).visitorId;
      setClock(new Date(Date.now() + 31 * DAY));
      const back = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
        resumeKey: first.body.data.resumeKey,
      }).expect(200);
      expect(back.body.data).toMatchObject({
        resumed: false,
        resumeLost: true,
      });
      expect(back.body.data.resumeKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokenOf(back).visitorId).not.toBe(firstVisitor);
    });

    it('example.com → shop.example.com (оба — хосты сайта) — тот же посетитель; хост другого сайта того же eTLD+1 — нет', async () => {
      const apex = domain();
      const a = await widgetFixture(stack, [
        { host: apex },
        { host: `shop.${apex}` },
      ]);
      const b = await widgetFixture(stack, [{ host: `blog.${apex}` }]);
      const first = await session({
        pk: a.pk,
        parentOrigin: `https://${apex}`,
      }).expect(200);
      const key = first.body.data.resumeKey as string;

      const shop = await session({
        pk: a.pk,
        parentOrigin: `https://shop.${apex}`,
        resumeKey: key,
      }).expect(200);
      expect(shop.body.data.resumed).toBe(true);
      expect(tokenOf(shop).visitorId).toBe(tokenOf(first).visitorId);
      expect(tokenOf(shop).parentOrigin).toBe(`https://shop.${apex}`);

      const other = await session({
        pk: b.pk,
        parentOrigin: `https://blog.${apex}`,
        resumeKey: key,
      }).expect(200);
      expect(other.body.data).toMatchObject({
        resumed: false,
        resumeLost: true,
      });
      expect(tokenOf(other).visitorId).not.toBe(tokenOf(first).visitorId);
    });

    it('CHIPS: два сайта клиентов на одном eTLD+1 (одна секция cookie) — указатели не перезаписывают друг друга', async () => {
      const apex = domain();
      const a = await widgetFixture(stack, [{ host: `a.${apex}` }]);
      const b = await widgetFixture(stack, [{ host: `b.${apex}` }]);
      const sa = await session({
        pk: a.pk,
        parentOrigin: `https://a.${apex}`,
      }).expect(200);
      // Браузер в секции apex уже держит cookie сайта A и шлёт её же к B.
      const sb = await session(
        { pk: b.pk, parentOrigin: `https://b.${apex}` },
        { cookie: jar(sa) },
      ).expect(200);
      expect(sb.body.data).toMatchObject({ resumed: false, resumeLost: false });
      expect(cookieOf(sb, b.pk)).not.toBeNull();
      expect(cookieOf(sb, a.pk)).toBeNull(); // cookie A не тронута
      const both = jar(sa, sb);
      expect(both.split('; ')).toHaveLength(2);
      // Возврат на A и на B (без localStorage, только cookie): каждый — свой посетитель.
      const backA = await session(
        { pk: a.pk, parentOrigin: `https://a.${apex}` },
        { cookie: both },
      ).expect(200);
      const backB = await session(
        { pk: b.pk, parentOrigin: `https://b.${apex}` },
        { cookie: both },
      ).expect(200);
      expect(backA.body.data.resumed).toBe(true);
      expect(backB.body.data.resumed).toBe(true);
      expect(tokenOf(backA).visitorId).toBe(tokenOf(sa).visitorId);
      expect(tokenOf(backB).visitorId).toBe(tokenOf(sb).visitorId);
    });

    it('тот же host у ДРУГОГО кабинета (сайта) — указатель чужого сайта не восстанавливает', async () => {
      const d = domain();
      const a = await widgetFixture(stack, [{ host: d }]);
      const b = await widgetFixture(stack, [{ host: d }]);
      const first = await session({
        pk: a.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const r = await session({
        pk: b.pk,
        parentOrigin: `https://${d}`,
        resumeKey: first.body.data.resumeKey,
      }).expect(200);
      expect(r.body.data).toMatchObject({ resumed: false, resumeLost: true });
      expect(tokenOf(r).visitorId).not.toBe(tokenOf(first).visitorId);
    });

    it('указатель с хоста другого eTLD+1 того же сайта — не восстанавливается (разные секции браузера)', async () => {
      const d1 = domain();
      const d2 = domain();
      const f = await widgetFixture(stack, [{ host: d1 }, { host: d2 }]);
      const first = await session({
        pk: f.pk,
        parentOrigin: `https://${d1}`,
      }).expect(200);
      const r = await session({
        pk: f.pk,
        parentOrigin: `https://${d2}`,
        resumeKey: first.body.data.resumeKey,
      }).expect(200);
      expect(r.body.data).toMatchObject({ resumed: false, resumeLost: true });
    });

    it('при расхождении побеждает cookie (HttpOnly); мусор вместо ключа — resumeLost', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const a = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const b = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const r = await session(
        {
          pk: f.pk,
          parentOrigin: `https://${d}`,
          resumeKey: b.body.data.resumeKey,
        },
        {
          cookie: `other=1; ${widgetResumeCookieName(f.pk)}=${a.body.data.resumeKey as string}`,
        },
      ).expect(200);
      expect(r.body.data.resumed).toBe(true);
      expect(tokenOf(r).visitorId).toBe(tokenOf(a).visitorId);

      const junk = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
        resumeKey: 'not-a-key',
      }).expect(200);
      expect(junk.body.data).toMatchObject({
        resumed: false,
        resumeLost: true,
      });
    });

    it('п.9: cookie указателя не делает сессии — маршруты по токену без заголовка отвечают SESSION_REQUIRED', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const s = await session({
        pk: f.pk,
        parentOrigin: `https://${d}`,
      }).expect(200);
      const cookie = `${widgetResumeCookieName(f.pk)}=${s.body.data.resumeKey as string}`;
      for (const [method, path] of [
        ['get', '/widget/v1/state'],
        ['post', '/widget/v1/forget'],
        ['post', '/widget/v1/handoff'],
      ] as const) {
        const r = await request(srv())
          [method](path)
          .set('Origin', W_ORIGIN)
          .set('Cookie', cookie)
          .expect(401);
        expect(r.body.error.code).toBe('SESSION_REQUIRED');
      }
      // forget с cookie, но без токена, ничего не удалил.
      expect(
        await stack.prisma.assistSiteVisitorResume.count({
          where: { siteId: f.siteId },
        }),
      ).toBe(1);
    });

    it('выдача сессий — не больше 5 в минуту на ipHash сайта (RATE_LIMITED с retryAfterMs)', async () => {
      const d = domain();
      const f = await widgetFixture(stack, [{ host: d }]);
      const ip = freshIp();
      for (let i = 0; i < WIDGET_DEFAULTS.sessionsPerIpPerMinute; i++) {
        await session(
          { pk: f.pk, parentOrigin: `https://${d}` },
          { ip },
        ).expect(200);
      }
      const r = await session(
        { pk: f.pk, parentOrigin: `https://${d}` },
        { ip },
      ).expect(429);
      expect(r.body.error.code).toBe('RATE_LIMITED');
      expect(r.body.error.details.retryAfterMs).toBeGreaterThanOrEqual(0);
      // Другой сайт с того же IP — своё окно (ipHash солится сайтом).
      const g = await widgetFixture(stack, [{ host: domain() }]);
      await session(
        { pk: g.pk, parentOrigin: `https://${g.hosts[0].host}` },
        { ip },
      ).expect(200);
    });

    it('ipHash в токене — суточная соль + соль сайта: один IP на двух сайтах даёт разные хеши', async () => {
      const a = await widgetFixture(stack, [{ host: domain() }]);
      const b = await widgetFixture(stack, [{ host: domain() }]);
      const ip = freshIp();
      const ra = await session(
        { pk: a.pk, parentOrigin: a.hosts[0].origin },
        { ip },
      ).expect(200);
      const rb = await session(
        { pk: b.pk, parentOrigin: b.hosts[0].origin },
        { ip },
      ).expect(200);
      expect(tokenOf(ra).ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenOf(ra).ipHash).not.toBe(tokenOf(rb).ipHash);
      expect(JSON.stringify(tokenOf(ra))).not.toContain(ip);
      expect(TEST_SECRETS_KEY).toBeTruthy();
    });

    describe('предпросмотр (§3-бис.4): одноразовый обмен токена', () => {
      async function issue(
        f: { accountId: string; siteId: string },
        p: { purpose: 'site' | 'tma'; origin?: string; expiresInMs?: number },
      ): Promise<string> {
        const token = randomBytes(32).toString('base64url');
        await stack.prisma.assistSitePreviewToken.create({
          data: {
            accountId: f.accountId,
            siteId: f.siteId,
            tokenHash: sha256Hex(token),
            purpose: p.purpose,
            origin: p.origin ?? null,
            draft: {
              schema: 1,
              brand: { name: 'Черновик' },
              hosts: [{ hostId: 'x' }],
            },
            createdByTelegramId: 1n,
            expiresAt: new Date(Date.now() + (p.expiresInMs ?? 30 * 60_000)),
          },
        });
        return token;
      }
      function exchange(pk: string, token: string, parentOrigin: string) {
        return request(srv())
          .post('/widget/v1/preview/exchange')
          .set('Origin', W_ORIGIN)
          .send({ pk, token, parentOrigin });
      }

      it('purpose=tma: обмен один раз; сессия пускает предка конфигуратора, флаг preview в токене', async () => {
        const d = domain();
        const f = await widgetFixture(stack, [{ host: d }], { publish: false });
        const token = await issue(f, { purpose: 'tma' });
        const ex = await exchange(f.pk, token, TMA_ORIGIN).expect(200);
        expect(ex.body.data.config.brand.name).toBe('Черновик');
        expect(ex.body.data.config.hosts).toBeUndefined();
        expect(
          (await exchange(f.pk, token, TMA_ORIGIN).expect(403)).body.error.code,
        ).toBe('PREVIEW_INVALID');

        const s = await session({
          pk: f.pk,
          parentOrigin: TMA_ORIGIN,
          previewSession: ex.body.data.previewSession,
        }).expect(200);
        expect(s.body.data).toMatchObject({ preview: true, resumeKey: null });
        expect(cookieOf(s)).toBeNull();
        expect(tokenOf(s).preview).toBe(true);
        await request(srv())
          .get('/widget/v1/state')
          .set('Origin', W_ORIGIN)
          .set(WIDGET_VISITOR_TOKEN_HEADER, s.body.data.visitorToken)
          .expect(200);
        // Без сессии предпросмотра тот же origin не пускается.
        expect(
          (await session({ pk: f.pk, parentOrigin: TMA_ORIGIN }).expect(403))
            .body.error.code,
        ).toBe('WIDGET_DISABLED');
      });

      it('purpose=site: только на origin, для которого выдан; чужой origin, истёкший токен, чужой сайт — PREVIEW_INVALID', async () => {
        const d = domain();
        const f = await widgetFixture(stack, [{ host: d }]);
        const g = await widgetFixture(stack, [{ host: domain() }]);
        const t1 = await issue(f, { purpose: 'site', origin: `https://${d}` });
        expect(
          (await exchange(f.pk, t1, `https://${domain()}`).expect(403)).body
            .error.code,
        ).toBe('PREVIEW_INVALID');
        expect(
          (await exchange(g.pk, t1, `https://${d}`).expect(403)).body.error
            .code,
        ).toBe('PREVIEW_INVALID');
        await exchange(f.pk, t1, `https://${d}`).expect(200);
        const t2 = await issue(f, {
          purpose: 'site',
          origin: `https://${d}`,
          expiresInMs: -1000,
        });
        expect(
          (await exchange(f.pk, t2, `https://${d}`).expect(403)).body.error
            .code,
        ).toBe('PREVIEW_INVALID');
        const t3 = await issue(f, { purpose: 'tma' });
        const r = await request(srv())
          .post('/widget/v1/preview/exchange')
          .set('Origin', `https://${d}`)
          .send({ pk: f.pk, token: t3, parentOrigin: TMA_ORIGIN })
          .expect(403);
        expect(r.body.error.code).toBe('ORIGIN_DENIED');
      });

      it('гонка «прочитали до чужого обмена»: условный UPDATE не даёт второй сессии', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        const token = await issue(f, { purpose: 'tma' });
        await exchange(f.pk, token, TMA_ORIGIN).expect(200);
        // Второй обмен «прочитал» строку до первого (usedAt ещё null) —
        // защищает только условие usedAt IS NULL в самом UPDATE.
        const real =
          await stack.prisma.assistSitePreviewToken.findUniqueOrThrow({
            where: { tokenHash: sha256Hex(token) },
          });
        const spy = jest
          .spyOn(stack.publicDb.assistSitePreviewToken, 'findUnique')
          .mockResolvedValueOnce({ ...real, usedAt: null } as never);
        try {
          const r = await exchange(f.pk, token, TMA_ORIGIN).expect(403);
          expect(r.body.error.code).toBe('PREVIEW_INVALID');
        } finally {
          spy.mockRestore();
        }
      });

      it('два параллельных обмена одного токена — сессия одна', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        const token = await issue(f, { purpose: 'tma' });
        const rs = await Promise.all(
          Array.from({ length: 5 }, () => exchange(f.pk, token, TMA_ORIGIN)),
        );
        expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      });
    });
  },
);
