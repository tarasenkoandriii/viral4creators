/**
 * Приёмка Э4 п.1 — «диалог считается по правилам (30 мин тишины, ×2 после
 * 30 ответов)» — юнит-тесты (ТЗ §7.1, Р-58).
 */
import {
  DIALOG_BASE_UNITS,
  DIALOG_IDLE_MS,
  dialogMultiplier,
  dialogUnits,
  isNewDialog,
  unitsDelta,
  unitsForCost,
} from './units';

describe('счёт диалогов в единицах (§7.1)', () => {
  it('30 минут тишины — ровно граница: 30:00 — тот же диалог, 30:00.001 — новый', () => {
    const t0 = new Date('2026-10-04T10:00:00Z');
    expect(isNewDialog(null, t0)).toBe(true);
    expect(isNewDialog(t0, new Date(t0.getTime() + 29 * 60_000))).toBe(false);
    expect(isNewDialog(t0, new Date(t0.getTime() + DIALOG_IDLE_MS))).toBe(
      false,
    );
    expect(isNewDialog(t0, new Date(t0.getTime() + DIALOG_IDLE_MS + 1))).toBe(
      true,
    );
  });

  it('множитель: ≤ 30 ответов — ×1, 31–60 — ×2, > 60 — ×3', () => {
    expect([1, 30, 31, 60, 61, 200].map(dialogMultiplier)).toEqual([
      1, 1, 2, 2, 3, 3,
    ]);
  });

  it('текстовый диалог: 1 → 2 после 30 ответов → 3 после 60', () => {
    expect(dialogUnits(1, 0)).toBe(0);
    expect(dialogUnits(1, 1)).toBe(1);
    expect(dialogUnits(1, 30)).toBe(1);
    expect(dialogUnits(1, 31)).toBe(2);
    expect(dialogUnits(1, 61)).toBe(3);
  });

  it('приращения по ответам 1…65: первый — 1, 31-й и 61-й — ещё по 1, сумма = итог', () => {
    const deltas = Array.from({ length: 65 }, (_, i) =>
      unitsDelta(1, i + 1, i === 0),
    );
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(dialogUnits(1, 65));
    expect(deltas.map((d, i) => (d ? i + 1 : 0)).filter(Boolean)).toEqual([
      1, 31, 61,
    ]);
  });

  it('веса: голос — 2 (×2 после 30 → 4), Resemble — 3, «Админка» — 3', () => {
    expect(DIALOG_BASE_UNITS).toEqual({
      text: 1,
      voice: 2,
      'voice-premium': 3,
      admin: 3,
    });
    expect(dialogUnits(DIALOG_BASE_UNITS.voice, 1)).toBe(2);
    expect(dialogUnits(DIALOG_BASE_UNITS.voice, 31)).toBe(4);
    expect(unitsDelta(DIALOG_BASE_UNITS.admin, 31, false)).toBe(3);
  });

  it('диалог засчитан впервые после 30 мин тишины на n-м ответе — весь его вес', () => {
    expect(unitsDelta(1, 1, true)).toBe(1);
    expect(unitsDelta(2, 1, true)).toBe(2);
  });

  it('pro-модель — ⌈себестоимость / $0.04⌉, не меньше 1', () => {
    expect(unitsForCost(0)).toBe(1);
    expect(unitsForCost(40_000)).toBe(1);
    expect(unitsForCost(40_001)).toBe(2);
    expect(unitsForCost(120_000)).toBe(3);
  });
});
