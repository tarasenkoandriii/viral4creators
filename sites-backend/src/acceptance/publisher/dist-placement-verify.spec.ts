/**
 * [AT-F10, S1-2] Проверка размещения закупки (P-C, проектный документ §7.2;
 * ТЗ §13 «публикация проверена»): фактический URL размещения записывается
 * при `published` (публикация в канале `paid-venues`) и должен быть на
 * площадке закупки; `verified_complete` — только если URL совпадает с
 * записанным, на странице найдена ВЫДАННАЯ ссылка (utm_content =
 * placementCode, кампания, адрес назначения), маркировка — обещанная, а
 * доказательство приложено. Чужой URL или ссылка без UTM размещения — 400,
 * закупка остаётся `published`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F10] проверка размещения: URL, ссылка с UTM, маркировка, доказательство',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('чужой URL → 400 и не verified_complete; URL площадки записан публикацией; проверка пишет доказательство', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
      });
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      let pl = (
        await op.post(`${P}/placements/${x.placementId}/reserve`, {
          expectedRevision: x.revision,
        })
      ).body.data;
      pl = (
        await op.post(`${P}/placements/${x.placementId}/order`, {
          externalOrderId: 'ORD-V1',
          expectedRevision: pl.revision,
        })
      ).body.data;
      pl = (
        await op.post(`${P}/placements/${x.placementId}/publication`, {
          publishDueAt: new Date(Date.now() + 86_400_000).toISOString(),
          expectedRevision: pl.revision,
        })
      ).body.data;

      // Опубликовано — но не на площадке закупки.
      const foreign = await op.post(
        `${P}/placements/${x.placementId}/published`,
        {
          url: 'https://unrelated.example/x',
          publishedAt: new Date().toISOString(),
          expectedRevision: pl.revision,
        },
      );
      expect(foreign.status).toBe(400);
      expect(foreign.body.error.details.fields).toEqual([
        { field: 'url', code: 'venue_mismatch' },
      ]);
      const url = 'https://www.venue.example/blog/post-7/';
      const pub = await op.post(`${P}/placements/${x.placementId}/published`, {
        url,
        publishedAt: new Date().toISOString(),
        expectedRevision: pl.revision,
      });
      expect(pub.status).toBe(200);
      expect(pub.body.data.status).toBe('published');
      const rec = await s.prisma.pubPublication.findFirstOrThrow({
        where: {
          productId: w.product.id,
          channel: { code: 'paid-venues' },
        },
        include: { channel: { select: { kind: true } } },
      });
      expect(rec).toMatchObject({
        finalUrl: 'https://www.venue.example/blog/post-7',
        versionId: w.versionId,
        stage: 'test',
        status: 'published',
        verifyStatus: 'not_checked',
        channel: { kind: 'paid_venue' },
      });

      const good = {
        url: 'https://www.venue.example/blog/post-7',
        linkUrl: pl.issuedUrl as string,
        evidenceUrl: 'https://archive.example/post-7.png',
        marking: 'sponsored',
        expectedRevision: pub.body.data.revision,
      };
      const bad = async (patch: Record<string, unknown>) => {
        const r = await op.post(`${P}/placements/${x.placementId}/verify`, {
          ...good,
          ...patch,
        });
        expect(r.status).toBe(400);
        return r.body.error.details.fields as Array<{
          field: string;
          code: string;
        }>;
      };
      // Аудит P3b: чужой URL без UTM.
      expect(
        await bad({
          url: 'https://totally-other.example/no-utm',
          linkUrl: 'https://totally-other.example/no-utm',
        }),
      ).toEqual(
        expect.arrayContaining([
          { field: 'url', code: 'venue_mismatch' },
          { field: 'linkUrl', code: 'utm' },
        ]),
      );
      // На площадке, но не тот URL, что записан при publish.
      expect(await bad({ url: 'https://venue.example/other' })).toEqual([
        { field: 'url', code: 'not_published' },
      ]);
      // Ссылка без UTM размещения / с чужим кодом / на другой адрес.
      const issued = new URL(pl.issuedUrl as string);
      const noContent = new URL(issued);
      noContent.searchParams.delete('utm_content');
      expect(await bad({ linkUrl: noContent.toString() })).toEqual([
        { field: 'linkUrl', code: 'utm' },
      ]);
      const otherCode = new URL(issued);
      otherCode.searchParams.set('utm_content', 'pl9-zzzzzz');
      expect(await bad({ linkUrl: otherCode.toString() })).toEqual([
        { field: 'linkUrl', code: 'utm' },
      ]);
      const otherDest = new URL(issued);
      otherDest.pathname = '/materials/other';
      expect(await bad({ linkUrl: otherDest.toString() })).toEqual([
        { field: 'linkUrl', code: 'utm' },
      ]);
      // Маркировка не та, что обещала площадка; без доказательства — нет.
      expect(await bad({ marking: 'nofollow' })).toEqual([
        { field: 'marking', code: 'mismatch' },
      ]);
      expect(await bad({ evidenceUrl: undefined })).toEqual([
        { field: 'evidenceUrl', code: 'required' },
      ]);
      expect(
        (await op.get(`${P}/placements/${x.placementId}`)).body.data.status,
      ).toBe('published');

      const ok = await op.post(`${P}/placements/${x.placementId}/verify`, good);
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('verified_complete');
      expect(
        await s.prisma.pubPublication.findFirstOrThrow({
          where: { id: rec.id },
        }),
      ).toMatchObject({
        verifyStatus: 'ok',
        evidenceUrl: 'https://archive.example/post-7.png',
        verifiedBy: `member:${w.team.operator.memberId}`,
      });
    });
  },
);
