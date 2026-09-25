import {
  API_KEY_PREFIX,
  apiKeyFromHeader,
  hashApiKey,
  hintOf,
  issueApiKey,
  shouldTouchLastUsed,
  LAST_USED_GRANULARITY_MS,
} from './api-key';

/**
 * Этап 144. Ключ внешнего API: выпуск, хеш и разбор заголовка.
 */
describe('issueApiKey', () => {
  it('два выпуска не совпадают ни секретом, ни хешем', () => {
    // 32 случайных байта: совпадение здесь означало бы, что источник
    // случайности не тот, за который его принимают.
    const a = issueApiKey();
    const b = issueApiKey();
    expect(a.secret).not.toBe(b.secret);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('секрет начинается с префикса продукта и достаточно длинный', () => {
    const { secret } = issueApiKey();
    expect(secret.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 байта в base64url — не меньше 40 символов.
    expect(secret.length).toBeGreaterThan(40);
  });

  it('хеш — это хеш секрета, а не что-то похожее на него', () => {
    const { secret, keyHash } = issueApiKey();
    expect(keyHash).toBe(hashApiKey(secret));
    // И самого секрета в хеше нет — иначе хранить хеш незачем.
    expect(keyHash).not.toContain(secret.slice(API_KEY_PREFIX.length));
  });

  it('открытая часть — начало ключа, а не весь ключ', () => {
    const { secret, hint } = issueApiKey();
    expect(secret.startsWith(hint)).toBe(true);
    expect(hint.length).toBeLessThan(secret.length);
    expect(hintOf(secret)).toBe(hint);
  });
});

describe('apiKeyFromHeader', () => {
  it('достаёт ключ из Bearer', () => {
    expect(apiKeyFromHeader(`Bearer ${API_KEY_PREFIX}abc`)).toBe(
      `${API_KEY_PREFIX}abc`,
    );
  });

  it('схема разбирается без учёта регистра, а ключ — с учётом', () => {
    // Регистр схемы не важен по RFC 7235; регистр ключа важен, и
    // «починить» его приведением значило бы принимать чужой за свой.
    expect(apiKeyFromHeader(`bearer ${API_KEY_PREFIX}AbC`)).toBe(
      `${API_KEY_PREFIX}AbC`,
    );
  });

  it('чужой Bearer ключом API не притворяется', () => {
    // Админский и кроновый секреты ходят тем же заголовком. Без
    // проверки префикса они ушли бы в поиск по базе, и отказ назывался
    // бы «ключ не найден» вместо «это не ключ API».
    expect(apiKeyFromHeader('Bearer some-cron-secret')).toBeNull();
  });

  it('нет заголовка, не та схема, пробелы — null, а не пустой ключ', () => {
    // Пустая строка ушла бы в поиск по базе и совпала бы с чем угодно,
    // что там лежит пустым.
    expect(apiKeyFromHeader(undefined)).toBeNull();
    expect(apiKeyFromHeader('')).toBeNull();
    expect(apiKeyFromHeader(`Basic ${API_KEY_PREFIX}abc`)).toBeNull();
    expect(apiKeyFromHeader('Bearer ')).toBeNull();
    expect(apiKeyFromHeader(`Bearer ${API_KEY_PREFIX}a b`)).toBeNull();
  });
});

describe('shouldTouchLastUsed', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('ни разу не использованный ключ отмечается сразу', () => {
    expect(shouldTouchLastUsed(null, now)).toBe(true);
  });

  it('свежая отметка второй раз не пишется', () => {
    // Запись на каждый вызов — плата за наблюдаемость на самом горячем
    // пути; вопрос «этим ключом ещё пользуются?» от часа не зависит.
    expect(shouldTouchLastUsed(new Date(now.getTime() - 60_000), now)).toBe(
      false,
    );
  });

  it('старая отметка обновляется', () => {
    expect(
      shouldTouchLastUsed(
        new Date(now.getTime() - LAST_USED_GRANULARITY_MS - 1),
        now,
      ),
    ).toBe(true);
  });
});
