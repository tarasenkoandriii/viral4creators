import { createHmac } from 'crypto';
import {
  STARS_INVOICE_PAYLOAD_MAX_BYTES,
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

  it('просроченный payload прежнего формата — null', () => {
    const rePacked = Buffer.from(
      JSON.stringify({
        userId: 'user-1',
        purpose: 'SUBSCRIPTION',
        target: 'STANDARD',
        expiresAt: Math.floor(Date.now() / 1000) - 10,
      }),
      'utf8',
    ).toString('base64url');
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
  // Аудит Э4 (2026-10-02): Bot API `createInvoiceLink`/`sendInvoice` —
  // «Bot-defined invoice payload, 1-128 bytes». Прежний формат весил
  // 184–187 байт для cuid — Telegram отклонял инвойс целиком.
  describe('лимит Bot API на invoice_payload (1–128 байт)', () => {
    const CUID = 'clx1a2b3c4d5e6f7g8h9i0j1k'; // 25 символов, как @default(cuid())
    const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
    it.each([
      [CUID, 'SUBSCRIPTION', 'STANDARD'],
      [CUID, 'CREDIT_PACK', 'large'],
      [UUID, 'SUBSCRIPTION', 'PREMIUM'],
      [UUID, 'CREDIT_PACK', 'small'],
    ] as const)(
      '%s / %s / %s — укладывается и проверяется',
      (userId, purpose, target) => {
        const raw = signStarsInvoicePayload({ userId, purpose, target }, KEY);
        expect(STARS_INVOICE_PAYLOAD_MAX_BYTES).toBe(128);
        expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThanOrEqual(1);
        expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(128);
        expect(verifyStarsInvoicePayload(raw, KEY)).toEqual(
          expect.objectContaining({ userId, purpose, target }),
        );
      },
    );

    it('слишком длинный userId — sign бросает, а не отдаёт Telegram негодный payload', () => {
      expect(() =>
        signStarsInvoicePayload(
          {
            userId: 'u'.repeat(120),
            purpose: 'SUBSCRIPTION',
            target: 'STANDARD',
          },
          KEY,
        ),
      ).toThrow(/128/);
    });

    it('разделитель в userId/target — sign бросает (поле не сможет подменить соседнее)', () => {
      expect(() =>
        signStarsInvoicePayload(
          { userId: 'u1:S', purpose: 'SUBSCRIPTION', target: 'STANDARD' },
          KEY,
        ),
      ).toThrow();
    });

    it('подмена поля в компактном теле при чужой подписи — null', () => {
      const raw = signStarsInvoicePayload(
        { userId: CUID, purpose: 'SUBSCRIPTION', target: 'STANDARD' },
        KEY,
      );
      const forged = raw.replace(':STANDARD:', ':PREMIUM:');
      expect(forged).not.toBe(raw);
      expect(verifyStarsInvoicePayload(forged, KEY)).toBeNull();
    });

    it('просроченный компактный payload — null, а со skipExpiry (автопродление) — валиден', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const raw = signStarsInvoicePayload(
        { userId: CUID, purpose: 'SUBSCRIPTION', target: 'STANDARD' },
        KEY,
      );
      jest.setSystemTime(new Date('2026-03-01T00:00:00Z'));
      try {
        expect(verifyStarsInvoicePayload(raw, KEY)).toBeNull();
        expect(
          verifyStarsInvoicePayload(raw, KEY, { skipExpiry: true })?.target,
        ).toBe('STANDARD');
      } finally {
        jest.useRealTimers();
      }
    });

    it('прежний формат base64url(JSON) с верной подписью по-прежнему проверяется', () => {
      const b64 = Buffer.from(
        JSON.stringify({
          userId: 'u-old',
          purpose: 'SUBSCRIPTION',
          target: 'PREMIUM',
          expiresAt: 1,
        }),
        'utf8',
      ).toString('base64url');
      const sig = createHmac('sha256', KEY).update(b64).digest('base64url');
      expect(
        verifyStarsInvoicePayload(`${b64}.${sig}`, KEY, { skipExpiry: true }),
      ).toEqual(
        expect.objectContaining({ userId: 'u-old', target: 'PREMIUM' }),
      );
    });
  });
});
