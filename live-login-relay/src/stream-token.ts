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
  // Защита самой примитивы, а не только вызывающего (найдено аудитом
  // этапа 108): `createHash().update(undefined)` бросает
  // `ERR_INVALID_ARG_TYPE` — и, поскольку вызов происходит синхронно
  // внутри обработчика `ws.on('message')`, это ронял ВЕСЬ процесс реле.
  // Основную проверку делает `parseClientMessage` (client-message.ts),
  // но функция проверки токена не должна зависеть от того, что её
  // единственный сегодняшний вызывающий не забыл провалидировать вход:
  // «не строка» — это просто «токен не совпал», а не аварийное
  // завершение сервиса.
  if (typeof presentedToken !== 'string' || presentedToken.length === 0) {
    return false;
  }
  const presentedHash = hashToken(presentedToken);
  const bufA = Buffer.from(presentedHash, 'hex');
  const bufB = Buffer.from(expectedHash, 'hex');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
