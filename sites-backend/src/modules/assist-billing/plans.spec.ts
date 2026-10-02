import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  ASSIST_PLANS,
  ASSIST_PLAN_IDS,
  MIN_OVERAGE_PER_DIALOG_USD,
  assistPlanAllows,
  planPrice,
  priceFromUsd,
  publicPlans,
  siteDailyCapFromPlan,
  topupPrice,
  topupPackMicroUsd,
} from './plans';
import {
  DIALOG_IDLE_MS,
  DIALOG_WEIGHT_STEPS,
  PUBLIC_DIALOG_WEIGHTS,
} from './units';

const LANDING_SNAPSHOT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'sites-landing',
  'assist-plans.snapshot.json',
);

describe('ASSIST_PLANS (§7.1)', () => {
  it('таблица §7.1: цены, диалоги, сайты, бюджеты обучения Р-58', () => {
    expect(
      ASSIST_PLAN_IDS.map((id) => [
        id,
        ASSIST_PLANS[id].priceUsdMonthly,
        ASSIST_PLANS[id].dialogsPerMonth,
        ASSIST_PLANS[id].sites,
        ASSIST_PLANS[id].learningBudgetMicroUsd,
      ]),
    ).toEqual([
      ['trial', 0, 50, 1, 500_000],
      ['start', 19, 400, 1, 500_000],
      ['business', 59, 1200, 3, 3_000_000],
      ['pro', 149, 3000, 10, 8_000_000],
    ]);
  });

  it('докупка не дешевле $0.05 за диалог; у Trial — стоп', () => {
    const perDialog = ASSIST_PLAN_IDS.map((id) => {
      const per100 = ASSIST_PLANS[id].overageUsdPer100;
      return per100 === null
        ? null
        : per100 / 100 >= MIN_OVERAGE_PER_DIALOG_USD;
    });
    expect(perDialog).toEqual([null, true, true, true]);
    expect(assistPlanAllows('trial', 'overage')).toBe(false);
    expect(assistPlanAllows('start', 'overage')).toBe(true);
    expect(topupPackMicroUsd('start')).toBe(6_000_000);
  });

  it('возможности: «на базе» убирается с Business, действия «Админки» — только Pro; без тарифа — ничего', () => {
    expect(assistPlanAllows('start', 'removePoweredBy')).toBe(false);
    expect(assistPlanAllows('business', 'removePoweredBy')).toBe(true);
    expect(assistPlanAllows('business', 'adminActions')).toBe(false);
    expect(assistPlanAllows('pro', 'adminActions')).toBe(true);
    expect(assistPlanAllows(null, 'voice')).toBe(false);
  });

  it('суточный потолок сайта = месячная себестоимость лимита / 10 (Start — $1.6, как до Э4)', () => {
    expect(siteDailyCapFromPlan('start')).toBe(1_600_000);
    expect(siteDailyCapFromPlan('business')).toBe(4_800_000);
    expect(siteDailyCapFromPlan('trial')).toBe(200_000);
    expect(siteDailyCapFromPlan(null)).toBe(0);
  });

  it('цена к оплате: вверх до целой гривны и целой звезды', () => {
    const rates = { uahPerUsd: 41.5, starsPerUsd: 77 };
    expect(priceFromUsd(19, rates)).toEqual({
      uahMinor: 78900,
      stars: 1463,
      usd: 19,
    });
    expect(planPrice('pro', rates)).toEqual({
      uahMinor: 618400,
      stars: 11473,
      usd: 149,
    });
    expect(topupPrice('business', 2, rates)).toEqual({
      uahMinor: 45700,
      stars: 847,
      usd: 11,
    });
    expect(topupPrice('trial', 1, rates)).toBeNull();
    // Курс ровно в целое — без лишней копейки из-за плавающей точки.
    expect(priceFromUsd(10, { uahPerUsd: 40, starsPerUsd: 50 })).toEqual({
      uahMinor: 40000,
      stars: 500,
      usd: 10,
    });
  });

  (existsSync(LANDING_SNAPSHOT) ? it : it.skip)(
    'публичный ответ = файл-снимок лендинга (кроме source/checkedAt/note) + веса',
    () => {
      const landing = JSON.parse(
        readFileSync(LANDING_SNAPSHOT, 'utf8'),
      ) as Record<string, unknown>;
      const live = publicPlans({
        idleCloseMinutes: DIALOG_IDLE_MS / 60_000,
        weightSteps: DIALOG_WEIGHT_STEPS,
        weights: PUBLIC_DIALOG_WEIGHTS,
      }) as unknown as Record<string, unknown>;
      const strip = (o: Record<string, unknown>) => {
        const {
          source: _s,
          checkedAt: _c,
          note: _n,
          dialogWeights: _w,
          ...rest
        } = o;
        return rest;
      };
      expect(strip(live)).toEqual(strip(landing));
      expect(live.dialogWeights).toEqual({ text: 1, voice: 2, admin: 3 });
    },
  );
});
