/**
 * Шифрование OAuth-токенов каналов выгрузки в состоянии покоя (этап 61,
 * ТЗ §14.3-14.4). `PublishingChannel.accessTokenEnc`/`refreshTokenEnc` —
 * единственное место в проекте, где секрет чужого сервиса (не наш
 * собственный API-ключ) лежит в нашей базе; утечка строки из БД не должна
 * сразу означать утечку доступа к чужому YouTube/TikTok-каналу.
 *
 * AES-256-GCM — аутентифицированное шифрование (подмена ciphertext
 * ломает расшифровку, а не тихо отдаёт мусор), ключ приходит из
 * `CHANNEL_TOKEN_KEY` (32 байта, base64) — как и остальные опциональные
 * интеграции проекта, отсутствие ключа не валит старт приложения
 * (`configuration.ts` не требует его в `validateConfiguration`), а
 * проявляется мягко: `PublishingChannelService` не сможет ни зашифровать
 * новый токен при подключении канала, ни расшифровать существующий перед
 * выгрузкой — соответствующий вызов бросит здесь же, при первом
 * обращении, а не при старте.
 *
 * Формат хранимой строки: `<base64 iv (12 байт)>.<base64 authTag (16
 * байт)>.<base64 ciphertext>` — один текстовый столбец, без бинарных
 * колонок и без второй таблицы под IV.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // рекомендация NIST для GCM
const KEY_LENGTH = 32; // AES-256

/** Бросает с понятным текстом, если CHANNEL_TOKEN_KEY не задан или не
 * похож на 32 байта base64 — это ошибка конфигурации, а не сети/БД. */
function resolveKey(rawKey: string | undefined): Buffer {
  const trimmed = rawKey?.trim();
  if (!trimmed) {
    throw new Error(
      'CHANNEL_TOKEN_KEY не задан — подключение каналов выгрузки недоступно, пока переменная не появится',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(trimmed, 'base64');
  } catch {
    throw new Error('CHANNEL_TOKEN_KEY: не удалось декодировать как base64');
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CHANNEL_TOKEN_KEY: ожидалось ${KEY_LENGTH} байт после base64-декода, получено ${key.length}`,
    );
  }
  return key;
}

export function encryptToken(
  plaintext: string,
  rawKey: string | undefined,
): string {
  const key = resolveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptToken(
  stored: string,
  rawKey: string | undefined,
): string {
  const key = resolveKey(rawKey);
  const parts = stored.split('.');
  if (parts.length !== 3) {
    throw new Error(
      'Повреждённая запись токена: ожидался формат iv.authTag.ciphertext',
    );
  }
  const [ivPart, authTagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart, 'base64');
  const authTag = Buffer.from(authTagPart, 'base64');
  const ciphertext = Buffer.from(ciphertextPart, 'base64');
  if (iv.length !== IV_LENGTH || authTag.length !== 16) {
    throw new Error('Повреждённая запись токена: неверная длина iv/authTag');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // Неверный ключ или подменённый ciphertext — GCM бросит здесь же
  // (проверка authTag), а не молча отдаст мусор.
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
