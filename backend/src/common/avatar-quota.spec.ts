import {
  AVATAR_OPERATIONS,
  AVATAR_QUOTA_ENV,
  avatarQuotaExhausted,
  avatarQuotaPerDay,
} from './avatar-quota';

describe('квота аватар-роликов', () => {
  it('аватар входит в PREMIUM — и потолок есть только там', () => {
    expect(avatarQuotaPerDay('PREMIUM', {})).toBeGreaterThan(0);
    expect(avatarQuotaPerDay('LITE', {})).toBe(0);
    expect(avatarQuotaPerDay('STANDARD', {})).toBe(0);
  });

  it('потолок меняется переменной окружения — без выката', () => {
    expect(
      avatarQuotaPerDay('PREMIUM', { [AVATAR_QUOTA_ENV.PREMIUM]: '12' }),
    ).toBe(12);
  });

  it('ноль в переменной — законный способ временно закрыть фичу', () => {
    // Не «пусто, значит по умолчанию»: ноль должен ЗАКРЫВАТЬ.
    expect(
      avatarQuotaPerDay('PREMIUM', { [AVATAR_QUOTA_ENV.PREMIUM]: '0' }),
    ).toBe(0);
  });

  it('мусор и пустая строка откатываются к умолчанию, а не к нулю', () => {
    // Опечатка в переменной не должна молча выключить платную фичу.
    for (const raw of ['', '  ', 'пять', '-3', '2.5']) {
      expect(
        avatarQuotaPerDay('PREMIUM', { [AVATAR_QUOTA_ENV.PREMIUM]: raw }),
      ).toBe(avatarQuotaPerDay('PREMIUM', {}));
    }
  });

  it('граница включающая: использовано ровно столько же — уже нельзя', () => {
    expect(avatarQuotaExhausted(4, 5)).toBe(false);
    expect(avatarQuotaExhausted(5, 5)).toBe(true);
    expect(avatarQuotaExhausted(6, 5)).toBe(true);
  });

  it('квоту расходует та же операция, которой пишется расход', () => {
    // Иначе счётчик считал бы одно, а деньги списывались за другое.
    expect(AVATAR_OPERATIONS).toContain('avatar-generation');
  });
});
