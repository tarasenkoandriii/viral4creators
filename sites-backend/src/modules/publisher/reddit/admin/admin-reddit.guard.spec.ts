/**
 * P-R-ADM, аудит 15.10.2026 (adm-1, adm-2): строка журнала доступа Админки
 * пишется ДО завершения ответа (запись ждёт и `@Res()`-обработчик, и ответ
 * фильтра ошибок), обрыв клиентом до ответа — строка 499, ровно одна строка
 * на запрос; каждое значение `route` журнала проходит регулярное выражение
 * триггера (то же, что в миграции 20261024090000).
 */
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { Logger, type ExecutionContext } from '@nestjs/common';
import express = require('express');
import type { NextFunction, Request, Response } from 'express';
import {
  ACCESS_LOG_WAIT_MS,
  AdminRedditGuard,
  CLIENT_CLOSED_STATUS,
} from './admin-reddit.guard';
import {
  AdminAccessLog,
  accessRouteOf,
  accessRouteTemplates,
  type AdminAccessEntry,
} from './admin-access-log';

const SECRET = 'admin-reddit-guard-spec-secret-01';
const BASE = '/internal/admin/reddit';

function ctxOf(req: Request, res: Response): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/** Ручной промис: тест решает, когда «база» дописала строку. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('P-R-ADM: журнал доступа — до ответа, обрыв — 499 (аудит adm-1)', () => {
  const saved = process.env.SITES_INTERNAL_SECRET;
  let server: http.Server;
  let port: number;
  let writes: AdminAccessEntry[];
  let gate: ReturnType<typeof deferred> | null;
  let release: ReturnType<typeof deferred>;
  let handlerDone: number;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    process.env.SITES_INTERNAL_SECRET = SECRET;
    const log = {
      write: jest.fn(async (e: AdminAccessEntry) => {
        writes.push(e);
        if (gate) await gate.promise;
      }),
    } as unknown as AdminAccessLog;
    const guard = new AdminRedditGuard(log);
    const app = express();
    // Без точки монтирования: гвард видит полный путь, как в Nest.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith(`${BASE}/`)) return next();
      try {
        guard.canActivate(ctxOf(req, res));
        next();
      } catch (e) {
        res.status(400).json({ error: (e as Error).name });
      }
    });
    // `@Res()`-обработчик (как rx/*): отвечает сам.
    app.get(`${BASE}/rx/projects/:id`, (_req, res) => {
      handlerDone++;
      res.status(200).json({ success: true, data: { ok: true } });
    });
    // Медленный обработчик (импорт): отвечает, когда тест отпустит.
    app.post(`${BASE}/import/apply`, async (_req, res) => {
      await release.promise;
      handlerDone++;
      res.status(200).json({ success: true, data: { late: true } });
    });
    // Ошибка (как ответ фильтра PubExceptionFilter).
    app.post(`${BASE}/cx/sources/:id/revoke`, (_req, res) => {
      res
        .status(404)
        .json({ success: false, error: { code: 'PUB_NOT_FOUND' } });
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.SITES_INTERNAL_SECRET;
    else process.env.SITES_INTERNAL_SECRET = saved;
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    writes = [];
    gate = null;
    release = deferred();
    handlerDone = 0;
  });

  function send(method: string, p: string, signal?: AbortSignal) {
    return fetch(`http://127.0.0.1:${port}${BASE}/${p}`, {
      method,
      signal,
      headers: {
        'X-Sites-Internal-Secret': SECRET,
        'X-Admin-Actor': 'u1',
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  }

  it('ответ завершается только после записи строки (успех и ошибка)', async () => {
    for (const [method, p, status, route] of [
      ['GET', 'rx/projects/p1', 200, 'rx/projects/:id'],
      ['POST', 'cx/sources/s1/revoke', 404, 'cx/sources/:id/revoke'],
    ] as const) {
      writes = [];
      gate = deferred();
      let body: string | null = null;
      const res = send(method, p).then(async (r) => {
        body = await r.text();
        return r;
      });
      await tick(100);
      // Строка уже записывается, а тело ответа клиент ещё не получил.
      expect(writes).toEqual([{ actor: 'admin:u1', method, route, status }]);
      expect(body).toBeNull();
      gate.resolve();
      const r = await res;
      expect(r.status).toBe(status);
      expect(body).toContain('success');
      expect(writes).toHaveLength(1);
    }
  });

  it('клиент ушёл до ответа — строка 499 сразу; поздний ответ обработчика второй строки не даёт', async () => {
    const ac = new AbortController();
    const res = send('POST', 'import/apply', ac.signal).catch(
      (e: unknown) => e,
    );
    await tick(100);
    expect(writes).toEqual([]);
    ac.abort();
    await res;
    for (let i = 0; i < 50 && writes.length === 0; i++) await tick();
    expect(writes).toEqual([
      {
        actor: 'admin:u1',
        method: 'POST',
        route: 'import/apply',
        status: CLIENT_CLOSED_STATUS,
      },
    ]);
    release.resolve();
    for (let i = 0; i < 50 && handlerDone === 0; i++) await tick();
    await tick(100);
    expect(handlerDone).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it('база не отвечает — ответ ждёт не дольше ACCESS_LOG_WAIT_MS', async () => {
    gate = deferred(); // так и не отпустим
    const t0 = Date.now();
    const r = await send('GET', 'rx/projects/p2');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('success');
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(ACCESS_LOG_WAIT_MS - 100);
    expect(waited).toBeLessThan(ACCESS_LOG_WAIT_MS + 2000);
    gate.resolve();
  }, 15_000);
});

describe('P-R-ADM: значения route журнала проходят триггер (аудит adm-2)', () => {
  /** Регулярное выражение route из последней миграции, где оно задано. */
  function triggerRouteRe(): RegExp {
    const dir = path.resolve(__dirname, '../../../../../prisma/migrations');
    const files = fs
      .readdirSync(dir)
      .sort()
      .map((d) => path.join(dir, d, 'migration.sql'))
      .filter((f) => fs.existsSync(f));
    let src: string | null = null;
    for (const f of files) {
      const m =
        /pub_reddit_admin_access_log_guard"\(\)[\s\S]*?NEW\."route" ~ '([^']+)'/.exec(
          fs.readFileSync(f, 'utf8'),
        );
      if (m) src = m[1];
    }
    if (!src) throw new Error('регулярное выражение route не найдено');
    return new RegExp(src);
  }

  it('все шаблоны маршрутов (≥ 71) и значения неизвестного пути — проходят; мусор — нет', () => {
    const re = triggerRouteRe();
    const all = accessRouteTemplates();
    // 71 маршрут (метод + шаблон) + 3 значения неизвестного пути.
    expect(all.length).toBeGreaterThanOrEqual(71 + 3);
    expect(all).toContain('cx/ai/calls/:callId');
    const bad = all.filter((r) => !(r.length <= 200 && re.test(r)));
    expect(bad).toEqual([]);
    for (const junk of ['?', '/status', 'rx/a b', '', ' status'])
      expect({ junk, ok: re.test(junk) }).toEqual({ junk, ok: false });
    // Нераспознанные пути — значения, которые триггер принимает.
    for (const p of [
      `${BASE}/STATUS`,
      `${BASE}/params/foo-bar/propose`,
      `${BASE}/rx/members`,
      `${BASE}/cx/claims`,
      '/elsewhere',
    ])
      expect(re.test(accessRouteOf('GET', p))).toBe(true);
  });
});
