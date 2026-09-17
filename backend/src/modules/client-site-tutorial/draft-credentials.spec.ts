/**
 * Хранение тестовых кред заказчика (§7.3 ТЗ, этап 111).
 *
 * Главное, что здесь проверяется, — что потеря кредов НЕ может пройти
 * тихо. У cookie jar рядом обратная политика (битую куку выбросить и
 * жить дальше), и если бы креды поехали тем же путём, пересборка ролика
 * записала бы экран ошибки входа вместо обучалки, а ни один счётчик об
 * этом бы не сказал.
 */

import { encryptToken } from '../../common/token-crypto';
import {
  CredentialsCorruptedError,
  CredentialsTooLargeError,
  MAX_CREDENTIALS_BYTES,
  decryptCredentials,
  encryptCredentials,
} from './draft-credentials';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const FIELDS = [
  { selector: '#email', value: 'shop@example.com' },
  { selector: 'input[name="password"]', value: 'п@роль — с юникодом' },
];

describe('круг шифрование → расшифровка', () => {
  it('поля возвращаются теми же и в том же порядке', () => {
    expect(decryptCredentials(encryptCredentials(FIELDS, KEY), KEY)).toEqual(
      FIELDS,
    );
  });

  it('в зашифрованной строке нет открытого пароля', () => {
    // Иначе всё упражнение бессмысленно: строка лежит в БД, которую
    // видит оператор и бэкап.
    const enc = encryptCredentials(FIELDS, KEY);
    expect(enc).not.toContain('п@роль');
    expect(enc).not.toContain('shop@example.com');
  });

  it('пустое значение поля — законно, а не повод потерять поле', () => {
    const fields = [{ selector: '#otp', value: '' }];
    expect(decryptCredentials(encryptCredentials(fields, KEY), KEY)).toEqual(
      fields,
    );
  });
});

describe('потеря кред никогда не проходит тихо', () => {
  it('чужой ключ — исключение, а не пустой список', () => {
    const enc = encryptCredentials(FIELDS, KEY);
    expect(() => decryptCredentials(enc, OTHER_KEY)).toThrow(
      CredentialsCorruptedError,
    );
  });

  it('мусор вместо записи — исключение', () => {
    expect(() => decryptCredentials('не-шифр', KEY)).toThrow(
      CredentialsCorruptedError,
    );
  });

  it('повреждённое поле роняет разбор целиком, а не выбрасывает одно поле', () => {
    // Ровно та разница с cookie jar, ради которой заведён отдельный
    // модуль: половина кред хуже, чем честная ошибка.
    const enc = encryptCredentials(FIELDS, KEY);
    const broken = encryptCredentialsRaw(
      JSON.stringify([{ selector: '#email', value: 'ok' }, { selector: 42 }]),
    );
    expect(decryptCredentials(enc, KEY)).toHaveLength(2);
    expect(() => decryptCredentials(broken, KEY)).toThrow(
      CredentialsCorruptedError,
    );
  });

  it('не список — исключение', () => {
    const enc = encryptCredentialsRaw(JSON.stringify({ selector: '#a' }));
    expect(() => decryptCredentials(enc, KEY)).toThrow(
      CredentialsCorruptedError,
    );
  });
});

describe('потолок размера', () => {
  it('превышение — ошибка, а не обрезание', () => {
    // Обрезанный пароль выглядит сохранённым и ломает вход молча.
    const huge = [{ selector: '#a', value: 'я'.repeat(MAX_CREDENTIALS_BYTES) }];
    expect(() => encryptCredentials(huge, KEY)).toThrow(
      CredentialsTooLargeError,
    );
  });

  it('обычная форма входа в потолок помещается с огромным запасом', () => {
    expect(() => encryptCredentials(FIELDS, KEY)).not.toThrow();
  });
});

/** Зашифровать произвольный JSON тем же ключом — нужно, чтобы собрать
 * заведомо испорченную запись, какую мог бы оставить более старый код. */
function encryptCredentialsRaw(json: string): string {
  return encryptToken(json, KEY);
}
