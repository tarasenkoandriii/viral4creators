// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/wayforpay-signature.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import { createHmac } from 'crypto';
import {
  formatWayForPayAmount,
  safeEqualString,
  verifyWayForPayCallback,
  wayforpayAckSignature,
  wayforpayCallbackSignature,
  wayforpayPurchaseSignature,
} from './wayforpay-signature';

/** Эталон — та же конкатенация, что в документации WayForPay (вручную). */
function md5(secret: string, parts: string[]): string {
  return createHmac('md5', secret)
    .update(parts.join(';'), 'utf8')
    .digest('hex');
}

const SECRET = 'flk3409refn54t54t*FNJRET';

describe('wayforpay-signature (общий с sites-backend)', () => {
  it('сумма — основные единицы без лишних нулей', () => {
    expect(formatWayForPayAmount(789)).toBe('789');
    expect(formatWayForPayAmount(0.13)).toBe('0.13');
    expect(formatWayForPayAmount(19.999)).toBe('20');
    expect(formatWayForPayAmount(1.5)).toBe('1.5');
  });

  it('подпись покупки: merchant;domain;order;date;amount;currency;name;1;amount', () => {
    const sig = wayforpayPurchaseSignature(
      {
        merchantAccount: 'test_merch_n1',
        merchantDomainName: 'www.market.ua',
        orderReference: 'DH783023',
        orderDate: 1415379863,
        amount: 1547.36,
        currency: 'UAH',
        productName: 'Процессор Intel Core i5-4670 3.4GHz',
      },
      SECRET,
    );
    expect(sig).toBe(
      md5(SECRET, [
        'test_merch_n1',
        'www.market.ua',
        'DH783023',
        '1415379863',
        '1547.36',
        'UAH',
        'Процессор Intel Core i5-4670 3.4GHz',
        '1',
        '1547.36',
      ]),
    );
  });

  it('подпись вебхука и её проверка; подмена суммы/статуса — отказ', () => {
    const body = {
      merchantAccount: 'test_merch_n1',
      orderReference: 'ord-1',
      amount: 789,
      currency: 'UAH',
      authCode: '541963',
      cardPan: '4102****8217',
      transactionStatus: 'Approved',
      reasonCode: 1100,
    };
    const merchantSignature = wayforpayCallbackSignature(body, SECRET);
    expect(merchantSignature).toBe(
      md5(SECRET, [
        'test_merch_n1',
        'ord-1',
        '789',
        'UAH',
        '541963',
        '4102****8217',
        'Approved',
        '1100',
      ]),
    );
    expect(
      verifyWayForPayCallback({ ...body, merchantSignature }, SECRET),
    ).toBe(true);
    expect(
      verifyWayForPayCallback(
        { ...body, amount: 1, merchantSignature },
        SECRET,
      ),
    ).toBe(false);
    expect(
      verifyWayForPayCallback(
        { ...body, transactionStatus: 'Declined', merchantSignature },
        SECRET,
      ),
    ).toBe(false);
    expect(
      verifyWayForPayCallback({ ...body, merchantSignature }, 'other-secret'),
    ).toBe(false);
  });

  it('квитанция accept: order;accept;time', () => {
    expect(wayforpayAckSignature('ord-1', 1700000000, SECRET)).toBe(
      md5(SECRET, ['ord-1', 'accept', '1700000000']),
    );
  });

  it('сравнение постоянного времени: разная длина — false без исключения', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
  });
});
