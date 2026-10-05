/**
 * Э3-бис: статистика экспериментов (§5-тер.2, §5-тер.16 п.14) — назначение
 * группы, мощность, SRM, итог без подглядывания.
 */
import { createHash } from 'crypto';
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

  // Детерминированный набор ключей (раньше — randomBytes: допуск 0.6 п.п. при
  // N=10 000 и p=0.1 — это ≈2σ, тест падал в ~5% прогонов). Ключи — 12 байт
  // sha256 от счётчика в base64url (тот же вид, что настоящий ключ визита).
  const VISITS = 40_000;
  const visitKey = (i: number): string =>
    createHash('sha256')
      .update(`e3bis-visit-${i}`)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  const KEYS = Array.from({ length: VISITS }, (_, i) => visitKey(i));

  it.each([
    ['salt-1', 0.1],
    ['salt-2', 0.1],
    ['salt-1', 0.5],
    ['salt-2', 0.5],
  ])(
    '40 000 ключей визита, соль %s: доля группы b = %s ± 4σ, детерминированно',
    (salt, share) => {
      let b = 0;
      for (const v of KEYS) {
        if (armOf(salt, v, share) === 'b') b++;
        expect(armOf(salt, v, share)).toBe(armOf(salt, v, share));
      }
      const sigma = Math.sqrt((share * (1 - share)) / VISITS);
      // p=0.1: 4σ = 0.6 п.п. (прежний допуск, но теперь при вчетверо большей N).
      expect(Math.abs(b / VISITS - share)).toBeLessThan(4 * sigma);
    },
  );

  it('хеш равномерен по всему диапазону: χ² по 20 корзинам < 43.8 (df=19, p=0.001)', () => {
    const bins = new Array<number>(20).fill(0);
    for (const v of KEYS) {
      bins[Math.floor((fnv1a32(`salt-1:${v}`) / 4294967296) * 20)]++;
    }
    const e = VISITS / 20;
    const chi2 = bins.reduce((s, o) => s + ((o - e) * (o - e)) / e, 0);
    expect(chi2).toBeLessThan(43.82);
    // и доля через armOf совпадает с корзинами: share=0.05 → первая корзина
    expect(KEYS.filter((v) => armOf('salt-1', v, 0.05) === 'b').length).toBe(
      bins[0],
    );
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
