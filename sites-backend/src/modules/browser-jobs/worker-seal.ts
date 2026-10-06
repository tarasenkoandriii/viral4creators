/**
 * Запечатывание секретов учётки для браузерного воркера (Э-С Ш3; аудит
 * слияния §3.2 «расшифровать может только браузерный воркер»; хвост Ш2 (5)).
 *
 * Схема: X25519 (эфемерный ключ на каждое запечатывание) + HKDF-SHA256 +
 * AES-256-GCM, AAD — id задания и номер попытки. Открытый ключ воркера —
 * у sites-backend (`SITES_WORKER_SEAL_PUBLIC_KEY`), закрытый — ТОЛЬКО у
 * воркера (`BROWSER_WORKER_SEAL_PRIVATE_KEY`).
 *
 * Что это даёт уже сейчас: ответ `credentials` несёт не открытый текст, а
 * конверт под ключ воркера. Держатель одного HMAC-секрета воркера (утечка
 * env, перехват запроса, журнал прокси/платформы) секрета учётки НЕ
 * получает — нужен ещё закрытый ключ, которого на Vercel нет вовсе.
 * Чего НЕ даёт (хвост — `doc/TODO.md`): sites-backend по-прежнему
 * расшифровывает хранилище Ш2 своим KEK в момент выдачи; «шифровать под
 * ключ воркера при записи» — следующий шаг.
 *
 * ЧИСТЫЙ модуль (только `crypto` Node) — копия у воркера:
 * `browser-worker/src/shared/worker-seal.ts` (scripts/sync-worker-shared.mjs).
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'crypto';

export const SEAL_VERSION = 'v1';
const INFO = 'v4c-browser-worker-seal-v1';
const B64U = /^[A-Za-z0-9_-]{43}$/;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function isUsableSealKey(v: string | undefined): v is string {
  return typeof v === 'string' && B64U.test(v.trim());
}

function publicKeyOf(x: string): KeyObject {
  if (!isUsableSealKey(x))
    throw new SealError('открытый ключ воркера не задан');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: x.trim() },
    format: 'jwk',
  });
}

function privateKeyOf(d: string): KeyObject {
  if (!isUsableSealKey(d))
    throw new SealError('закрытый ключ воркера не задан');
  const pub = derivePublicFromPrivate(d);
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: d.trim(), x: pub },
    format: 'jwk',
  });
}

/** Открытый ключ (base64url `x`) из закрытого (`d`) — для самопроверки. */
export function derivePublicFromPrivate(d: string): string {
  if (!isUsableSealKey(d))
    throw new SealError('закрытый ключ воркера не задан');
  // PKCS#8 X25519: фиксированный префикс + 32 байта ключа.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    Buffer.from(d.trim(), 'base64url'),
  ]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new SealError('ключ не X25519');
  return jwk.x;
}

export function generateWorkerSealKeys(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  return { publicKey: pub.x, privateKey: priv.d };
}

function rawPublic(k: KeyObject): Buffer {
  const jwk = k.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url');
}

function deriveKey(
  shared: Buffer,
  epk: Buffer,
  rpk: Buffer,
  aad: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([epk, rpk]),
      Buffer.from(`${INFO}|${aad}`, 'utf8'),
      32,
    ),
  );
}

/** Конверт `v1.<epk>.<iv>.<ct+tag>` (base64url) под открытый ключ воркера. */
export function sealForWorker(
  workerPublicKey: string,
  plaintext: Buffer,
  aad: string,
): string {
  const rpkObj = publicKeyOf(workerPublicKey);
  const { publicKey: epkObj, privateKey: eskObj } =
    generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eskObj, publicKey: rpkObj });
  const epk = rawPublic(epkObj);
  const key = deriveKey(shared, epk, rawPublic(rpkObj), aad);
  shared.fill(0);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  key.fill(0);
  return [
    SEAL_VERSION,
    epk.toString('base64url'),
    iv.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/** Открыть конверт закрытым ключом воркера; чужой AAD/ключ/порча — SealError. */
export function openSealed(
  workerPrivateKey: string,
  sealed: string,
  aad: string,
): Buffer {
  const parts = typeof sealed === 'string' ? sealed.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) {
    throw new SealError('неизвестный формат конверта');
  }
  const [, epkB, ivB, ctB] = parts;
  const epk = Buffer.from(epkB, 'base64url');
  const iv = Buffer.from(ivB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (epk.length !== 32 || iv.length !== 12 || ct.length < 16) {
    throw new SealError('повреждённый конверт');
  }
  const sk = privateKeyOf(workerPrivateKey);
  const epkObj = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: epkB },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: sk, publicKey: epkObj });
  const key = deriveKey(shared, epk, rawPublic(createPublicKey(sk)), aad);
  shared.fill(0);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new SealError('конверт не открылся (ключ, AAD или порча)');
  } finally {
    key.fill(0);
  }
}

/** AAD конверта: секрет годен только для этого задания и этой попытки. */
export function sealAad(jobId: string, attempt: number): string {
  return `bjob:${jobId}:${attempt}`;
}
