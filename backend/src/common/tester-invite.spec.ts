import {
  INVITE_PREFIX,
  INVITE_TOKEN_LENGTH,
  inviteLink,
  invitePayload,
  inviteToken,
  inviteVerdict,
  tokenFromStart,
} from './tester-invite';
import { CODE_ALPHABET } from './referral';

/**
 * Этап 155. Здесь решается, кому выдаётся право тратить наши деньги, —
 * поэтому каждое правило отдельной строкой.
 */
const NOW = new Date('2026-09-25T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  token: 'ABC',
  freeScenarios: ['PRODUCT_VIDEO'],
  expiresAt: null,
  revokedAt: null,
  userId: null,
  ...over,
});

describe('токен и ссылка', () => {
  it('токен нужной длины и только из алфавита приглашений', () => {
    // Алфавит без похожих друг на друга букв и цифр: ссылку однажды
    // прочитают вслух или перепишут руками.
    const token = inviteToken();
    expect(token).toHaveLength(INVITE_TOKEN_LENGTH);
    for (const ch of token) expect(CODE_ALPHABET).toContain(ch);
  });

  it('нагрузка влезает в 64 символа Telegram с запасом', () => {
    const payload = invitePayload(inviteToken());
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ссылка — именно `?start=`, а не `?startapp=`', () => {
    // `startapp` открывает мини-апп и разбирается фронтом; диалога с
    // ботом он не создаёт, а нам нужен именно диалог.
    const link = inviteLink('v4c_bot', 'TOKEN123');
    expect(link).toBe('https://t.me/v4c_bot?start=t_TOKEN123');
    expect(link).not.toContain('startapp');
  });
});

describe('разбор команды', () => {
  it('берёт токен из нашей нагрузки', () => {
    expect(tokenFromStart('/start t_ABC123')).toBe('ABC123');
    expect(tokenFromStart('  /start t_ABC123  ')).toBe('ABC123');
    expect(tokenFromStart('/start@v4c_bot t_ABC123')).toBe('ABC123');
  });

  it('чужое и пустое — одинаково «не наше»', () => {
    // Разные ответы на разные причины рассказали бы постороннему, как
    // устроены наши ссылки, а пользы не дали бы.
    expect(tokenFromStart('/start')).toBeNull();
    expect(tokenFromStart('/start ')).toBeNull();
    expect(tokenFromStart('/start r_ABC')).toBeNull();
    expect(tokenFromStart('/start t_')).toBeNull();
    expect(tokenFromStart('/start t_АБВ')).toBeNull();
    expect(tokenFromStart('привет')).toBeNull();
    expect(tokenFromStart(undefined)).toBeNull();
    expect(
      tokenFromStart(`/start ${INVITE_PREFIX}${'x'.repeat(80)}`),
    ).toBeNull();
  });
});

describe('можно ли активировать', () => {
  it('свежее приглашение активируется', () => {
    expect(inviteVerdict(row(), 'tg1', NOW)).toEqual({ kind: 'activate' });
  });

  it('повтор тем же человеком — не отказ', () => {
    // Нажатие START легко повторить, и второй ответ должен быть тем же.
    expect(inviteVerdict(row({ userId: 'tg1' }), 'tg1', NOW)).toEqual({
      kind: 'repeat',
    });
  });

  it('другой человек по чужой ссылке — отказ', () => {
    expect(inviteVerdict(row({ userId: 'tg1' }), 'tg2', NOW)).toEqual({
      kind: 'taken',
    });
  });

  it('отзыв сильнее всего, включая своего же владельца', () => {
    // Оператор отозвал именно затем, чтобы доступа больше не было;
    // отвечать бывшему владельцу «это ваша ссылка» незачем.
    expect(
      inviteVerdict(row({ userId: 'tg1', revokedAt: NOW }), 'tg1', NOW),
    ).toEqual({ kind: 'revoked' });
    expect(
      inviteVerdict(
        row({ revokedAt: NOW, expiresAt: new Date('2020-01-01') }),
        'tg1',
        NOW,
      ),
    ).toEqual({ kind: 'revoked' });
  });

  it('срок сильнее занятости, но слабее отзыва', () => {
    expect(
      inviteVerdict(row({ expiresAt: new Date('2026-09-24') }), 'tg1', NOW),
    ).toEqual({ kind: 'expired' });
    expect(
      inviteVerdict(
        row({ expiresAt: new Date('2026-09-24'), userId: 'tg1' }),
        'tg1',
        NOW,
      ),
    ).toEqual({ kind: 'expired' });
  });

  it('срок ровно в момент проверки уже истёк', () => {
    // Граница закрыта в сторону отказа: «до 25-го» человек читает как
    // «25-е ещё мой», и дата ставится концом дня, а не его началом.
    expect(inviteVerdict(row({ expiresAt: NOW }), 'tg1', NOW)).toEqual({
      kind: 'expired',
    });
    expect(
      inviteVerdict(
        row({ expiresAt: new Date(NOW.getTime() + 1) }),
        'tg1',
        NOW,
      ),
    ).toEqual({ kind: 'activate' });
  });
});
