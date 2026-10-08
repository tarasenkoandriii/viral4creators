/**
 * Подпись экспорта голосовой карты (§5-кватер.12, аудит Н-5): ключ — свой
 * `ASSIST_VOICE_MAP_EXPORT_KEY` или ПРОИЗВОДНЫЙ HMAC(ASSIST_SECRETS_KEY,
 * 'voice-map-export-v1') (сам KEK ключом HMAC не служит); сверка — за
 * постоянное время, другая длина — «не наш файл», а не исключение; без
 * ключа файл «нашим» не признаётся. Без базы: только подпись.
 */
import { createHmac } from 'crypto';
import { canonicalJson } from '../assist-ui-core/voice-map';
import { VoiceMapService } from './voice-map.service';

type Signer = {
  env: NodeJS.ProcessEnv;
  signature(p: unknown): string;
  signatureValid(p: unknown, got: unknown): boolean;
};

function signer(env: NodeJS.ProcessEnv): Signer {
  const s = Object.create(VoiceMapService.prototype) as Signer;
  s.env = env;
  return s;
}

const PAYLOAD = { v: 1, kind: 'site', targets: [{ key: 'cart' }] };
const KEK = 'k'.repeat(44);

describe('подпись экспорта карты (аудит Н-5)', () => {
  it('без своего ключа — производный от ASSIST_SECRETS_KEY с меткой, не сам KEK', () => {
    const s = signer({ ASSIST_SECRETS_KEY: KEK });
    const derived = createHmac('sha256', KEK)
      .update('voice-map-export-v1')
      .digest();
    expect(s.signature(PAYLOAD)).toBe(
      createHmac('sha256', derived)
        .update(canonicalJson(PAYLOAD))
        .digest('base64url'),
    );
    expect(s.signature(PAYLOAD)).not.toBe(
      createHmac('sha256', KEK)
        .update(canonicalJson(PAYLOAD))
        .digest('base64url'),
    );
  });

  it('свой ключ важнее KEK; сверка своей подписи — да, чужой/правленой — нет', () => {
    const s = signer({
      ASSIST_VOICE_MAP_EXPORT_KEY: 'e'.repeat(40),
      ASSIST_SECRETS_KEY: KEK,
    });
    const sig = s.signature(PAYLOAD);
    expect(sig).toBe(
      createHmac('sha256', 'e'.repeat(40))
        .update(canonicalJson(PAYLOAD))
        .digest('base64url'),
    );
    expect(s.signatureValid(PAYLOAD, sig)).toBe(true);
    expect(s.signatureValid({ ...PAYLOAD, v: 2 }, sig)).toBe(false);
    expect(
      signer({ ASSIST_SECRETS_KEY: KEK }).signatureValid(PAYLOAD, sig),
    ).toBe(false);
  });

  it('другая длина, не строка — false без исключения (timingSafeEqual)', () => {
    const s = signer({ ASSIST_SECRETS_KEY: KEK });
    const sig = s.signature(PAYLOAD);
    expect(s.signatureValid(PAYLOAD, sig.slice(1))).toBe(false);
    expect(s.signatureValid(PAYLOAD, `${sig}x`)).toBe(false);
    expect(s.signatureValid(PAYLOAD, 42)).toBe(false);
    expect(s.signatureValid(PAYLOAD, undefined)).toBe(false);
  });

  it('№60: файл, подписанный до ротации ASSIST_SECRETS_KEY, остаётся «нашим»', () => {
    const before = signer({ ASSIST_SECRETS_KEY: KEK });
    const oldSig = before.signature(PAYLOAD);
    const rotated = signer({
      ASSIST_SECRETS_KEY: 'n'.repeat(44),
      ASSIST_SECRETS_KEY_VERSION: 'v2',
      ASSIST_SECRETS_KEYS_OLD: `v1:${KEK}`,
    });
    expect(rotated.signatureValid(PAYLOAD, oldSig)).toBe(true);
    // Новая подпись — текущим ключом (v2): прежний её не признаёт.
    const newSig = rotated.signature(PAYLOAD);
    expect(newSig).not.toBe(oldSig);
    expect(before.signatureValid(PAYLOAD, newSig)).toBe(false);
    // Прежний ключ убран из env — старый файл уже не «наш».
    const onlyNew = signer({
      ASSIST_SECRETS_KEY: 'n'.repeat(44),
      ASSIST_SECRETS_KEY_VERSION: 'v2',
    });
    expect(onlyNew.signatureValid(PAYLOAD, oldSig)).toBe(false);
    expect(onlyNew.signatureValid(PAYLOAD, newSig)).toBe(true);
  });

  it('без ключей подпись в файле есть, но «нашим» файл не признаётся', () => {
    const s = signer({});
    const sig = s.signature(PAYLOAD);
    expect(typeof sig).toBe('string');
    expect(s.signatureValid(PAYLOAD, sig)).toBe(false);
  });
});
