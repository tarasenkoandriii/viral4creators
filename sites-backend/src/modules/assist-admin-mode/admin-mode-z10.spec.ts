/**
 * Заход 10 (пакет Г): подпись кнопки «Админки» (Р-З10-15, Ш6 (4)) и общий
 * расчёт окна тревоги компенсаций для экрана и push (Р-З10-13).
 */
import { HttpException } from '@nestjs/common';
import { WIDGET_LABEL_MAX, cleanWidgetLabel } from './admin-mode.service';
import {
  COMPENSATION_ALERT,
  actionStats,
  compensationWindow,
  type ActionStatRow,
} from './admin-stats.service';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return ((e as HttpException).getResponse() as { code: string }).code;
  }
  return null;
};

describe('Р-З10-15 — подпись кнопки помощника (data-label)', () => {
  it('пробелы схлопываются; пусто — подпись по умолчанию (null)', () => {
    expect(cleanWidgetLabel('  Помічник   Viral  ')).toBe('Помічник Viral');
    expect(cleanWidgetLabel('   ')).toBeNull();
    expect(cleanWidgetLabel(null)).toBeNull();
    expect(cleanWidgetLabel(undefined)).toBeNull();
  });

  it('HTML, управляющие символы и > 40 символов — 400 ADMIN_LABEL_INVALID', () => {
    expect(code(() => cleanWidgetLabel('<b>x</b>'))).toBe(
      'ADMIN_LABEL_INVALID',
    );
    expect(code(() => cleanWidgetLabel('a\u0007b'))).toBe(
      'ADMIN_LABEL_INVALID',
    );
    expect(code(() => cleanWidgetLabel('я'.repeat(WIDGET_LABEL_MAX + 1)))).toBe(
      'ADMIN_LABEL_INVALID',
    );
    // 40 символов кириллицы — это символы, а не байты: годится.
    expect(cleanWidgetLabel('я'.repeat(WIDGET_LABEL_MAX))).toHaveLength(40);
  });
});

describe('Р-З10-13 — окно тревоги компенсаций (экран и push — один расчёт)', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const comp = (status: string, hoursAgo: number): ActionStatRow => ({
    operation: 'shop.cancelOrder',
    status,
    attempts: 1,
    compensationOf: 'p0',
    chainStatus: null,
    unrequested: false,
    createdAt: new Date(now.getTime() - hoursAgo * 3_600_000),
    executedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
  });

  it('порог: < 80% на ≥ 10 попытках за 24 ч; старше суток не считаются', () => {
    const rows = [
      ...Array.from({ length: 7 }, () => comp('done', 1)),
      ...Array.from({ length: 3 }, () => comp('failed', 2)),
    ];
    expect(compensationWindow(rows, now)).toEqual({
      attempts: 10,
      ok: 7,
      alert: true,
    });
    expect(actionStats(rows, now).compensations.alert).toBe(true);
    // 8 из 10 — ровно порог 80%: не тревога.
    const eight = [
      ...Array.from({ length: 8 }, () => comp('done', 1)),
      ...Array.from({ length: 2 }, () => comp('failed', 1)),
    ];
    expect(compensationWindow(eight, now).alert).toBe(false);
    // 9 попыток — ниже минимума выборки.
    expect(compensationWindow(rows.slice(1), now).alert).toBe(false);
    // Попытки старше суток выпадают из окна.
    const old = rows.map((r, i) => (i < 5 ? comp(r.status, 30) : r));
    expect(compensationWindow(old, now).attempts).toBe(5);
    expect(COMPENSATION_ALERT.minAttempts).toBe(10);
  });

  it('`unknown` и `expired` после «Да» — неуспех; не компенсации — мимо окна', () => {
    const rows = [
      ...Array.from({ length: 6 }, () => comp('done', 1)),
      comp('unknown', 1),
      { ...comp('expired', 1), attempts: 1 },
      comp('failed', 1),
      comp('failed', 1),
      { ...comp('failed', 1), compensationOf: null },
    ];
    expect(compensationWindow(rows, now)).toEqual({
      attempts: 10,
      ok: 6,
      alert: true,
    });
  });
});
