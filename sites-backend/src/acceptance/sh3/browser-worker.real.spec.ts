/**
 * Интеграция Э-С Ш3: НАСТОЯЩИЙ браузерный воркер (`browser-worker/dist`,
 * отдельный процесс, Chromium Playwright) ↔ НАСТОЯЩИЙ sites-backend (этот
 * стенд на реальном Postgres, слушает порт) ↔ https-стенд «сайта заказчика».
 *
 * Сеть воркера — как в бою: только через его фильтрующий прокси; «сайт»
 * достижим через вышестоящий CONNECT («интернет» этого теста), имена
 * резолвятся подменой DNS воркера (NODE_ENV=test) в публичный адрес.
 *
 * Сценарии: «Снимок» от кнопки владельца до ссылки на скриншот и карты Ш4;
 * обход «Админки» за логином с учёткой из реестра Ш2 (конверт под ключ
 * воркера) — страницы в `assist_admin_pages`, «Видалити» не нажат, пароль не
 * в журнале процесса воркера; остановка воркера SIGTERM — штатный выход.
 *
 * Локальный прогон (не CI: нужен собранный воркер и Chromium):
 *   (cd browser-worker && npm run build)
 *   SH3_WORKER_INTEGRATION=1 SITES_DIRECT_URL=… npx jest src/acceptance/sh3/browser-worker.real
 * Под root — без песочницы; с `SH3_WORKER_UID=<uid непривилегированного>` —
 * воркер запускается этим пользователем С песочницей Chromium (как в образе).
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import {
  createServer as createHttp,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { createServer as createHttps, type Server as HttpsServer } from 'https';
import { connect, type AddressInfo, type Socket } from 'net';
import { join } from 'path';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { SiteCredentialsService } from '../../modules/site-credentials/site-credentials.service';
import {
  TEST_TLS_CERT,
  TEST_TLS_KEY,
} from '../../modules/site-crawl/testing/tls-fixture.testing';
import { Sh3Stack, body, type Sh3Site } from './sh3-stack';

const WORKER_MAIN = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'browser-worker',
  'dist',
  'main.js',
);
const CHROMIUM =
  process.env.BROWSER_WORKER_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const ENABLED =
  process.env.SH3_WORKER_INTEGRATION === '1' &&
  !!process.env.SITES_DIRECT_URL &&
  existsSync(WORKER_MAIN) &&
  existsSync(CHROMIUM);
const PUBLIC_IP = '93.184.216.34';

jest.setTimeout(240_000);

const until = async (fn: () => Promise<boolean>, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('не дождались');
};

(ENABLED ? describe : describe.skip)(
  'Интеграция Ш3: настоящий воркер ↔ sites-backend ↔ стенд',
  () => {
    const st = new Sh3Stack();
    let s: Sh3Site;
    let stand: HttpsServer;
    let internet: ReturnType<typeof createHttp>;
    let worker: ChildProcess;
    const out: string[] = [];
    const hits: string[] = [];
    const sockets = new Set<Socket>();
    const PASSWORD = ['Real', 'Sh3', randomBytes(4).toString('hex')].join('-');

    beforeAll(async () => {
      await st.init();
      s = await st.site();
      await st.app.listen(0, '127.0.0.1');
      const apiPort = (st.app.getHttpServer().address() as AddressInfo).port;
      const page = (
        res: ServerResponse,
        html: string,
        headers: Record<string, string> = {},
      ) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          ...headers,
        });
        res.end(html);
      };
      stand = createHttps(
        { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
        (req: IncomingMessage, res) => {
          let b = '';
          req.on('data', (c: Buffer) => (b += c.toString()));
          req.on('end', () => {
            const host = (req.headers.host ?? '').replace(/:\d+$/, '');
            const path = (req.url ?? '/').split('?')[0];
            hits.push(`${req.method} ${host}${path}`);
            const authed = String(req.headers.cookie ?? '').includes('sid=ok');
            if (host === s.shopHost && path === '/') {
              return page(
                res,
                '<!doctype html><title>Магазин</title><h1>Головна</h1><button data-assist-id="buy">Купити</button>',
              );
            }
            if (
              host === s.adminHost &&
              path === '/login' &&
              req.method === 'POST'
            ) {
              const p = new URLSearchParams(b);
              if (
                p.get('login') === 'manager' &&
                p.get('password') === PASSWORD
              ) {
                res.writeHead(302, {
                  location: '/admin',
                  'set-cookie': 'sid=ok; Path=/; Secure; HttpOnly',
                });
                return res.end();
              }
            }
            if (host === s.adminHost && (path === '/login' || !authed)) {
              if (path !== '/login') {
                res.writeHead(302, { location: '/login' });
                return res.end();
              }
              return page(
                res,
                '<!doctype html><title>Вхід</title><form method="post" action="/login"><input name="login"><input type="password" name="password"><button>Увійти</button></form>',
              );
            }
            if (host === s.adminHost && path === '/admin') {
              return page(
                res,
                '<!doctype html><title>Адмінка</title><nav><a href="/admin/orders">Замовлення</a><a href="/logout">Вийти</a></nav><h1>Панель</h1><button aria-expanded="false" onclick="fetch(\'/hit/delete\',{method:\'POST\'})">Видалити</button>',
              );
            }
            if (host === s.adminHost && path === '/admin/orders') {
              return page(
                res,
                '<!doctype html><title>Замовлення</title><h1>Замовлення</h1><table><tr><th>Клієнт</th></tr><tr><td>Іван Петренко</td></tr></table>',
              );
            }
            res.writeHead(404);
            res.end();
          });
        },
      );
      await new Promise<void>((r) => stand.listen(0, '127.0.0.1', r));
      const standPort = (stand.address() as AddressInfo).port;
      internet = createHttp();
      internet.on('connect', (req, client: Socket) => {
        sockets.add(client);
        if (req.url !== `${PUBLIC_IP}:443`) {
          client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
        const up = connect(standPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          up.pipe(client);
          client.pipe(up);
        });
        sockets.add(up);
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
      });
      await new Promise<void>((r) => internet.listen(0, '127.0.0.1', r));
      const netPort = (internet.address() as AddressInfo).port;
      // Под root песочница Chromium не стартует: SH3_WORKER_UID=<uid> запускает
      // воркер непривилегированным пользователем С ПЕСОЧНИЦЕЙ (как в образе).
      const uid = Number(process.env.SH3_WORKER_UID ?? '') || undefined;
      const asRoot = process.getuid?.() === 0 && !uid;
      worker = spawn(process.execPath, [WORKER_MAIN], {
        ...(uid ? { uid, gid: uid } : {}),
        env: {
          HOME: '/tmp',
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          SITES_BACKEND_URL: `http://127.0.0.1:${apiPort}`,
          SITES_WORKER_HMAC_SECRET: st.workerSecret,
          BROWSER_WORKER_SEAL_PRIVATE_KEY: st.keys.privateKey,
          BROWSER_WORKER_ID: 'bw-real-sh3',
          BROWSER_WORKER_SANDBOX: asRoot ? 'off' : 'on',
          BROWSER_WORKER_CHROMIUM_PATH: CHROMIUM,
          BROWSER_WORKER_TEST_DNS: `${s.shopHost}=${PUBLIC_IP},${s.adminHost}=${PUBLIC_IP}`,
          BROWSER_WORKER_TEST_IGNORE_TLS: '1',
          BROWSER_WORKER_UPSTREAM_PROXY_URL: `http://127.0.0.1:${netPort}`,
          BROWSER_WORKER_POLL_MS: '300',
          BROWSER_WORKER_IDLE_POLL_MAX_MS: '600',
          BROWSER_WORKER_HEALTH_FILE: `/tmp/bw-real-${process.pid}.health`,
          LOG_LEVEL: 'debug',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stdout!.on('data', (c: Buffer) => out.push(c.toString()));
      worker.stderr!.on('data', (c: Buffer) => out.push(c.toString()));
    });

    afterAll(async () => {
      if (worker && worker.exitCode === null) worker.kill('SIGKILL');
      for (const x of sockets) x.destroy();
      await new Promise<void>((r) => internet?.close(() => r()));
      stand?.closeAllConnections();
      await new Promise<void>((r) => stand?.close(() => r()));
      await st.close();
    });

    it('«Снимок»: кнопка владельца → воркер → скриншот и карта Ш4', async () => {
      const r = body(
        await request(st.srv())
          .post(`/assist/sites/${s.siteId}/voice-map/site/snapshots`)
          .set(st.as(s.ownerTg))
          .send({ url: `https://${s.shopHost}/` })
          .expect(200),
      );
      let view: Record<string, unknown> = {};
      await until(async () => {
        view = body(
          await request(st.srv())
            .get(
              `/assist/sites/${s.siteId}/voice-map/site/snapshots/${r.snapshotId}`,
            )
            .set(st.as(s.ownerTg))
            .expect(200),
        );
        return view.status === 'done' || view.status === 'failed';
      });
      expect(view.status).toBe('done');
      expect(JSON.stringify(view.elements)).toContain('Купити');
      const shot = [...st.storage.files.values()][0];
      expect(
        shot.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
      ).toBe(true);
      expect(
        await st.prisma.siteUiMap.count({
          where: { siteId: s.siteId, source: 'qa' },
        }),
      ).toBe(1);
    });

    it('обход «Админки» за логином: страницы записаны, «Видалити» не нажат, пароль не в журнале воркера', async () => {
      const creds = st.app.get(SiteCredentialsService);
      const acc = await creds.create(
        s.accountId,
        s.siteId,
        {
          label: 'Менеджер',
          hostIds: [s.adminHostId],
          products: ['assist-admin'],
          confirmedTestAccount: true,
          username: 'manager',
          password: PASSWORD,
        },
        'tma:test',
      );
      const crawl = `/assist/sites/${s.siteId}/admin-mode/private-crawl`;
      await request(st.srv())
        .put(crawl)
        .set(st.as(s.ownerTg))
        .send({
          enabled: true,
          hostId: s.adminHostId,
          testAccountId: acc.id,
          startPath: '/admin',
        })
        .expect(200);
      const run = body(
        await request(st.srv())
          .post(`${crawl}/run`)
          .set(st.as(s.ownerTg))
          .expect(200),
      );
      await until(async () => {
        const j = await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
          where: { id: run.jobId },
        });
        return j.status === 'done' || j.status === 'failed';
      });
      const job = await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
        where: { id: run.jobId },
      });
      expect([job.status, job.note]).toEqual(['done', 'страниц: 2']);
      const pages = await st.prisma.assistAdminPage.findMany({
        where: { siteId: s.siteId },
      });
      expect(pages.map((p) => new URL(p.url).pathname).sort()).toEqual([
        '/admin',
        '/admin/orders',
      ]);
      expect(pages.map((p) => p.text).join('\n')).not.toContain(
        'Іван Петренко',
      );
      expect(
        hits.some((h) => h.includes('/hit/delete') || h.includes('/logout')),
      ).toBe(false);
      expect(out.join('')).not.toContain(PASSWORD);
    });

    it('SIGTERM — штатная остановка', async () => {
      const exited = new Promise<number | null>((r) =>
        worker.once('exit', (code) => r(code)),
      );
      worker.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out.join('')).toContain('остановка');
    });
  },
);
