import { createHmac } from 'crypto';
import {
  signStarsInvoicePayload,
  verifyStarsInvoicePayload,
} from './stars-invoice-payload.util';

const KEY = 'test-payment-token-key';

describe('stars-invoice-payload.util', () => {
  it('round-trip: verify возвращает то, что подписал sign', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
      KEY,
    );
    const payload = verifyStarsInvoicePayload(raw, KEY);
    expect(payload?.userId).toBe('user-1');
    expect(payload?.purpose).toBe('SUBSCRIPTION');
    expect(payload?.target).toBe('STANDARD');
  });

  it('CREDIT_PACK payload — target это id пакета', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'CREDIT_PACK', target: 'small' },
      KEY,
    );
    expect(verifyStarsInvoicePayload(raw, KEY)?.target).toBe('small');
  });

  it('подделанная подпись — null, а не исключение', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
      KEY,
    );
    const [payload] = raw.split('.');
    expect(
      verifyStarsInvoicePayload(`${payload}.wrongsignature`, KEY),
    ).toBeNull();
  });

  it('подделанный payload при валидной по формату подписи — null', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
      KEY,
    );
    const [, sig] = raw.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        userId: 'attacker',
        purpose: 'SUBSCRIPTION',
        target: 'PREMIUM',
        expiresAt: 9999999999,
      }),
      'utf8',
    ).toString('base64url');
    expect(verifyStarsInvoicePayload(`${forged}.${sig}`, KEY)).toBeNull();
  });

  it('неверный ключ проверки — null', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
      KEY,
    );
    expect(verifyStarsInvoicePayload(raw, 'a-different-key')).toBeNull();
  });

  it('просроченный payload — null', () => {
    const raw = signStarsInvoicePayload(
      { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
      KEY,
    );
    const [payloadB64] = raw.split('.');
    const decoded = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
    decoded.expiresAt = Math.floor(Date.now() / 1000) - 10;
    const rePacked = Buffer.from(JSON.stringify(decoded), 'utf8').toString(
      'base64url',
    );
    const sig = createHmac('sha256', KEY).update(rePacked).digest('base64url');
    expect(verifyStarsInvoicePayload(`${rePacked}.${sig}`, KEY)).toBeNull();
  });

  it('пустая строка/undefined — null', () => {
    expect(verifyStarsInvoicePayload(undefined, KEY)).toBeNull();
    expect(verifyStarsInvoicePayload('', KEY)).toBeNull();
  });

  it('без ключа sign бросает понятную ошибку', () => {
    expect(() =>
      signStarsInvoicePayload(
        { userId: 'user-1', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
        undefined,
      ),
    ).toThrow(/PAYMENT_TOKEN_KEY/);
  });
});
