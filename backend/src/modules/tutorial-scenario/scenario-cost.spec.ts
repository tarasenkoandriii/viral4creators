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
