/**
 * Одноразовый streamToken на сессию — doc/LIVE-LOGIN-RELAY-SPEC.md §10.2.
 *
 * В памяти `Session` хранится НЕ сам токен, а sha256-хэш от него —
 * сравнение при WS-хендшейке идёт по хэшу через `timingSafeEqual`, той
 * же дисциплиной «не хранить секрет плоским текстом», что уже применена
 * в проекте для куда более долгоживущих секретов (`token-crypto.ts`),
 * только здесь — необратимым хэшем, а не шифрованием: токен одноразовый
 * и короткоживущий, расшифровывать обратно никогда не требуется.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface StreamTokenPair {
  token: string;
  hash: string; // hex sha256
}

export function generateStreamToken(): StreamTokenPair {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyStreamToken(
  presentedToken: string,
  expectedHash: string,
): boolean {
  const presentedHash = hashToken(presentedToken);
  const bufA = Buffer.from(presentedHash, 'hex');
  const bufB = Buffer.from(expectedHash, 'hex');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
