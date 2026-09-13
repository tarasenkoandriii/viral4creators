import {
  buildExtensionPlan,
  chainCostMicroUsd,
  VEO_MAX_SECONDS,
  GROK_MAX_SECONDS,
} from './video-extension-plan';

describe('buildExtensionPlan (ТЗ §9.4)', () => {
  it('запрос короче 8 секунд — один вызов, не урезано', () => {
    const plan = buildExtensionPlan('veo', 5);
    expect(plan).toEqual({
      totalCalls: 1,
      targetDurationSeconds: 8,
      wasCapped: false,
    });
  });

  it('Veo: запрос ровно на потолке (56с) — 7 вызовов, не урезано', () => {
    const plan = buildExtensionPlan('veo', 56);
    expect(plan.totalCalls).toBe(7);
    expect(plan.targetDurationSeconds).toBe(56);
    expect(plan.wasCapped).toBe(false);
  });

  it('Veo: запрос выше потолка (100с) — урезается до 56с/7 вызовов', () => {
    const plan = buildExtensionPlan('veo', 100);
    expect(plan.totalCalls).toBe(7);
    expect(plan.targetDurationSeconds).toBe(VEO_MAX_SECONDS);
    expect(plan.wasCapped).toBe(true);
  });

  it('Grok: свой потолок — 30 секунд, не 56 (§10.1 ТЗ)', () => {
    const plan = buildExtensionPlan('grok', 100);
    expect(plan.targetDurationSeconds).toBe(GROK_MAX_SECONDS);
    expect(plan.wasCapped).toBe(true);
    // 30/8 округляется вверх — 4 вызова (24с было бы недостаточно).
    expect(plan.totalCalls).toBe(4);
  });

  it('длительность референса — второй, более узкий потолок (§9.4 «б»)', () => {
    // Референс всего 20 секунд — даже с запросом на 56, Veo не должен
    // выдумывать несуществующий хвост длиннее оригинала.
    const plan = buildExtensionPlan('veo', 56, 20);
    expect(plan.targetDurationSeconds).toBe(20);
    expect(plan.wasCapped).toBe(true);
    expect(plan.totalCalls).toBe(3); // ceil(20/8) = 3
  });

  it('референс длиннее потолка провайдера — потолок провайдера всё равно главный', () => {
    const plan = buildExtensionPlan('veo', 56, 200);
    expect(plan.targetDurationSeconds).toBe(VEO_MAX_SECONDS);
  });

  it('запрос 0 или отрицательный — не меньше базовых 8 секунд, один вызов', () => {
    expect(buildExtensionPlan('veo', 0)).toEqual({
      totalCalls: 1,
      targetDurationSeconds: 8,
      wasCapped: false,
    });
  });
});

describe('chainCostMicroUsd', () => {
  it('умножает цену одного вызова на число вызовов плана', () => {
    const plan = buildExtensionPlan('veo', 56); // 7 вызовов
    // Veo standard $0.40/сек × 8с = $3.20 = 3_200_000 микро-USD за вызов.
    expect(chainCostMicroUsd(plan, 3_200_000)).toBe(22_400_000);
  });

  it('один вызов (короткий запрос) — цена цепочки равна цене одного вызова', () => {
    const plan = buildExtensionPlan('grok', 5);
    expect(chainCostMicroUsd(plan, 640_000)).toBe(640_000);
  });
});
