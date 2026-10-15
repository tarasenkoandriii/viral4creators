/**
 * Инфраструктура ядра P-A1 без базы: реестр таблиц (§15.4), порты и
 * заглушки «не успех» (§16.0), реестр кронов (§15.1), фильтр ошибок
 * (§11.1–11.2), перечислитель маршрутов.
 */
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ModuleRef } from '@nestjs/core';
import {
  PUB_CRON_PERIOD_MIN,
  PUB_CRON_SCHEDULE,
  PubCronRegistry,
  rotationOffset,
} from '../cron/job-registry';
import { PubError, PubExceptionFilter, validationError } from './errors';
import { PubContributions } from './contributions';
import {
  BUDGET_LIMIT_PORT,
  CONTENT_PORT,
  PORT_OWNERS,
  PubPorts,
  notImplementedPort,
} from './ports';
import { fillPath } from './route-enumerator';
import {
  CROSS_PRODUCT_REFS,
  ENCRYPTED_COLUMNS,
  NOT_EXPORTED,
  exportOrder,
  pubTableRegistry,
} from './table-registry';
import { fakeCronJob } from './testing/fake-ports';

describe('table-registry (§15.4)', () => {
  const reg = pubTableRegistry();
  const index = new Map(reg.map((t, i) => [t.table, i]));

  it('73 таблицы pub_* из DMMF (66 P0 + 7 P-R); родитель раньше ребёнка; продукт первым', () => {
    expect(reg).toHaveLength(73);
    expect(reg[0].table).toBe('pub_products');
    for (const t of reg)
      for (const r of t.refs)
        expect(index.get(r.table)! < index.get(t.table)!).toBe(true);
    expect(
      reg
        .flatMap((t) => t.deferred.map((d) => `${t.table}.${d.column}`))
        .sort(),
    ).toEqual([
      'pub_ai_configs.evalRunId',
      'pub_contents.approvedVersionId',
      'pub_contents.currentVersionId',
      'pub_contents.publishedVersionId',
      'pub_parameter_proposals.decisionId',
      'pub_placements.expenseId',
    ]);
    const restored = reg.find((t) => t.table === 'pub_products')!;
    expect(restored.refs).toEqual([]);
    expect(CROSS_PRODUCT_REFS.length).toBe(4);
  });

  it('экспорт без служебных таблиц; шифротексты помечены; колонки и делегаты', () => {
    const exp = exportOrder().map((t) => t.table);
    for (const t of NOT_EXPORTED) expect(exp).not.toContain(t);
    expect(exp).toHaveLength(68); // 62 P0 + 6 pub_reddit_* (P-R M1+M2)
    const contacts = reg.find((t) => t.table === 'pub_lead_contacts')!;
    expect(contacts.encrypted).toEqual(ENCRYPTED_COLUMNS.pub_lead_contacts);
    expect(contacts.delegate).toBe('pubLeadContact');
    expect(contacts.columns).toEqual(
      expect.arrayContaining([
        'id',
        'accountId',
        'productId',
        'leadId',
        'contactEnc',
        'matchHash',
      ]),
    );
    expect(contacts.refs.map((r) => r.table)).toEqual(
      expect.arrayContaining(['pub_products', 'pub_leads']),
    );
  });
});

