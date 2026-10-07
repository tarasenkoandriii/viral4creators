/**
 * Конверт сессии черновика для раунда на браузерном воркере (Ш3-хвост (3)).
 *
 * Формат — тот же, что `sites-backend/src/modules/browser-jobs/worker-seal.ts`
 * (копия у воркера — `browser-worker/src/shared/worker-seal.ts`):
 * `v1.<epk>.<iv>.<ct+tag>` (base64url), X25519 с эфемерным ключом + HKDF-SHA256
 * + AES-256-GCM, AAD — строкой. Своей реализацией, а не копией: генератор —
 * отдельный пакет без общего кода с sites-backend; совместимость держит
 * спек на эталонном конверте, запечатанном кодом sites-backend
 * (`worker-session-seal.spec.ts`).
 *
 * Зачем: cookie jar черновика — секрет входа. В очередь воркера (база
 * sites-backend) он уходит только конвертом под открытый ключ воркера, а
 * новая сессия возвращается конвертом под ОДНОРАЗОВЫЙ ключ этого раунда
 * (`ephemeralReplyKeys`): закрытый ключ живёт в памяти функции генератора
 * на время одного раунда, и ни sites-backend, ни база ответ не прочтут.
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

const VERSION = 'v1';
const INFO = 'v4c-browser-worker-seal-v1';
const B64U = /^[A-Za-z0-9_-]{43}$/;

export class WorkerSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerSealError';
  }
}

/**
 * Привязка конвертов раунда — как `ExploreAadParts` протокола очереди
 * (sites-backend `browser-jobs/protocol.ts`): одноразовый `nonce`, ключ
 * ответа и хосты замка по алфавиту (аудит захода 7).
 */
export interface ExploreAadParts {
  nonce: string;
  replyKey: string;
  allowedHosts: readonly string[];
}

function aadTail(p: ExploreAadParts): string {
  return `${p.nonce}:${p.replyKey}:${[...new Set(p.allowedHosts)].sort().join(',')}`;
}

/** AAD конверта сессии (генератор → воркер). */
export function exploreSessionAad(p: ExploreAadParts): string {
  return `texp-in:${aadTail(p)}`;
}

/** AAD значения ввода (поле или шаг переигровки `index`). */
export function exploreFillAad(p: ExploreAadParts, index: number): string {
  return `texp-fill:${aadTail(p)}:${index}`;
}

/** AAD ответа (воркер → генератор). */
export function exploreReplyAad(p: ExploreAadParts): string {
  return `texp-out:${aadTail(p)}`;
}

/**
 * Хосты замка раунда — как их считает sites-backend (`lockHostOf`): имя в
 * нижнем регистре без точки в конце, порт — если нестандартный; без дублей.
 */
export function exploreLockHosts(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    const u = new URL(raw);
    const def = u.protocol === 'https:' ? '443' : '80';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    out.add(u.port && u.port !== def ? `${host}:${u.port}` : host);
  }
  return [...out];
}

export function isSealKey(v: unknown): v is string {
  return typeof v === 'string' && B64U.test(v);
}

function raw(k: KeyObject): Buffer {
  return Buffer.from(
    (k.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
}

function derive(shared: Buffer, epk: Buffer, rpk: Buffer, aad: string): Buffer {
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

/** Конверт под открытый ключ (`x` X25519, base64url). */
export function sealTo(
  publicKey: string,
  plaintext: Buffer,
  aad: string,
): string {
  if (!isSealKey(publicKey))
    throw new WorkerSealError('ключ конверта не X25519');
  const rpk = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: publicKey },
    format: 'jwk',
  });
  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: rpk });
  const epk = raw(eph.publicKey);
  const key = derive(shared, epk, raw(rpk), aad);
  shared.fill(0);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  key.fill(0);
  return [VERSION, epk, iv, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** Пара ключей одного раунда: открытый — воркеру, закрытый — только в памяти. */
export interface ReplyKeys {
  publicKey: string;
  open(sealed: string, aad: string): Buffer;
}

export function ephemeralReplyKeys(): ReplyKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    open: (sealed, aad) => openWith(privateKey, sealed, aad),
  };
}

function openWith(sk: KeyObject, sealed: string, aad: string): Buffer {
  const parts = typeof sealed === 'string' ? sealed.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new WorkerSealError('неизвестный формат конверта');
  }
  const [, epkB, ivB, ctB] = parts;
  const epk = Buffer.from(epkB, 'base64url');
  const iv = Buffer.from(ivB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (epk.length !== 32 || iv.length !== 12 || ct.length < 16) {
    throw new WorkerSealError('повреждённый конверт');
  }
  const epkObj = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: epkB },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: sk, publicKey: epkObj });
  const key = derive(shared, epk, raw(createPublicKey(sk)), aad);
  shared.fill(0);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new WorkerSealError('конверт не открылся (ключ, AAD или порча)');
  } finally {
    key.fill(0);
  }
}

/** Только тесты: открыть закрытым ключом `d` (base64url) — эталонный конверт. */
export function openWithPrivateForTests(
  d: string,
  x: string,
  sealed: string,
  aad: string,
): Buffer {
  const sk = createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d, x },
    format: 'jwk',
  });
  return openWith(sk, sealed, aad);
}
