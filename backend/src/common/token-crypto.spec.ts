import { encryptToken, decryptToken } from './token-crypto';

// 32 байта случайных данных, base64 — валидный CHANNEL_TOKEN_KEY для тестов.
const KEY = Buffer.from('0123456789abcdef0123456789abcdef')
  .subarray(0, 32)
  .toString('base64');
const OTHER_KEY = Buffer.alloc(32, 7).toString('base64');

describe('token-crypto', () => {
  it('round-trip: расшифровка возвращает исходный текст', () => {
    const plaintext = 'ya29.a0AfH6SMC-example-access-token';
    const stored = encryptToken(plaintext, KEY);
    expect(decryptToken(stored, KEY)).toBe(plaintext);
  });

  it('разные вызовы шифрования одного текста дают разный ciphertext (случайный iv)', () => {
    const a = encryptToken('same-token', KEY);
    const b = encryptToken('same-token', KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY)).toBe('same-token');
    expect(decryptToken(b, KEY)).toBe('same-token');
  });

  it('хранимая строка — три base64-части через точку', () => {
    const stored = encryptToken('x', KEY);
    expect(stored.split('.')).toHaveLength(3);
  });

  it('пустой CHANNEL_TOKEN_KEY — понятная ошибка', () => {
    expect(() => encryptToken('x', undefined)).toThrow(
      /CHANNEL_TOKEN_KEY не задан/,
    );
    expect(() => encryptToken('x', '')).toThrow(/CHANNEL_TOKEN_KEY не задан/);
  });

  it('CHANNEL_TOKEN_KEY неверной длины — понятная ошибка', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptToken('x', shortKey)).toThrow(/32 байт/);
  });

  it('расшифровка неверным ключом бросает (аутентификация GCM)', () => {
    const stored = encryptToken('secret-token', KEY);
    expect(() => decryptToken(stored, OTHER_KEY)).toThrow();
  });

  it('расшифровка повреждённого ciphertext бросает, а не отдаёт мусор', () => {
    const stored = encryptToken('secret-token', KEY);
    const [iv, authTag, ciphertext] = stored.split('.');
    const tampered = [
      iv,
      authTag,
      ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA'),
    ].join('.');
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });

  it('расшифровка строки неверного формата — понятная ошибка', () => {
    expect(() => decryptToken('not-a-valid-stored-token', KEY)).toThrow(
      /Повреждённая запись токена/,
    );
  });
});