describe('ports: заглушка — «не успех» (§16.0)', () => {
  it('любой метод нереализованного порта — 501 PUB_NOT_IMPLEMENTED с портом и владельцем', () => {
    const p = notImplementedPort(BUDGET_LIMIT_PORT);
    let err: unknown = null;
    try {
      void p.applyParameters({} as never, { id: 'p', accountId: 'a' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PubError);
    expect((err as PubError).getStatus()).toBe(501);
    expect((err as PubError).details).toEqual({
      port: BUDGET_LIMIT_PORT,
      method: 'applyParameters',
      owner: 'P-C',
    });
    expect((p as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('PubPorts: есть провайдер — он; нет — заглушка; has() честный', () => {
    const impl = { applyParameters: jest.fn() };
    const ref = {
      get: (token: string) => {
        if (token === BUDGET_LIMIT_PORT) return impl;
        throw new Error('not found');
      },
    } as unknown as ModuleRef;
    const ports = new PubPorts(ref);
    expect(ports.budgetLimit()).toBe(impl);
    expect(ports.has(BUDGET_LIMIT_PORT)).toBe(true);
    expect(ports.has(CONTENT_PORT)).toBe(false);
    expect(() =>
      ports
        .content()
        .markWithdrawn({} as never, { id: 'p', accountId: 'a' }, 'v', 'r'),
    ).toThrow(expect.objectContaining({ code: 'PUB_NOT_IMPLEMENTED' }));
    expect(Object.values(PORT_OWNERS)).toEqual(
      expect.arrayContaining(['P-A1', 'P-B1', 'P-B2', 'P-C', 'P-D', 'P-E']),
    );
  });
});

describe('cron/job-registry (§15.1)', () => {
  const contributions = (jobs: ReturnType<typeof fakeCronJob>[]) =>
    ({ list: () => jobs }) as unknown as PubContributions;

  it('расписание §15.1: задания P-A1 и пакетов; задание вне списка или не с тем расписанием — ошибка старта', () => {
    expect(PUB_CRON_SCHEDULE['members-reconcile']).toEqual({
      schedule: 'tick',
      owner: 'P-A1',
    });
    expect(PUB_CRON_SCHEDULE.housekeeping).toEqual({
      schedule: 'daily',
      owner: 'P-A1',
    });
    // + `ai-calls-run` (minute, аудит P-B2 S2-1), `site-revalidate`
    // (minute, Р-PUB-Z2-8).
    expect(PUB_CRON_SCHEDULE['site-revalidate']).toEqual({
      schedule: 'minute',
      owner: 'P-A1',
    });
    // + `reddit-retention` (daily, P-R M2), `admin-access-log-retention`
    // (daily, P-R-ADM).
    expect(Object.keys(PUB_CRON_SCHEDULE)).toHaveLength(24);
    const reg = new PubCronRegistry(contributions([]));
    expect(() => reg.validate([fakeCronJob('unknown-job', 'tick')])).toThrow(
      /не описано/,
    );
    expect(() => reg.validate([fakeCronJob('housekeeping', 'tick')])).toThrow(
      /по §15.1 — daily/,
    );
    // аудит P3-11: два провайдера с одним ключом — ошибка старта
    expect(() =>
      reg.validate([
        fakeCronJob('housekeeping', 'daily'),
        fakeCronJob('housekeeping', 'daily'),
      ]),
    ).toThrow(/дважды/);
  });

  it('аудит P3-11: порядок ротируется по периоду (хвост не голодает); pending — отдельный статус', async () => {
    const order: string[][] = [];
    const reg = new PubCronRegistry(contributions([]));
    const keys = reg.jobsOf('tick').map((j) => j.key);
    expect(rotationOffset('tick', new Date(0), keys.length)).toBe(0);
    for (let i = 0; i < keys.length; i++) {
      const r = await reg.run('tick', {
        now: new Date(i * PUB_CRON_PERIOD_MIN.tick * 60_000),
      });
      order.push(r.jobs.map((j) => j.key));
    }
    // каждый проход начинается со следующего задания; все побывали первыми
    expect(order.map((o) => o[0])).toEqual(keys);
    expect(
      order.every((o) => [...o].sort().join() === [...keys].sort().join()),
    ).toBe(true);
    expect(
      rotationOffset(
        'daily',
        new Date(3 * PUB_CRON_PERIOD_MIN.daily * 60_000),
        9,
      ),
    ).toBe(3);
    const pending = new PubCronRegistry(
      contributions([
        fakeCronJob('members-reconcile', 'tick', async () => ({
          processed: 0,
          pending: ['member-reassign:leads'],
        })),
      ]),
    );
    const r = await pending.run('tick', { now: new Date(0) });
    expect(r.pending).toBe(1);
    expect(r.ok).toBe(0);
    expect(r.jobs.find((j) => j.key === 'members-reconcile')).toMatchObject({
      status: 'pending',
      pending: ['member-reassign:leads'],
    });
  });

  it('проход: ошибка одного задания не останавливает другие; нет задания — missing; бюджет — skipped', async () => {
    const calls: string[] = [];
    const reg = new PubCronRegistry(
      contributions([
        fakeCronJob('members-reconcile', 'tick', async () => {
          calls.push('mr');
          throw new Error('упало');
        }),
        fakeCronJob('rate-hits-sweep', 'tick', async (ctx) => {
          calls.push(`rh:${ctx.scope?.siteIds.join(',')}`);
          return { processed: 3 };
        }),
      ]),
    );
    const r = await reg.run('tick', {
      scope: { siteIds: ['s1'] },
      now: new Date(0),
    });
    expect(calls).toEqual(['mr', 'rh:s1']);
    expect(r.errors).toBe(1);
    expect(r.ok).toBe(1);
    // `ai-month-open` — tick (аудит P-B2 S3-6)
    expect(r.missing).toBe(10);
    expect(r.jobs.find((j) => j.key === 'members-reconcile')).toMatchObject({
      status: 'error',
      error: 'Error: упало',
    });
    expect(r.jobs.find((j) => j.key === 'lead-enrich')).toMatchObject({
      status: 'missing',
      owner: 'P-D',
    });
    const late = await reg.run('tick', { budgetMs: -1 });
    expect(
      late.jobs
        .filter((j) => j.status === 'skipped')
        .map((j) => j.key)
        .sort(),
    ).toEqual(['members-reconcile', 'rate-hits-sweep']);
    expect(late.skipped).toBe(2);
  });
});

describe('PubExceptionFilter (§11.1–11.2)', () => {
  function render(e: PubError, lang?: string) {
    const out: {
      status?: number;
      body?: Record<string, unknown>;
      headers: Record<string, string>;
    } = { headers: {} };
    const res = {
      status(c: number) {
        out.status = c;
        return this;
      },
      json(b: Record<string, unknown>) {
        out.body = b;
        return this;
      },
      setHeader(k: string, v: string) {
        out.headers[k] = v;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({
          method: 'POST',
          path: '/publisher/x',
          headers: lang ? { 'accept-language': lang } : {},
        }),
      }),
    } as unknown as ArgumentsHost;
    new PubExceptionFilter().catch(e, host);
    return out;
  }

  it('конверт: код, текст на языке запроса, details целиком; Retry-After для 429', () => {
    const r = render(validationError([{ field: 'basis', code: 'pii' }]), 'ru');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      success: false,
      error: {
        code: 'PUB_VALIDATION',
        message: 'Проверьте поля формы',
        details: { fields: [{ field: 'basis', code: 'pii' }] },
      },
      meta: { path: '/publisher/x' },
    });
    const rl = render(
      new PubError('PUB_RATE_LIMITED', {
        retryAfterSec: 12.2,
        altContact: null,
      }),
    );
    expect(rl.status).toBe(429);
    expect(rl.headers['Retry-After']).toBe('13');
    expect((rl.body!.error as { message: string }).message).toBe(
      'Забагато звернень — спробуйте пізніше',
    );
    const nf = render(new PubError('PUB_NOT_FOUND'));
    expect(nf.body!.error).toEqual({
      code: 'PUB_NOT_FOUND',
      message: "Об'єкт не знайдено",
    });
  });

  it('PubError — HttpException с кодом и статусом (общий фильтр тоже поймёт код)', () => {
    const e = new PubError('PUB_CONFLICT', { currentRevision: 3 });
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      error: 'PUB_CONFLICT',
      code: 'PUB_CONFLICT',
    });
  });
});

describe('route-enumerator', () => {
  it('fillPath подставляет параметры пути', () => {
    expect(
      fillPath('/publisher/products/:pid/roles/:grantId/revoke', {
        pid: 'p 1',
        grantId: 'g',
      }),
    ).toBe('/publisher/products/p%201/roles/g/revoke');
    expect(fillPath('/a/:x', {})).toBe('/a/x');
  });
});

describe('table-registry ↔ schema.prisma (соглашение имён связей P-A0)', () => {
  it('внешние ключи реестра = @relation(fields: [...]) схемы (кроме межпродуктовых и на себя)', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '../../../../prisma/schema.prisma'),
      'utf8',
    );
    const expected = new Set<string>();
    for (const block of schema.matchAll(/^model (Pub\w+) \{([\s\S]*?)^\}/gm)) {
      for (const f of block[2].matchAll(
        /^\s+\w+\s+(Pub\w+)\??\s+@relation\("[^"]+", fields: \[([^\]]+)\]/gm,
      )) {
        const cols = f[2]
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== 'accountId');
        if (f[1] === block[1]) continue;
        if (
          CROSS_PRODUCT_REFS.some(
            ([m, c]) => m === block[1] && cols.includes(c),
          )
        )
          continue;
        expected.add(`${block[1]}.${cols.join('+')}->${f[1]}`);
      }
    }
    const actual = new Set(
      pubTableRegistry().flatMap((t) => [
        ...t.refs.map((r) => `${t.model}.${r.columns.join('+')}->${r.model}`),
        ...t.deferred.map((r) => `${t.model}.${r.column}->${r.model}`),
      ]),
    );
    // обратные ссылки — только необязательные колонки
    for (const t of pubTableRegistry()) {
      for (const d of t.deferred) {
        expect({
          col: `${t.model}.${d.column}`,
          nullable: new RegExp(`^\\s+${d.column}\\s+String\\?`, 'm').test(
            schema,
          ),
        }).toEqual({
          col: `${t.model}.${d.column}`,
          nullable: true,
        });
      }
    }
    expect(expected.size).toBeGreaterThanOrEqual(150);
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});
