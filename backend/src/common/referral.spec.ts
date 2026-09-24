/**
 * Правила приглашений — «Условно бесплатный Lite» §5, этап 134.
 */

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  funnelOf,
  isCounted,
  isNewcomer,
  makeCode,
  normalizeCode,
  referralClaimWindowMs,
  referralDailyCountedCap,
  referralInviteeBonus,
  referralUnlockTarget,
} from './referral';

describe('код приглашения', () => {
  it('в алфавите нет знаков, которые люди путают', () => {
    // Ссылку переписывают с чужого экрана и диктуют вслух. «Код не
    // подошёл» стоит здесь не сообщения об ошибке, а потерянного
    // приглашённого.
    for (const ch of '01OIL') expect(CODE_ALPHABET).not.toContain(ch);
  });

  it('код нужной длины и только из алфавита', () => {
    const code = makeCode((n) => Uint8Array.from({ length: n }, (_, i) => i));
    expect(code).toHaveLength(CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
  });

  it('регистр и пробелы человеку прощаем', () => {
    expect(normalizeCode('  abcd2345 ')).toBe('ABCD2345');
  });

  it('чужое отвергается, а не чинится', () => {
    // Длина, посторонние знаки и не-строка — всё это «кода нет», и
    // угадывать за человека мы не пытаемся: угаданный код привёл бы
    // его к чужому пригласившему.
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('ABCD234O')).toBeNull();
    expect(normalizeCode(42)).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
});

describe('настройки программы', () => {
  it('ноль — законное значение, мусор даёт умолчание', () => {
    expect(referralInviteeBonus({ REFERRAL_INVITEE_BONUS: '0' })).toBe(0);
    expect(referralInviteeBonus({ REFERRAL_INVITEE_BONUS: 'нет' })).toBe(1);
    expect(referralDailyCountedCap({ REFERRAL_DAILY_COUNTED_CAP: '-3' })).toBe(
      10,
    );
    expect(referralUnlockTarget({ REFERRAL_UNLOCK_TARGET: '5' })).toBe(5);
  });
});

describe('засчёт', () => {
  it('засчитан только дошедший до ролика', () => {
    expect(isCounted({ status: 'IDENTIFIED' })).toBe(false);
    expect(isCounted({ status: 'GENERATED' })).toBe(true);
  });

  it('снятое оператором не считается, но из списка не исчезает', () => {
    expect(isCounted({ status: 'GENERATED', revokedAt: new Date() })).toBe(
      false,
    );
  });
});

describe('воронка кабинета', () => {
  it('три числа приходят счётчиками, а не длиной списка', () => {
    // Найдено аудитом этапа 134: список приглашённых в кабинете обрезан
    // полусотней, и считать воронку по нему значило показывать
    // «50 вошли» всякому, у кого их больше.
    expect(funnelOf({ visitCount: 90, identified: 60, generated: 9 })).toEqual({
      visited: 90,
      identified: 60,
      generated: 9,
    });
  });

  it('переходов не бывает меньше, чем вошедших', () => {
    // Счётчик кликов теряется на блокировщиках и в приватных вкладках,
    // а строка о вошедшем не теряется никогда. «3 перехода, 5 вошли» —
    // это два числа, которым человек перестанет верить обоим.
    expect(
      funnelOf({ visitCount: 0, identified: 2, generated: 1 }).visited,
    ).toBe(2);
  });
});

describe('кто ещё считается новым (§5.2)', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const hours = (n: number) => n * 60 * 60 * 1000;

  it('аккаунт, заведённый только что', () => {
    expect(isNewcomer(new Date('2026-09-24T11:59:00Z'), hours(24), now)).toBe(
      true,
    );
  });

  it('вчерашний — ещё да, позавчерашний — уже нет', () => {
    // Между переходом по ссылке и входом человек проходит мастер, а
    // привязка может опоздать на повтор. Сутки закрывают это, месяцы —
    // это уже давний пользователь, и его клик по чужой ссылке не
    // должен создавать ничего.
    expect(isNewcomer(new Date('2026-09-23T13:00:00Z'), hours(24), now)).toBe(
      true,
    );
    expect(isNewcomer(new Date('2026-09-22T12:00:00Z'), hours(24), now)).toBe(
      false,
    );
  });

  it('часы сервера разъехались — человеку это не в минус', () => {
    expect(isNewcomer(new Date('2026-09-24T12:05:00Z'), hours(24), now)).toBe(
      true,
    );
  });

  it('нулевое окно выключает привязку целиком', () => {
    expect(isNewcomer(now, 0, now)).toBe(false);
  });

  it('окно читается из переменной окружения в часах', () => {
    expect(referralClaimWindowMs({ REFERRAL_CLAIM_WINDOW_HOURS: '2' })).toBe(
      hours(2),
    );
    expect(referralClaimWindowMs({})).toBe(hours(24));
    expect(referralClaimWindowMs({ REFERRAL_CLAIM_WINDOW_HOURS: 'нет' })).toBe(
      hours(24),
    );
  });
});
