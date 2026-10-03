/**
 * Э3-бис: статистика экспериментов (§5-тер.2, §5-тер.16 п.14) — назначение
 * группы, мощность, SRM, итог без подглядывания.
 */
import { randomBytes } from 'crypto';
import {
  MAX_MDE_REL,
  analyze,
  armOf,
  estimatePower,
  fnv1a32,
  mdeFor,
  requiredTotal,
  srmP,
} from './experiment-math';

describe('эксперименты: математика (Э3-бис)', () => {
  it('FNV-1a 32: известные векторы (тот же код в загрузчике)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('10 000 случайных ключей визита: доля группы b — 10% ± 0.6 п.п., детерминированно', () => {
    let b = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = randomBytes(12).toString('base64url');
      if (armOf('salt-1', v, 0.1) === 'b') b++;
      expect(armOf('salt-1', v, 0.1)).toBe(armOf('salt-1', v, 0.1));
    }
    expect(Math.abs(b / 10_000 - 0.1)).toBeLessThan(0.006);
  });

  it('SRM: правильная доля — p высокое; перекос — p < 0.001', () => {
    expect(srmP(9000, 1000, 0.1)!).toBeGreaterThan(0.05);
    expect(srmP(9300, 700, 0.1)!).toBeLessThan(0.001);
    expect(srmP(0, 0, 0.1)).toBeNull();
  });

  it('мощность: пример ТЗ — +10% при 2% базе и 10% контроле требует ≈ 45 тыс. в контроле', () => {
    const total = requiredTotal(0.02, 0.1, 0.1);
    expect(total * 0.1).toBeGreaterThan(40_000);
    expect(total * 0.1).toBeLessThan(50_000);
    expect(mdeFor(0.02, total, 0.1)).toBeCloseTo(0.1, 2);
  });

  it('малый трафик → запуск не предлагается (MDE > 30%); без трафика/конверсий — причина', () => {
    const small = estimatePower({
      units28: 300,
      conversions28: 6,
      share: 0.1,
      horizonDays: 28,
    });
    expect(small.ok).toBe(false);
    expect(small.reason).toBe('underpowered');
    expect(small.mdeRel).toBeGreaterThan(MAX_MDE_REL);
    expect(
      estimatePower({
        units28: 0,
        conversions28: 0,
        share: 0.5,
        horizonDays: 28,
      }).reason,
    ).toBe('no_traffic');
    expect(
      estimatePower({
        units28: 100,
        conversions28: 0,
        share: 0.5,
        horizonDays: 28,
      }).reason,
    ).toBe('no_conversions');
    const big = estimatePower({
      units28: 60_000,
      conversions28: 6_000,
      share: 0.5,
      horizonDays: 28,
    });
    expect(big.ok).toBe(true);
    expect(big.minUnitsPerArm).toBeGreaterThan(0);
  });

  it('итог: недостаточно выборки — не «эффекта нет»; значимый эффект — significant', () => {
    expect(
      analyze({ nA: 50, nB: 50, xA: 5, xB: 10, minUnitsPerArm: 1000 }).verdict,
    ).toBe('insufficient_sample');
    const r = analyze({
      nA: 5000,
      nB: 5000,
      xA: 500,
      xB: 600,
      minUnitsPerArm: 4000,
    });
    expect(r.verdict).toBe('significant');
    expect(r.ciLow).toBeGreaterThan(0);
    expect(r.liftRel).toBeCloseTo(0.2, 2);
    const flat = analyze({
      nA: 5000,
      nB: 5000,
      xA: 500,
      xB: 505,
      minUnitsPerArm: 4000,
    });
    expect(flat.verdict).toBe('not_significant');
    expect(flat.ciLow).toBeLessThan(0);
  });
});
