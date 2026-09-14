import {
  buildExtensionPlan,
  billableSeconds,
  chainCostMicroUsd,
  VEO_MAX_SECONDS,
  GROK_MAX_SECONDS,
} from './video-extension-plan';

describe('buildExtensionPlan (ТЗ §9.4)', () => {
  it('запрос короче 8 секунд — один вызов, не урезано', () => {
    const plan = buildExtensionPlan('veo', 5);
    expect(plan).toEqual({
      totalCalls: 1,
      segments: [8],
      targetDurationSeconds: 8,
      wasCapped: false,
      exceedsReference: false,
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

  it('Grok: свой потолок — 25 секунд (15 нативно + одно расширение до 10)', () => {
    const plan = buildExtensionPlan('grok', 100);
    expect(plan.targetDurationSeconds).toBe(GROK_MAX_SECONDS);
    expect(plan.wasCapped).toBe(true);
    expect(plan.segments).toEqual([15, 10]);
    expect(plan.totalCalls).toBe(2);
  });

  it('Grok: до 15 секунд — один нативный вызов нужной длины, без цепочки', () => {
    const plan = buildExtensionPlan('grok', 12);
    expect(plan.segments).toEqual([12]);
    expect(plan.totalCalls).toBe(1);
    expect(plan.targetDurationSeconds).toBe(12);
    expect(plan.wasCapped).toBe(false);
  });

  it('Grok: 16 секунд — расширение не короче 2 с (14 + 2, не 15 + 1)', () => {
    expect(buildExtensionPlan('grok', 16).segments).toEqual([14, 2]);
    expect(buildExtensionPlan('grok', 20).segments).toEqual([15, 5]);
  });

  it('длительность референса — справка, а не потолок (сбой 14.09.2026)', () => {
    // Раньше референс в 20 с молча резал запрос; теперь только флаг.
    const plan = buildExtensionPlan('veo', 56, 20);
    expect(plan.targetDurationSeconds).toBe(56);
    expect(plan.wasCapped).toBe(false);
    expect(plan.exceedsReference).toBe(true);
    expect(plan.totalCalls).toBe(7);
    expect(buildExtensionPlan('veo', 16, 20).exceedsReference).toBe(false);
  });

  it('референс длиннее потолка провайдера — потолок провайдера всё равно главный', () => {
    const plan = buildExtensionPlan('veo', 56, 200);
    expect(plan.targetDurationSeconds).toBe(VEO_MAX_SECONDS);
  });

  it('запрос 0 или отрицательный — не меньше базовых 8 секунд, один вызов', () => {
    expect(buildExtensionPlan('veo', 0)).toEqual({
      totalCalls: 1,
      segments: [8],
      targetDurationSeconds: 8,
      wasCapped: false,
      exceedsReference: false,
    });
  });

  it('Veo: 20 секунд — 3 вызова по 8, оплачиваются все 24', () => {
    const plan = buildExtensionPlan('veo', 20);
    expect(plan.segments).toEqual([8, 8, 8]);
    expect(billableSeconds(plan)).toBe(24);
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

  it('Grok: посекундно по реальным сегментам, а не «8 × число вызовов»', () => {
    // 640_000 за 8 с = 80_000/с; 12 с одним вызовом = 960_000.
    expect(chainCostMicroUsd(buildExtensionPlan('grok', 12), 640_000)).toBe(
      960_000,
    );
    // 20 с = 15 + 5 = 20 с × 80_000.
    expect(chainCostMicroUsd(buildExtensionPlan('grok', 20), 640_000)).toBe(
      1_600_000,
    );
  });
});
