/**
 * [AT-F10-02] Высокая общая посещаемость без соответствия аудитории (P-C,
 * проектный документ §6.4; F10): поля прогноза переходов/просмотров нет —
 * такой ввод отвергается (`unknown_field`), а не молча теряется; высокий
 * балл без обязательной проверки «тематика и рынок» не делает площадку
 * `verified`; утрата обязательного условия возвращает `verified` в
 * кандидаты.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  missingForVerified,
  venueScore,
} from '../../modules/publisher/distribution/venues.service';
import {
  apiAs,
  distStack,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

const TOP = {
  topic: { score: 2, why: 'Загальна тематика' },
  geo_language: { score: 2, why: 'Україна' },
  format: { score: 2, why: 'Банер і стаття' },
  evidence_freshness: { score: 2, why: 'Свіжа статистика' },
  real_distribution: { score: 2, why: '500 тис. переглядів' },
} as const;

describe('[AT-F10-02] балл и условия (unit)', () => {
  it('балл — сумма известных; неизвестное не даёт плюса и не усредняется', () => {
    expect(venueScore(TOP)).toEqual({ sum: 10, max: 10, known: 5 });
    expect(
      venueScore({
        topic: { score: 2, why: 'x' },
        format: { score: null, why: 'невідомо' },
      }),
    ).toEqual({ sum: 2, max: 2, known: 1 });
  });
  it('высокий балл без проверки аудитории — условие не выполнено', () => {
    expect(
      missingForVerified(
        {
          checkTopicMarket: false,
          checkPriceConfirmed: true,
          checkFormatConfirmed: true,
          checkTermSet: true,
          checkSupplierKnown: true,
          linkMarking: 'nofollow',
        },
        1,
      ),
    ).toEqual(['checks.topicMarket']);
  });
});

ciDescribe(
  '[AT-F10-02] нет прогноза трафика; рейтинг не заменяет проверку аудитории',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('прогноз переходов — unknown_field; 10/10 без соответствия аудитории — не verified; утрата условия — снова candidate', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const withForecast = await op.post(`${P}/venues`, {
        title: 'Великий портал',
        url: 'https://bigportal.example',
        criteria: TOP,
        forecastClicks: 1200,
        expectedLeads: 5,
      });
      expect(withForecast.status).toBe(400);
      expect(withForecast.body.error.details.fields).toEqual(
        expect.arrayContaining([
          { field: 'forecastClicks', code: 'unknown_field' },
          { field: 'expectedLeads', code: 'unknown_field' },
        ]),
      );
      const extraCriterion = await op.post(`${P}/venues`, {
        title: 'Великий портал',
        url: 'https://bigportal.example',
        criteria: { ...TOP, traffic_forecast: { score: 2, why: 'x' } },
      });
      expect(extraCriterion.body.error.details.fields).toEqual([
        { field: 'criteria.traffic_forecast', code: 'unknown_field' },
      ]);

      const v = (
        await op.post(`${P}/venues`, {
          title: 'Великий портал',
          url: 'https://bigportal.example',
          audienceNote: 'Загальна аудиторія, не підприємці',
          criteria: TOP,
          checks: {
            topicMarket: false,
            priceConfirmed: true,
            formatConfirmed: true,
            termSet: true,
            supplierKnown: true,
          },
          linkMarking: 'nofollow',
          evidence: [
            {
              criterion: 'real_distribution',
              sourceId: w.sourceId,
              checkedAt: '2026-10-12T10:00:00.000Z',
            },
          ],
        })
      ).body.data;
      expect(v.score).toEqual({ sum: 10, max: 10, known: 5 });
      expect(v.missingForVerified).toEqual(['checks.topicMarket']);
      expect(Object.keys(v)).not.toEqual(
        expect.arrayContaining(['forecastClicks']),
      );
      const tryVerify = await op.post(`${P}/venues/${v.id}/transition`, {
        to: 'verified',
        expectedRevision: v.revision,
      });
      expect(tryVerify.status).toBe(400);
      expect(tryVerify.body.error.details.fields).toEqual([
        { field: 'checks.topicMarket', code: 'required' },
      ]);
      // База держит то же правило (триггер), даже мимо сервиса.
      await expect(
        s.prisma.pubVenue.update({
          where: { id: v.id },
          data: { status: 'verified' },
        }),
      ).rejects.toThrow(/verified/);

      // Проверенная карточка теряет условие — возвращается в кандидаты.
      const td = (await op.get(`${P}/venues/${w.venueId}`)).body.data;
      expect(td.status).toBe('verified');
      const lost = await op.patch(`${P}/venues/${w.venueId}`, {
        checks: { priceConfirmed: false },
        expectedRevision: td.revision,
      });
      expect(lost.status).toBe(200);
      expect(lost.body.data).toMatchObject({
        status: 'candidate',
        missingForVerified: ['checks.priceConfirmed'],
      });
    });
  },
);
