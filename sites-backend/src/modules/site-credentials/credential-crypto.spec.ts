import { randomBytes } from 'crypto';
import {
  CREDENTIAL_MAX_BYTES,
  CredentialAad,
  CredentialCryptoError,
  envelopeVersion,
  loadKeyring,
  openCredential,
  resealCredential,
  sealCredential,
} from './credential-crypto';

const k = () => randomBytes(32).toString('base64');
const K1 = k();
const K2 = k();

const AAD: CredentialAad = {
  scope: 'A',
  accountId: 'acc1',
  siteId: 'site1',
  testAccountId: 'ta1',
  purpose: 'password',
};

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CredentialCryptoError ? e.code : 'other';
  }
}

describe('связка ключей SITE_CREDENTIALS_KEYS', () => {
  it('нет переменной — not_configured (хранилище выключено, не «кривое»)', () => {
    expect(code(() => loadKeyring({}))).toBe('not_configured');
    expect(code(() => loadKeyring({ SITE_CREDENTIALS_KEYS: '  ' }))).toBe(
      'not_configured',
    );
  });

  it('один ключ — он текущий; несколько — нужна текущая версия', () => {
    expect(loadKeyring({ SITE_CREDENTIALS_KEYS: `v1:${K1}` }).current).toBe(
      'v1',
    );
    expect(
      code(() => loadKeyring({ SITE_CREDENTIALS_KEYS: `v1:${K1},v2:${K2}` })),
    ).toBe('invalid_keys');
    const r = loadKeyring({
      SITE_CREDENTIALS_KEYS: ` v1:${K1} , v2:${K2} `,
      SITE_CREDENTIALS_KEY_CURRENT: 'v2',
    });
    expect(r.current).toBe('v2');
    expect(r.versions).toEqual(['v1', 'v2']);
  });

  it('кривые ключи и версии — invalid_keys, без байт ключа в тексте', () => {
    for (const raw of [
      'v1:short',
      `x1:${K1}`,
      `v1:${K1},v1:${K2}`,
      `${K1}`,
      `v0:${K1}`,
    ]) {
      let err: unknown;
      try {
        loadKeyring({ SITE_CREDENTIALS_KEYS: raw });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialCryptoError);
      expect((err as CredentialCryptoError).code).toBe('invalid_keys');
      expect((err as Error).message).not.toContain(K1);
    }
    expect(
      code(() =>
        loadKeyring({
          SITE_CREDENTIALS_KEYS: `v1:${K1}`,
          SITE_CREDENTIALS_KEY_CURRENT: 'v9',
        }),
      ),
    ).toBe('invalid_keys');
  });
});

describe('шифрование секрета (AES-256-GCM, версия, AAD)', () => {
  const ring = loadKeyring({ SITE_CREDENTIALS_KEYS: `v1:${K1}` });

  it('туда-обратно; шифротекст в формате sc1 и без открытого текста', () => {
    const sealed = sealCredential('pa$$-секрет', AAD, ring);
    expect(sealed.keyVersion).toBe('v1');
    expect(sealed.ciphertext).toMatch(/^sc1\.v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed.ciphertext).not.toContain('pa$$');
    expect(envelopeVersion(sealed.ciphertext)).toBe('v1');
    expect(openCredential(sealed, AAD, ring)).toBe('pa$$-секрет');
  });

  it('два шифрования одного секрета различаются (случайный iv)', () => {
    expect(sealCredential('x', AAD, ring).ciphertext).not.toBe(
      sealCredential('x', AAD, ring).ciphertext,
    );
  });

  it.each([
    ['scope', { scope: 'B' as const }],
    ['кабинет', { accountId: 'acc2' }],
    ['сайт', { siteId: 'site2' }],
    ['учётка', { testAccountId: 'ta2' }],
    ['назначение', { purpose: 'session-cookies' as const }],
  ])('подмена AAD (%s) — отказ tampered', (_name, patch) => {
    const sealed = sealCredential('secret', AAD, ring);
    expect(code(() => openCredential(sealed, { ...AAD, ...patch }, ring))).toBe(
      'tampered',
    );
  });

  it('подмена шифротекста или тега — tampered', () => {
    const sealed = sealCredential('secret', AAD, ring);
    const parts = sealed.ciphertext.split('.');
    const flip = (s: string) => {
      const b = Buffer.from(s, 'base64url');
      b[0] ^= 1;
      return b.toString('base64url');
    };
    for (const i of [2, 3, 4]) {
      const bad = [...parts];
      bad[i] = flip(bad[i]);
      expect(
        code(() =>
          openCredential(
            { ciphertext: bad.join('.'), keyVersion: 'v1' },
            AAD,
            ring,
          ),
        ),
      ).toBe('tampered');
    }
  });

  it('подмена версии: в колонке — version_mismatch; в конверте — нет ключа или tampered', () => {
    const both = loadKeyring({
      SITE_CREDENTIALS_KEYS: `v1:${K1},v2:${K2}`,
      SITE_CREDENTIALS_KEY_CURRENT: 'v1',
    });
    const sealed = sealCredential('secret', AAD, both);
    expect(
      code(() => openCredential({ ...sealed, keyVersion: 'v2' }, AAD, both)),
    ).toBe('version_mismatch');
    const swapped = sealed.ciphertext.replace(/^sc1\.v1\./, 'sc1.v2.');
    // Конверт и колонка согласованы на v2, но шифровали ключом v1 и AAD с v1.
    expect(
      code(() =>
        openCredential({ ciphertext: swapped, keyVersion: 'v2' }, AAD, both),
      ),
    ).toBe('tampered');
    expect(
      code(() =>
        openCredential({ ciphertext: swapped, keyVersion: 'v2' }, AAD, ring),
      ),
    ).toBe('unknown_key');
  });

  it('не тот формат — malformed; больше потолка — too_large', () => {
    expect(
      code(() =>
        openCredential({ ciphertext: 'abc', keyVersion: 'v1' }, AAD, ring),
      ),
    ).toBe('malformed');
    expect(
      code(() =>
        sealCredential(
          'x'.repeat(CREDENTIAL_MAX_BYTES.password + 1),
          AAD,
          ring,
        ),
      ),
    ).toBe('too_large');
  });

  it('ротация: строка v1 перешифровывается v2 и читается; уже текущая — без изменений', () => {
    const old = sealCredential('secret', AAD, ring);
    const both = loadKeyring({
      SITE_CREDENTIALS_KEYS: `v1:${K1},v2:${K2}`,
      SITE_CREDENTIALS_KEY_CURRENT: 'v2',
    });
    const next = resealCredential(old, AAD, both);
    expect(next?.keyVersion).toBe('v2');
    const onlyV2 = loadKeyring({ SITE_CREDENTIALS_KEYS: `v2:${K2}` });
    expect(openCredential(next!, AAD, onlyV2)).toBe('secret');
    expect(resealCredential(next!, AAD, both)).toBeNull();
    // Старый ключ удалён до ротации — строка не читается (честный отказ).
    expect(code(() => openCredential(old, AAD, onlyV2))).toBe('unknown_key');
  });
});
