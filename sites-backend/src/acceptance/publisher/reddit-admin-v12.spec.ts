/**
 * [P-R-ADM] Внутренний API Админки, v1.2 (Р-RD-ADM-9…13) — полная работа из
 * Админки, только платформенный продукт и только Reddit/платформенные
 * объекты:
 *  - источники контента: список (без доказательств Reddit), ручной
 *    `manual_text|url` (иное — 400, без сети); отзыв ТОЛЬКО доказательства
 *    Reddit (`origin=reddit`) — источник контента, чужой — 404;
 *  - оффер и факты бренда платформенного продукта: создать, активировать
 *    (утверждает admin, решение `offer_active_version` — admin) → подсказка
 *    `hints.offerActiveVersion`;
 *  - отзыв согласования и «снять с плана» (`unschedule`, причина
 *    обязательна) Reddit-материала; согласование статьи P0 — 404;
 *  - снять отметку о публикации (`withdrawn`, причина) — только публикация
 *    Reddit-материала; иной переход — 409 admin_scope;
 *  - опрос вызова AI — только `pub.reddit.draft` этого продукта;
 *  - журнал доступа в базе (`pub_reddit_admin_access_log`): шаблон маршрута без id,
 *    актор admin, статус; append-only, ретенция 365 дней;
 *  - секрет — ДО разбора тела: тело > 1 МБ с неверным секретом — 401, не 413.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  approvedArticle,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { AdminAccessLogRetentionJob } from '../../modules/publisher/reddit/admin/admin-access-log';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  approvedVersion,
  ok,
  openRedditPublish,
  redditAi,
  redditDraftJson,
  redditStack,
  redditWorld,
  seedStudio,
  type RedditAi,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(300_000);

const ACTOR = `admin:${ADMIN_USER}`;
const ghost = () =>
  `c${randomUUID().replace(/-/g, '').slice(0, 24)}`.replace(/[0-9]/g, 'z');
const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: { code?: string; details?: unknown } };
  return {
    status: r.status,
    code: b?.error?.code ?? null,
    details: b?.error?.details ?? null,
  };
};

ciDescribe(
  '[P-R-ADM] Админка v1.2: источники, оффер и бренд, отзывы, публикации, AI, журнал доступа',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let wb: RedditWorld;
    let A: AdminApi;
    let ai: RedditAi;
    let net: EgressWatch;
    let restore: () => void;
    let own: StudioIds;
    let foreign: StudioIds;
    let article: {
      versionId: string;
      approvalId: string;
      publicationId: string;
    };

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s, 'working');
      wb = await redditWorld(s, 'working');
      restore = useAdminEnv(w.acc.siteId);
      ai = await redditAi(s, w);
      await openRedditPublish(s.prisma, w);
      A = adminApi(s);
      own = await seedStudio(
        s,
        w,
        api(s, w.acc.accountId, w.team.editor),
        api(s, w.acc.accountId, w.team.product_owner),
      );
      foreign = await seedStudio(
        s,
        wb,
        api(s, wb.acc.accountId, wb.team.editor),
        api(s, wb.acc.accountId, wb.team.product_owner),
      );
      const art = await approvedArticle(
        new Kit(s as unknown as ContentStack, w.acc, w.product),
      );
      // Публикация статьи — до смены оффера (новый оффер снимает согласования).
      const artPub = await new Kit(
        s as unknown as ContentStack,
        w.acc,
        w.product,
      ).publish(art.version.id, 'test', `adm-${Date.now()}`);
      article = {
        versionId: art.version.id,
        approvalId: art.approval.id,
        publicationId: artPub,
      };
      net = watchEgress();
    });
    afterAll(async () => {
      net?.restore();
      ai?.restore();
      restore?.();
      await s?.close();
    });

    it('источники: список без доказательств Reddit; ручной manual_text|url — да (актор admin, без сети), иной вид — 400', async () => {
      const list = ok<{ items: Array<{ id: string }> }>(
        await A.get('cx/sources'),
        200,
      );
      const reddit = await s.prisma.pubSource.findMany({
        where: { productId: w.product.id, origin: 'reddit' },
        select: { id: true },
      });
      expect(reddit.length).toBeGreaterThan(0);
      expect(list.items.map((x) => x.id)).toContain(own.sourceId);
      for (const r of reddit)
        expect(list.items.map((x) => x.id)).not.toContain(r.id);
      const created = ok<{ id: string }>(
        await A.post('cx/sources', {
          kind: 'manual_text',
          title: 'Методика платформи',
          fragment: 'Один перевірений матеріал — кілька форматів.',
          visibility: 'private',
          usage: 'allowed',
        }),
        201,
      );
      const row = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect([row.createdBy, row.origin, row.productId]).toEqual([
        ACTOR,
        'content',
        w.product.id,
      ]);
      ok(
        await A.post('cx/sources', {
          kind: 'url',
          url: 'https://example.com/methodology',
          title: 'Сторінка методики',
          fragment: 'Опис методики своїми словами.',
          visibility: 'public',
          usage: 'allowed',
        }),
        201,
      );
      for (const kind of ['document', 'discussion', 'interview', undefined]) {
        const r = await A.post('cx/sources', {
          kind,
          title: 'x',
          fragment: 'y',
          visibility: 'private',
          usage: 'allowed',
        });
        expect({ kind, ...shape(r) }).toEqual({
          kind,
          status: 400,
          code: 'PUB_VALIDATION',
          details: { fields: [{ field: 'kind', code: 'enum' }] },
        });
      }
      expect(net.outbound).toEqual([]);
      expect(net.foreign()).toEqual([]);
    });

    it('отзыв: доказательство Reddit платформенного продукта — да; источник контента, чужое, несуществующее — 404', async () => {
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: own.snapshotId! },
      });
      const fsnap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: foreign.snapshotId! },
      });
      const g = shape(
        await A.post(`cx/sources/${ghost()}/revoke`, { reason: 'Перевірка' }),
      );
      expect(g.status).toBe(404);
      expect(
        shape(
          await A.post(`cx/sources/${own.sourceId}/revoke`, {
            reason: 'Перевірка',
          }),
        ),
      ).toEqual(g);
      expect(
        shape(
          await A.post(`cx/sources/${fsnap.sourceId}/revoke`, {
            reason: 'Перевірка',
          }),
        ),
      ).toEqual(g);
      const r = ok<{ source: { usage: string } }>(
        await A.post(`cx/sources/${snap.sourceId}/revoke`, {
          reason: 'Першоджерело правил застаріло',
        }),
        200,
      );
      expect(r.source.usage).toBe('revoked');
      const comm = ok<{ rules: { gate: { reasons: string[] } } | null }>(
        await A.get(`rx/communities/${own.communityId}`),
        200,
      );
      expect(JSON.stringify(comm)).toContain('rules_source_revoked');
      expect(
        (
          await s.prisma.pubSource.findUniqueOrThrow({
            where: { id: own.sourceId },
          })
        ).usage,
      ).toBe('allowed');
    });

    it('оффер и факты бренда платформенного продукта: создать и активировать актором admin → гейт reddit_publish видит оффер', async () => {
      const fact = ok<{ fact: { id: string } } & { id?: string }>(
        await A.post('cx/brand-facts', {
          factKey: 'platform.since',
          kind: 'fact',
          value: { text: 'Платформа працює з 2024 року' },
        }),
        201,
      );
      const factId =
        (fact as { fact?: { id: string } }).fact?.id ??
        (fact as { id: string }).id;
      ok(
        await A.post(`cx/brand-facts/${factId}/activate`, {
          basis: 'Підтверджено оператором платформи',
        }),
        200,
      );
      const frow = await s.prisma.pubBrandFact.findUniqueOrThrow({
        where: { id: factId },
      });
      expect([frow.status, frow.approvedBy]).toEqual(['active', ACTOR]);
      ok(await A.get('cx/brand-facts'), 200);
      const offer = ok<{ id: string }>(
        await A.post('cx/offers', {
          title: 'Платформа: супровід Reddit',
          text: 'Ручний режим: дослідження, чернетки, перевірка правил.',
        }),
        201,
      );
      const act = await A.post(`cx/offers/${offer.id}/activate`, {
        basis: 'Оффер платформи затверджено оператором',
      });
      expect(act.status).toBe(200);
      const orow = await s.prisma.pubOfferVersion.findUniqueOrThrow({
        where: { id: offer.id },
      });
      expect([orow.status, orow.approvedBy]).toEqual(['active', ACTOR]);
      const dec = await s.prisma.pubParameterDecision.findFirstOrThrow({
        where: {
          productId: w.product.id,
          parameterKey: 'offer_active_version',
        },
        orderBy: { decidedAt: 'desc' },
      });
      expect(dec.decidedBy).toBe(ACTOR);
      const params = ok<{
        hints: { offerActiveVersion: { offerVersionId: string } };
      }>(await A.get('params'), 200);
      expect(params.hints.offerActiveVersion.offerVersionId).toBe(offer.id);
      const offers = ok<{ items: Array<{ id: string }> }>(
        await A.get('cx/offers'),
        200,
      );
      expect(offers.items.map((x) => x.id)).toContain(offer.id);
      // Чужой оффер — 404, как несуществующий.
      const fo = await s.prisma.pubOfferVersion.findFirstOrThrow({
        where: { productId: wb.product.id },
      });
      expect(
        shape(
          await A.post(`cx/offers/${fo.id}/activate`, {
            basis: 'xxxxxxxxxxxx',
          }),
        ),
      ).toEqual(
        shape(
          await A.post(`cx/offers/${ghost()}/activate`, {
            basis: 'xxxxxxxxxxxx',
          }),
        ),
      );
    });

    it('согласование: отзыв согласования Reddit-материала — да; статьи P0 — 404; «снять с плана» после копирования — с причиной', async () => {
      const ids = await seedStudio(
        s,
        w,
        api(s, w.acc.accountId, w.team.editor),
        api(s, w.acc.accountId, w.team.product_owner),
      );
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const v = await approvedVersion(ed, po, w, ids);
      const appr = await s.prisma.pubApproval.findFirstOrThrow({
        where: { objectId: v.id, status: 'active' },
      });
      const g = shape(
        await A.post(`cx/approvals/${ghost()}/revoke`, { reason: 'Перевірка' }),
      );
      expect(
        shape(
          await A.post(`cx/approvals/${article.approvalId}/revoke`, {
            reason: 'Перевірка',
          }),
        ),
      ).toEqual(g);
      expect(g.status).toBe(404);
      // Копирование переводит approved → scheduled; «снять с плана» — назад.
      ok(await A.post(`rx/contents/${ids.contentId}/copy`), 200);
      let c = await s.prisma.pubContent.findUniqueOrThrow({
        where: { id: ids.contentId },
      });
      expect(c.status).toBe('scheduled');
      expect(
        shape(
          await A.post(`cx/contents/${ids.contentId}/transition`, {
            expectedRevision: c.revision,
            to: 'approved',
          }),
        ),
      ).toMatchObject({
        status: 400,
        details: { fields: [{ field: 'reason', code: 'required' }] },
      });
      ok(
        await A.post(`cx/contents/${ids.contentId}/transition`, {
          expectedRevision: c.revision,
          to: 'approved',
          reason: 'Публікацію перенесено',
        }),
        200,
      );
      c = await s.prisma.pubContent.findUniqueOrThrow({
        where: { id: ids.contentId },
      });
      expect(c.status).toBe('approved');
      // v1.3: id отзыва — из вида материала (`approval`), без ручного ввода.
      type Mat = {
        approvedVersion: { id: string } | null;
        approval: {
          id: string;
          versionId: string;
          status: string;
          selfReview: boolean;
          decidedAt: string;
        } | null;
      };
      const mat = ok<Mat>(await A.get(`rx/contents/${ids.contentId}`), 200);
      expect(mat.approval).toEqual({
        id: appr.id,
        versionId: v.id,
        status: 'active',
        selfReview: appr.selfReview,
        decidedAt: appr.decidedAt.toISOString(),
      });
      expect(mat.approvedVersion?.id).toBe(v.id);
      const rev = ok<{ status: string }>(
        await A.post(`cx/approvals/${mat.approval!.id}/revoke`, {
          reason: 'Правила спільноти змінились',
        }),
        200,
      );
      expect(rev.status).toBe('revoked');
      const after = ok<Mat>(await A.get(`rx/contents/${ids.contentId}`), 200);
      expect(after.approval).toBeNull();
    });

    it('публикация: снять отметку (withdrawn, причина) — только Reddit-материал; иной переход — 409 admin_scope; чужое — 404', async () => {
      const ids = await seedStudio(
        s,
        w,
        api(s, w.acc.accountId, w.team.editor),
        api(s, w.acc.accountId, w.team.product_owner),
      );
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      await approvedVersion(ed, po, w, ids);
      ok(await A.post(`rx/contents/${ids.contentId}/copy`), 200);
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: ids.opportunityId! },
      });
      const pub = ok<{ id: string; revision: number }>(
        await A.post(`rx/contents/${ids.contentId}/report-publication`, {
          url: `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/x/k1v12/`,
          postedAt: new Date().toISOString(),
        }),
        201,
      );
      const row = await s.prisma.pubPublication.findUniqueOrThrow({
        where: { id: pub.id },
      });
      const other = await A.post(`cx/publications/${pub.id}/transition`, {
        to: 'failed',
        expectedRevision: row.revision,
        reason: 'x',
      });
      expect(shape(other)).toMatchObject({
        status: 409,
        code: 'PUB_TRANSITION_INVALID',
        details: { reason: 'admin_scope' },
      });
      const g = shape(
        await A.post(`cx/publications/${ghost()}/transition`, {
          to: 'withdrawn',
          expectedRevision: 1,
          reason: 'x',
        }),
      );
      expect(g.status).toBe(404);
      const done = ok<{ status: string }>(
        await A.post(`cx/publications/${pub.id}/transition`, {
          to: 'withdrawn',
          expectedRevision: row.revision,
          reason: 'Пост видалено модераторами',
        }),
        200,
      );
      expect(done.status).toBe('withdrawn');
      // Публикация статьи P0 того же (платформенного) продукта — как
      // несуществующая: снимать из Админки можно только Reddit-отметки.
      const ap = await s.prisma.pubPublication.findUniqueOrThrow({
        where: { id: article.publicationId },
      });
      expect(
        shape(
          await A.post(`cx/publications/${ap.id}/transition`, {
            to: 'withdrawn',
            expectedRevision: ap.revision,
            reason: 'x',
          }),
        ),
      ).toEqual(g);
      expect(
        (
          await s.prisma.pubPublication.findUniqueOrThrow({
            where: { id: ap.id },
          })
        ).status,
      ).toBe(ap.status);
    });

    it('опрос вызова AI: pub.reddit.draft платформенного продукта — да; иной генератор, чужой, несуществующий — 404', async () => {
      const ids = await seedStudio(
        s,
        w,
        api(s, w.acc.accountId, w.team.editor),
        api(s, w.acc.accountId, w.team.product_owner),
        { withContent: false },
      );
      ai.model.reply(redditDraftJson(2, 'comment', ids.sourceId));
      const gen = ok<{ callId: string }>(
        await A.post(`rx/briefs/${ids.briefId}/generate`, {
          template: 'helpful_answer',
          variants: 2,
        }),
        200,
      );
      const view = ok<{ callId: string; generator: string; status: string }>(
        await A.get(`cx/ai/calls/${gen.callId}`),
        200,
      );
      expect(view).toMatchObject({
        callId: gen.callId,
        generator: 'pub.reddit.draft',
        status: 'ok',
      });
      const kit = new Kit(s as unknown as ContentStack, w.acc, w.product);
      const helperCall = await kit.aiCall('pub.helper.answer', { answer: 'x' });
      const g = shape(await A.get(`cx/ai/calls/${ghost()}`));
      expect(g.status).toBe(404);
      expect(shape(await A.get(`cx/ai/calls/${helperCall}`))).toEqual(g);
    });

    it('журнал доступа: строки в базе — актор admin, шаблон маршрута без id, статус; append-only; ретенция 365 дней', async () => {
      const before = new Date(Date.now() - 1000);
      await A.get(`rx/projects/${own.projectId}`);
      await A.get('status');
      await A.post(`cx/sources/${ghost()}/revoke`, { reason: 'x' });
      await adminApi(s, { secret: 'w'.repeat(40) }).get('status');
      const want = [
        `${ACTOR} GET rx/projects/:id 200`,
        `${ACTOR} GET status 200`,
        `${ACTOR} POST cx/sources/:id/revoke 404`,
      ];
      let rows: Array<{
        id: string;
        actor: string;
        method: string;
        route: string;
        status: number;
      }> = [];
      let mine: string[] = [];
      // Строка пишется после ответа (событие finish) — ждём её.
      for (let i = 0; i < 100; i++) {
        rows = await s.prisma.pubRedditAdminAccessLog.findMany({
          where: { at: { gte: before } },
          orderBy: { at: 'asc' },
        });
        mine = rows.map((r) => `${r.actor} ${r.method} ${r.route} ${r.status}`);
        if (want.every((x) => mine.includes(x))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(mine).toEqual(expect.arrayContaining(want));
      expect(JSON.stringify(rows)).not.toContain(own.projectId);
      // Неверный секрет — без актора, в журнал не попадает.
      expect(rows.every((r) => r.actor === ACTOR)).toBe(true);
      const fresh = rows[0];
      await expect(
        s.prisma.pubRedditAdminAccessLog.update({
          where: { id: fresh.id },
          data: { status: 200 },
        }),
      ).rejects.toThrow(/append-only|23514|pub_/);
      await expect(
        s.prisma.pubRedditAdminAccessLog.delete({ where: { id: fresh.id } }),
      ).rejects.toThrow(/старше 365 дней|23514|pub_/);
      await expect(
        s.prisma.pubRedditAdminAccessLog.create({
          data: {
            actor: 'member:x',
            method: 'GET',
            route: 'status',
            status: 200,
          },
        }),
      ).rejects.toThrow(/23514|pub_/);
      const old = await s.prisma.pubRedditAdminAccessLog.create({
        data: {
          actor: ACTOR,
          method: 'GET',
          route: 'status',
          status: 200,
          at: new Date(Date.now() - 366 * 86_400_000),
        },
      });
      const job = s.mod.get(AdminAccessLogRetentionJob);
      const out = await job.run({
        now: new Date(),
        deadline: new Date(Date.now() + 30_000),
      } as never);
      expect(out.processed).toBeGreaterThanOrEqual(1);
      expect(
        await s.prisma.pubRedditAdminAccessLog.findUnique({
          where: { id: old.id },
        }),
      ).toBeNull();
      expect(
        await s.prisma.pubRedditAdminAccessLog.findUnique({
          where: { id: fresh.id },
        }),
      ).not.toBeNull();
    });

    it('секрет — до разбора тела: импорт > 1 МБ с неверным секретом — 401 (не 413), без строк журнала', async () => {
      const big = {
        communitiesCsv: 'x'.repeat(1024 * 1024 + 100),
        projectTitle: 'x',
        locale: 'en',
        market: 'US',
      };
      const wrong = await adminApi(s, { secret: 'w'.repeat(40) }).postRaw(
        'import/plan',
        big,
      );
      expect(shape(wrong)).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      const none = await adminApi(s, { secret: null }).postRaw(
        'import/apply',
        big,
      );
      expect(shape(none)).toEqual(shape(wrong));
      expect((wrong.body as { error: { message: string } }).error.message).toBe(
        (await adminApi(s, { secret: 'w'.repeat(40) }).get('status')).body.error
          .message,
      );
      const right = await A.postRaw('import/plan', big);
      expect(right.status).toBe(413);
    });
  },
);
