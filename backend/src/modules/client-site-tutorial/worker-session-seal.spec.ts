/**
 * Конверты раунда на воркере (Ш3-хвост (3)): формат совместим с
 * `worker-seal.ts` sites-backend и копией воркера — эталонные конверты
 * ниже запечатаны и открыты кодом sites-backend (одноразовые тестовые
 * ключи, не секреты). AAD — nonce, ключ ответа и хосты замка (аудит
 * захода 7) — те же строки, что у протокола очереди.
 */
import {
  WorkerSealError,
  ephemeralReplyKeys,
  exploreFillAad,
  exploreLockHosts,
  exploreReplyAad,
  exploreSessionAad,
  openWithPrivateForTests,
  sealTo,
} from './worker-session-seal';

const X = 'IIRNQT9jMm2A_UoS02HkgEvzvlldcaOr1lKG2L-XDUY';
const D = 'eMWacWm-O5mnEwu_L6GlI05QcelPsmA4Wtx0-nW1mWU';
const PARTS = {
  nonce: 'vector-nonce-000000000000',
  replyKey: X,
  allowedHosts: ['shop.test', 'a.shop.test'],
};
/** Ответ, запечатанный `sealForWorker` sites-backend под `exploreReplyAad(PARTS)`. */
const REPLY =
  'v1.okbJ3XKpK6_rNCfxFMx1O0pmgCU2WdvDaaTynV8fgTU.tyOqeYtcymUt1I8v.lmRxZT7UBVrKiIHos3oMyx1rtua44ylhQI0wXGA8MbzEkPJbOW5-T-7IDisPLVdLyerHONgS-diqanSfurSEhKp9D7o';

describe('конверты раунда на воркере', () => {
  it('AAD — строка протокола очереди: nonce, ключ ответа, хосты по алфавиту', () => {
    expect(exploreSessionAad(PARTS)).toBe(
      `texp-in:vector-nonce-000000000000:${X}:a.shop.test,shop.test`,
    );
    expect(exploreFillAad(PARTS, 3)).toBe(
      `texp-fill:vector-nonce-000000000000:${X}:a.shop.test,shop.test:3`,
    );
    expect(
      exploreReplyAad({
        ...PARTS,
        allowedHosts: ['shop.test', 'a.shop.test', 'shop.test'],
      }),
    ).toBe(exploreReplyAad(PARTS));
  });

  it('хосты замка — как lockHostOf sites-backend: нижний регистр, нестандартный порт, без дублей', () => {
    expect(
      exploreLockHosts([
        'https://Shop.Test/cart?x=1',
        'https://shop.test',
        'https://shop.test:8443/a',
        'http://a.shop.test:80/',
      ]),
    ).toEqual(['shop.test', 'shop.test:8443', 'a.shop.test']);
  });

  it('эталон sites-backend открывается этим кодом; чужой AAD — нет', () => {
    expect(
      openWithPrivateForTests(D, X, REPLY, exploreReplyAad(PARTS)).toString(),
    ).toBe('{"url":"https://shop.test/cart?step=2","cookies":[]}');
    expect(() =>
      openWithPrivateForTests(
        D,
        X,
        REPLY,
        exploreReplyAad({ ...PARTS, allowedHosts: ['evil.test'] }),
      ),
    ).toThrow(WorkerSealError);
  });

  it('этот код запечатывает так, что открывает закрытый ключ (формат v1)', () => {
    const sealed = sealTo(
      X,
      Buffer.from('[{"name":"a"}]'),
      exploreSessionAad(PARTS),
    );
    expect(sealed).toMatch(
      /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/,
    );
    expect(
      openWithPrivateForTests(
        D,
        X,
        sealed,
        exploreSessionAad(PARTS),
      ).toString(),
    ).toBe('[{"name":"a"}]');
  });

  it('одноразовый ключ ответа: открывает только свой конверт и свой nonce', () => {
    const k = ephemeralReplyKeys();
    const other = ephemeralReplyKeys();
    const parts = { ...PARTS, replyKey: k.publicKey };
    const sealed = sealTo(
      k.publicKey,
      Buffer.from('jar'),
      exploreReplyAad(parts),
    );
    expect(k.open(sealed, exploreReplyAad(parts)).toString()).toBe('jar');
    expect(() =>
      k.open(sealed, exploreReplyAad({ ...parts, nonce: 'n3' })),
    ).toThrow();
    expect(() => other.open(sealed, exploreReplyAad(parts))).toThrow();
    expect(() => sealTo('короткий', Buffer.from('x'), 'a')).toThrow(
      WorkerSealError,
    );
  });
});
