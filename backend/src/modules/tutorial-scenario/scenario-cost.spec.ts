import { estimateScenarioCost } from './scenario-cost';
import { ScenarioStep } from './scenario-steps.types';

const freeSteps: ScenarioStep[] = [
  { kind: 'goto', route: 'wizard.product' },
  { kind: 'click', selector: '[data-testid="next"]' },
];

describe('estimateScenarioCost', () => {
  it('сценарий без triggerPaidOperation — costly=false, сумма null, unpriced false', () => {
    const estimate = estimateScenarioCost(freeSteps);
    expect(estimate).toEqual({
      costly: false,
      estimatedCostMicroUsd: null,
      unpriced: false,
    });
  });

  it('один платный шаг — считает через estimateCost() на известной ставке (Veo, $0.4/сек)', () => {
    const steps: ScenarioStep[] = [
      ...freeSteps,
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'Veo, ожидаемо 8 секунд рендера',
      },
    ];
    const estimate = estimateScenarioCost(steps);
    expect(estimate.costly).toBe(true);
    expect(estimate.unpriced).toBe(false);
    // 8 секунд * 0.4 USD/сек = 3.2 USD = 3_200_000 микродолларов.
    expect(estimate.estimatedCostMicroUsd).toBe(3_200_000);
  });

  it('несколько платных шагов — суммирует стоимость по каждому', () => {
    const steps: ScenarioStep[] = [
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'Veo рендер',
      },
      { kind: 'click', selector: '[data-testid="generate"]' },
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'grok-imagine-video-1.5:720p',
        expectedUnits: { seconds: 8 },
        note: 'Grok 720p рендер',
      },
      { kind: 'click', selector: '[data-testid="generate-2"]' },
    ];
    const estimate = estimateScenarioCost(steps);
    // Veo: 8 * 0.4 = 3.2 USD; Grok 720p: 8 * 0.14 = 1.12 USD → 4.32 USD.
    expect(estimate.costly).toBe(true);
    expect(estimate.unpriced).toBe(false);
    expect(estimate.estimatedCostMicroUsd).toBe(4_320_000);
  });

  it('модель без ставки в MODEL_RATES — unpriced=true, а не тихий ноль', () => {
    const steps: ScenarioStep[] = [
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'модель-которой-нет-в-прайсе',
        expectedUnits: { seconds: 10 },
        note: 'неизвестная модель',
      },
    ];
    const estimate = estimateScenarioCost(steps);
    expect(estimate.costly).toBe(true);
    expect(estimate.unpriced).toBe(true);
  });
});

/**
 * Ноль у объявленного платного шага — не сумма, а отсутствие прикидки
 * (сквозной аудит 29.09.2026).
 */
describe('estimateScenarioCost — нулевая прикидка помечается всегда', () => {
  const paid = (model: string, expectedUnits: Record<string, number>) =>
    [
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model,
        expectedUnits,
        note: 'рендер',
      },
    ] as never;

  it('модель есть в прайсе, но единицы не те — $0 И пометка', () => {
    // Ставка видеомодели задана за СЕКУНДУ. `calls` при верном имени
    // давал `unpriced: false` и уверенный $0.0000 без подписи — самый
    // опасный из двух исходов, потому что оператор видит цифру без
    // оговорки.
    const est = estimateScenarioCost(
      paid('veo-3.1-generate-preview', { calls: 1 }),
    );
    expect(est.costly).toBe(true);
    expect(est.estimatedCostMicroUsd).toBe(0);
    expect(est.unpriced).toBe(true);
  });

  it('модели нет в прайсе — $0 и пометка, как и было', () => {
    const est = estimateScenarioCost(paid('veo-3', { seconds: 8 }));
    expect(est.unpriced).toBe(true);
  });

  it('всё на месте — сумма больше нуля и без пометки', () => {
    const est = estimateScenarioCost(
      paid('veo-3.1-generate-preview', { seconds: 8 }),
    );
    expect(est.estimatedCostMicroUsd).toBeGreaterThan(0);
    expect(est.unpriced).toBe(false);
  });
});
