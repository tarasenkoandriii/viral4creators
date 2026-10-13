/**
 * [AT-F10-01] Площадки по одинаковым критериям (P-C, проектный документ
 * §6.4, §7.2; F10): десять кандидатов оцениваются по одним и тем же пяти
 * критериям 0–2 с пояснением; пять карточек становятся `verified` только с
 * условиями (пять обязательных проверок, маркировка ссылки) и источником
 * данных (`pub_venue_evidence`); полнота показывается отдельно от балла,
 * неизвестное не усредняется. AI-сравнение в P0 выключено (ДТ-2).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  distStack,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

const ALL_CHECKS = {
  topicMarket: true,
  priceConfirmed: true,
  formatConfirmed: true,
  termSet: true,
  supplierKnown: true,
};

ciDescribe(
  '[AT-F10-01] десять кандидатов → пять verified с условиями и доказательствами',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('одинаковые критерии; verified — с проверками, маркировкой и доказательством; полнота ≠ балл', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const P = `/publisher/products/${w.product.id}`;
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await op.post(`${P}/venues`, {
          title: `Майданчик ${i + 1}`,
          url: `https://venue${i + 1}.example`,
          topic: 'Маркетинг для малого бізнесу',
          market: 'UA',
          language: 'uk',
          formats: ['article'],
          criteria: {
            topic: { score: 2, why: 'Тематика збігається' },
            geo_language: { score: i % 2 ? 1 : 2, why: 'Україна' },
            format: { score: 1, why: 'Партнерська стаття' },
            evidence_freshness: {
              score: i < 5 ? 1 : null,
              why: i < 5 ? 'Дані за місяць' : 'Невідомо',
            },
            real_distribution: { score: null, why: 'Немає даних про розсилку' },
          },
        });
        expect(r.status).toBe(201);
        ids.push(r.body.data.id);
      }
      const list = (
        await op.get(`${P}/venues?limit=20`)
      ).body.data.items.filter((v: { id: string }) => ids.includes(v.id));
      expect(list).toHaveLength(10);
      for (const v of list) {
        // Однакові критерії у всіх карток.
        expect(Object.keys(v.criteria).sort()).toEqual(
          [
            'evidence_freshness',
            'format',
            'geo_language',
            'real_distribution',
            'topic',
          ].sort(),
        );
        expect(v.status).toBe('candidate');
      }
      const one = (await op.get(`${P}/venues/${ids[0]}`)).body.data;
      // Невідоме не усереднюється: max — лише з відомих критеріїв.
      expect(one.score).toEqual({ sum: 6, max: 8, known: 4 });
      expect(one.completeness).toBe(4);
      const six = (await op.get(`${P}/venues/${ids[5]}`)).body.data;
      expect(six.score).toEqual({ sum: 4, max: 6, known: 3 });
      expect(six.completeness).toBe(3);
      expect(six.missingForVerified).toEqual(
        expect.arrayContaining([
          'checks.topicMarket',
          'linkMarking',
          'evidence',
        ]),
      );

      // Перевірка без умов — відмова з переліком.
      const early = await op.post(`${P}/venues/${ids[0]}/transition`, {
        to: 'verified',
        expectedRevision: one.revision,
      });
      expect(early.status).toBe(400);
      expect(
        early.body.error.details.fields.map((f: { field: string }) => f.field),
      ).toEqual(
        expect.arrayContaining([
          'checks.priceConfirmed',
          'linkMarking',
          'evidence',
        ]),
      );

      for (const id of ids.slice(0, 5)) {
        const cur = (await op.get(`${P}/venues/${id}`)).body.data;
        const p = await op.patch(`${P}/venues/${id}`, {
          checks: ALL_CHECKS,
          linkMarking: 'sponsored',
          evidence: [
            {
              criterion: 'topic',
              sourceId: w.sourceId,
              checkedAt: '2026-10-12T10:00:00.000Z',
            },
          ],
          expectedRevision: cur.revision,
        });
        expect(p.status).toBe(200);
        expect(p.body.data.missingForVerified).toEqual([]);
        const v = await op.post(`${P}/venues/${id}/transition`, {
          to: 'verified',
          expectedRevision: p.body.data.revision,
        });
        expect(v.status).toBe(200);
        expect(v.body.data).toMatchObject({
          status: 'verified',
          linkMarking: 'sponsored',
        });
        expect(v.body.data.evidence).toEqual([
          expect.objectContaining({ criterion: 'topic', sourceId: w.sourceId }),
        ]);
      }
      const verified = (await op.get(`${P}/venues?status=verified`)).body.data
        .items;
      // + площадка TD-08.
      expect(verified).toHaveLength(6);

      // Отклонение — с причиной.
      const r10 = (await op.get(`${P}/venues/${ids[9]}`)).body.data;
      expect(
        (
          await op.post(`${P}/venues/${ids[9]}/transition`, {
            to: 'rejected',
            expectedRevision: r10.revision,
          })
        ).status,
      ).toBe(400);
      const rej = await op.post(`${P}/venues/${ids[9]}/transition`, {
        to: 'rejected',
        reason: 'Високий ризик: накрутка переглядів',
        expectedRevision: r10.revision,
      });
      expect(rej.body.data).toMatchObject({
        status: 'rejected',
        rejectReason: 'Високий ризик: накрутка переглядів',
      });

      const ai = await op.post(`${P}/venues/compare`, {
        venueIds: ids.slice(0, 2),
      });
      expect(ai.status).toBe(409);
      expect(ai.body.error).toMatchObject({
        code: 'PUB_AI_DISABLED',
        details: { generator: 'pub.venues.compare' },
      });
    });
  },
);
