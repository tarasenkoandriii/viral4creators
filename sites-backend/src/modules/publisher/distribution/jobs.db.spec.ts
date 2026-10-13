/**
 * AI Publisher, P-C — задания кронов зоны (проектный документ §15.1):
 *  - `publications-verify`: своя страница загружается (здесь — двойник
 *    читателя), `pub-version` сверяется с hash версии → `verifyStatus`;
 *    `pending` с совпадением → `published`; 3 неудачи подряд — задача
 *    `publication_unverified`; на показ страницы результат не влияет;
 *    чужой хост не загружается;
 *  - `budget-reconcile`: согласованный бюджет — без задач; запись мимо
 *    функций → задача владельцу (critical) и остановка новых обязательств
 *    (`PUB_BUDGET_STOPPED`), оплата при этом не блокируется задачей;
 *  - регистрация заданий в реестре `PUB_CRON_SCHEDULE`.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PUB_CRON_SCHEDULE } from '../cron/job-registry';
import { PubContributions } from '../core/contributions';
import { PubPorts } from '../core/ports';
import { seedVerifiedHost } from '../testing/fixtures.testing';
import { BudgetReconcileJob } from './budget-reconcile.job';
import {
  PublicationsService,
  PublicationsVerifyJob,
  pageVersionOf,
  type PageReadResult,
} from './publications.service';
import {
  apiAs,
  distStack,
  seedTd08,
  type DistStack,
} from './testing/td08.testing';

jest.setTimeout(120_000);

describe('pageVersionOf', () => {
  it('читает meta pub-version (любой порядок атрибутов, регистр hex)', () => {
    const h = 'A'.repeat(64);
    expect(
      pageVersionOf(`<head><meta name="pub-version" content="${h}"></head>`),
    ).toBe('a'.repeat(64));
    expect(
      pageVersionOf(`<meta content='${'b'.repeat(64)}' name='pub-version'/>`),
    ).toBe('b'.repeat(64));
    expect(pageVersionOf('<meta name="description" content="x">')).toBeNull();
  });
});

ciDescribe('задания P-C', () => {
  let s: DistStack;
  beforeAll(async () => {
    s = await distStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('все три задания P-C зарегистрированы с расписанием §15.1', () => {
    const jobs = s.mod.get(PubContributions).list('cron-job');
    for (const key of [
      'approvals-expire-purchase',
      'publications-verify',
      'budget-reconcile',
    ]) {
      const j = jobs.find((x) => x.key === key);
      expect(j?.schedule).toBe(PUB_CRON_SCHEDULE[key].schedule);
      expect(PUB_CRON_SCHEDULE[key].owner).toBe('P-C');
    }
  });

  it('publications-verify: pending + совпадение → published; 3 несовпадения → задача оператору; чужой хост не грузится', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    await seedVerifiedHost(
      s.prisma,
      w.acc.accountId,
      w.product.siteId,
      'ai-publisher.org',
    );
    const pages: Record<string, PageReadResult> = {};
    const reads: string[] = [];
    const job = new PublicationsVerifyJob(
      s.mod.get(SitesDb),
      s.mod.get(PubPorts),
      s.mod.get(PublicationsService),
      {
        read: async (url: string) => {
          reads.push(url);
          return pages[url] ?? { ok: false, status: 404 };
        },
      },
    );
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    // Ожидающая публикация по TD-08 версии: снимаем существующую и пишем pending.
    const existing = (await op.get(`${P}/publications`)).body.data.items[0];
    await op.post(`${P}/publications/${existing.id}/transition`, {
      to: 'withdrawn',
      reason: 'Перевипуск сторінки',
      expectedRevision: existing.revision,
    });
    const pend = await op
      .post(`${P}/publications`, {
        versionId: w.versionId,
        channelId: w.siteChannelId,
        pending: true,
      })
      .catch((e) => e);
    // Та же версия по тому же URL уже есть (withdrawn) — уникальность (channel, url, version).
    expect(pend.status).toBe(409);

    // Новая версия → pending.
    const v2 = await s.prisma.pubContentVersion.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        contentId: w.articleId,
        number: 2,
        title: 'v2',
        body: 'v2',
        meta: {},
        format: 'article',
        offerVersionId: (await s.prisma.pubContentVersion.findFirst({
          where: { id: w.versionId },
        }))!.offerVersionId,
        authorMemberId: 'td08-editor',
        status: 'submitted',
        hash: 'e'.repeat(64),
        frozenAt: new Date(),
        createdBy: 'member:td08-editor',
      },
    });
    await s.prisma.pubApproval.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: v2.id,
        versionHash: 'e'.repeat(64),
        approverMemberId: 'o',
        approverDisplayName: 'Власник',
        createdBy: 'member:o',
      },
    });
    const p2 = await op.post(`${P}/publications`, {
      versionId: v2.id,
      channelId: w.siteChannelId,
      pending: true,
    });
    expect(p2.body.data).toMatchObject({
      status: 'pending',
      publishedAt: null,
    });
    const url = p2.body.data.finalUrl as string;
    pages[url] = {
      ok: true,
      status: 200,
      html: `<html><head><meta name="pub-version" content="${'e'.repeat(64)}"></head></html>`,
    };
    const ctx = () => ({
      now: new Date(),
      scope: { siteIds: [w.product.siteId] },
      deadline: new Date(Date.now() + 30_000),
    });
    const r1 = await job.run(ctx());
    expect(r1.processed).toBeGreaterThanOrEqual(1);
    let row = await s.prisma.pubPublication.findFirst({
      where: { id: p2.body.data.id },
    });
    expect(row).toMatchObject({
      status: 'published',
      verifyStatus: 'ok',
      verifiedBy: 'system:publications-verify',
    });
    expect(s.content.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ versionId: v2.id, stage: 'test' }),
      ]),
    );
    // Сайт стал отдавать другую версию: три неудачи подряд → задача.
    pages[url] = { ok: true, status: 200, html: '<html><head></head></html>' };
    for (let i = 0; i < 3; i++) {
      await s.prisma.pubPublication.update({
        where: { id: p2.body.data.id },
        data: { lastVerifiedAt: new Date(Date.now() - 7 * 3_600_000) },
      });
      await job.run(ctx());
    }
    row = await s.prisma.pubPublication.findFirst({
      where: { id: p2.body.data.id },
    });
    expect(row).toMatchObject({
      status: 'published',
      verifyStatus: 'mismatch',
    });
    expect(row?.verifyResult).toMatch(/^fail:3:/);
    expect(
      await s.prisma.pubReviewTask.count({
        where: {
          productId: w.product.id,
          reason: 'publication_unverified',
          objectId: p2.body.data.id,
          status: 'open',
        },
      }),
    ).toBe(1);

    // Публикация на чужом хосте канала site не загружается.
    const foreign = await s.prisma.pubPublication.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        versionId: v2.id,
        channelId: w.siteChannelId,
        approvalId: (await s.prisma.pubApproval.findFirst({
          where: { objectId: v2.id },
        }))!.id,
        stage: 'test',
        finalUrl: 'https://evil.example/materials/x',
        status: 'pending',
        opKey: randomUUID(),
        createdBy: 'member:o',
      },
    });
    reads.length = 0;
    await job.checkOne(
      { id: foreign.id, accountId: w.ref.accountId, productId: w.ref.id },
      new Date(),
    );
    expect(reads).toEqual([]);
    expect(
      (await s.prisma.pubPublication.findFirst({ where: { id: foreign.id } }))
        ?.verifyResult,
    ).toMatch(/host_not_allowed/);
  });

  it('budget-reconcile: согласованный бюджет — без задачи; запись мимо функций → задача и STOPPED', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const e = (
      await op.post(`${P}/expenses`, {
        category: 'tools',
        description: 'Сервіс',
        amount: { currency: 'UAH', minor: '50000' },
      })
    ).body.data;
    const job = s.mod.get(BudgetReconcileJob);
    const ctx = {
      now: new Date('2026-10-13T08:00:00Z'),
      scope: { siteIds: [w.product.siteId] },
      deadline: new Date(Date.now() + 30_000),
    };
    const ok = await job.run(ctx);
    expect(ok.details).toMatchObject({ checked: 1, mismatches: 0 });
    // Запись оплаты мимо функций (ошибка кода/ручная правка базы).
    await s.prisma.pubExpenseEntry.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        expenseId: e.id,
        kind: 'pay',
        amountMinor: 10_000n,
        status: 'confirmed',
        occurredAt: new Date(),
        confirmedAt: new Date(),
        confirmedBy: 'member:x',
        opKey: randomUUID(),
        createdBy: 'member:x',
      },
    });
    const bad = await job.run(ctx);
    expect(bad.details).toMatchObject({ checked: 1, mismatches: 1 });
    const task = await s.prisma.pubReviewTask.findFirst({
      where: {
        productId: w.product.id,
        objectType: 'budget_limit',
        status: 'open',
      },
    });
    expect(task).toMatchObject({
      reason: 'other',
      severity: 'critical',
      triggerRef: 'budget-reconcile:2026-10-13',
    });
    // Повтор в тот же день задачу не дублирует.
    await job.run(ctx);
    expect(
      await s.prisma.pubReviewTask.count({
        where: { productId: w.product.id, objectType: 'budget_limit' },
      }),
    ).toBe(1);
    const stopped = await op.post(`${P}/expenses`, {
      category: 'tools',
      description: 'Ще сервіс',
      amount: { currency: 'UAH', minor: '100' },
    });
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toMatchObject({
      code: 'PUB_BUDGET_STOPPED',
      details: { reason: 'reconcile' },
    });
    const view = (await op.get(`${P}/budget`)).body.data;
    expect(view.reconcileStopped).toBe(true);
    expect(view.warnings).toContain('reconcile_stopped');
    // Владелец закрыл задачу, но расхождение осталось — функции сами не пропустят.
    await s.prisma.pubReviewTask.update({
      where: { id: task!.id },
      data: {
        status: 'resolved',
        resolution: 'Перевірено',
        resolvedBy: 'member:x',
        resolvedAt: new Date(),
      },
    });
    const still = await op.post(`${P}/expenses`, {
      category: 'tools',
      description: 'Ще сервіс',
      amount: { currency: 'UAH', minor: '100' },
    });
    expect(still.body.error).toMatchObject({
      code: 'PUB_BUDGET_STOPPED',
      details: { reason: 'counters_mismatch' },
    });
    const audit = await s.prisma.pubAuditEvent.findFirst({
      where: {
        productId: w.product.id,
        actor: 'system:budget-reconcile',
        objectType: 'budget_limit',
        action: 'update',
      },
    });
    // Оплата мимо функций сдвигает net_paid и open (used = net + open не меняется).
    expect(audit?.meta).toEqual({ fields: 'netPaid,openCommit,heads' });
  });
});
