/**
 * №60 (Р-З10-12), зона аналитики: `identify` лида, секреты интеграций и
 * подпись `assistRef`, записанные ДО связки ключей (замороженная формула,
 * ключ K1), читаются после выката и после ротации; при версии v1 новый код
 * пишет прежний формат (откат выката читает).
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { refSecret, refSecrets } from './ai/ai-env';
import {
  decryptSecret,
  encryptSecret,
  integrationsKey,
} from './integrations.service';
import { issueRef, verifyRef } from './public/ai-intake.service';
import {
  decryptIdentity,
  encryptIdentity,
  identityKey,
} from './public/identity-crypto';

const K1 = 'analytics-legacy-k1';
const K2 = 'analytics-new-k2';
const BEFORE = { ASSIST_SECRETS_KEY: K1 };
const ROTATED = {
  ASSIST_SECRETS_KEY: K2,
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: `v1:${K1}`,
};
const ONLY_K2 = { ASSIST_SECRETS_KEY: K2, ASSIST_SECRETS_KEY_VERSION: 'v2' };

/** Замороженный шифр до №60 (identity-crypto / integrations.service). */
function legacyGcm(plain: string, aad: string, label: string): string {
  const key = createHmac('sha256', K1).update(label).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

describe('identify лида (assist_site_leads.identityEnc)', () => {
  const identity = {
    name: 'Ivan',
    email: 'i@example.com',
    externalId: 'u-1',
    userHash: null,
  };
  const legacy = legacyGcm(
    JSON.stringify(identity),
    'lead-1',
    'assist-site-identity-v1',
  );

  it('строка до №60 читается до и после ротации; без прежнего ключа — null', () => {
    expect(decryptIdentity(legacy, 'lead-1', identityKey(BEFORE)!)).toEqual(
      identity,
    );
    expect(decryptIdentity(legacy, 'lead-1', identityKey(ROTATED)!)).toEqual(
      identity,
    );
    expect(decryptIdentity(legacy, 'lead-1', identityKey(ONLY_K2)!)).toBeNull();
  });

  it('новая запись — прежний формат при v1 и v2; v2 читается без прежнего ключа', () => {
    expect(
      encryptIdentity(identity, 'l2', identityKey(BEFORE)!).startsWith('v1.'),
    ).toBe(true);
    const enc = encryptIdentity(identity, 'l2', identityKey(ROTATED)!);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptIdentity(enc, 'l2', identityKey(BEFORE)!)).toBeNull();
    expect(decryptIdentity(enc, 'l2', identityKey(ONLY_K2)!)).toEqual(identity);
  });
});

describe('секрет интеграции (assist_site_integrations.secretEnc)', () => {
  const legacy = legacyGcm(
    'whsec_abc',
    'site1:goal_webhook',
    'assist-site-integration-secret-v1',
  );

  it('строка до №60 читается до и после ротации', () => {
    expect(
      decryptSecret(legacy, 'site1:goal_webhook', integrationsKey(BEFORE)!),
    ).toBe('whsec_abc');
    expect(
      decryptSecret(legacy, 'site1:goal_webhook', integrationsKey(ROTATED)!),
    ).toBe('whsec_abc');
    expect(
      decryptSecret(legacy, 'site1:identity', integrationsKey(ROTATED)!),
    ).toBeNull();
    expect(
      decryptSecret(legacy, 'site1:goal_webhook', integrationsKey(ONLY_K2)!),
    ).toBeNull();
  });

  it('новая запись — прежний формат при v1 и v2', () => {
    expect(
      encryptSecret('s', 'a', integrationsKey(BEFORE)!).startsWith('v1.'),
    ).toBe(true);
    const enc = encryptSecret('s', 'a', integrationsKey(ROTATED)!);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc, 'a', integrationsKey(BEFORE)!)).toBeNull();
    expect(decryptSecret(enc, 'a', integrationsKey(ONLY_K2)!)).toBe('s');
  });
});

describe('assistRef: выдан до ротации — принимается после неё (2 суток)', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const visit = 'a'.repeat(32);

  it('секрет v1 — прежняя формула; ref до ротации проверяется связкой', () => {
    expect(refSecret(BEFORE)).toBe(
      createHash('sha256').update(`assist-ref:${K1}`).digest('hex'),
    );
    expect(refSecrets(ROTATED)).toHaveLength(2);
    const ref = issueRef('site1', visit, now, BEFORE)!;
    expect(verifyRef('site1', ref, now, ROTATED)).toBe(visit);
    expect(verifyRef('site1', ref, now, ONLY_K2)).toBeNull();
    expect(verifyRef('site2', ref, now, ROTATED)).toBeNull();
    const fresh = issueRef('site1', visit, now, ROTATED)!;
    expect(verifyRef('site1', fresh, now, BEFORE)).toBeNull();
    expect(verifyRef('site1', fresh, now, ONLY_K2)).toBe(visit);
  });

  it('свой ASSIST_ANALYTICS_REF_SECRET — один, связка не участвует', () => {
    const env = { ...ROTATED, ASSIST_ANALYTICS_REF_SECRET: 'x'.repeat(20) };
    expect(refSecrets(env)).toEqual(['x'.repeat(20)]);
  });
});
