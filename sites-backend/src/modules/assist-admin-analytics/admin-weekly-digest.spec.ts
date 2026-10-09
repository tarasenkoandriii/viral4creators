/**
 * Заход 11, Р-З11-В3: когда отчёт недели «Админки» ждёт сводки и когда
 * остаток досылается отдельно (чистые правила по замку `assist-digest`).
 */
import {
  ADMIN_DIGEST_ALIVE_MS,
  ADMIN_DIGEST_WAIT_MS,
  digestAhead,
  digestPassed,
  parseWeeklyTexts,
} from './admin-weekly-digest';

const at = (s: string) => new Date(s);
const MON_0610 = at('2026-10-05T06:10:00Z');

describe('отчёт недели «Админки» — ждать ли сводку (digestAhead)', () => {
  it('сводка вчера, сегодня ещё нет — ждём', () => {
    expect(
      digestAhead(MON_0610, {
        lastStartedAt: at('2026-10-04T06:30:00Z'),
        lockedUntil: null,
      }),
    ).toBe(true);
  });

  it('сводка сегодня уже стартовала (идёт или прошла) — не ждём', () => {
    for (const lockedUntil of [null, at('2026-10-05T06:45:00Z')]) {
      expect(
        digestAhead(at('2026-10-05T06:40:00Z'), {
          lastStartedAt: at('2026-10-05T06:30:00Z'),
          lockedUntil,
        }),
      ).toBe(false);
    }
    // Ровно полночь UTC — уже «сегодня».
    expect(
      digestAhead(MON_0610, {
        lastStartedAt: at('2026-10-05T00:00:00Z'),
        lockedUntil: null,
      }),
    ).toBe(false);
  });

  it('сводки не было или она давно не запускалась — не ждём', () => {
    expect(digestAhead(MON_0610, null)).toBe(false);
    expect(
      digestAhead(MON_0610, { lastStartedAt: null, lockedUntil: null }),
    ).toBe(false);
    const stale = new Date(MON_0610.getTime() - ADMIN_DIGEST_ALIVE_MS - 1);
    expect(
      digestAhead(MON_0610, { lastStartedAt: stale, lockedUntil: null }),
    ).toBe(false);
    const alive = new Date(MON_0610.getTime() - ADMIN_DIGEST_ALIVE_MS + 60_000);
    expect(
      digestAhead(MON_0610, { lastStartedAt: alive, lockedUntil: null }),
    ).toBe(true);
  });
});

describe('досылка остатка (digestPassed)', () => {
  const pendingAt = MON_0610;
  it('сводка стартовала после постановки и закончилась — досылаем', () => {
    expect(
      digestPassed(at('2026-10-05T06:50:00Z'), pendingAt, {
        lastStartedAt: at('2026-10-05T06:30:00Z'),
        lockedUntil: null,
      }),
    ).toBe(true);
    // Замок истёк (упавший проход) — тоже прошла.
    expect(
      digestPassed(at('2026-10-05T06:50:00Z'), pendingAt, {
        lastStartedAt: at('2026-10-05T06:30:00Z'),
        lockedUntil: at('2026-10-05T06:45:00Z'),
      }),
    ).toBe(true);
  });

  it('сводка ещё идёт или стартовала до постановки — ждём', () => {
    expect(
      digestPassed(at('2026-10-05T06:35:00Z'), pendingAt, {
        lastStartedAt: at('2026-10-05T06:30:00Z'),
        lockedUntil: at('2026-10-05T06:45:00Z'),
      }),
    ).toBe(false);
    expect(
      digestPassed(at('2026-10-05T07:00:00Z'), pendingAt, {
        lastStartedAt: at('2026-10-04T06:30:00Z'),
        lockedUntil: null,
      }),
    ).toBe(false);
    expect(digestPassed(at('2026-10-05T07:00:00Z'), pendingAt, null)).toBe(
      false,
    );
  });

  it('страховка: ждём дольше 8 ч — досылаем без сводки', () => {
    const late = new Date(pendingAt.getTime() + ADMIN_DIGEST_WAIT_MS);
    expect(digestPassed(late, pendingAt, null)).toBe(true);
    expect(digestPassed(new Date(late.getTime() - 1), pendingAt, null)).toBe(
      false,
    );
  });
});

describe('тексты ожидания (parseWeeklyTexts)', () => {
  const ok = {
    uk: { text: 'Тиждень', button: 'Відкрити' },
    ru: { text: 'Неделя', button: 'Открыть' },
    en: { text: 'Week', button: 'Open' },
  };
  it('полные uk/ru/en — как есть', () => {
    expect(parseWeeklyTexts(ok)).toEqual(ok);
  });
  it('нет языка, пустой текст, не объект — null', () => {
    expect(parseWeeklyTexts({ uk: ok.uk, ru: ok.ru })).toBeNull();
    expect(
      parseWeeklyTexts({ ...ok, en: { text: '', button: 'x' } }),
    ).toBeNull();
    expect(parseWeeklyTexts({ ...ok, ru: { text: 'a' } })).toBeNull();
    expect(parseWeeklyTexts(null)).toBeNull();
    expect(parseWeeklyTexts([ok])).toBeNull();
  });
});
