/**
 * AT-CORE-02, серверная часть (P-D, проектный документ §6.2
 * `pub_rate_hits`, §11.4; аудит P2-10; ТЗ §8.3): не больше N новых отправок
 * за последние W секунд на технический источник (`form_limit`, умолчание
 * 5 / 600 с) — СКОЛЬЗЯЩЕЕ окно, без стыка корзин; 6-я → 429 с `Retry-After`
 * и альтернативным контактом; повтор той же отправки не считается и не
 * упирается в лимит; сброс тестового счётчика между сценариями; IPv6 —
 * по /64; сырой IP не хранится.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import {
  MemoryWindowLimiter,
  rateKey,
} from '../../modules/publisher/public/rate-limit';

jest.setTimeout(120_000);

describe('[AT-CORE-02] Лимит формы: окно чтений в памяти (unit)', () => {
  it('скользящее окно: limit в окне, затем отказ с ожиданием до выхода старейшего удара', () => {
    const l = new MemoryWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(l.hit('203.0.113.5', t0).ok).toBe(true);
    expect(l.hit('203.0.113.5', t0 + 10_000).ok).toBe(true);
    expect(l.hit('203.0.113.5', t0 + 20_000).ok).toBe(true);
    const no = l.hit('203.0.113.5', t0 + 30_000);
    expect(no).toEqual({ ok: false, count: 3, retryAfterSec: 30 });
    // Окно скользит: через 60 с после первого удара место освобождается.
    expect(l.hit('203.0.113.5', t0 + 60_001).ok).toBe(true);
    // IPv6 — по /64: соседний адрес той же сети — то же окно.
    const v6 = new MemoryWindowLimiter(1, 60_000);
    expect(v6.hit('2001:db8:1:2::1', t0).ok).toBe(true);
    expect(v6.hit('2001:db8:1:2::ffff', t0 + 1).ok).toBe(false);
    expect(v6.hit('2001:db8:1:3::1', t0 + 2).ok).toBe(true);
  });

  it('ключ окна — продукт, область и HMAC источника (сырого IP нет)', () => {
    expect(rateKey('p1', 'form', 'a'.repeat(64))).toBe(
      `p1:form:${'a'.repeat(64)}`,
    );
  });
});

ciDescribe(
  '[AT-CORE-02] Лимит формы на базе: скользящее окно pub_rate_hits',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let restore: Array<() => void>;

    const hitsOf = (productId: string) =>
      s.prisma.$queryRaw<Array<{ key: string; at: Date }>>`
      SELECT "key", "at" FROM "sites"."pub_rate_hits"
       WHERE "key" LIKE ${`${productId}:form:%`} ORDER BY "at"`;

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, {
        kind: 'test',
        formLimit: { count: 5, windowSec: 600 },
        altContact: { label: 'Напишіть нам', href: 'https://t.me/pubd_help' },
      });
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });
    beforeEach(async () => {
      await s.prisma
        .$executeRaw`DELETE FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${w.product.id}:%`}`;
    });

    it('6-я новая отправка за 600 с → 429 PUB_RATE_LIMITED, Retry-After, альтернативный контакт; сырой IP не хранится', async () => {
      const ip = '203.0.113.77';
      for (let i = 0; i < 5; i++) {
        const r = await postLead(s, leadBody(w.product.publicKey), {
          origin: w.origin,
          ip,
        });
        expect(r.status).toBe(201);
      }
      const body = leadBody(w.product.publicKey);
      const r = await postLead(s, body, { origin: w.origin, ip });
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('PUB_RATE_LIMITED');
      expect(r.body.error.details.altContact).toEqual({
        label: 'Напишіть нам',
        href: 'https://t.me/pubd_help',
      });
      const after = Number(r.headers['retry-after']);
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThanOrEqual(600);
      expect(r.body.error.details.retryAfterSec).toBe(after);
      expect(
        await s.prisma.pubLead.count({
          where: { submissionKey: body.submissionKey },
        }),
      ).toBe(0);
      const hits = await hitsOf(w.product.id);
      expect(hits).toHaveLength(5);
      for (const h of hits) {
        expect(h.key).toMatch(
          new RegExp(`^${w.product.id}:form:[0-9a-f]{64}$`),
        );
        expect(h.key).not.toContain(ip);
      }
    });

    it('окно скользящее: удары старше 600 с не считаются (стыка корзин нет)', async () => {
      const ip = randomIp();
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await postLead(s, leadBody(w.product.publicKey), {
              origin: w.origin,
              ip,
            })
          ).status,
        ).toBe(201);
      }
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(429);
      // Самый старый удар «уходит» за край окна (601 с назад) — одно место.
      const [oldest] = await hitsOf(w.product.id);
      await s.prisma.$executeRaw`
      UPDATE "sites"."pub_rate_hits" SET "at" = now() - interval '601 seconds'
       WHERE "key" = ${oldest.key} AND "at" = ${oldest.at}`;
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(429);
      // Удары за 599 с — ещё в окне (граница скольжения, не календарная корзина).
      await s.prisma.$executeRaw`
      UPDATE "sites"."pub_rate_hits" SET "at" = now() - interval '599 seconds'
       WHERE "key" LIKE ${`${w.product.id}:form:%`} AND "at" > now() - interval '600 seconds'`;
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(429);
    });

    it('повтор той же отправки после исчерпания лимита → 200 (не считается и не упирается)', async () => {
      const ip = randomIp();
      const first = leadBody(w.product.publicKey);
      expect((await postLead(s, first, { origin: w.origin, ip })).status).toBe(
        201,
      );
      for (let i = 0; i < 4; i++)
        await postLead(s, leadBody(w.product.publicKey), {
          origin: w.origin,
          ip,
        });
      const repeat = await postLead(s, first, { origin: w.origin, ip });
      expect(repeat.status).toBe(200);
      expect((await hitsOf(w.product.id)).length).toBe(5);
    });

    it('разные источники — разные окна; IPv6 одной /64 — одно окно', async () => {
      for (let i = 0; i < 5; i++) {
        await postLead(s, leadBody(w.product.publicKey), {
          origin: w.origin,
          ip: '2001:db8:aa:bb::1',
        });
      }
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip: '2001:db8:aa:bb::99',
          })
        ).status,
      ).toBe(429);
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip: '2001:db8:aa:cc::1',
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip: '203.0.113.200',
          })
        ).status,
      ).toBe(201);
    });

    it('сброс тестового счётчика (админ, маршрут ядра → порт P-D) возвращает лимит; у рабочего продукта в live сброса нет', async () => {
      const ip = randomIp();
      for (let i = 0; i < 5; i++)
        await postLead(s, leadBody(w.product.publicKey), {
          origin: w.origin,
          ip,
        });
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(429);
      const reset = await request(s.app!.getHttpServer())
        .post(`/publisher/products/${w.product.id}/test/rate-limit/reset`)
        .set(asMember(w.account.owner.telegramId, w.account.accountId))
        .send({ opKey: randomUUID() });
      expect(reset.status).toBe(200);
      expect(reset.body.data.removed).toBe(5);
      expect(
        (
          await postLead(s, leadBody(w.product.publicKey), {
            origin: w.origin,
            ip,
          })
        ).status,
      ).toBe(201);

      const live = await intakeProduct(s, { kind: 'working' });
      const denied = await request(s.app!.getHttpServer())
        .post(`/publisher/products/${live.product.id}/test/rate-limit/reset`)
        .set(asMember(live.account.owner.telegramId, live.account.accountId))
        .send({ opKey: randomUUID() });
      expect(denied.status).toBe(400);
    });

    it('утверждённый лимит продукта применяется (form_limit 2 / 60 с)', async () => {
      const tight = await intakeProduct(s, {
        kind: 'test',
        formLimit: { count: 2, windowSec: 60 },
      });
      const ip = randomIp();
      expect(
        (
          await postLead(s, leadBody(tight.product.publicKey), {
            origin: tight.origin,
            ip,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await postLead(s, leadBody(tight.product.publicKey), {
            origin: tight.origin,
            ip,
          })
        ).status,
      ).toBe(201);
      const third = await postLead(s, leadBody(tight.product.publicKey), {
        origin: tight.origin,
        ip,
      });
      expect(third.status).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('S3-12: без доверенного прокси (TRUSTED_PROXY_CIDRS пуст, не Vercel) подставной X-Forwarded-For игнорируется — 6-я → 429', async () => {
      const saved = {
        TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS,
        VERCEL: process.env.VERCEL,
      };
      delete process.env.TRUSTED_PROXY_CIDRS;
      delete process.env.VERCEL;
      try {
        const p = await intakeProduct(s, { kind: 'test' });
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          statuses.push(
            (
              await postLead(s, leadBody(p.product.publicKey), {
                origin: p.origin,
                ip: `198.51.100.${10 + i}`,
              })
            ).status,
          );
        }
        expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  },
);
