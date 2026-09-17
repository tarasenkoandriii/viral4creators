import {
  generateStreamToken,
  hashToken,
  verifyStreamToken,
} from '../src/stream-token';

describe('stream-token', () => {
  it('generates unique tokens with sufficient entropy', () => {
    const a = generateStreamToken();
    const b = generateStreamToken();
    expect(a.token).not.toEqual(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });

  it('verifies a token against its own hash', () => {
    const { token, hash } = generateStreamToken();
    expect(verifyStreamToken(token, hash)).toBe(true);
  });

  it('rejects a token that belongs to a different session', () => {
    const a = generateStreamToken();
    const b = generateStreamToken();
    expect(verifyStreamToken(a.token, b.hash)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const { token, hash } = generateStreamToken();
    expect(verifyStreamToken(`${token}x`, hash)).toBe(false);
  });

  it('rejects an empty token', () => {
    const { hash } = generateStreamToken();
    expect(verifyStreamToken('', hash)).toBe(false);
  });

  it('hashToken is deterministic', () => {
    expect(hashToken('abc')).toEqual(hashToken('abc'));
  });
});

/**
 * Регрессия аудита этапа 108: сама примитива проверки токена не должна
 * БРОСАТЬ на нестроковом входе. До фикса `createHash().update(undefined)`
 * бросал `ERR_INVALID_ARG_TYPE` синхронно внутри обработчика
 * `ws.on('message')` — то есть ронял весь процесс реле. Основную
 * фильтрацию делает `parseClientMessage`, но проверка токена не должна
 * зависеть от дисциплины вызывающего.
 */
describe('verifyStreamToken — нестроковый вход', () => {
  it('возвращает false вместо исключения', () => {
    const { hash } = generateStreamToken();
    for (const bad of [undefined, null, 123, {}, []]) {
      expect(() =>
        verifyStreamToken(bad as unknown as string, hash),
      ).not.toThrow();
      expect(verifyStreamToken(bad as unknown as string, hash)).toBe(false);
    }
  });
});
