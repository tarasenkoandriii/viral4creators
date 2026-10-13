/**
 * Р-PUB-Z2-8: задание `site-revalidate` — журнал аудита как очередь
 * (снятие материала/публикации, отзыв согласования, решение rejected|revoked
 * по ключу `public_publish`, уход из live), вызов только сконфигурированного
 * адреса с секретом, повтор после сбоя, отметка покрытых событий, no-op без
 * конфигурации. HTTP — фейк.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { publisherRevalidateTarget } from '../../../config/publisher-env';
import { seedTwoAccounts, type TwoAccounts } from '../testing/fixtures.testing';
import { AuditService } from './audit';
import type { AuditInput } from './ports';
import {
  SITE_REVALIDATE_ACTOR,
  SITE_REVALIDATE_WINDOW_MS,
  SiteRevalidateJob,
  type RevalidateHttp,
} from './site-revalidate.job';
import { coreStack, type CoreStack } from './testing/core-stack.testing';

jest.setTimeout(60_000);

const SECRET = 's'.repeat(24);
const ENV = {
  PUBLISHER_SITE_URL: 'https://site.example',
  PUBLISHER_REVALIDATE_SECRET: SECRET,
} as NodeJS.ProcessEnv;

describe('publisherRevalidateTarget: только https-origin и секрет ≥ 16', () => {
  it('корректный адрес → <origin>/api/revalidate', () => {
    expect(publisherRevalidateTarget(ENV)).toEqual({
      target: { url: 'https://site.example/api/revalidate', secret: SECRET },
      problem: null,
    });
    expect(
      publisherRevalidateTarget({
        ...ENV,
        PUBLISHER_SITE_URL: 'https://site.example/',
      }).target?.url,
    ).toBe('https://site.example/api/revalidate');
  });

  it('не задано, короткий секрет, не https, путь, запрос, учётные данные — target null с причиной', () => {
    expect(publisherRevalidateTarget({}).target).toBeNull();
    for (const bad of [
      { PUBLISHER_SITE_URL: 'https://site.example' },
      { ...ENV, PUBLISHER_REVALIDATE_SECRET: 'short' },
      { ...ENV, PUBLISHER_SITE_URL: 'http://site.example' },
      { ...ENV, PUBLISHER_SITE_URL: 'https://site.example/other' },
      { ...ENV, PUBLISHER_SITE_URL: 'https://site.example/?x=1' },
      { ...ENV, PUBLISHER_SITE_URL: 'https://u:p@site.example' },
      { ...ENV, PUBLISHER_SITE_URL: 'ftp://site.example' },
      { ...ENV, PUBLISHER_SITE_URL: 'не адрес' },
      {
        ...ENV,
        PUBLISHER_SITE_URL: 'http://localhost:3000',
        NODE_ENV: 'production',
      },
    ] as NodeJS.ProcessEnv[]) {
      const r = publisherRevalidateTarget(bad);
      expect(r.target).toBeNull();
      expect(r.problem).toEqual(expect.any(String));
      expect(r.problem).not.toContain(SECRET);
    }
    // Локальный стенд вне production — http://localhost допустим.
    expect(
      publisherRevalidateTarget({
        ...ENV,
        PUBLISHER_SITE_URL: 'http://localhost:3000',
        NODE_ENV: 'test',
      }).target?.url,
    ).toBe('http://localhost:3000/api/revalidate');
  });
});

ciDescribe('Publisher: задание site-revalidate на базе', () => {
  let s: CoreStack;
  let w: TwoAccounts;
  let audit: AuditService;
  const calls: Array<{ url: string; init: Parameters<RevalidateHttp>[1] }> = [];
  let reply: () => Promise<{ status: number }> = async () => ({ status: 200 });
  const http: RevalidateHttp = async (url, init) => {
    calls.push({ url, init });
    return reply();
  };
  const job = (env: NodeJS.ProcessEnv = ENV) =>
    new SiteRevalidateJob(s.db, audit, http, env);
  const ctx = (now = new Date()) => ({
    now,
    scope: { siteIds: [w.a.siteId, w.b.siteId] },
    deadline: new Date(Date.now() + 30_000),
  });
  const event = (
    who: 'a' | 'b',
    e: AuditInput,
    occurredAt = new Date(),
  ): Promise<void> => {
    const acc = w[who];
    return s.db.forAccount(acc.accountId).$transaction((tx) =>
      audit.write(tx, {
        ...e,
        accountId: acc.accountId,
        productId: acc.product!.id,
        actor: 'member:m1',
        occurredAt,
      }),
    );
  };
  const marks = (who: 'a' | 'b') =>
    s.prisma.pubAuditEvent.findMany({
      where: { productId: w[who].product!.id, actor: SITE_REVALIDATE_ACTOR },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    s = await coreStack();
    audit = s.mod.get(AuditService);
    w = await seedTwoAccounts(s.prisma, { withProducts: true });
  });
  afterAll(async () => {
    await s.close();
  });
  beforeEach(() => {
    calls.length = 0;
    reply = async () => ({ status: 200 });
  });

  it('нет событий — нет вызова; посторонние события (не снятие) не считаются', async () => {
    await event('a', {
      objectType: 'content',
      objectId: 'c0',
      action: 'transition',
      fromStatus: 'draft',
      toStatus: 'in_review',
    });
    await event('a', {
      objectType: 'parameter',
      objectId: 'p0',
      action: 'reject',
      toStatus: 'rejected',
      meta: { parameterKey: 'form_limit' },
    });
    await event('a', {
      objectType: 'product',
      objectId: w.a.product!.id,
      action: 'transition',
      fromStatus: 'closed',
      toStatus: 'live',
      meta: { field: 'mode' },
    });
    expect(await job().run(ctx())).toEqual({
      processed: 0,
      details: { pending: 0 },
    });
    expect(calls).toEqual([]);
  });

  it('без конфигурации — no-op с предупреждением, не ошибка; события ждут', async () => {
    await event('a', {
      objectType: 'content',
      objectId: `c-${randomUUID()}`,
      action: 'transition',
      fromStatus: 'published',
      toStatus: 'withdrawn',
    });
    const j = job({});
    const warn = jest
      .spyOn((j as unknown as { log: { warn: () => void } }).log, 'warn')
      .mockImplementation(() => undefined);
    const r = await j.run(ctx());
    expect(r).toEqual({
      processed: 0,
      details: { pending: 1, configured: false },
    });
    await j.run(ctx());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(await marks('a')).toEqual([]);
  });

  it('снятие и закрытие public_publish: один POST на сконфигурированный адрес с секретом, без переадресаций; события отмечены, повтора нет', async () => {
    await event('a', {
      objectType: 'publication',
      objectId: 'pub1',
      action: 'transition',
      fromStatus: 'published',
      toStatus: 'withdrawn',
    });
    await event('b', {
      objectType: 'parameter',
      objectId: 'par1',
      action: 'revoke',
      toStatus: 'revoked',
      meta: { parameterKey: 'domain_host', version: 2 },
    });
    await event('b', {
      objectType: 'product',
      objectId: w.b.product!.id,
      action: 'transition',
      fromStatus: 'live',
      toStatus: 'closed',
      meta: { field: 'mode' },
    });
    await event('b', {
      objectType: 'approval',
      objectId: 'ap1',
      action: 'revoke',
      fromStatus: 'active',
      toStatus: 'revoked',
    });
    const r = await job().run(ctx());
    // + событие предыдущего теста (ждало конфигурации).
    expect(r).toEqual({ processed: 5, details: { products: 2, status: 200 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://site.example/api/revalidate');
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const ma = await marks('a');
    const mb = await marks('b');
    expect(ma).toHaveLength(1);
    expect(mb).toHaveLength(1);
    expect(mb[0]).toMatchObject({
      objectType: 'product',
      action: 'update',
      meta: { field: 'siteRevalidate', status: 200 },
    });
    expect((mb[0].meta as { eventIds: string[] }).eventIds).toHaveLength(3);
    // Отмеченные события не вызывают повтора.
    expect(await job().run(ctx())).toEqual({
      processed: 0,
      details: { pending: 0 },
    });
    expect(calls).toHaveLength(1);
  });

  it('сбой сайта (5xx, сеть) — без отметки, повтор следующим проходом; старше окна — не повторяется', async () => {
    await event('a', {
      objectType: 'content',
      objectId: 'c2',
      action: 'transition',
      fromStatus: 'published',
      toStatus: 'withdrawn',
    });
    reply = async () => ({ status: 503 });
    const j = job();
    jest
      .spyOn((j as unknown as { log: { warn: () => void } }).log, 'warn')
      .mockImplementation(() => undefined);
    expect(await j.run(ctx())).toEqual({
      processed: 0,
      details: { pending: 1, failed: true, status: 503 },
    });
    reply = async () => {
      throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    };
    expect(await j.run(ctx())).toEqual({
      processed: 0,
      details: { pending: 1, failed: true, error: 'TimeoutError' },
    });
    expect((await marks('a')).length).toBe(1);
    reply = async () => ({ status: 200 });
    expect((await j.run(ctx())).processed).toBe(1);
    expect(calls).toHaveLength(3);
    expect((await marks('a')).length).toBe(2);
    // Событие старше окна повторов не берётся (сайт уже обновился по ISR).
    await event(
      'a',
      {
        objectType: 'content',
        objectId: 'c-old',
        action: 'transition',
        fromStatus: 'published',
        toStatus: 'withdrawn',
      },
      new Date(Date.now() - SITE_REVALIDATE_WINDOW_MS - 60_000),
    );
    expect((await j.run(ctx())).processed).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('чужие сайты (scope) не трогаются; позднее событие — новый вызов', async () => {
    await event('a', {
      objectType: 'content',
      objectId: 'c3',
      action: 'transition',
      fromStatus: 'published',
      toStatus: 'withdrawn',
    });
    const other = await job().run({
      ...ctx(),
      scope: { siteIds: ['site-nobody'] },
    });
    expect(other.processed).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await job().run(ctx())).processed).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
