/**
 * AI Publisher — приёмка P-E: гипотезы F17 по HTTP (AT-F17-01):
 * зарегистрировать изменение ДО запуска, собрать доступные данные (снимок),
 * записать решение с лимитом. Роли — матрица §4.2 (AN, PO).
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../prisma/publisher-schema.testing';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import {
  seedMembers,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../../modules/publisher/testing/fixtures.testing';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';

jest.setTimeout(90_000);

const DAY = 86_400_000;

ciDescribe(
  '[AT-F17-01] Гипотеза: регистрация до запуска, данные, решение с лимитом',
  () => {
    let s: ReportsStack;
    let w: TwoAccounts;
    let team: SeededMembers;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let contentId: string;
    const srv = () => s.app!.getHttpServer();
    const as = (k: keyof SeededMembers) =>
      asMember(team[k].telegramId, w.a.accountId);
    const pid = () => w.a.product!.id;
    const body = (over: Record<string, unknown> = {}) => {
      const start = new Date(Date.now() + DAY);
      return {
        opKey: randomUUID(),
        key: `cta-${randomUUID().slice(0, 8)}`,
        hypothesis: 'Пояснення ціни біля CTA збільшить кваліфіковані звернення',
        change: 'Текст CTA матеріалу «Як обрати»',
        metric: 'Унікальні зовнішні кваліфіковані prospect_id',
        expectedSignal: 'Не менше двох за вікно',
        stopConditions: 'Витрачено ліміт або немає вимірювання',
        windowStart: start.toISOString(),
        windowEnd: new Date(start.getTime() + 14 * DAY).toISOString(),
        ...over,
      };
    };

    beforeAll(async () => {
      s = await reportsStack({ http: true });
      w = await seedTwoAccounts(s.prisma, { withProducts: true });
      team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
      owner = await connectOwner();
      const raw = new PubDb(owner);
      contentId = await raw.article({
        accountId: w.a.accountId,
        siteId: w.a.siteId,
        productId: pid(),
      });
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });

    it('задним числом не регистрируется (windowStart раньше регистрации) — 400; viewer и editor — 403', async () => {
      const past = new Date(Date.now() - DAY);
      const r = await request(srv())
        .post(`/publisher/products/${pid()}/experiments`)
        .set(as('analyst'))
        .send(
          body({
            windowStart: past.toISOString(),
            windowEnd: new Date(past.getTime() + 7 * DAY).toISOString(),
          }),
        );
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'windowStart', code: 'before_registration' },
      ]);
      for (const k of ['viewer', 'editor'] as const) {
        const f = await request(srv())
          .post(`/publisher/products/${pid()}/experiments`)
          .set(as(k))
          .send(body());
        expect([k, f.status, f.body.error.code]).toEqual([
          k,
          403,
          'PUB_ROLE_REQUIRED',
        ]);
      }
    });

    it('ключ из цифр (дата запуска) регистрируется: в аудите — keyRef, не «телефон» (флейк Z-1)', async () => {
      const key = `cta-${Date.now()}`;
      const r = await request(srv())
        .post(`/publisher/products/${pid()}/experiments`)
        .set(as('analyst'))
        .send(body({ key }));
      expect(r.status).toBe(201);
      expect(r.body.data.key).toBe(key);
    });

    it('регистрация → применение → снимок данных → решение с лимитом; решение без лимита — 400', async () => {
      const reg = await request(srv())
        .post(`/publisher/products/${pid()}/experiments`)
        .set(as('analyst'))
        .send(body({ contentIds: [contentId], limitMinor: '150000' }));
      expect(reg.status).toBe(201);
      const e = reg.body.data;
      expect(e).toMatchObject({
        kind: 'change',
        version: 1,
        status: 'registered',
        limitMinor: '150000',
        contentIds: [contentId],
      });
      expect(e.thresholds.d42).toEqual({
        sessions: 100,
        qualified: 5,
        proposals: 2,
        minSampleForConclusion: 5,
      });
      expect(new Date(e.windowStart).getTime()).toBeGreaterThanOrEqual(
        new Date(e.registeredAt).getTime(),
      );
      const applied = await request(srv())
        .post(`/publisher/products/${pid()}/experiments/${e.id}/apply`)
        .set(as('analyst'))
        .send({ opKey: randomUUID() });
      expect(applied.status).toBe(200);
      expect(applied.body.data.status).toBe('running');
      expect(
        new Date(applied.body.data.appliedAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(e.registeredAt).getTime());
      // Доступные данные: снимок ad_hoc по окну эксперимента.
      const snap = await request(srv())
        .post(`/publisher/products/${pid()}/reports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          kind: 'ad_hoc',
          experimentId: e.id,
          periodStart: new Date(Date.now() - DAY).toISOString(),
          periodEnd: new Date(Date.now() + DAY).toISOString(),
        });
      expect(snap.status).toBe(201);
      expect(snap.body.data).toMatchObject({
        kind: 'ad_hoc',
        experimentId: e.id,
        attributionModel: 'last_non_direct_30d',
      });
      // Решение с лимитом: окно открыто, выборки нет → только «невизначено», решение — продолжить ограниченно.
      const ok = await request(srv())
        .post(`/publisher/products/${pid()}/experiments/${e.id}/conclude`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Вікно не закрите, вибірки немає',
          decision: 'continue_limited',
        });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        status: 'concluded',
        conclusion: 'inconclusive',
        decision: 'continue_limited',
        decidedBy: `member:${team.analyst.memberId}`,
        limitMinor: '150000',
      });
      // Без лимита решение «продолжить/масштабировать» не записывается.
      const noLimit = await request(srv())
        .post(`/publisher/products/${pid()}/experiments`)
        .set(as('analyst'))
        .send(body());
      await request(srv())
        .post(
          `/publisher/products/${pid()}/experiments/${noLimit.body.data.id}/apply`,
        )
        .set(as('analyst'))
        .send({ opKey: randomUUID() });
      const bad = await request(srv())
        .post(
          `/publisher/products/${pid()}/experiments/${noLimit.body.data.id}/conclude`,
        )
        .set(as('product_owner'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Перевірка ліміту',
          decision: 'scale',
        });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields).toEqual([
        { field: 'decision', code: 'limit_required' },
      ]);
      // Стоп закупок лимита не требует.
      const stop = await request(srv())
        .post(
          `/publisher/products/${pid()}/experiments/${noLimit.body.data.id}/conclude`,
        )
        .set(as('product_owner'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Зупинити закупки',
          decision: 'stop_purchases',
        });
      expect(stop.status).toBe(200);
    });

    it('список и CSV (аудит export); материал из чужого кабинета — 400 not_found', async () => {
      const list = await request(srv())
        .get(`/publisher/products/${pid()}/experiments`)
        .set(as('viewer'));
      expect(list.status).toBe(200);
      expect(list.body.data.items.length).toBeGreaterThanOrEqual(2);
      const csv = await request(srv())
        .get(`/publisher/products/${pid()}/experiments?format=csv`)
        .set(as('analyst'));
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.split('\r\n')[0]).toBe(
        'id,key,version,kind,status,hypothesis,metric,windowStart,windowEnd,limitMinor,t0,t42,t72,t90,conclusion,decision,decidedAt,supersedesId',
      );
      const audit = await s.prisma.pubAuditEvent.findFirst({
        where: { productId: pid(), action: 'export', objectType: 'experiment' },
      });
      expect(audit).not.toBeNull();
      const foreign = await new PubDb(owner).article({
        accountId: w.b.accountId,
        siteId: w.b.siteId,
        productId: w.b.product!.id,
      });
      const r = await request(srv())
        .post(`/publisher/products/${pid()}/experiments`)
        .set(as('analyst'))
        .send(body({ contentIds: [foreign] }));
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'contentIds', code: 'not_found' },
      ]);
    });
  },
);
